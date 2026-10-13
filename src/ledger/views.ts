// Servicing views (task 4.4, PRD P0-7). Reads only, nothing stored: balances from trialBalance/owedCents,
// state from loanStatus, the schedule rebuilt from the loan's terms (D3), payments and their split from the
// ledger lines. Every amount crosses into JavaScript through centsFromNumeric.

import type { ClientBase } from 'pg';
import type { AccountName } from './accounts';
import { trialBalance } from './balances';
import { DELINQUENCY_BANDS, type LoanState } from './config';
import { loanStatus, type LoanStatus } from './delinquency';
import { EntryError } from './entry';
import { centsFromNumeric, formatCents } from './money';
import { owedCents } from './owed';
import { buildSchedule, type ScheduleRow, type ScheduleTerms } from './schedule';
import type { Buckets } from './waterfall';

type Db = Pick<ClientBase, 'query'>;

export type LedgerRow = { entryId: string; date: string; memo: string | null; account: AccountName; debitCents: number; creditCents: number; kind: string | null; reversesEntryId: string | null };
export type StatementPayment = { entryId: string; date: string; cents: number; split: Buckets };
export type ScheduleActual = ScheduleRow & { coveredCents: number };

/** Every line posted for the loan, oldest entry first, lines in posting order. */
export async function loanLedger(db: Db, loanId: string): Promise<LedgerRow[]> {
  const { rows } = await db.query<{ entryId: string; date: string; memo: string | null; account: AccountName; debit: string; credit: string; kind: string | null; reversesEntryId: string | null }>(
    `SELECT e."id" AS "entryId", e."date"::text AS date, e."memo", e."kind", e."reversesEntryId", l."account", l."debitCents"::text AS debit, l."creditCents"::text AS credit
       FROM "LedgerEntry" e JOIN "LedgerLine" l ON l."entryId" = e."id"
      WHERE e."loanId" = $1 ORDER BY e."date", e."createdAt", e."id", l."position"`,
    [loanId],
  );
  return rows.map((r) => ({ ...r, debitCents: centsFromNumeric(r.debit), creditCents: centsFromNumeric(r.credit) }));
}

export type LedgerItem = { type: 'line'; row: LedgerRow } | { type: 'fold'; from: string; to: string; days: number; cents: number; rows: LedgerRow[] };

/** Display only: consecutive daily accrual entries (two or more) become one fold; the lines inside are untouched. */
export function foldLedger(lines: readonly LedgerRow[]): LedgerItem[] {
  const out: LedgerItem[] = [];
  let run: LedgerRow[] = [];
  const flush = () => {
    const ids = new Set(run.map((r) => r.entryId));
    if (ids.size >= 2) out.push({ type: 'fold', from: run[0]!.date, to: run[run.length - 1]!.date, days: ids.size, cents: run.filter((r) => r.account === 'interest_receivable').reduce((a, r) => a + r.debitCents, 0), rows: run });
    else run.forEach((row) => out.push({ type: 'line', row }));
    run = [];
  };
  for (const l of lines) {
    if (l.kind === 'accrual') run.push(l);
    else { flush(); out.push({ type: 'line', row: l }); }
  }
  flush();
  return out;
}

const BUCKET_OF: Partial<Record<AccountName, keyof Buckets>> = { fees_receivable: 'fees', interest_receivable: 'interest', loans_receivable: 'principal' };

/** A payment is an entry with a Dr cash line; its split is that entry's credits to the receivables. */
export function paymentsFrom(lines: readonly LedgerRow[]): StatementPayment[] {
  const out = new Map<string, StatementPayment>();
  for (const l of lines) if (l.account === 'cash' && l.debitCents > 0) out.set(l.entryId, { entryId: l.entryId, date: l.date, cents: l.debitCents, split: { fees: 0, interest: 0, principal: 0 } });
  for (const l of lines) {
    const p = out.get(l.entryId);
    const bucket = BUCKET_OF[l.account];
    if (p && bucket) p.split[bucket] += l.creditCents;
  }
  return [...out.values()];
}

/** D19's cumulative cover: cash received fills installments oldest first; each row shows how much of it is covered. */
export function scheduleActuals(rows: readonly ScheduleRow[], paidCents: number): ScheduleActual[] {
  let before = 0;
  return rows.map((r) => {
    const coveredCents = Math.min(r.paymentCents, Math.max(0, paidCents - before));
    before += r.paymentCents;
    return { ...r, coveredCents };
  });
}

async function loanTerms(db: Db, loanId: string): Promise<ScheduleTerms> {
  const { rows } = await db.query<ScheduleTerms>(
    'SELECT "principalCents", "aprBps", "termMonths", "disbursementDate"::text AS "disbursementDate" FROM "Loan" WHERE "id" = $1',
    [loanId],
  );
  if (!rows[0]) throw new EntryError('unknown_loan');
  return rows[0];
}

export type LoanDetail = { loanId: string; terms: ScheduleTerms; status: LoanStatus; owed: Buckets; schedule: ScheduleActual[]; ledger: LedgerRow[] };

/** Servicer's view of one loan as of `asOf`: schedule against cash received through `asOf`, every ledger line, state. */
export async function loanDetail(db: Db, { loanId, asOf }: { loanId: string; asOf: string }): Promise<LoanDetail> {
  const terms = await loanTerms(db, loanId);
  const status = await loanStatus(db, { loanId, asOf });
  const ledger = await loanLedger(db, loanId);
  const paid = paymentsFrom(ledger).filter((p) => p.date <= asOf).reduce((sum, p) => sum + p.cents, 0);
  return { loanId, terms, status, owed: await owedCents(db, loanId), schedule: scheduleActuals(buildSchedule(terms).rows, paid), ledger };
}

