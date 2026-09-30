// The accrual run (task 2.5, D6, D15). Everything it needs is read from the ledger, nothing is kept
// beside it: principal for day D is loans_receivable dated before D, the segment starts on the date of
// the last such line, and day D's entry is cumulative interest for the segment so far minus the accrual
// already posted in it (D5). So a skipped day, or one that rounded to 0, is caught up on the next run.

import type { ClientBase, DatabaseError } from 'pg';
import { cumulativeInterestCents } from './accrual';
import { addDays, assertDate, daysBetween } from './calendar';
import { centsFromNumeric } from './money';
import { postEntry } from './post';

type Db = Pick<ClientBase, 'query'>;
export type Accrued = { loanId: string; date: string; amountCents: number; entryId: string };

/**
 * Posts every missing accrual day through `asOf` for every loan, one entry per (loan, day):
 * Dr interest_receivable / Cr interest_income. Returns what it posted. Re-running a date posts nothing.
 * The database, not this code, keeps a day from being posted twice (already_accrued): a run that loses a
 * race stops on that loan, since the winner is posting it and the next run recomputes from the ledger.
 */
export async function runAccrual(db: Db, { asOf }: { asOf: string }): Promise<Accrued[]> {
  assertDate(asOf);
  const { rows: loans } = await db.query<{ id: string; aprBps: number }>('SELECT "id", "aprBps" FROM "Loan" ORDER BY "createdAt", "id"');
  const out: Accrued[] = [];
  for (const loan of loans) out.push(...(await accrueLoan(db, loan.id, loan.aprBps, asOf)));
  return out;
}

async function accrueLoan(db: Db, loanId: string, aprBps: number, asOf: string): Promise<Accrued[]> {
  // Principal changes by date. A line dated asOf takes effect the day after, so it is not read (D6).
  const { rows: changes } = await db.query<{ date: string; net: string }>(
    `SELECT e."date"::text AS date, sum(l."debitCents" - l."creditCents")::text AS net
       FROM "LedgerLine" l JOIN "LedgerEntry" e ON e."id" = l."entryId"
      WHERE e."loanId" = $1 AND l."account" = 'loans_receivable' AND e."date" < $2
      GROUP BY e."date" ORDER BY e."date"`,
    [loanId, asOf],
  );
  const { rows: accrued } = await db.query<{ date: string; cents: string }>(
    `SELECT e."date"::text AS date, sum(l."debitCents")::text AS cents
       FROM "LedgerLine" l JOIN "LedgerEntry" e ON e."id" = l."entryId"
      WHERE e."loanId" = $1 AND e."kind" = 'accrual' AND l."account" = 'interest_receivable' AND e."date" <= $2
      GROUP BY e."date"`,
    [loanId, asOf],
  );
  const posted = new Map(accrued.map((r) => [r.date, centsFromNumeric(r.cents)]));

  const out: Accrued[] = [];
  let next = 0;
  let principalCents = 0;
  let segmentStart = '';
  let segmentPostedCents = 0;
  // ponytail: walks every day since disbursement on each run; start from the last posted day if books get long.
  for (let date = changes[0] && addDays(changes[0].date, 1); date && date <= asOf; date = addDays(date, 1)) {
    while (next < changes.length && changes[next]!.date < date) {
      principalCents += centsFromNumeric(changes[next]!.net);
      segmentStart = changes[next]!.date;
      segmentPostedCents = 0;
      next++;
    }
    const already = posted.get(date);
    if (already !== undefined) {
      segmentPostedCents += already;
      continue;
    }
    if (principalCents <= 0) continue;
    const amountCents = cumulativeInterestCents(principalCents, aprBps, daysBetween(segmentStart, date)) - segmentPostedCents;
    if (amountCents === 0) continue; // an entry needs positive lines; the next day's difference carries it
    try {
      const entryId = await postEntry(db, {
        date,
        loanId,
        kind: 'accrual',
        memo: `Accrue ${loanId} ${date}`,
        lines: [
          { account: 'interest_receivable', debitCents: amountCents, creditCents: 0 },
          { account: 'interest_income', debitCents: 0, creditCents: amountCents },
        ],
      });
      out.push({ loanId, date, amountCents, entryId });
      segmentPostedCents += amountCents;
    } catch (err) {
      if ((err as DatabaseError).constraint === 'already_accrued') break;
      throw err;
    }
  }
  return out;
}
