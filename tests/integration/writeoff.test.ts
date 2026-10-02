import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { trialBalance } from '@/ledger/balances';
import { addDays } from '@/ledger/calendar';
import { PAYMENT_ORDER } from '@/ledger/config';
import { loanStatus, runStatus, writeOff } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postPayment } from '@/ledger/payment';
import { postEntryInTx } from '@/ledger/post';
import { readEntry } from '@/ledger/read';
import { verifyLedger } from '@/ledger/verify';
import { bookOverview, loanLedger, statementText } from '@/ledger/views';

// Task 4.7b (D25): WO1 through the real path, day by day: accrual, the late-fee job, then each payment or write-off
// posted that day, in the fixture's order. Every attempt is held to the fixture's result or refusal code.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const racer = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(async () => {
  await client.end();
  await racer.end();
});

type Event = { posted_on: string; payment?: number; write_off?: boolean; date?: string; reason?: string };
type Line = { account: string; debit: number; credit: number };
const wo = JSON.parse(readFileSync('fixtures/writeoff/WO1.json', 'utf8')) as {
  input: { principal_cents: number; apr_bps: number; term_months: number; disbursement_date: string; run_through: string; events: Event[] };
  expected: {
    fees: { installment: number; date: string; cents: number }[];
    results: Record<string, unknown>[];
    days: { date: string; dpd: number; state: string }[];
    totals: { cash_received_cents: number; accrual_entries: number; write_offs_cents: number; interest_income_cents: number; fees_income_cents: number };
  };
};
const { input, expected } = wo;

let loanId = '';
let writeOffId = '';
const seen = { fees: [] as unknown[], results: [] as Record<string, unknown>[], days: [] as unknown[] };

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
  for (let asOf = input.disbursement_date; asOf < input.run_through; ) {
    asOf = addDays(asOf, 1);
    await runAccrual(client, { asOf });
    for (const f of await runStatus(client, { asOf })) seen.fees.push({ installment: f.installment, date: f.date, cents: f.cents });
    for (const e of input.events.filter((x) => x.posted_on === asOf)) {
      try {
        if (e.payment !== undefined) {
          const r = await postPayment(client, { loanId, date: asOf, paymentCents: e.payment, order: PAYMENT_ORDER });
          seen.results.push({ allocation: r.allocation });
          continue;
        }
        const w = await writeOff(client, { loanId, date: e.date!, reason: e.reason! });
        writeOffId = w.entryId;
        const entry = (await readEntry(client, w.entryId))!;
        seen.results.push({
          written_off: w.writtenOff,
          memo: entry.memo,
          lines: entry.lines.map((l) => ({ account: l.account, debit: l.debitCents, credit: l.creditCents })),
        });
      } catch (err) {
        seen.results.push({ error: (err as { code?: string }).code });
      }
    }
  }
  for (const d of expected.days) {
    const s = await loanStatus(client, { loanId, asOf: d.date });
    seen.days.push({ date: d.date, dpd: s.dpd, state: s.state });
  }
}, 120_000);

it('WO1: every payment and write-off is posted or refused as the fixture says, with the fixture lines', () => {
  const sorted = (r: Record<string, unknown>) => ('lines' in r ? { ...r, lines: new Set(r.lines as Line[]) } : r);
  expect(seen.results.map(sorted)).toEqual(expected.results.map(sorted));
});

it('WO1: state every day; written_off from the write-off date, DPD frozen', () => {
  expect(seen.days).toEqual(expected.days);
});

it('WO1: after it nothing accrues, no fee is charged, receivables are zero, income nets the reversal, verify is clean', async () => {
  expect(seen.fees).toEqual(expected.fees);
  expect(await runAccrual(client, { asOf: input.run_through })).toEqual([]);
  expect(await runStatus(client, { asOf: '2026-12-31' })).toEqual([]);
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM "LedgerEntry" WHERE "loanId" = $1 AND "kind" = 'accrual'`, [loanId]);
  expect(rows[0].n).toBe(expected.totals.accrual_entries);
  expect(await owedCents(client, loanId)).toEqual({ fees: 0, interest: 0, principal: 0 });
  const tb = await trialBalance(client);
  expect(tb.balancesCents.write_offs).toBe(expected.totals.write_offs_cents);
  expect(tb.balancesCents.interest_income).toBe(expected.totals.interest_income_cents);
  expect(tb.balancesCents.fees_income).toBe(expected.totals.fees_income_cents);
  const text = statementText(await loanLedger(client, loanId), input.run_through);
  expect(text).toContain('2026-07-13 Written off $886.73: borrower unreachable');
  expect(text.at(-1)).toBe('2026-07-31 Owed $0.00: fees $0.00, interest $0.00, principal $0.00');
  const book = await bookOverview(client, { loanIds: [loanId], asOf: input.run_through });
  expect(book.buckets.find((b) => b.state === 'written_off')).toEqual({ state: 'written_off', count: 1, outstandingCents: 0 });
  expect((await verifyLedger(client)).findings).toEqual([]);
});

it('the database keeps one write-off per loan, whatever the service checked', async () => {
  const { rows } = await client.query('SELECT "kind" FROM "LedgerEntry" WHERE "id" = $1', [writeOffId]);
  expect(rows).toEqual([{ kind: 'write_off' }]);
  await client.query('BEGIN');
  const err = await client
    .query(`INSERT INTO "LedgerEntry" ("id", "date", "loanId", "kind") VALUES (gen_random_uuid(), '2026-07-31', $1, 'write_off')`, [loanId])
    .catch((e: unknown) => e);
  await client.query('ROLLBACK');
  expect(err).toMatchObject({ constraint: 'already_written_off' });
});

it('a write-off waits for the loan lock, then sees the payment that cured the default', async () => {
  // A second loan, nothing ever paid: default_recommended from installment 1's due date + 120.
  const { loanId: l2 } = await createLoan(client, { principalCents: 50000, aprBps: 1200, termMonths: 6, disbursementDate: '2026-01-15' });
  const date = '2026-06-15'; // 02-15 + 120
  for (let asOf = '2026-01-15'; asOf < date; ) {
    asOf = addDays(asOf, 1);
    await runAccrual(client, { asOf });
  }
  await runStatus(client, { asOf: date });
  expect((await loanStatus(client, { loanId: l2, asOf: date })).state).toBe('default_recommended');
  // `client` plays a payment holding the lock between its read and its commit, paying enough to cure.
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM "Loan" WHERE "id" = $1 FOR UPDATE', [l2]);
  const pid = (await racer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  let settled = false;
  const w = writeOff(racer, { loanId: l2, date, reason: 'race' }).finally(() => (settled = true));
  w.catch(() => {});
  const blocked = async () => ((await client.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [pid])).rowCount ?? 0) > 0;
  while (!settled && !(await blocked())) await new Promise((r) => setTimeout(r, 20));
  expect(settled).toBe(false); // without the lock it would have read 120 DPD and posted
  const owed = await owedCents(client, l2);
  await postEntryInTx(client, {
    date,
    loanId: l2,
    lines: [
      { account: 'cash', debitCents: owed.fees + owed.interest + owed.principal, creditCents: 0 },
      { account: 'fees_receivable', debitCents: 0, creditCents: owed.fees },
      { account: 'interest_receivable', debitCents: 0, creditCents: owed.interest },
      { account: 'loans_receivable', debitCents: 0, creditCents: owed.principal },
    ],
  });
  await client.query('COMMIT');
  await expect(w).rejects.toMatchObject({ code: 'not_in_default' });
  expect((await verifyLedger(client)).findings).toEqual([]);
});
