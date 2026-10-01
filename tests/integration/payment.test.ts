import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import am1 from '../../fixtures/amortization/AM1.json';
import ac4 from '../../fixtures/accrual/AC4_first_installment_period.json';
import { runAccrual } from '@/ledger/accrue';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postPayment } from '@/ledger/payment';
import { postEntry, postEntryInTx } from '@/ledger/post';
import { readEntry } from '@/ledger/read';
import { verifyLedger } from '@/ledger/verify';

// Task 3.3 (D16): payments through the real posting path. Each fixture's owed_before is built from the
// ledger (L1, the AC4 accrual = 1019, a 1500 fee when owed), then paid on the accrual day.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const racer = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = Promise.all([client.connect(), racer.connect()]);
afterAll(() => Promise.all([client.end(), racer.end()]));
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
});

const D = ac4.expected.entries.at(-1)!.date;
const L1 = {
  principalCents: am1.input.principal_cents,
  aprBps: am1.input.apr_bps,
  termMonths: am1.input.term_months,
  disbursementDate: am1.input.disbursement_date,
};
const fee = (loanId: string) =>
  postEntry(client, {
    date: am1.input.disbursement_date,
    loanId,
    lines: [
      { account: 'fees_receivable', debitCents: 1500, creditCents: 0 },
      { account: 'fees_income', debitCents: 0, creditCents: 1500 },
    ],
  });
async function book(fees: number) {
  const { loanId } = await createLoan(client, L1);
  if (fees) await fee(loanId);
  await runAccrual(client, { asOf: D });
  return loanId;
}

const dir = 'fixtures/waterfall';
const fixtures = readdirSync(dir).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
for (const f of fixtures) {
  it(`${f.id}: ${f.description}`, async () => {
    const loanId = await book(f.input.owed_before.fees);
    const pay = () => postPayment(client, { loanId, date: D, paymentCents: f.input.payment_cents, order: f.config.waterfall_order });
    if (f.expected.error) {
      await expect(pay()).rejects.toMatchObject({ code: f.expected.error });
      expect(await owedCents(client, loanId)).toEqual(f.input.owed_before);
    } else {
      const r = await pay();
      expect(r.allocation).toEqual(f.expected.allocation);
      expect(r.loanClosed).toBe(f.expected.loan_closed);
      expect(await owedCents(client, loanId)).toEqual(f.expected.remaining);
      const e = (await readEntry(client, r.entryId))!;
      const lines = e.lines.map((l) => ({ account: l.account, debit: l.debitCents, credit: l.creditCents }));
      expect(lines.find((l) => l.account === 'cash')).toEqual(f.expected.journal_lines.find((l: { account: string }) => l.account === 'cash'));
      expect(new Set(lines.map((l) => JSON.stringify(l)))).toEqual(new Set(f.expected.journal_lines.map((l: object) => JSON.stringify(l))));
      expect(e.loanId).toBe(loanId);
    }
    expect((await verifyLedger(client)).findings).toEqual([]);
  });
}

it('a payment on a day whose accrual is not posted is refused and writes nothing', async () => {
  const { loanId } = await createLoan(client, L1);
  await expect(postPayment(client, { loanId, date: D, paymentCents: 100, order: ['fees', 'interest', 'principal'] })).rejects.toMatchObject({ code: 'accrual_pending' });
  expect(await owedCents(client, loanId)).toEqual({ fees: 0, interest: 0, principal: 100000 });
});

it('a payment waits for the loan lock, then allocates against what the winner posted', async () => {
  const loanId = await book(0);
  // `client` plays the first payment, stopped between its read and its commit, holding the loan lock.
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM "Loan" WHERE "id" = $1 FOR UPDATE', [loanId]);
  let settled = false;
  const second = postPayment(racer, { loanId, date: D, paymentCents: 101019, order: ['fees', 'interest', 'principal'] }).finally(() => (settled = true));
  second.catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  expect(settled).toBe(false); // without the lock it would already have read the full payoff and posted
  await postEntryInTx(client, {
    date: D,
    loanId,
    lines: [
      { account: 'cash', debitCents: 101019, creditCents: 0 },
      { account: 'interest_receivable', debitCents: 0, creditCents: 1019 },
      { account: 'loans_receivable', debitCents: 0, creditCents: 100000 },
    ],
  });
  await client.query('COMMIT');
  await expect(second).rejects.toMatchObject({ code: 'exceeds_payoff', payoffCents: 0 });
  expect(await owedCents(client, loanId)).toEqual({ fees: 0, interest: 0, principal: 0 });
  expect((await verifyLedger(client)).findings).toEqual([]);
});
