// Pure date arithmetic on ISO `YYYY-MM-DD` strings, in UTC. Nothing here reads the clock (non-negotiable 6):
// every date comes in as an argument.

export type CalendarErrorCode = 'invalid_date' | 'invalid_count';

export class CalendarError extends Error {
  constructor(readonly code: CalendarErrorCode) {
    super(code);
  }
}

const MS_PER_DAY = 86_400_000;

/** A real calendar day as `YYYY-MM-DD`: strict format, and the day must exist (no 2026-02-30). */
export function assertDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CalendarError('invalid_date');
  const ms = Date.parse(value); // date-only ISO parses as UTC midnight, but rolls 02-30 over to 03-02
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new CalendarError('invalid_date');
  return value;
}

function assertCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new CalendarError('invalid_count');
  return value;
}

const toDate = (date: string) => new Date(Date.parse(assertDate(date)));
// A result outside four-digit years formats as `+010000-...` and is refused here.
const format = (d: Date) => assertDate(Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10));

export function addDays(date: string, days: number): string {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + assertCount(days));
  return format(d);
}

/** `to` minus `from`, in days: signed, and actual (Feb 29 counts). */
export function daysBetween(from: string, to: string): number {
  // Exact: both are UTC midnights, and UTC has no DST, so the difference is a whole number of days.
  return (toDate(to).getTime() - toDate(from).getTime()) / MS_PER_DAY;
}

/**
 * D3: the same day-of-month `months` later, clamped to that month's end. Always count from the original
 * date (due k = disbursement + k months), never chain: Jan 31 -> Feb 28 -> Mar 31, not Mar 28.
 */
export function addMonthsClamped(date: string, months: number): string {
  const d = toDate(date);
  const day = d.getUTCDate();
  // setUTCFullYear, not Date.UTC, which maps years 0-99 to 1900-1999. Overflowing months normalise.
  d.setUTCFullYear(d.getUTCFullYear(), d.getUTCMonth() + assertCount(months), 1);
  const monthEnd = new Date(d);
  monthEnd.setUTCFullYear(d.getUTCFullYear(), d.getUTCMonth() + 1, 0); // day 0 = last day of the month
  d.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return format(d);
}
