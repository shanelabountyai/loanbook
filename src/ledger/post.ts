// The posting service (task 1.6): the one write path for money. No other code inserts ledger rows;
// eslint.config.mjs makes that an error outside this file.
//
// Validates first (assertValidEntry, the service layer), then writes entry and lines in one
// transaction at one level, which the A3 trigger requires (see migration 20260929000000_ledger_init).
// The database's own checks run again at COMMIT. Date and memo go to the database unvalidated.

import type { ClientBase } from 'pg';
import { assertValidEntry, type EntryInput } from './entry';

export type PostInput = EntryInput & { date: string; memo?: string | null };

/**
 * Posts one entry and returns its id. Owns its transaction, so the caller's connection must not be
 * in one: a surrounding BEGIN would be committed here. Throws EntryError or MoneyError (match on
 * `.code`) before touching the database, or the database's error after rolling back.
 */
export async function postEntry(db: Pick<ClientBase, 'query'>, entry: PostInput): Promise<string> {
  assertValidEntry(entry);

  await db.query('BEGIN');
  try {
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO "LedgerEntry" ("id", "date", "loanId", "memo") VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"',
      [entry.date, entry.loanId ?? null, entry.memo ?? null],
    );
    const id = rows[0]!.id;
    for (const [position, l] of entry.lines.entries()) {
      await db.query(
        `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [id, position, l.account, l.debitCents, l.creditCents],
      );
    }
    await db.query('COMMIT');
    return id;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
