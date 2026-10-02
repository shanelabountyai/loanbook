import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { trialBalance } from '@/ledger/balances';
import { PAYMENT_ORDER } from '@/ledger/config';
import { loanStatus, runStatus } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { formatCents } from '@/ledger/money';
import { owedCents } from '@/ledger/owed';
import { postPayment } from '@/ledger/payment';
import { payoffQuote } from '@/ledger/payoff';
import { verifyLedger } from '@/ledger/verify';
import { loanLedger, statementText } from '@/ledger/views';

// Task 4.5 (D22): CP1, one loan's life through the real path, day by day: accrual, the late-fee job, then the
// payment. The payoff is whatever the quote says on its day. The statement is narrated from the ledger lines alone.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(() => client.end());

type Buckets = { fees: number; interest: number; principal: number };
const cp = JSON.parse(readFileSync('fixtures/capstone/CP1.json', 'utf8')) as {
  input: { principal_cents: number; apr_bps: number; term_months: number; disbursement_date: string; payments: { date: string; cents?: number; payoff?: boolean }[] };
  expected: {
    payments: { date: string; cents: number; owed_before: Buckets; allocation: Buckets; remaining: Buckets; loan_closed: boolean }[];
    fees: { installment: number; date: string; cents: number }[];
    days: { date: string; dpd: number; state: string }[];
    totals: { cash_received_cents: number; interest_income_cents: number; fees_income_cents: number; accrual_entries: number };
    owed_at_end: Buckets;
    statement: string[];
  };
};
const { input, expected } = cp;
const ZERO: Buckets = { fees: 0, interest: 0, principal: 0 };

let loanId = '';
const seen = { payments: [] as unknown[], fees: [] as unknown[], days: [] as unknown[], accruals: 0 };

beforeAll(async () => {
  await client.connect();
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
  ({ loanId } = await createLoan(client, {
    principalCents: input.principal_cents,
    aprBps: input.apr_bps,
    termMonths: input.term_months,
    disbursementDate: input.disbursement_date,
  }));
  for (const day of expected.days) {
    const asOf = day.date;
    seen.accruals += (await runAccrual(client, { asOf })).length;
    for (const f of await runStatus(client, { asOf })) seen.fees.push({ installment: f.installment, date: f.date, cents: f.cents });
    const pay = input.payments.find((p) => p.date === asOf);
    if (pay) {
      const owedBefore = await owedCents(client, loanId);
      const cents = pay.payoff ? (await payoffQuote(client, { loanId, asOf })).totalCents : pay.cents!;
      const r = await postPayment(client, { loanId, date: asOf, paymentCents: cents, order: PAYMENT_ORDER });
      seen.payments.push({ date: asOf, cents, owed_before: owedBefore, allocation: r.allocation, remaining: r.remaining, loan_closed: r.loanClosed });
    }
    const s = await loanStatus(client, { loanId, asOf });
    seen.days.push({ date: asOf, dpd: s.dpd, state: s.state });
  }
}, 120_000);

it('CP1: every payment is allocated as the fixture says, the last one at the quote, closing the loan', () => {
  expect(seen.payments).toEqual(expected.payments.map(({ date, cents, owed_before, allocation, remaining, loan_closed }) => ({ date, cents, owed_before, allocation, remaining, loan_closed })));
  expect(seen.payments.at(-1)).toMatchObject({ loan_closed: true, remaining: ZERO });
});

it('CP1: one late fee per missed installment, on its grace-exit day; state and DPD match on every day', () => {
  expect(seen.fees).toEqual(expected.fees);
  expect(seen.days).toEqual(expected.days);
});

it('CP1: the statement narrated from the ledger lines matches the fixture word for word', async () => {
  const lines = await loanLedger(client, loanId);
  expect(statementText(lines, expected.days.at(-1)!.date)).toEqual(expected.statement);
  // an earlier asOf stops at that day: the fixture's lines through the 03-15 payment, then what is owed
  const early = statementText(lines, '2026-03-15');
  expect(early.slice(0, -1)).toEqual(expected.statement.slice(0, 5));
  const r = expected.payments[1]!.remaining;
  expect(early.at(-1)).toBe(`2026-03-15 Owed ${formatCents(r.fees + r.interest + r.principal)}: fees ${formatCents(r.fees)}, interest ${formatCents(r.interest)}, principal ${formatCents(r.principal)}`);
});

it('CP1: every receivable is zero, income and cash reconcile, ledger:verify is clean', async () => {
  expect(await owedCents(client, loanId)).toEqual(expected.owed_at_end);
  expect(expected.owed_at_end).toEqual(ZERO);
  const tb = await trialBalance(client);
  expect(tb.perLoanCents[loanId]).toEqual({ loans_receivable: 0, interest_receivable: 0, fees_receivable: 0 });
  expect(tb.balancesCents.interest_income).toBe(expected.totals.interest_income_cents);
  expect(tb.balancesCents.fees_income).toBe(expected.totals.fees_income_cents);
  expect(tb.balancesCents.cash).toBe(expected.totals.cash_received_cents - input.principal_cents);
  expect(seen.accruals).toBe(expected.totals.accrual_entries);
  expect((await verifyLedger(client)).findings).toEqual([]);
});
