import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import { createLoan } from '@/ledger/loan';
import { loanStatus } from '@/ledger/delinquency';
import { postEntry } from '@/ledger/post';

// Task 4.2: loanStatus reads the payments from the ledger and the schedule from the loan terms; every simulated day.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
});

const dir = 'fixtures/delinquency';
const am1 = JSON.parse(readFileSync('fixtures/amortization/AM1.json', 'utf8')).input;

for (const f of readdirSync(dir)) {
  const fx = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  it(`${fx.id}: status from the ledger on every day`, async () => {
    const { loanId } = await createLoan(client, {
      principalCents: am1.principal_cents,
      aprBps: am1.apr_bps,
      termMonths: am1.term_months,
      disbursementDate: am1.disbursement_date,
    });
    for (const p of fx.input.payments) {
      await postEntry(client, {
        date: p.date,
        loanId,
        memo: 'payment',
        lines: [
          { account: 'cash', debitCents: p.cents, creditCents: 0 },
          { account: 'loans_receivable', debitCents: 0, creditCents: p.cents },
        ],
      });
    }
    for (const d of fx.expected.days) {
      const s = await loanStatus(client, { loanId, asOf: d.date });
      expect([d.date, s.dpd, s.state]).toEqual([d.date, d.dpd, d.state]);
    }
  });
}

it('unknown loan is refused', async () => {
  await expect(loanStatus(client, { loanId: 'nope', asOf: '2026-03-01' })).rejects.toMatchObject({ code: 'unknown_loan' });
});
