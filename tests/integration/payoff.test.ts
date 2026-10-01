import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { payoffQuote } from '@/ledger/payoff';
import { postPayment } from '@/ledger/payment';
import { postEntry } from '@/ledger/post';
import { buildSchedule } from '@/ledger/schedule';
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
const am1 = JSON.parse(readFileSync('fixtures/amortization/AM1.json', 'utf8')).input;
const L1 = { principalCents: am1.principal_cents, aprBps: am1.apr_bps, termMonths: am1.term_months, disbursementDate: am1.disbursement_date };

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

// Task 3.5: the quote is what the payment path accepts. Pay it after accruing through its date and the loan is zero.
async function payQuote(loanId: string, date: string) {
  const q = await payoffQuote(client, { loanId, asOf: date });
  await runAccrual(client, { asOf: date });
  const before = (await client.query('SELECT count(*)::int AS n FROM "LedgerEntry"')).rows[0].n;
  const over = { loanId, date, paymentCents: q.totalCents + 1, order };
  await expect(postPayment(client, over)).rejects.toMatchObject({ code: 'exceeds_payoff' }); // WF8, real path
  expect((await client.query('SELECT count(*)::int AS n FROM "LedgerEntry"')).rows[0].n).toBe(before);
  const paid = await postPayment(client, { loanId, date, paymentCents: q.totalCents, order });
  expect(paid.loanClosed).toBe(true);
  expect(paid.remaining).toEqual({ fees: 0, interest: 0, principal: 0 });
  expect(await owedCents(client, loanId)).toEqual({ fees: 0, interest: 0, principal: 0 });
  expect((await verifyLedger(client)).findings).toEqual([]);
  return q;
}

it('round trip: quote for D, accrue through D, pay the quote on D closes the loan to zero', async () => {
  const { loanId } = await createLoan(client, L1);
  await postEntry(client, {
    date: '2026-02-01',
    loanId,
    lines: [
      { account: 'fees_receivable', debitCents: 1500, creditCents: 0 },
      { account: 'fees_income', debitCents: 0, creditCents: 1500 },
    ],
  });
  await runAccrual(client, { asOf: '2026-02-15' });
  await postPayment(client, { loanId, date: '2026-02-15', paymentCents: 10000, order });
  const q = await payQuote(loanId, '2026-03-20'); // accrual partly posted, partly pending at the quote
  expect(q.pendingAccrualCents).toBeGreaterThan(0);
});

it('D9: L1 paid on schedule owes the quote on the final due date, not the last row', async () => {
  const { loanId } = await createLoan(client, L1);
  const s = buildSchedule(L1);
  for (const r of s.rows.slice(0, -1)) {
    await runAccrual(client, { asOf: r.dueDate });
    await postPayment(client, { loanId, date: r.dueDate, paymentCents: s.installmentCents, order });
  }
  const last = s.rows.at(-1)!;
  const q = await payQuote(loanId, last.dueDate);
  expect(q.totalCents).not.toBe(last.paymentCents); // D4's drift lands in the final payment
});

it('an unknown loan and a bad date are refused', async () => {
  await expect(payoffQuote(client, { loanId: 'nope', asOf: '2026-02-15' })).rejects.toMatchObject({ code: 'unknown_loan' });
  const { loanId } = await createLoan(client, { principalCents: 100000, aprBps: 1200, termMonths: 6, disbursementDate: '2026-01-15' });
  await expect(payoffQuote(client, { loanId, asOf: '2026-02-30' })).rejects.toThrow();
});
