// Delinquency status (task 4.2, D18/D19, D23), late fees (D20), fee waivers (D24) and write-offs (D25): pure functions of the schedule, the cash received and the date.
// Nothing is stored; the state is recomputed from the ledger and the loan's terms on every read.

import type { ClientBase } from 'pg';
import type { DatabaseError } from 'pg';
import { addDays, assertDate, daysBetween } from './calendar';
import { DELINQUENCY_BANDS, GRACE_EXIT_DPD, LATE_FEE_CENTS, type LoanState } from './config';
import { EntryError } from './entry';
import { formatCents } from './money';
import { accrualDue } from './accrue';
import { owedCents } from './owed';
import { postEntry, postEntryInTx, reverseEntryInTx } from './post';
import { readEntry } from './read';
import { buildSchedule } from './schedule';
import type { Buckets } from './waterfall';

export type Installment = { dueDate: string; paymentCents: number };
export type Payment = { date: string; cents: number };

/**
 * D19: days since the due date of the oldest installment not yet covered by cumulative payments received
 * through `asOf`. An installment is past due from the day after its due date; none past due and unpaid is 0.
 * D27: the final installment is the payoff (D9), so with `owesPrincipal` it stays unsatisfied whatever cash covered.
 */
export function dpd(schedule: readonly Installment[], payments: readonly Payment[], asOf: string, owesPrincipal = false): number {
  const paid = payments.filter((p) => p.date <= asOf).reduce((sum, p) => sum + p.cents, 0);
  let due = 0;
  for (const row of schedule) {
    due += row.paymentCents;
    if (due > paid && row.dueDate < asOf) return daysBetween(row.dueDate, asOf);
    if (due > paid) return 0; // oldest unsatisfied is not past due yet, and later ones are due later
  }
  const last = schedule.at(-1);
  return owesPrincipal && last && last.dueDate < asOf ? daysBetween(last.dueDate, asOf) : 0;
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

/** Principal (loans_receivable) still owed through `date`. */
function principalBy(days: readonly DayTotals[], date: string): number {
  return days.filter((d) => d.date <= date).reduce((sum, d) => sum + d.principalCents, 0);
}

/** D23: a loan whose principal is repaid through `date` is closed: DPD 0 and no late fee, whatever the schedule says. */
function closedBy(days: readonly DayTotals[], date: string): boolean {
  return principalBy(days, date) === 0;
}

export type LoanStatus = { loanId: string; asOf: string; dpd: number; state: LoanState };

/** Cash received (Dr cash lines) and the schedule rebuilt from the loan's terms, in one read-only snapshot. */
export async function loanStatus(db: Pick<ClientBase, 'query'>, { loanId, asOf }: { loanId: string; asOf: string }): Promise<LoanStatus> {
  assertDate(asOf);
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    return await statusIn(db, loanId, asOf);
  } finally {
    await db.query('ROLLBACK');
  }
}

/** `loanStatus` inside a transaction the caller owns. D25: from its write-off date a loan is `written_off`, DPD as of that date. */
async function statusIn(db: Pick<ClientBase, 'query'>, loanId: string, asOf: string): Promise<LoanStatus> {
  const { rows: loans } = await db.query<{ principalCents: number; aprBps: number; termMonths: number; disbursementDate: string }>(
    'SELECT "principalCents", "aprBps", "termMonths", "disbursementDate"::text AS "disbursementDate" FROM "Loan" WHERE "id" = $1',
    [loanId],
  );
  if (!loans[0]) throw new EntryError('unknown_loan');
  const { rows: wo } = await db.query<{ date: string }>(
    `SELECT "date"::text AS date FROM "LedgerEntry" WHERE "loanId" = $1 AND "kind" = 'write_off' AND "date" <= $2`,
    [loanId, asOf],
  );
  const byDate = await ledgerByDate(db, loanId);
  const schedule = buildSchedule(loans[0]).rows;
  // a written-off loan owed principal until the write-off entry itself (writeOff refuses any state but default)
  if (wo[0]) return { loanId, asOf, dpd: dpd(schedule, byDate.filter((r) => r.date <= wo[0]!.date), wo[0].date, true), state: 'written_off' };
  const days = closedBy(byDate, asOf) ? 0 : dpd(schedule, byDate.filter((r) => r.date <= asOf), asOf, principalBy(byDate, asOf) > 0);
  return { loanId, asOf, dpd: days, state: stateFromDpd(days) };
}

export type FeeAssessed = { loanId: string; installment: number; date: string; cents: number; entryId: string };

/**
 * Late-fee job (D19, D20): for every loan, one `LATE_FEE_CENTS` fee per installment still unsatisfied (cumulative
 * cash short of cumulative scheduled, or for the final one principal still owed, D27) on the day its DPD reaches `GRACE_EXIT_DPD`, dated that day: Dr fees_receivable /
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
    const rows = buildSchedule(loan).rows;
    for (const row of rows) {
      dueCents += row.paymentCents;
      const date = addDays(row.dueDate, GRACE_EXIT_DPD);
      if (date > asOf || assessed.has(row.n) || closedBy(cash, date)) continue;
      const paid = cash.filter((c) => c.date <= date).reduce((sum, c) => sum + c.cents, 0);
      if (paid >= dueCents && !(row === rows.at(-1) && principalBy(cash, date) > 0)) continue;
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

export type FeeWaived = { loanId: string; installment: number; feeEntryId: string; entryId: string; cents: number };

/**
 * D24: waives a late fee by reversing its entry, with a reason. Under the D16 row lock on the loan, refuses a fee
 * already reversed, and one the loan's pooled fees_receivable would not cover on the waiver date or any later posted
 * date. The fee entry stays, so its installment stays assessed and `runStatus` never charges it again.
 */
