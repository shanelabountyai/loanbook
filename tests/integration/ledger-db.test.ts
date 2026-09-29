import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import fixture from '../../fixtures/ledger/entry_validation.json';
import { CHART } from '@/ledger/accounts';

// Task 1.5: the database refuses what the service refuses, with the same code. Everything here is
// raw SQL on its own connection, so nothing in src/ledger can catch a case first. Amounts are
// written into the SQL text as literals, not bound: that is the path an integer column rounds (D12).

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('ROLLBACK');
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry"'); // row triggers do not fire on TRUNCATE
});

type Line = { account: string; debit: number; credit: number };
type Entry = { date: string; loan_id: string | null; memo?: string; lines: Line[] };

const insertEntry = async (e: Pick<Entry, 'date' | 'loan_id' | 'memo'>) => {
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO "LedgerEntry" ("id", "date", "loanId", "memo") VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"',
    [e.date, e.loan_id, e.memo ?? null],
  );
  return rows[0]!.id;
};

const insertLine = (entryId: string, position: number, l: Line) =>
  client.query(
    `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
     VALUES (gen_random_uuid(), $1, $2, $3, ${l.debit}, ${l.credit})`,
    [entryId, position, l.account],
  );

/** One transaction per entry. Returns the fixture code the database refused it with, or 'accepted'. */
const post = async (e: Entry, inside?: (entryId: string) => Promise<unknown>) => {
  try {
    await client.query('BEGIN');
    const id = await insertEntry(e);
    for (const [i, l] of e.lines.entries()) await insertLine(id, i, l);
    await inside?.(id);
    await client.query('COMMIT');
    return 'accepted';
  } catch (err) {
    await client.query('ROLLBACK');
    return rejection(err);
  }
};

const rejection = (err: unknown) => {
  const constraint = (err as pg.DatabaseError).constraint;
  if (!constraint) throw err;
  return constraint;
};

const refused = async (sql: string, params: unknown[] = []) => {
  try {
    await client.query(sql, params);
  } catch (err) {
    return rejection(err);
  }
  return 'accepted';
};

const count = async (table: 'LedgerEntry' | 'LedgerLine') =>
  Number((await client.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n);

const V1 = fixture.valid[0]!.entry;
const line = (account: string, debit: number, credit: number): Line => ({ account, debit, credit });

describe('ledger tables refuse invalid entries (entry_validation.json)', () => {
  it.each(fixture.valid.map((c) => [c.id, c.note, c.entry] as const))('accepts %s: %s', async (_id, _note, entry) => {
    expect(await post(entry)).toBe('accepted');
    expect(await count('LedgerEntry')).toBe(1);
    expect(await count('LedgerLine')).toBe(entry.lines.length);
  });

  it.each(fixture.invalid.map((c) => [c.id, c.error, c.note, c.entry] as const))(
    'refuses %s as %s: %s',
    async (_id, error, _note, entry) => {
      expect(await post(entry)).toBe(error);
      expect(await count('LedgerEntry')).toBe(0);
      expect(await count('LedgerLine')).toBe(0);
    },
  );

  it('refuses a float however it arrives, and stores nothing rounded (D12)', async () => {
    const entry = { ...V1, lines: [line('cash', 10, 0), line('lender_capital', 0, 10)] };
    for (const amount of ['10.5', '10.5::float8', '10.4::numeric', "'10.5'"]) {
      const code = await post(entry, (id) =>
        client.query(
          `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
           VALUES (gen_random_uuid(), $1, 2, 'cash', ${amount}, 0)`,
          [id],
        ),
      );
      expect([amount, code]).toEqual([amount, 'non_integer_amount']);
    }
    expect(await post({ ...V1, lines: [line('cash', 10.5, 0), line('lender_capital', 0, 10.5)] })).toBe('non_integer_amount');
    expect(await count('LedgerLine')).toBe(0);
  });

  it('refuses an amount past the safe integer range, as assertCents does (D11)', async () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(await post({ ...V1, lines: [line('cash', big, 0), line('lender_capital', 0, big)] })).toBe('accepted');
    const code = await post(V1, (id) =>
      client.query(
        `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
         VALUES (gen_random_uuid(), $1, 2, 'cash', 9007199254740992, 0)`,
        [id],
      ),
    );
    expect(code).toBe('non_integer_amount');
  });

  it('SET CONSTRAINTS IMMEDIATE cannot slip an unbalanced line in after the check has run', async () => {
    const code = await post(V1, async (id) => {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await insertLine(id, 2, line('cash', 1, 0));
    });
    expect(code).toBe('unbalanced');
    expect(await count('LedgerEntry')).toBe(0);
  });
});

// The account list and the loan-id rule are written out in the migration. This holds both to the chart in code.
describe('the chart in the database is the chart in code (D8)', () => {
  it.each(Object.entries(CHART))('%s', async (account, { normal, requiresLoanId }) => {
    const other = account === 'cash' ? 'lender_capital' : 'cash';
    const lines =
      normal === 'debit' ? [line(account, 100, 0), line(other, 0, 100)] : [line(other, 100, 0), line(account, 0, 100)];
    expect(await post({ ...V1, loan_id: 'L1', lines })).toBe('accepted');
    expect(await post({ ...V1, loan_id: null, lines })).toBe(requiresLoanId ? 'missing_loan_id' : 'accepted');
    expect(await post({ ...V1, loan_id: '', lines })).toBe(requiresLoanId ? 'missing_loan_id' : 'accepted');
  });
});

describe('ledger tables are append-only (A1 to A3)', () => {
  let entryId: string;
  beforeEach(async () => {
    expect(await post(V1)).toBe('accepted');
    entryId = (await client.query<{ id: string }>('SELECT "id" FROM "LedgerEntry"')).rows[0]!.id;
  });

  it('covers every case in the fixture', () => {
    expect(fixture.append_only.map((c) => [c.id, c.action, c.expect])).toEqual([
      ['A1', 'update_entry_line', 'rejected'],
      ['A2', 'delete_entry', 'rejected'],
      ['A3', 'insert_line_into_existing_entry', 'rejected'],
    ]);
  });

  it('A1: a line cannot be updated, nor an entry', async () => {
    expect(await refused('UPDATE "LedgerLine" SET "debitCents" = "debitCents"')).toBe('append_only');
    expect(await refused(`UPDATE "LedgerLine" SET "account" = 'cash'`)).toBe('append_only');
    expect(await refused(`UPDATE "LedgerEntry" SET "memo" = 'edited'`)).toBe('append_only');
  });

  it('A2: an entry cannot be deleted, nor a line', async () => {
    expect(await refused('DELETE FROM "LedgerEntry"')).toBe('append_only');
    expect(await refused('DELETE FROM "LedgerLine"')).toBe('append_only');
    expect(await count('LedgerEntry')).toBe(1);
    expect(await count('LedgerLine')).toBe(2);
  });

  it('A3: a line cannot join an entry from an earlier transaction, even a balanced pair', async () => {
    await client.query('BEGIN');
    expect(await refused(insertLineSql, [entryId, 2, 'cash', 100, 0])).toBe('append_only');
    await client.query('ROLLBACK');
    expect(await refused(insertLineSql, [entryId, 2, 'cash', 100, 0])).toBe('append_only'); // autocommit
    expect(await count('LedgerLine')).toBe(2);
  });
});

const insertLineSql = `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
  VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`;
