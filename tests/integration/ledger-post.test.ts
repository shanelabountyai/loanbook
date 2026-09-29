import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import fixture from '../../fixtures/ledger/entry_validation.json';
import { postEntry } from '@/ledger/post';
import { readEntry } from '@/ledger/read';

// Task 1.6: the posting service is the one write path. V1-V3 are accepted and read back exactly;
// I1-I9 are refused with the fixture's code and leave nothing behind; a failure mid-write rolls back.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry"');
});

type FixtureEntry = (typeof fixture.valid)[number]['entry'] | (typeof fixture.invalid)[number]['entry'];
const input = (e: FixtureEntry) => ({
  date: e.date,
  loanId: e.loan_id,
  memo: 'memo' in e ? e.memo : null,
  lines: e.lines.map((l) => ({ account: l.account, debitCents: l.debit, creditCents: l.credit })),
});
const count = async () =>
  (await client.query<{ n: number }>('SELECT (SELECT count(*) FROM "LedgerEntry") + (SELECT count(*) FROM "LedgerLine") AS n')).rows[0]!.n;

it.each(fixture.valid.map((c) => [c.id, c.entry] as const))('%s is posted and reads back identically', async (_, e) => {
  const id = await postEntry(client, input(e));
  expect(await readEntry(client, id)).toStrictEqual({ id, ...input(e) });
});

it.each(fixture.invalid.map((c) => [c.id, c.error, c.entry] as const))('%s is refused as %s and writes nothing', async (_, code, e) => {
  await expect(postEntry(client, input(e))).rejects.toMatchObject({ code });
  expect(Number(await count())).toBe(0);
});

it('a failure after the entry is written rolls the whole entry back', async () => {
  let lines = 0;
  const failing = {
    query: (sql: string, values?: unknown[]) => {
      if (sql.includes('"LedgerLine"') && ++lines === 2) return Promise.reject(new Error('connection lost'));
      return client.query(sql, values);
    },
  } as unknown as pg.ClientBase;
  await expect(postEntry(failing, input(fixture.valid[0]!.entry))).rejects.toThrow('connection lost');
  expect(Number(await count())).toBe(0);
  // and the connection is left usable, not stuck in an aborted transaction
  expect((await client.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
});
