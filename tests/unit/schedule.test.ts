import { describe, expect, it } from 'vitest';
import { MoneyError } from '@/ledger/money';
import { ScheduleError, buildSchedule } from '@/ledger/schedule';
import AM1 from '../../fixtures/amortization/AM1.json';
import AM2 from '../../fixtures/amortization/AM2.json';
import AM3 from '../../fixtures/amortization/AM3.json';
import AM4 from '../../fixtures/amortization/AM4.json';
import AM5 from '../../fixtures/amortization/AM5.json';

const terms = (f: typeof AM1) => ({
  principalCents: f.input.principal_cents,
  aprBps: f.input.apr_bps,
  termMonths: f.input.term_months,
  disbursementDate: f.input.disbursement_date,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ScheduleError || e instanceof MoneyError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('buildSchedule: AM1-AM5 to the cent, every field (D3)', () => {
  it.each([AM1, AM2, AM3, AM4, AM5].map((f) => [f.id, f] as const))('%s', (_, f) => {
    const s = buildSchedule(terms(f));
    expect({
      installment_cents: s.installmentCents,
      final_payment_cents: s.finalPaymentCents,
      final_payment_adjustment_cents: s.finalPaymentAdjustmentCents,
      total_interest_cents: s.totalInterestCents,
      total_paid_cents: s.totalPaidCents,
      schedule: s.rows.map((r) => ({
        n: r.n,
        due_date: r.dueDate,
        payment_cents: r.paymentCents,
        interest_cents: r.interestCents,
        principal_cents: r.principalCents,
        remaining_balance_cents: r.remainingBalanceCents,
      })),
    }).toEqual(f.expected);
  });
});

describe('buildSchedule: boundary', () => {
  const base = terms(AM1);

  it.each([
    ['float principal', { principalCents: 100000.5 }, 'non_integer_amount'],
    ['string principal', { principalCents: '100000' }, 'non_integer_amount'],
    ['float rate', { aprBps: 1200.5 }, 'non_integer_rate'],
    ['zero principal', { principalCents: 0 }, 'invalid_principal'],
    ['negative principal', { principalCents: -1 }, 'invalid_principal'],
    ['negative rate', { aprBps: -1 }, 'invalid_rate'],
    ['zero term', { termMonths: 0 }, 'invalid_term'],
    ['fractional term', { termMonths: 1.5 }, 'invalid_term'],
    ['term as string', { termMonths: '6' }, 'invalid_term'],
    // 7 cents over 12 months at 0%: installment 1, balance gone by row 7, rows 8-12 would go negative (D14)
    ['installment clears the balance early', { principalCents: 7, aprBps: 0, termMonths: 12 }, 'degenerate_schedule'],
  ])('%s is refused', (_, override, expected) => {
    expect(code(() => buildSchedule({ ...base, ...override } as never))).toBe(expected);
  });

  it('refuses a bad disbursement date', () => {
    expect(() => buildSchedule({ ...base, disbursementDate: '2026-02-30' })).toThrow('invalid_date');
  });
});
