// Reading entries back (task 1.5b). Every amount comes through centsFromNumeric, the one read edge.

import type { ClientBase } from 'pg';
import { centsFromNumeric } from './money';

export type StoredEntry = {
  id: string;
  date: string; // YYYY-MM-DD, read as text so no time zone touches it
  loanId: string | null;
  memo: string | null;
  lines: { account: string; debitCents: number; creditCents: number }[];
};

export async function readEntry(db: Pick<ClientBase, 'query'>, id: string): Promise<StoredEntry | null> {
  const { rows } = await db.query<{
    date: string;
    loanId: string | null;
    memo: string | null;
    account: string | null;
    debit: string | null;
    credit: string | null;
  }>(
    `SELECT e."date"::text AS date, e."loanId", e."memo", l."account", l."debitCents"::text AS debit, l."creditCents"::text AS credit
       FROM "LedgerEntry" e LEFT JOIN "LedgerLine" l ON l."entryId" = e."id"
      WHERE e."id" = $1 ORDER BY l."position"`,
    [id],
  );
  const first = rows[0];
  if (!first) return null;
  return {
    id,
    date: first.date,
    loanId: first.loanId,
    memo: first.memo,
    lines: rows
      .filter((r) => r.account !== null)
      .map((r) => ({ account: r.account!, debitCents: centsFromNumeric(r.debit!), creditCents: centsFromNumeric(r.credit!) })),
  };
}
