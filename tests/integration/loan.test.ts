import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import am1 from '../../fixtures/amortization/AM1.json';
import fixture from '../../fixtures/ledger/entry_validation.json';
import { trialBalance } from '@/ledger/balances';
import { createLoan } from '@/ledger/loan';
import { readEntry } from '@/ledger/read';
import { verifyLedger } from '@/ledger/verify';

// Task 2.3: a loan's terms are a fact, written once; its disbursement is a posting (V1 for L1).
// No balance column: what the borrower owes comes from the ledger.

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
const V1 = fixture.valid.find((c) => c.id === 'V1')!.entry;
const count = async () =>
  Number(
    (await client.query<{ n: string }>('SELECT (SELECT count(*) FROM "Loan") + (SELECT count(*) FROM "LedgerEntry") AS n')).rows[0]!.n,
  );

it('L1 is stored with its terms and disbursed as V1', async () => {
  const { loanId, entryId } = await createLoan(client, L1);

  const { rows } = await client.query('SELECT * FROM "Loan"');
  expect(rows).toEqual([expect.objectContaining({ id: loanId, principalCents: 100000, aprBps: 1200, termMonths: 6 })]);
  const { rows: dates } = await client.query<{ d: string }>('SELECT "disbursementDate"::text AS d FROM "Loan"');
  expect(dates[0]!.d).toBe(V1.date);

  expect(await readEntry(client, entryId)).toMatchObject({
    date: V1.date,
    loanId,
    lines: V1.lines.map((l) => ({ account: l.account, debitCents: l.debit, creditCents: l.credit })),
  });
  expect((await trialBalance(client)).perLoanCents).toEqual({ [loanId]: { loans_receivable: 100000, interest_receivable: 0, fees_receivable: 0 } });
  expect((await verifyLedger(client)).findings).toEqual([]);
});

it('no balance column: the table holds terms only', async () => {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Loan' ORDER BY column_name`,
  );
  expect(rows.map((r) => r.column_name)).toEqual(['aprBps', 'createdAt', 'disbursementDate', 'id', 'principalCents', 'termMonths']);
});

it.each([
  ['invalid_principal', { principalCents: 0 }],
  ['invalid_rate', { aprBps: -1 }],
  ['invalid_term', { termMonths: 0 }],
  ['degenerate_schedule', { principalCents: 7, aprBps: 0, termMonths: 12 }],
  ['non_integer_amount', { principalCents: 100000.5 }],
  ['invalid_date', { disbursementDate: '2026-02-30' }],
])('terms that cannot make a schedule are refused (%s) and nothing is written', async (code, bad) => {
  await expect(createLoan(client, { ...L1, ...bad })).rejects.toMatchObject({ code });
  expect(await count()).toBe(0);
});

// Below the service: raw SQL, as a writer that skipped createLoan would.
const raw = async (sql: string, params: unknown[] = []) => {
  try {
    await client.query(sql, params);
    return 'accepted';
  } catch (err) {
    return (err as pg.DatabaseError).constraint;
  }
};
const insert = (principal: number, apr: number, term: number) =>
  raw('INSERT INTO "Loan" ("id", "principalCents", "aprBps", "termMonths", "disbursementDate") VALUES (gen_random_uuid()::text, $1, $2, $3, $4)', [
    principal,
    apr,
    term,
    L1.disbursementDate,
  ]);

it('the database refuses terms outside D14 (invalid_principal, invalid_rate, invalid_term)', async () => {
  expect(await insert(0, 1200, 6)).toBe('invalid_principal');
  expect(await insert(100000, -1, 6)).toBe('invalid_rate');
  expect(await insert(100000, 1200, 0)).toBe('invalid_term');
  expect(await insert(100000, 1200, 6)).toBe('accepted');
});

it('the database refuses UPDATE and DELETE of a loan (append_only): no refinancing in place', async () => {
  const { loanId } = await createLoan(client, L1);
  expect(await raw('UPDATE "Loan" SET "aprBps" = 900 WHERE "id" = $1', [loanId])).toBe('append_only');
  expect(await raw('DELETE FROM "Loan" WHERE "id" = $1', [loanId])).toBe('append_only');
});
