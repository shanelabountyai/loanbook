import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { createLoan } from '@/ledger/loan';
import { payoffQuote } from '@/ledger/payoff';
import { postPayment } from '@/ledger/payment';
import { postEntry } from '@/ledger/post';
import { verifyLedger } from '@/ledger/verify';

// Task 3.4 (D17): the quote is read from the ledger plus the accrual days the run would still post.
// Each fixture's history is built through the real paths, then quoted.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
});

const dir = 'fixtures/payoff';
const fixtures = readdirSync(dir).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
const order = ['fees', 'interest', 'principal'] as const;

async function build(f: (typeof fixtures)[number]) {
  const i = f.input;
  const { loanId } = await createLoan(client, {
    principalCents: i.principal_cents,
    aprBps: i.apr_bps,
    termMonths: 6,
    disbursementDate: i.disbursement_date,
  });
  if (i.fees_assessed_cents) {
    await postEntry(client, {
      date: i.disbursement_date,
      loanId,
      lines: [
        { account: 'fees_receivable', debitCents: i.fees_assessed_cents, creditCents: 0 },
        { account: 'fees_income', debitCents: 0, creditCents: i.fees_assessed_cents },
      ],
    });
  }
  for (const p of i.payments) {
    await runAccrual(client, { asOf: p.date });
    const a = p.allocation;
    await postPayment(client, { loanId, date: p.date, paymentCents: a.fees + a.interest + a.principal, order });
  }
  await runAccrual(client, { asOf: i.accrual_posted_through });
  return loanId;
}

for (const f of fixtures) {
  it(`${f.id}: ${f.description}`, async () => {
    const loanId = await build(f);
    const before = (await client.query('SELECT count(*)::int AS n FROM "LedgerEntry"')).rows[0].n;
    const q = await payoffQuote(client, { loanId, asOf: f.input.as_of });
    const e = f.expected;
    expect(q).toEqual({
      loanId,
      asOf: f.input.as_of,
      principalCents: e.principal_cents,
      interestCents: e.interest_cents,
      feesCents: e.fees_cents,
      totalCents: e.total_cents,
      postedInterestCents: e.posted_interest_cents,
      pendingAccrualCents: e.pending_accrual_cents,
    });
    expect(await payoffQuote(client, { loanId, asOf: f.input.as_of })).toEqual(q); // same inputs, same output
    expect((await client.query('SELECT count(*)::int AS n FROM "LedgerEntry"')).rows[0].n).toBe(before); // posts nothing
    expect((await verifyLedger(client)).findings).toEqual([]);
  });
}

it('an unknown loan and a bad date are refused', async () => {
  await expect(payoffQuote(client, { loanId: 'nope', asOf: '2026-02-15' })).rejects.toMatchObject({ code: 'unknown_loan' });
  const { loanId } = await createLoan(client, { principalCents: 100000, aprBps: 1200, termMonths: 6, disbursementDate: '2026-01-15' });
  await expect(payoffQuote(client, { loanId, asOf: '2026-02-30' })).rejects.toThrow();
});
