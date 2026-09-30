import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import fixture from '../../fixtures/ledger/entry_validation.json';
import { readEntry } from '@/ledger/read';

// Task 1.5b (PRD P0-1 bullet 3): V1, the $1,000 disbursement, reads back exactly as posted. No
// posting service yet (1.6), so it is written with raw SQL; the read goes through src/ledger.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry"');
});

const V1 = fixture.valid[0]!.entry;

it('V1 disbursement reads back identically', async () => {
  await client.query('BEGIN');
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO "LedgerEntry" ("id", "date", "loanId", "memo") VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"',
    [V1.date, V1.loan_id, V1.memo],
  );
  const id = rows[0]!.id;
  // Written in reverse, so the read-back order has to come from position, not insertion.
  for (const [position, l] of [...V1.lines.entries()].reverse()) {
    await client.query(
      `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [id, position, l.account, l.debit, l.credit],
    );
  }
  await client.query('COMMIT');

  expect(await readEntry(client, id)).toStrictEqual({
    id,
    date: V1.date,
    loanId: V1.loan_id,
    memo: V1.memo,
    reversesEntryId: null,
    lines: V1.lines.map((l) => ({ account: l.account, debitCents: l.debit, creditCents: l.credit })),
  });
});

it('an unknown entry reads as null', async () => {
  expect(await readEntry(client, '00000000-0000-0000-0000-000000000000')).toBeNull();
});
