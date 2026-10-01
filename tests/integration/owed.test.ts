import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import am1 from '../../fixtures/amortization/AM1.json';
import ac4 from '../../fixtures/accrual/AC4_first_installment_period.json';
import { runAccrual } from '@/ledger/accrue';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postEntry } from '@/ledger/post';

// Task 3.2: owed is read from the ledger per loan, never stored. L1 is AM1's loan.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
});

const L1 = {
  principalCents: am1.input.principal_cents,
  aprBps: am1.input.apr_bps,
  termMonths: am1.input.term_months,
  disbursementDate: am1.input.disbursement_date,
};

it('L1 after disbursement and the AC4 accrual owes 100000 / 1019 / 0, and only that loan', async () => {
  const { loanId } = await createLoan(client, L1);
  const other = await createLoan(client, { ...L1, principalCents: 50000 });
  expect(await owedCents(client, loanId)).toEqual({ fees: 0, interest: 0, principal: 100000 });
  await runAccrual(client, { asOf: ac4.expected.entries.at(-1)!.date });
  expect(await owedCents(client, loanId)).toEqual({ fees: 0, interest: ac4.expected.total_cents, principal: 100000 });
  expect((await owedCents(client, other.loanId)).principal).toBe(50000);
});

it('fees and payments move the figures; an unknown loan owes nothing', async () => {
  const { loanId } = await createLoan(client, L1);
  await postEntry(client, {
    date: '2026-02-01',
    loanId,
    memo: 'Late fee',
    lines: [
      { account: 'fees_receivable', debitCents: 1500, creditCents: 0 },
      { account: 'fees_income', debitCents: 0, creditCents: 1500 },
    ],
  });
  await postEntry(client, {
    date: '2026-02-02',
    loanId,
    memo: 'Principal reduction',
    lines: [
      { account: 'cash', debitCents: 400, creditCents: 0 },
      { account: 'loans_receivable', debitCents: 0, creditCents: 400 },
    ],
  });
  expect(await owedCents(client, loanId)).toEqual({ fees: 1500, interest: 0, principal: 99600 });
  expect(await owedCents(client, 'nope')).toEqual({ fees: 0, interest: 0, principal: 0 });
});
