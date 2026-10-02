import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { trialBalance } from '@/ledger/balances';
import { PAYMENT_ORDER } from '@/ledger/config';
import { runStatus } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postPayment } from '@/ledger/payment';
import { verifyLedger } from '@/ledger/verify';
import { bookOverview, loanDetail, loanStatement } from '@/ledger/views';

// Task 4.4: the servicing views read the ledger through the real path (accrual, late fee, waterfall) and store nothing.
// DQ3 (short payment, fee at grace exit, cover on 03-01) beside DQ2 (nothing paid), both on AM1's terms.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
});

const am1 = JSON.parse(readFileSync('fixtures/amortization/AM1.json', 'utf8')).input;
const dq3 = JSON.parse(readFileSync('fixtures/delinquency/DQ3.json', 'utf8'));
const dq2 = JSON.parse(readFileSync('fixtures/delinquency/DQ2.json', 'utf8'));
const terms = { principalCents: am1.principal_cents, aprBps: am1.apr_bps, termMonths: am1.term_months, disbursementDate: am1.disbursement_date };
const AS_OF = '2026-03-01';
const dayOf = (fx: { expected: { days: { date: string; dpd: number; state: string }[] } }) => fx.expected.days.find((d) => d.date === AS_OF)!;
const total = (b: { fees: number; interest: number; principal: number }) => b.fees + b.interest + b.principal;

async function book() {
  const short = (await createLoan(client, terms)).loanId;
  const missed = (await createLoan(client, terms)).loanId;
  const other = (await createLoan(client, terms)).loanId; // in the ledger, not in the book asked for
  for (const p of dq3.input.payments as { date: string; cents: number }[]) {
    await runAccrual(client, { asOf: p.date });
    await runStatus(client, { asOf: p.date });
    await postPayment(client, { loanId: short, date: p.date, paymentCents: p.cents, order: PAYMENT_ORDER });
  }
  return { short, missed, other };
}

it('loan detail: state as of the day, schedule covered oldest first, every line of the loan', async () => {
  const { short } = await book();
  const d = await loanDetail(client, { loanId: short, asOf: AS_OF });
  expect({ dpd: d.status.dpd, state: d.status.state }).toEqual({ dpd: dayOf(dq3).dpd, state: dayOf(dq3).state });
  expect(d.owed).toEqual(await owedCents(client, short));
  expect(d.schedule.map((r) => r.coveredCents)).toEqual([17255, 0, 0, 0, 0, 0]);
  expect(d.terms).toEqual(terms);
  const debits = d.ledger.reduce((s, l) => s + l.debitCents, 0);
  expect(debits).toBe(d.ledger.reduce((s, l) => s + l.creditCents, 0));
  expect(new Set(d.ledger.map((l) => l.account))).toContain('fees_receivable');
  // as of the short payment's day the second payment is not counted yet
  const early = await loanDetail(client, { loanId: short, asOf: '2026-02-15' });
  expect(early.schedule[0]!.coveredCents).toBe(10000);
});

it('statement: each payment with its split, the late fee taken first, balance from the ledger', async () => {
  const { short } = await book();
  const s = await loanStatement(client, short);
  expect(s.payments.map((p) => [p.date, p.cents])).toEqual([['2026-02-15', 10000], ['2026-03-01', 7255]]);
  for (const p of s.payments) expect(total(p.split)).toBe(p.cents);
  expect(s.payments[0]!.split.fees).toBe(0);
  expect(s.payments[1]!.split.fees).toBe(dq3.expected.fees[0].cents);
  expect(s.owed).toEqual(await owedCents(client, short));
  expect(s.owed.fees).toBe(0);
});

it('book: outstanding sums the loans asked for, and each lands in its D18 band', async () => {
  const { short, missed, other } = await book();
  const b = await bookOverview(client, { loanIds: [short, missed], asOf: AS_OF });
  const tb = (await trialBalance(client)).perLoanCents;
  const owed = (id: string) => tb[id]!.fees_receivable + tb[id]!.interest_receivable + tb[id]!.loans_receivable;
  expect(total(b.outstanding)).toBe(owed(short) + owed(missed));
  expect(b.loans.map((l) => l.loanId)).not.toContain(other);
  expect(b.loans.find((l) => l.loanId === missed)!.state).toBe(dayOf(dq2).state);
  const counted = Object.fromEntries(b.buckets.filter((x) => x.count > 0).map((x) => [x.state, x.count]));
  expect(counted).toEqual(dayOf(dq3).state === dayOf(dq2).state ? { [dayOf(dq3).state]: 2 } : { [dayOf(dq3).state]: 1, [dayOf(dq2).state]: 1 });
  expect(b.buckets.reduce((s, x) => s + x.outstandingCents, 0)).toBe(total(b.outstanding));
  expect((await verifyLedger(client)).findings).toEqual([]);
});

it('an unknown loan is refused, not shown as empty', async () => {
  await expect(loanStatement(client, 'nope')).rejects.toMatchObject({ code: 'unknown_loan' });
  await expect(loanDetail(client, { loanId: 'nope', asOf: AS_OF })).rejects.toMatchObject({ code: 'unknown_loan' });
});
