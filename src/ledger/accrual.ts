// Accrual math (D4, D5): pure, no clock, no database. Task 2.5 posts what this computes.

import { CalendarError, addDays, assertDate } from './calendar';
import { assertBps, assertCents, roundHalfUp } from './money';

// Actual/365: a day is aprBps / (10000 × 365) of principal, in leap years too (D4).
const YEAR = 3_650_000n;

/**
 * D4 + D5: interest on `principalCents` for `days` days of one principal segment, simple, as one exact
 * fraction P·a·d / 3650000 rounded once. A segment's daily entries are differences of this, never roundings of
 * one day's interest, so a 30-day month is 986¢, not 30 × 33¢.
 */
export function cumulativeInterestCents(principalCents: number, aprBps: number, days: number): number {
  const p = BigInt(assertCents(principalCents));
  const a = BigInt(assertBps(aprBps));
  if (!Number.isSafeInteger(days) || days < 0) throw new CalendarError('invalid_count');
  return roundHalfUp(p * a * BigInt(days), YEAR);
}

export interface SegmentTerms {
  principalCents: number;
  aprBps: number;
  /** The date the principal took effect: day 1 of the segment is the day after (D6). */
  effectiveDate: string;
  days: number;
}

export interface AccrualDay {
  date: string;
  dayNumber: number;
  cumulativeCents: number;
  entryCents: number;
}

/** Every day of one segment. A principal change starts a new segment, which rounds on its own (D5, AC3). */
export function accrueSegment(terms: SegmentTerms): AccrualDay[] {
  const { principalCents, aprBps, days } = terms;
  const effectiveDate = assertDate(terms.effectiveDate);
  cumulativeInterestCents(principalCents, aprBps, days); // refuses bad input before a single day is built
  let previous = 0;
  const out: AccrualDay[] = [];
  for (let d = 1; d <= days; d++) {
    const cumulativeCents = cumulativeInterestCents(principalCents, aprBps, d);
    out.push({ date: addDays(effectiveDate, d), dayNumber: d, cumulativeCents, entryCents: cumulativeCents - previous });
    previous = cumulativeCents;
  }
  return out;
}