/**
 * The oldest installment cash has not covered (D19's cumulative cover) and what is left of it; null once nothing is owed (paid off, or written off).
 * D27: every printed row covered and money still owed is the final installment unpaid: its due date, and all that is owed (D9).
 */
export function nextDue(d: Pick<LoanDetail, 'schedule' | 'owed'>): { dueDate: string; cents: number } | null {
  if (d.owed.fees + d.owed.interest + d.owed.principal === 0) return null;
  const row = d.schedule.find((r) => r.coveredCents < r.paymentCents);
  if (row) return { dueDate: row.dueDate, cents: row.paymentCents - row.coveredCents };
  const last = d.schedule.at(-1);
  return last ? { dueDate: last.dueDate, cents: d.owed.fees + d.owed.interest + d.owed.principal } : null;
}

export type Statement = { loanId: string; payments: StatementPayment[]; owed: Buckets };

/** Borrower's statement: each payment with its split, and what is owed now. */
export async function loanStatement(db: Db, loanId: string): Promise<Statement> {
  await loanTerms(db, loanId);
  return { loanId, payments: paymentsFrom(await loanLedger(db, loanId)), owed: await owedCents(db, loanId) };
}

/**
 * The loan's life as text, from its ledger lines alone (task 4.5, D22): entries through `asOf` in posting order,
 * runs of accrual entries folded into one line, then what is owed on `asOf` as the receivables' sums.
 */
export function statementText(lines: readonly LedgerRow[], asOf: string): string[] {
  const entries = new Map<string, LedgerRow[]>();
  for (const l of lines) if (l.date <= asOf) entries.set(l.entryId, [...(entries.get(l.entryId) ?? []), l]);
  const owed: Buckets = { fees: 0, interest: 0, principal: 0 };
  const out: string[] = [];
  let run = null as { from: string; to: string; cents: number } | null;
  const flush = () => {
    if (run) out.push(`${run.from} to ${run.to} Interest accrued ${formatCents(run.cents)}`);
    run = null;
  };
  for (const e of entries.values()) {
    for (const l of e) {
      const bucket = BUCKET_OF[l.account];
      if (bucket) owed[bucket] += l.debitCents - l.creditCents;
    }
    const dr = (a: AccountName) => e.find((l) => l.account === a && l.debitCents > 0)?.debitCents;
    const date = e[0]!.date;
    const accrued = dr('interest_receivable');
    if (accrued !== undefined) {
      run = run ? { ...run, to: date, cents: run.cents + accrued } : { from: date, to: date, cents: accrued };
      continue;
    }
    flush();
    const paid = paymentsFrom(e)[0];
    if (paid) out.push(`${date} Payment ${formatCents(paid.cents)}: fees ${formatCents(paid.split.fees)}, interest ${formatCents(paid.split.interest)}, principal ${formatCents(paid.split.principal)}`);
    else if (dr('loans_receivable') !== undefined) out.push(`${date} Disbursed ${formatCents(dr('loans_receivable')!)}`);
    else if (dr('fees_receivable') !== undefined) out.push(`${date} Late fee ${formatCents(dr('fees_receivable')!)}`);
    else out.push(`${date} ${e[0]!.memo ?? 'Entry'}`);
  }
  flush();
  out.push(`${asOf} Owed ${formatCents(owed.fees + owed.interest + owed.principal)}: fees ${formatCents(owed.fees)}, interest ${formatCents(owed.interest)}, principal ${formatCents(owed.principal)}`);
  return out;
}

export type BookLoan = { loanId: string; state: LoanState; dpd: number; outstandingCents: number; owed: Buckets };
export type Book = { asOf: string; loans: BookLoan[]; outstanding: Buckets; buckets: { state: LoanState; count: number; outstandingCents: number }[] };

/**
 * Portfolio for the given loans: outstanding from one trial balance, and the loans counted into the D18 bands, then written_off (D25).
 * ponytail: one loanStatus per loan (N snapshots); one query over the book if it grows past a few hundred loans.
 */
export async function bookOverview(db: Db, { loanIds, asOf }: { loanIds: readonly string[]; asOf: string }): Promise<Book> {
  const { perLoanCents } = await trialBalance(db);
  const outstanding: Buckets = { fees: 0, interest: 0, principal: 0 };
  const loans: BookLoan[] = [];
  for (const loanId of loanIds) {
    const r = perLoanCents[loanId];
    const owed = { fees: r?.fees_receivable ?? 0, interest: r?.interest_receivable ?? 0, principal: r?.loans_receivable ?? 0 };
    outstanding.fees += owed.fees;
    outstanding.interest += owed.interest;
    outstanding.principal += owed.principal;
    const s = await loanStatus(db, { loanId, asOf });
    loans.push({ loanId, state: s.state, dpd: s.dpd, outstandingCents: owed.fees + owed.interest + owed.principal, owed });
  }
  const states: LoanState[] = [...DELINQUENCY_BANDS.map((b) => b.state), 'written_off'];
  const buckets = states.map((state) => {
    const inBand = loans.filter((l) => l.state === state);
    return { state, count: inBand.length, outstandingCents: inBand.reduce((sum, l) => sum + l.outstandingCents, 0) };
  });
  return { asOf, loans, outstanding, buckets };
}
