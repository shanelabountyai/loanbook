import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import tb1 from '../../fixtures/ledger/TB1_trial_balance.json';
import { postEntry } from '@/ledger/post';
import { trialBalance } from '@/ledger/balances';

// Task 1.7: balances are derived from lines. TB1 is posted through the one write path and must come
// back exactly: totals, every account, every loan.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry"');
});

it('TB1 posted through postEntry derives the expected trial balance exactly', async () => {
  for (const e of tb1.entries) {
    await postEntry(client, {
      date: e.date,
      loanId: e.loan_id,
      memo: e.memo,
      lines: e.lines.map((l) => ({ account: l.account, debitCents: l.debit, creditCents: l.credit })),
    });
  }
  const x = tb1.expected;
  expect(await trialBalance(client)).toStrictEqual({
    totalDebitsCents: x.total_debits_cents,
    totalCreditsCents: x.total_credits_cents,
    balancesCents: x.balances_cents,
    perLoanCents: x.per_loan_cents,
  });
});

it('an empty ledger is all zeros and no loans', async () => {
  const empty = await trialBalance(client);
  expect(empty).toMatchObject({ totalDebitsCents: 0, totalCreditsCents: 0, perLoanCents: {} });
  expect(Object.values(empty.balancesCents).every((c) => c === 0)).toBe(true);
  expect(Object.keys(empty.balancesCents)).toEqual(Object.keys(tb1.expected.balances_cents));
});
