import { describe, expect, it } from 'vitest';
import { accrueSegment, cumulativeInterestCents } from '@/ledger/accrual';
import { CalendarError, daysBetween } from '@/ledger/calendar';
import { MoneyError } from '@/ledger/money';
import AC1 from '../../fixtures/accrual/AC1_30day_month.json';
import AC2 from '../../fixtures/accrual/AC2_leap_year.json';
import AC3 from '../../fixtures/accrual/AC3_principal_change.json';
import AC4 from '../../fixtures/accrual/AC4_first_installment_period.json';

const rows = (entries: ReturnType<typeof accrueSegment>) =>
  entries.map((e) => ({
    date: e.date,
    day_number: e.dayNumber,
    cumulative_cents: e.cumulativeCents,
    entry_cents: e.entryCents,
  }));

const sum = (entries: ReturnType<typeof accrueSegment>) => entries.reduce((s, e) => s + e.entryCents, 0);

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MoneyError || e instanceof CalendarError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('accrueSegment: one principal segment, every day (D4, D5)', () => {
  it.each([AC1, AC2, AC4].map((f) => [f.id, f] as const))('%s', (_, f) => {
    const entries = accrueSegment({
      principalCents: f.input.principal_cents,
      aprBps: f.input.apr_bps,
      effectiveDate: f.input.principal_effective_date,
      days: f.input.days,
    });
    expect(rows(entries)).toEqual(f.expected.entries);
    expect(sum(entries)).toBe(f.expected.total_cents);
  });

  it('AC1: 986, not 30 daily roundings (990)', () => {
    expect(cumulativeInterestCents(100000, 1200, 30)).toBe(986);
    expect(30 * cumulativeInterestCents(100000, 1200, 1)).toBe(990);
  });

  it('AC4: accrued 1019 against the schedule 1000', () => {
    expect(cumulativeInterestCents(100000, 1200, 31)).toBe(AC4.expected.total_cents);
    expect(AC4.expected.schedule_interest_cents).toBe(1000);
  });

  it('AC2: 365 in a leap year, so 366 days is more than a year of interest', () => {
    expect(cumulativeInterestCents(100000, 1200, 365)).toBe(12000);
    expect(cumulativeInterestCents(100000, 1200, 366)).toBe(12033);
  });
});

describe('accrueSegment: AC3, two segments rounded separately', () => {
  it('329 + 592, every entry', () => {
    const segments = AC3.input.segments.map((s) =>
      accrueSegment({
        principalCents: s.principal_cents,
        aprBps: AC3.input.apr_bps,
        effectiveDate: s.principal_effective_date,
        days: daysBetween(s.principal_effective_date, s.through),
      }),
    );
    expect(segments.map(sum)).toEqual(AC3.expected.segment_totals_cents);
    expect(rows(segments.flat())).toEqual(AC3.expected.entries);
    expect(sum(segments.flat())).toBe(AC3.expected.total_cents);
  });
});

describe('accrual: boundary', () => {
  it('zero days, zero principal and zero rate accrue nothing', () => {
    expect(accrueSegment({ principalCents: 100000, aprBps: 1200, effectiveDate: '2026-01-15', days: 0 })).toEqual([]);
    expect(cumulativeInterestCents(0, 1200, 30)).toBe(0);
    expect(cumulativeInterestCents(100000, 0, 30)).toBe(0);
  });

  it.each([
    ['float principal', () => cumulativeInterestCents(100000.5, 1200, 1), 'non_integer_amount'],
    ['float rate', () => cumulativeInterestCents(100000, 1200.5, 1), 'non_integer_rate'],
    ['negative principal', () => cumulativeInterestCents(-1, 1200, 1), 'invalid_rounding_input'],
    ['negative rate', () => cumulativeInterestCents(100000, -1, 1), 'invalid_rounding_input'],
    ['negative days', () => cumulativeInterestCents(100000, 1200, -1), 'invalid_count'],
    ['fractional days', () => cumulativeInterestCents(100000, 1200, 1.5), 'invalid_count'],
    [
      'negative segment',
      () => accrueSegment({ principalCents: 1, aprBps: 1, effectiveDate: '2026-01-15', days: -1 }),
      'invalid_count',
    ],
    [
      'bad date',
      () => accrueSegment({ principalCents: 1, aprBps: 1, effectiveDate: '2026-02-30', days: 1 }),
      'invalid_date',
    ],
  ])('%s refused', (_, fn, expected) => {
    expect(code(fn)).toBe(expected);
  });
});

