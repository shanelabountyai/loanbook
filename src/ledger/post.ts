// The posting service (task 1.6): the one write path for money. No other code inserts ledger rows;
// eslint.config.mjs makes that an error outside this file.
//
// Validates first (assertValidEntry, the service layer), then writes entry and lines in one
// transaction at one level, which the A3 trigger requires (see migration 20260929000000_ledger_init).
// The database's own checks run again at COMMIT. Date and memo go to the database unvalidated.

import type { ClientBase, DatabaseError } from 'pg';
import { assertValidEntry, EntryError, type EntryInput } from './entry';
import { readEntry } from './read';

type Db = Pick<ClientBase, 'query'>;
/** `kind: 'accrual'` puts the entry under the database's one-per-(loan, day) rule (D15); `kind: 'late_fee'` with its `installment`, one-per-(loan, installment) (D20). */
export type PostInput = EntryInput & { date: string; memo?: string | null; kind?: 'accrual' | 'late_fee' | null; installment?: number | null };

/**
 * Posts one entry and returns its id. Owns its transaction, so the caller's connection must not be
 * in one: a surrounding BEGIN would be committed here. Throws EntryError or MoneyError (match on
 * `.code`) before touching the database, or the database's error after rolling back.
 */
export function postEntry(db: Db, entry: PostInput): Promise<string> {
  return write(db, entry, null);
}

/**
 * Reverses a posted entry (task 1.8): a new entry on the given date, same loan, each line's sides
 * swapped, naming the original. The pair nets to zero. Throws EntryError `dangling_reversal` for an
 * unknown entry and `already_reversed` for a second reversal; the unique index decides the second,
 * so two reversals racing still leave one.
 */
export async function reverseEntry(db: Db, { entryId, date, memo }: { entryId: string; date: string; memo?: string | null }) {
  const original = await readEntry(db, entryId);
  if (!original) throw new EntryError('dangling_reversal');
  const lines = original.lines.map((l) => ({ account: l.account, debitCents: l.creditCents, creditCents: l.debitCents }));
  try {
    return await write(db, { date, memo, loanId: original.loanId, lines }, entryId);
  } catch (err) {
    if ((err as DatabaseError).constraint === 'already_reversed') throw new EntryError('already_reversed');
    throw err;
  }
}

async function write(db: Db, entry: PostInput, reversesEntryId: string | null): Promise<string> {
  assertValidEntry(entry);

  await db.query('BEGIN');
  try {
    const id = await insert(db, entry, reversesEntryId);
    await db.query('COMMIT');
    return id;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

/**
 * Posts one entry inside a transaction the caller already opened and will commit or roll back (D16).
 * For a read-then-post that must be atomic, e.g. a payment allocated against what is owed.
 */
export async function postEntryInTx(db: Db, entry: PostInput): Promise<string> {
  assertValidEntry(entry);
  return insert(db, entry, null);
}

async function insert(db: Db, entry: PostInput, reversesEntryId: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO "LedgerEntry" ("id", "date", "loanId", "memo", "reversesEntryId", "kind", "installment")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING "id"`,
    [entry.date, entry.loanId ?? null, entry.memo ?? null, reversesEntryId, entry.kind ?? null, entry.installment ?? null],
  );
  const id = rows[0]!.id;
  for (const [position, l] of entry.lines.entries()) {
    await db.query(
      `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [id, position, l.account, l.debitCents, l.creditCents],
    );
  }
  return id;
}
