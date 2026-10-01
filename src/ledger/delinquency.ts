// Delinquency status (task 4.2, D18/D19): pure functions of the schedule, the cash received and the date.
// Nothing is stored; the state is recomputed from the ledger and the loan's terms on every read.

import type { ClientBase } from 'pg';
import { assertDate, daysBetween } from './calendar';
import { DELINQUENCY_BANDS, type LoanState } from './config';
import { EntryError } from './entry';
import { buildSchedule } from './schedule';

export type Installment = { dueDate: string; paymentCents: number };
export type Payment = { date: string; cents: number };

/**
 * D19: days since the due date of the oldest installment not yet covered by cumulative payments received
 * through `asOf`. An installment is past due from the day after its due date; none past due and unpaid is 0.
 */
export function dpd(schedule: readonly Installment[], payments: readonly Payment[], asOf: string): number {
  const paid = payments.filter((p) => p.date <= asOf).reduce((sum, p) => sum + p.cents, 0);
  let due = 0;
  for (const row of schedule) {
    due += row.paymentCents;
    if (due > paid && row.dueDate < asOf) return daysBetween(row.dueDate, asOf);
    if (due > paid) return 0; // oldest unsatisfied is not past due yet, and later ones are due later
  }
  return 0;
}

export function stateFromDpd(days: number): LoanState {
  return DELINQUENCY_BANDS.reduce((s, b) => (days >= b.minDpd ? b.state : s), DELINQUENCY_BANDS[0]!.state);
}

export type LoanStatus = { loanId: string; asOf: string; dpd: number; state: LoanState };

/** Cash received (Dr cash lines) and the schedule rebuilt from the loan's terms, in one read-only snapshot. */
export async function loanStatus(db: Pick<ClientBase, 'query'>, { loanId, asOf }: { loanId: string; asOf: string }): Promise<LoanStatus> {
  assertDate(asOf);
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const { rows: loans } = await db.query<{ principalCents: number; aprBps: number; termMonths: number; disbursementDate: string }>(
      'SELECT "principalCents", "aprBps", "termMonths", "disbursementDate"::text AS "disbursementDate" FROM "Loan" WHERE "id" = $1',
      [loanId],
    );
    if (!loans[0]) throw new EntryError('unknown_loan');
    const { rows } = await db.query<{ date: string; cents: string }>(
      `SELECT e."date"::text AS date, sum(l."debitCents")::text AS cents
         FROM "LedgerLine" l JOIN "LedgerEntry" e ON e."id" = l."entryId"
        WHERE e."loanId" = $1 AND l."account" = 'cash' AND e."date" <= $2
        GROUP BY e."date"`,
      [loanId, asOf],
    );
    const days = dpd(buildSchedule(loans[0]).rows, rows.map((r) => ({ date: r.date, cents: Number(r.cents) })), asOf);
    return { loanId, asOf, dpd: days, state: stateFromDpd(days) };
  } finally {
    await db.query('ROLLBACK');
  }
}
