import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { trialBalance } from '@/ledger/balances';
import { addDays } from '@/ledger/calendar';
import { PAYMENT_ORDER } from '@/ledger/config';
import { runStatus, waiveFee } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postPayment } from '@/ledger/payment';
import { postEntryInTx } from '@/ledger/post';
import { readEntry } from '@/ledger/read';
import { verifyLedger } from '@/ledger/verify';
import { loanLedger, statementText } from '@/ledger/views';

// Task 4.7a (D24): WV1 through the real path, day by day: accrual, the late-fee job, then each payment or waiver
// posted that day, in the fixture's order. Every waiver attempt is held to the fixture's result or refusal code.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const racer = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(async () => {
  await client.end();
  await racer.end();
});

type Event = { posted_on: string; payment?: number; waive?: { fee?: number; payment?: string }; date?: string; reason?: string };
const wv = JSON.parse(readFileSync('fixtures/waiver/WV1.json', 'utf8')) as {
  input: { principal_cents: number; apr_bps: number; term_months: number; disbursement_date: string; run_through: string; events: Event[] };
  expected: {
    fees: { installment: number; date: string; cents: number }[];
    results: Record<string, unknown>[];
    totals: { fees_assessed_cents: number; fees_waived_cents: number; fees_paid_cents: number; fees_owed_at_end: number; fees_income_cents: number };
  };
};
const { input, expected } = wv;

let loanId = '';
const feeIds = new Map<number, string>();
const paymentIds = new Map<string, string>();
const seen = { fees: [] as unknown[], results: [] as unknown[] };

beforeAll(async () => {
  await client.connect();
  await racer.connect();
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
  ({ loanId } = await createLoan(client, {
    principalCents: input.principal_cents,
    aprBps: input.apr_bps,
    termMonths: input.term_months,
    disbursementDate: input.disbursement_date,
  }));
  const fees = async () => (await owedCents(client, loanId)).fees;
  for (let asOf = input.disbursement_date; asOf < input.run_through; ) {
    asOf = addDays(asOf, 1);
    await runAccrual(client, { asOf });
    for (const f of await runStatus(client, { asOf })) {
      feeIds.set(f.installment, f.entryId);
      seen.fees.push({ installment: f.installment, date: f.date, cents: f.cents });
    }
    for (const e of input.events.filter((x) => x.posted_on === asOf)) {
      if (e.payment !== undefined) {
        const r = await postPayment(client, { loanId, date: asOf, paymentCents: e.payment, order: PAYMENT_ORDER });
        paymentIds.set(asOf, r.entryId);
        seen.results.push({ fees_paid: r.allocation.fees, fees_owed_after: await fees() });
        continue;
      }
      const entryId = e.waive!.fee !== undefined ? feeIds.get(e.waive!.fee)! : paymentIds.get(e.waive!.payment!)!;
      try {
        const w = await waiveFee(client, { entryId, date: e.date!, reason: e.reason! });
        seen.results.push({ memo: (await readEntry(client, w.entryId))!.memo, fees_owed_after: await fees() });
      } catch (err) {
        seen.results.push({ error: (err as { code?: string }).code, fees_owed_after: await fees() });
      }
    }
  }
}, 120_000);

it('WV1: every waiver is posted or refused as the fixture says, and fees owed match after each step', () => {
  expect(seen.results).toEqual(expected.results);
});

it('WV1: the late-fee job never charges a waived installment again', async () => {
  expect(seen.fees).toEqual(expected.fees);
  expect(await runStatus(client, { asOf: input.run_through })).toEqual([]);
});

it('WV1: each waiver reverses its fee; income nets the waivers; the statement narrates them; verify is clean', async () => {
  for (const n of [2, 4]) {
    const { rows } = await client.query('SELECT "loanId", "kind" FROM "LedgerEntry" WHERE "reversesEntryId" = $1', [feeIds.get(n)]);
    expect(rows).toEqual([{ loanId, kind: null }]);
  }
  const tb = await trialBalance(client);
  expect(tb.perLoanCents[loanId]!.fees_receivable).toBe(expected.totals.fees_owed_at_end);
  expect(tb.balancesCents.fees_income).toBe(expected.totals.fees_income_cents);
  const text = statementText(await loanLedger(client, loanId), input.run_through);
  expect(text).toContain('2026-04-27 Fee waived $15.00 (installment 2): hardship');
  expect(text).toContain('2026-05-27 Fee waived $15.00 (installment 4): servicer error');
  expect((await verifyLedger(client)).findings).toEqual([]);
});

it('a waiver waits for the loan lock, then sees the fees a payment took', async () => {
  const [fee5] = await runStatus(client, { asOf: '2026-06-26' }); // installment 5 unpaid: the pool is 1500 again
  expect(fee5).toMatchObject({ installment: 5, cents: 1500 });
  // `client` plays a payment holding the lock between its read and its commit, taking the whole fee.
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM "Loan" WHERE "id" = $1 FOR UPDATE', [loanId]);
  const pid = (await racer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  let settled = false;
  const waiver = waiveFee(racer, { entryId: fee5!.entryId, date: '2026-06-26', reason: 'race' }).finally(() => (settled = true));
  waiver.catch(() => {});
  // wait until the racer either blocks on a lock or finishes; a sleep would pass a lockless waiver on a slow machine
  const blocked = async () => ((await client.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [pid])).rowCount ?? 0) > 0;
  while (!settled && !(await blocked())) await new Promise((r) => setTimeout(r, 20));
  expect(settled).toBe(false); // without the lock it would have seen 1500 and posted
  await postEntryInTx(client, {
    date: '2026-06-26',
    loanId,
    lines: [
      { account: 'cash', debitCents: 1500, creditCents: 0 },
      { account: 'fees_receivable', debitCents: 0, creditCents: 1500 },
    ],
  });
  await client.query('COMMIT');
  await expect(waiver).rejects.toMatchObject({ code: 'fee_paid' });
  expect((await owedCents(client, loanId)).fees).toBe(0);
  expect((await verifyLedger(client)).findings).toEqual([]);
});
