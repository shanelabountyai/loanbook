import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import am1 from '../../fixtures/amortization/AM1.json';
import ac3 from '../../fixtures/accrual/AC3_principal_change.json';
import ac4 from '../../fixtures/accrual/AC4_first_installment_period.json';
import ac5 from '../../fixtures/accrual/AC5_idempotency_and_catchup.json';
import { runAccrual } from '@/ledger/accrue';
import { trialBalance } from '@/ledger/balances';
import { createLoan } from '@/ledger/loan';
import { postEntry } from '@/ledger/post';
import { verifyLedger } from '@/ledger/verify';

// Task 2.5: accrual posted through the ledger, derived from it on every run (D5, D6), and one entry per
// (loan, day) enforced by the database (D15). L1 is AM1's loan: 100000¢ at 1200 bps from 2026-01-15.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = Promise.all([client.connect(), other.connect()]);
afterAll(() => Promise.all([client.end(), other.end()]));
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
const days = (posted: { date: string; amountCents: number }[]) => posted.map(({ date, amountCents }) => ({ date, amountCents }));
const expected = (entries: { date: string; entry_cents: number }[]) => entries.map((e) => ({ date: e.date, amountCents: e.entry_cents }));
const accrualsInLedger = async () =>
  (
    await client.query<{ date: string; cents: string }>(
      `SELECT e."date"::text AS date, l."debitCents"::text AS cents FROM "LedgerEntry" e
         JOIN "LedgerLine" l ON l."entryId" = e."id" AND l."account" = 'interest_receivable'
        WHERE e."kind" = 'accrual' ORDER BY e."date"`,
    )
  ).rows.map((r) => ({ date: r.date, amountCents: Number(r.cents) }));
const clean = async () => expect((await verifyLedger(client)).findings).toEqual([]);
const reducePrincipal = (loanId: string, cents: number, date: string) =>
  postEntry(client, {
    date,
    loanId,
    memo: 'Principal reduction',
    lines: [
      { account: 'cash', debitCents: cents, creditCents: 0 },
      { account: 'loans_receivable', debitCents: 0, creditCents: cents },
    ],
  });

it('AC5: a repeat run posts nothing, and a run after a skipped day catches up every missing day', async () => {
  expect(ac5.input).toEqual({ principal_cents: L1.principalCents, apr_bps: L1.aprBps, principal_effective_date: L1.disbursementDate });
  await createLoan(client, L1);
  for (const run of ac5.runs) {
    expect(days(await runAccrual(client, { asOf: run.run_date }))).toEqual(expected(run.expected_entries));
    await clean();
  }
  expect((await trialBalance(client)).balancesCents.interest_receivable).toBe(ac5.expected_cumulative_after_all_runs_cents);
});

it('AC3 through the ledger: a principal reduction dated 01-25 takes effect 01-26, and each segment rounds on its own', async () => {
  const [seg1, seg2] = ac3.input.segments;
  const { loanId } = await createLoan(client, L1);

  await runAccrual(client, { asOf: seg1!.through });
  await clean();
  await reducePrincipal(loanId, seg1!.principal_cents - seg2!.principal_cents, seg2!.principal_effective_date);
  await runAccrual(client, { asOf: seg2!.through });
  await clean();

  expect(await accrualsInLedger()).toEqual(expected(ac3.expected.entries));
  const byDate = (to: string) => ac3.expected.entries.filter((e) => e.date <= to).reduce((s, e) => s + e.entry_cents, 0);
  expect(byDate(seg1!.through)).toBe(ac3.expected.segment_totals_cents[0]);
  expect((await trialBalance(client)).perLoanCents[loanId]!.interest_receivable).toBe(ac3.expected.total_cents);
});

it('AC3 in one run: the reduction already on the books before any accrual gives the same entries', async () => {
  const [, seg2] = ac3.input.segments;
  const { loanId } = await createLoan(client, L1);
  await reducePrincipal(loanId, L1.principalCents - seg2!.principal_cents, seg2!.principal_effective_date);
  await runAccrual(client, { asOf: seg2!.through });
  expect(await accrualsInLedger()).toEqual(expected(ac3.expected.entries));
  await clean();
});

it('AC4: 31 days of L1 read back through trialBalance as 1019, not the schedule’s 1000', async () => {
  const { loanId } = await createLoan(client, L1);
  const last = ac4.expected.entries.at(-1)!.date;
  expect(days(await runAccrual(client, { asOf: last }))).toEqual(expected(ac4.expected.entries));
  const tb = await trialBalance(client);
  expect(tb.perLoanCents[loanId]!.interest_receivable).toBe(ac4.expected.total_cents);
  expect(tb.balancesCents.interest_income).toBe(ac4.expected.total_cents);
  expect(ac4.expected.total_cents).not.toBe(ac4.expected.schedule_interest_cents);
  await clean();
});

it('the database allows one accrual per (loan, day): a second is refused (already_accrued)', async () => {
  const { loanId } = await createLoan(client, L1);
  const accrual = {
    date: '2026-01-16',
    loanId,
    kind: 'accrual' as const,
    lines: [
      { account: 'interest_receivable', debitCents: 33, creditCents: 0 },
      { account: 'interest_income', debitCents: 0, creditCents: 33 },
    ],
  };
  await postEntry(client, accrual);
  await expect(postEntry(client, accrual)).rejects.toMatchObject({ constraint: 'already_accrued' });
  await expect(postEntry(client, { ...accrual, kind: 'acrual' as 'accrual' })).rejects.toMatchObject({ constraint: 'invalid_kind' });
});

it('two runs racing leave one entry per day', async () => {
  await createLoan(client, L1);
  const last = ac4.expected.entries.at(-1)!.date;
  const [a, b] = await Promise.all([runAccrual(client, { asOf: last }), runAccrual(other, { asOf: last })]);
  expect(a.length + b.length).toBe(ac4.expected.entries.length);
  expect(await accrualsInLedger()).toEqual(expected(ac4.expected.entries));
  await clean();
});

it('a day that rounds to 0 posts nothing and is carried by the next day', async () => {
  // 1000¢ at 1200 bps: day 1 is 0.33¢ (0), day 2 cumulative 0.66¢ (1).
  await createLoan(client, { ...L1, principalCents: 1000 });
  expect(await runAccrual(client, { asOf: '2026-01-16' })).toEqual([]);
  expect(days(await runAccrual(client, { asOf: '2026-01-17' }))).toEqual([{ date: '2026-01-17', amountCents: 1 }]);
  await clean();
});

it('disbursement day accrues nothing, and a loan with no disbursement posted accrues nothing', async () => {
  await createLoan(client, L1);
  await client.query(
    'INSERT INTO "Loan" ("id", "principalCents", "aprBps", "termMonths", "disbursementDate") VALUES (\'undisbursed\', 100000, 1200, 6, \'2026-01-15\')',
  );
  expect(await runAccrual(client, { asOf: L1.disbursementDate })).toEqual([]);
  const run = await runAccrual(client, { asOf: '2026-01-20' });
  expect(run).toHaveLength(5);
  expect(run.some((r) => r.loanId === 'undisbursed')).toBe(false);
});

it('refuses an invalid as-of date before reading anything', async () => {
  await expect(runAccrual(client, { asOf: '2026-02-30' })).rejects.toMatchObject({ code: 'invalid_date' });
});
