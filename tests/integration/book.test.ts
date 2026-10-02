import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { trialBalance } from '@/ledger/balances';
import { addDays } from '@/ledger/calendar';
import { PAYMENT_ORDER } from '@/ledger/config';
import { loanStatus, runStatus } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postPayment } from '@/ledger/payment';
import { payoffQuote } from '@/ledger/payoff';
import { verifyLedger } from '@/ledger/verify';
import { bookOverview } from '@/ledger/views';

// Task 4.6 (D23): BK1, the PRD's simulated book. 40 loans over 2026, run day by day through the real path in job order:
// loans disbursed that day, accrual, the late-fee job, then payments (a payoff pays the quote). The state of every loan
// is read on every day and kept as transitions, the fixture's shape.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(() => client.end());

type Buckets = { fees: number; interest: number; principal: number };
type Loan = { n: number; principal_cents: number; apr_bps: number; term_months: number; disbursement_date: string; payments: { date: string; cents?: number; payoff?: boolean }[] };
type Out = {
  n: number;
  payments: { date: string; cents: number; allocation: Buckets; loan_closed: boolean }[];
  fees: { installment: number; date: string; cents: number }[];
  states: { date: string; state: string }[];
  owed_at_end: Buckets;
  accrual_entries: number;
};
const bk = JSON.parse(readFileSync('fixtures/book/BK1.json', 'utf8')) as {
  input: { start: string; run_through: string; loans: Loan[] };
  expected: { loans: Out[]; totals: { cash_received_cents: number; interest_income_cents: number; fees_income_cents: number; accrual_entries: number; states_at_end: Record<string, number> } };
};
const { input, expected } = bk;

const ids = new Map<number, string>();
const seen = new Map<string, Omit<Out, 'n' | 'owed_at_end'>>();
const end = input.run_through;

beforeAll(async () => {
  await client.connect();
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
  for (let D = input.start; D <= end; D = addDays(D, 1)) {
    for (const l of input.loans.filter((x) => x.disbursement_date === D)) {
      const { loanId } = await createLoan(client, { principalCents: l.principal_cents, aprBps: l.apr_bps, termMonths: l.term_months, disbursementDate: D });
      ids.set(l.n, loanId);
      seen.set(loanId, { payments: [], fees: [], states: [], accrual_entries: 0 });
    }
    for (const a of await runAccrual(client, { asOf: D })) seen.get(a.loanId)!.accrual_entries++;
    for (const f of await runStatus(client, { asOf: D })) seen.get(f.loanId)!.fees.push({ installment: f.installment, date: f.date, cents: f.cents });
    for (const l of input.loans) {
      const pay = l.payments.find((p) => p.date === D);
      if (!pay) continue;
      const loanId = ids.get(l.n)!;
      const cents = pay.payoff ? (await payoffQuote(client, { loanId, asOf: D })).totalCents : pay.cents!;
      const r = await postPayment(client, { loanId, date: D, paymentCents: cents, order: PAYMENT_ORDER });
      seen.get(loanId)!.payments.push({ date: D, cents, allocation: r.allocation, loan_closed: r.loanClosed });
    }
    for (const [loanId, s] of seen) {
      const { state } = await loanStatus(client, { loanId, asOf: D });
      if (s.states.at(-1)?.state !== state) s.states.push({ date: D, state });
    }
  }
}, 900_000);

it('BK1: every loan pays, takes fees and moves through states on the fixture days, to the cent', () => {
  for (const x of expected.loans) {
    const { n, payments, fees, states, accrual_entries } = x;
    expect({ n, ...seen.get(ids.get(n)!)! }).toEqual({ n, payments, fees, states, accrual_entries });
  }
});

it('BK1: what each loan owes at year end matches, and closed loans owe nothing', async () => {
  for (const x of expected.loans) expect({ n: x.n, owed: await owedCents(client, ids.get(x.n)!) }).toEqual({ n: x.n, owed: x.owed_at_end });
});

it('BK1: book totals and end states reconcile, and ledger:verify is clean', async () => {
  const tb = await trialBalance(client);
  const t = expected.totals;
  expect(tb.balancesCents.interest_income).toBe(t.interest_income_cents);
  expect(tb.balancesCents.fees_income).toBe(t.fees_income_cents);
  const lent = input.loans.reduce((s, l) => s + l.principal_cents, 0);
  expect(tb.balancesCents.cash).toBe(t.cash_received_cents - lent);
  expect([...seen.values()].reduce((s, l) => s + l.accrual_entries, 0)).toBe(t.accrual_entries);
  const book = await bookOverview(client, { loanIds: [...ids.values()], asOf: end });
  expect(Object.fromEntries(book.buckets.map((b) => [b.state, b.count]))).toEqual(t.states_at_end);
  expect((await verifyLedger(client)).findings).toEqual([]);
});