export async function waiveFee(db: Pick<ClientBase, 'query'>, { entryId, date, reason }: { entryId: string; date: string; reason: string }): Promise<FeeWaived> {
  assertDate(date);
  const why = reason.trim();
  if (!why) throw new EntryError('reason_required');
  const fee = await readEntry(db, entryId);
  if (!fee) throw new EntryError('dangling_reversal');
  const { rows } = await db.query<{ kind: string | null; installment: number | null }>('SELECT "kind", "installment" FROM "LedgerEntry" WHERE "id" = $1', [entryId]);
  if (rows[0]!.kind !== 'late_fee') throw new EntryError('not_a_fee');
  if (date < fee.date) throw new EntryError('before_fee');
  const loanId = fee.loanId!;
  const installment = rows[0]!.installment!;
  const cents = fee.lines.find((l) => l.account === 'fees_receivable')!.debitCents;

  await db.query('BEGIN');
  try {
    await db.query('SELECT 1 FROM "Loan" WHERE "id" = $1 FOR UPDATE', [loanId]);
    const { rowCount } = await db.query('SELECT 1 FROM "LedgerEntry" WHERE "reversesEntryId" = $1', [entryId]);
    if (rowCount) throw new EntryError('already_reversed');
    // running fees_receivable per date (the window's default frame takes a date's peers together) with the waiver in it
    const { rows: pool } = await db.query<{ covered: boolean }>(
      `SELECT coalesce(min(bal) >= 0, true) AS covered FROM (
         SELECT d, sum(delta) OVER (ORDER BY d) AS bal FROM (
           SELECT e."date" AS d, l."debitCents" - l."creditCents" AS delta
             FROM "LedgerLine" l JOIN "LedgerEntry" e ON e."id" = l."entryId"
            WHERE e."loanId" = $1 AND l."account" = 'fees_receivable'
           UNION ALL SELECT $2::date, -$3::numeric) x) y
        WHERE d >= $2::date`,
      [loanId, date, cents],
    );
    if (!pool[0]!.covered) throw new EntryError('fee_paid');
    const id = await reverseEntryInTx(db, fee, { date, memo: `Fee waived ${formatCents(cents)} (installment ${installment}): ${why}` });
    await db.query('COMMIT');
    return { loanId, installment, feeEntryId: entryId, entryId: id, cents };
  } catch (err) {
    await db.query('ROLLBACK');
    if ((err as DatabaseError).constraint === 'already_reversed') throw new EntryError('already_reversed');
    throw err;
  }
}

export type WrittenOff = { loanId: string; date: string; entryId: string; writtenOff: Buckets };

/**
 * D25: writes off a defaulted loan in one entry, with a reason: principal Dr write_offs, unpaid interest and fees
 * back out of their income, every receivable to zero. Under the D16 row lock, refuses a second write-off, one dated
 * before an entry already posted, one ahead of the accrual run, and a loan not `default_recommended` on `date`.
 */
export async function writeOff(db: Pick<ClientBase, 'query'>, { loanId, date, reason }: { loanId: string; date: string; reason: string }): Promise<WrittenOff> {
  assertDate(date);
  const why = reason.trim();
  if (!why) throw new EntryError('reason_required');
  await db.query('BEGIN');
  try {
    const { rowCount } = await db.query('SELECT 1 FROM "Loan" WHERE "id" = $1 FOR UPDATE', [loanId]);
    if (!rowCount) throw new EntryError('unknown_loan');
    const { rows } = await db.query<{ done: boolean | null; later: boolean | null }>(
      `SELECT bool_or("kind" = 'write_off') AS done, bool_or("date" > $2::date) AS later FROM "LedgerEntry" WHERE "loanId" = $1`,
      [loanId, date],
    );
    if (rows[0]!.done) throw new EntryError('already_written_off');
    if (rows[0]!.later) throw new EntryError('backdated');
    if ((await accrualDue(db, loanId, date)).length > 0) throw new EntryError('accrual_pending');
    if ((await statusIn(db, loanId, date)).state !== 'default_recommended') throw new EntryError('not_in_default');
    const owed = await owedCents(db, loanId);
    const pairs = [
      ['write_offs', 'loans_receivable', owed.principal],
      ['interest_income', 'interest_receivable', owed.interest],
      ['fees_income', 'fees_receivable', owed.fees],
    ] as const;
    const entryId = await postEntryInTx(db, {
      date,
      loanId,
      kind: 'write_off',
      memo: `Written off ${formatCents(owed.fees + owed.interest + owed.principal)}: ${why}`,
      lines: pairs
        .filter(([, , cents]) => cents > 0)
        .flatMap(([dr, cr, cents]) => [
          { account: dr, debitCents: cents, creditCents: 0 },
          { account: cr, debitCents: 0, creditCents: cents },
        ]),
    });
    await db.query('COMMIT');
    return { loanId, date, entryId, writtenOff: owed };
  } catch (err) {
    await db.query('ROLLBACK');
    if ((err as DatabaseError).constraint === 'already_written_off') throw new EntryError('already_written_off');
    throw err;
  }
}
