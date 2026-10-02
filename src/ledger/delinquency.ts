// Delinquency status (task 4.2, D18/D19, D23): pure functions of the schedule, the cash received and the date.
// Nothing is stored; the state is recomputed from the ledger and the loan's terms on every read.

import type { ClientBase } from 'pg';
import type { DatabaseError } from 'pg';
import { addDays, assertDate, daysBetween } from './calendar';
import { DELINQUENCY_BANDS, GRACE_EXIT_DPD, LATE_FEE_CENTS, type LoanState } from './config';
import { EntryError } from './entry';
import { postEntry } from './post';
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

type DayTotals = Payment & { principalCents: number };

/** Per posting date for one loan: cash received (Dr cash) and the net change in principal (loans_receivable). */
async function ledgerByDate(db: Pick<ClientBase, 'query'>, loanId: string): Promise<DayTotals[]> {
  const { rows } = await db.query<{ date: string; cash: string; principal: string }>(
    `SELECT e."date"::text AS date,
            coalesce(sum(l."debitCents") FILTER (WHERE l."account" = 'cash'), 0)::text AS cash,
            coalesce(sum(l."debitCents" - l."creditCents") FILTER (WHERE l."account" = 'loans_receivable'), 0)::text AS principal
       FROM "LedgerLine" l JOIN "LedgerEntry" e ON e."id" = l."entryId"
      WHERE e."loanId" = $1 GROUP BY e."date"`,
    [loanId],
  );
  return rows.map((r) => ({ date: r.date, cents: Number(r.cash), principalCents: Number(r.principal) }));
}

/** D23: a loan whose principal is repaid through `date` is closed: DPD 0 and no late fee, whatever the schedule says. */
function closedBy(days: readonly DayTotals[], date: string): boolean {
  return days.filter((d) => d.date <= date).reduce((sum, d) => sum + d.principalCents, 0) === 0;
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
    const byDate = await ledgerByDate(db, loanId);
    const days = closedBy(byDate, asOf) ? 0 : dpd(buildSchedule(loans[0]).rows, byDate.filter((r) => r.date <= asOf), asOf);
    return { loanId, asOf, dpd: days, state: stateFromDpd(days) };
  } finally {
    await db.query('ROLLBACK');
  }
}

export type FeeAssessed = { loanId: string; installment: number; date: string; cents: number; entryId: string };

/**
 * Late-fee job (D19, D20): for every loan, one `LATE_FEE_CENTS` fee per installment still unsatisfied (cumulative
 * cash short of cumulative scheduled) on the day its DPD reaches `GRACE_EXIT_DPD`, dated that day: Dr fees_receivable /
 * Cr fees_income. Returns what it posted; a re-run posts nothing. The database keeps one fee per (loan, installment)
 * (`already_fee_assessed`), so a run that loses a race skips that installment: the winner posted it.
 */
export async function runStatus(db: Pick<ClientBase, 'query'>, { asOf }: { asOf: string }): Promise<FeeAssessed[]> {
  assertDate(asOf);
  const { rows: loans } = await db.query<{ id: string; principalCents: number; aprBps: number; termMonths: number; disbursementDate: string }>(
    'SELECT "id", "principalCents", "aprBps", "termMonths", "disbursementDate"::text AS "disbursementDate" FROM "Loan" ORDER BY "createdAt", "id"',
  );
  const out: FeeAssessed[] = [];
  for (const loan of loans) {
    const cash = await ledgerByDate(db, loan.id);
    const { rows: done } = await db.query<{ installment: number }>(
      `SELECT "installment" FROM "LedgerEntry" WHERE "loanId" = $1 AND "kind" = 'late_fee'`,
      [loan.id],
    );
    const assessed = new Set(done.map((r) => r.installment));
    let dueCents = 0;
    for (const row of buildSchedule(loan).rows) {
      dueCents += row.paymentCents;
      const date = addDays(row.dueDate, GRACE_EXIT_DPD);
      if (date > asOf || assessed.has(row.n) || closedBy(cash, date)) continue;
      const paid = cash.filter((c) => c.date <= date).reduce((sum, c) => sum + c.cents, 0);
      if (paid >= dueCents) continue;
      try {
        const entryId = await postEntry(db, {
          date,
          loanId: loan.id,
          kind: 'late_fee',
          installment: row.n,
          memo: `Late fee ${loan.id} installment ${row.n}`,
          lines: [
            { account: 'fees_receivable', debitCents: LATE_FEE_CENTS, creditCents: 0 },
            { account: 'fees_income', debitCents: 0, creditCents: LATE_FEE_CENTS },
          ],
        });
        out.push({ loanId: loan.id, installment: row.n, date, cents: LATE_FEE_CENTS, entryId });
      } catch (err) {
        if ((err as DatabaseError).constraint !== 'already_fee_assessed') throw err;
      }
    }
  }
  return out;
}
