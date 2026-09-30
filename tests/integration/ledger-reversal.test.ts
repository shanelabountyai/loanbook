import { afterAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import fixture from '../../fixtures/ledger/entry_validation.json';
import { trialBalance } from '@/ledger/balances';
import { postEntry, reverseEntry } from '@/ledger/post';
import { readEntry } from '@/ledger/read';

// Task 1.8: a correction is a reversing entry. The service builds it from the original, sides
// swapped; the pair nets to zero; a second reversal is refused. The database holds the same two
// rules on its own, for a writer that goes around the service.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry"');
});

const { original, reversing_entry: reversing, expected_balances_after_both: after } = fixture.reversal;
const lines = (ls: typeof original.lines) => ls.map((l) => ({ account: l.account, debitCents: l.debit, creditCents: l.credit }));
const post = () => postEntry(client, { date: original.date, loanId: original.loan_id, memo: original.memo, lines: lines(original.lines) });
const reverse = (entryId: string) => reverseEntry(client, { entryId, date: reversing.date, memo: reversing.memo });
const count = async () =>
  Number((await client.query<{ n: string }>('SELECT (SELECT count(*) FROM "LedgerEntry") + (SELECT count(*) FROM "LedgerLine") AS n')).rows[0]!.n);

it('the reversing entry is the fixture’s: sides swapped, same loan, naming the original', async () => {
  const id = await post();
  const x = await reverse(id);
  expect(await readEntry(client, x)).toStrictEqual({
    id: x,
    date: reversing.date,
    loanId: reversing.loan_id,
    memo: reversing.memo,
    reversesEntryId: id,
    lines: lines(reversing.lines),
  });
});

it('the pair nets to zero', async () => {
  await reverse(await post());
  const { balancesCents } = await trialBalance(client);
  expect(balancesCents).toMatchObject(after);
  expect(Object.values(balancesCents).every((c) => c === 0)).toBe(true);
});

it('a second reversal is refused as already_reversed and writes nothing', async () => {
  const id = await post();
  await reverse(id);
  const before = await count();
  await expect(reverse(id)).rejects.toMatchObject({ code: fixture.duplicate_reversal_rejected.error });
  expect(await count()).toBe(before);
});

it('two reversals racing leave one', async () => {
  const id = await post();
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  try {
    const results = await Promise.allSettled([reverse(id), reverseEntry(other, { entryId: id, date: reversing.date })]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'already_reversed' } });
  } finally {
    await other.end();
  }
});

it('reversing an entry that does not exist is refused as dangling_reversal and writes nothing', async () => {
  await expect(reverse(randomUUID())).rejects.toMatchObject({ code: 'dangling_reversal' });
  expect(await count()).toBe(0);
});

// Below the service: raw SQL, one transaction, as a writer that skipped reverseEntry would.
const rawReversal = async (reversesEntryId: string) => {
  await client.query('BEGIN');
  try {
    const id = randomUUID();
    await client.query('INSERT INTO "LedgerEntry" ("id", "date", "loanId", "reversesEntryId") VALUES ($1, $2, $3, $4)', [
      id,
      reversing.date,
      reversing.loan_id,
      reversesEntryId,
    ]);
    for (const [position, l] of reversing.lines.entries()) {
      await client.query(
        `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [id, position, l.account, l.debit, l.credit],
      );
    }
    await client.query('COMMIT');
    return 'accepted';
  } catch (err) {
    await client.query('ROLLBACK');
    return (err as pg.DatabaseError).constraint;
  }
};

it('the database refuses a second reversal of one entry (already_reversed)', async () => {
  const id = await post();
  expect(await rawReversal(id)).toBe('accepted');
  expect(await rawReversal(id)).toBe('already_reversed');
});

it('the database refuses a reversal of an entry that does not exist (dangling_reversal)', async () => {
  expect(await rawReversal(randomUUID())).toBe('dangling_reversal');
});
