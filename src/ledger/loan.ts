// Loans (task 2.3). Terms are stored once; the schedule is rebuilt from them on read and never stored.
// The disbursement goes through postEntry like any other money.

import type { ClientBase } from 'pg';
import { postEntry } from './post';
import { buildSchedule, type ScheduleTerms } from './schedule';

type Db = Pick<ClientBase, 'query'>;

/**
 * Inserts the loan, then posts its disbursement (Dr loans_receivable / Cr cash, principal, on the
 * disbursement date). Terms that cannot make a schedule are refused first with buildSchedule's error,
 * so nothing is written. Two statements, not one transaction: if the posting fails the loan stays with
 * no receivable and accrues nothing. One transaction waits for Phase 3, which needs composed postings.
 */
export async function createLoan(db: Db, terms: ScheduleTerms): Promise<{ loanId: string; entryId: string }> {
  buildSchedule(terms);
  const { principalCents, aprBps, termMonths, disbursementDate } = terms;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO "Loan" ("id", "principalCents", "aprBps", "termMonths", "disbursementDate")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4) RETURNING "id"`,
    [principalCents, aprBps, termMonths, disbursementDate],
  );
  const loanId = rows[0]!.id;
  const entryId = await postEntry(db, {
    date: disbursementDate,
    loanId,
    memo: `Disburse ${loanId}`,
    lines: [
      { account: 'loans_receivable', debitCents: principalCents, creditCents: 0 },
      { account: 'cash', debitCents: 0, creditCents: principalCents },
    ],
  });
  return { loanId, entryId };
}
