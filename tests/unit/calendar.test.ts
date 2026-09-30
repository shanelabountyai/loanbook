import { describe, expect, it } from 'vitest';
import { CalendarError, addDays, addMonthsClamped, assertDate, daysBetween } from '@/ledger/calendar';
import AM1 from '../../fixtures/amortization/AM1.json';
import AM2 from '../../fixtures/amortization/AM2.json';
import AM3 from '../../fixtures/amortization/AM3.json';
import AM4 from '../../fixtures/amortization/AM4.json';
import AM5 from '../../fixtures/amortization/AM5.json';
import AC1 from '../../fixtures/accrual/AC1_30day_month.json';
import AC2 from '../../fixtures/accrual/AC2_leap_year.json';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CalendarError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('addMonthsClamped: every due date in AM1-AM5 (D3)', () => {
  it.each([AM1, AM2, AM3, AM4, AM5].map((f) => [f.id, f] as const))('%s', (_, f) => {
    const due = f.expected.schedule.map((row) => addMonthsClamped(f.input.disbursement_date, row.n));
    expect(due).toEqual(f.expected.schedule.map((row) => row.due_date));
  });

  it('counts from the disbursement date, never chained: Jan 31 -> Feb 28 -> Mar 31', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonthsClamped(addMonthsClamped('2026-01-31', 1), 1)).toBe('2026-03-28'); // what chaining would give
  });

  it('clamps to Feb 29 in a leap year, and crosses the year', () => {
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2027-12-30', 2)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-11-15', 14)).toBe('2028-01-15');
    expect(addMonthsClamped('2026-05-31', 0)).toBe('2026-05-31');
  });
});

describe('addDays and daysBetween: the accrual day count', () => {
  it.each([AC1, AC2].map((f) => [f.id, f] as const))('%s: entry date = effective date + day number', (_, f) => {
    for (const e of f.expected.entries) {
      expect(addDays(f.input.principal_effective_date, e.day_number)).toBe(e.date);
      expect(daysBetween(f.input.principal_effective_date, e.date)).toBe(e.day_number);
    }
  });

  it("counts Feb 29: AC2's 29 days", () => {
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29);
    expect(daysBetween('2026-02-01', '2026-03-01')).toBe(28);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('is signed, crosses years, and inverts addDays', () => {
    expect(daysBetween('2026-03-01', '2026-02-01')).toBe(-28);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2028-01-01', '2029-01-01')).toBe(366);
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-01-15', 0)).toBe('2026-01-15');
  });
});

describe('invalid input is refused', () => {
  it.each(['2026-01-01', '2028-02-29', '2000-02-29', '0050-06-30'])('accepts %s', (d) => {
    expect(assertDate(d)).toBe(d);
  });

  it.each([
    ['a day past month end', '2026-02-30'],
    ['Feb 29 off a leap year', '2027-02-29'],
    ['Feb 29 in a century year', '2100-02-29'],
    ['month 13', '2026-13-01'],
    ['day 0', '2026-01-00'],
    ['an unpadded month', '2026-1-01'],
    ['a timestamp', '2026-01-01T00:00:00Z'],
    ['an expanded year', '+02026-01-01'],
    ['whitespace', ' 2026-01-01'],
    ['a Date', new Date('2026-01-01')],
    ['a number', 20260101],
    ['undefined', undefined],
  ])('refuses %s', (_, d) => {
    expect(code(() => assertDate(d))).toBe('invalid_date');
    expect(code(() => addDays(d as string, 1))).toBe('invalid_date');
    expect(code(() => addMonthsClamped(d as string, 1))).toBe('invalid_date');
    expect(code(() => daysBetween('2026-01-01', d as string))).toBe('invalid_date');
  });

  it.each([1.5, NaN, Infinity, '1', undefined])('refuses a count of %s', (n) => {
    expect(code(() => addDays('2026-01-01', n as number))).toBe('invalid_count');
    expect(code(() => addMonthsClamped('2026-01-01', n as number))).toBe('invalid_count');
  });
});
