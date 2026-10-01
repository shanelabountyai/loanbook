import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allocate, WaterfallError, type Bucket } from '@/ledger/waterfall';
import { MoneyError } from '@/ledger/money';

type Fx = {
  id: string;
  description: string;
  config: { waterfall_order: Bucket[] };
  input: { owed_before: Record<Bucket, number>; payment_cents: number };
  expected: {
    allocation?: Record<Bucket, number>;
    remaining?: Record<Bucket, number>;
    loan_closed?: boolean;
    error?: string;
    payoff_cents?: number;
  };
};

const dir = new URL('../../fixtures/waterfall/', import.meta.url);
const fixtures: Fx[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));

const run = (f: Fx) =>
  allocate({ owed: f.input.owed_before, paymentCents: f.input.payment_cents, order: f.config.waterfall_order });

describe('waterfall fixtures', () => {
  it('reads all 13', () => expect(fixtures).toHaveLength(13));

  it.each(fixtures.filter((f) => !f.expected.error).map((f) => [f.id, f.description, f] as const))(
    '%s: %s',
    (_id, _d, f) => {
      const r = run(f);
      expect(r.allocation).toEqual(f.expected.allocation);
      expect(r.remaining).toEqual(f.expected.remaining);
      expect(r.loanClosed).toBe(f.expected.loan_closed);
    },
  );

  it.each(fixtures.filter((f) => f.expected.error).map((f) => [f.id, f.description, f] as const))(
    '%s: %s',
    (_id, _d, f) => {
      try {
        run(f);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(WaterfallError);
        expect((e as WaterfallError).code).toBe(f.expected.error);
        expect((e as WaterfallError).payoffCents).toBe(f.expected.payoff_cents);
      }
    },
  );
});

describe('waterfall guards', () => {
  const owed = { fees: 10, interest: 20, principal: 30 };
  const order: Bucket[] = ['fees', 'interest', 'principal'];
  const code = (over: Partial<Parameters<typeof allocate>[0]>) => {
    try {
      allocate({ owed, paymentCents: 5, order, ...over });
    } catch (e) {
      if (e instanceof WaterfallError || e instanceof MoneyError) return e.code;
      throw e;
    }
    return 'accepted';
  };

  it('refuses a negative payment', () => expect(code({ paymentCents: -1 })).toBe('non_positive_payment'));
  it('refuses a fractional payment', () => expect(code({ paymentCents: 1.5 })).toBe('non_integer_amount'));
  it('refuses a fractional or negative owed amount', () => {
    expect(code({ owed: { ...owed, fees: 0.5 } })).toBe('non_integer_amount');
    expect(code({ owed: { ...owed, fees: -1 } })).toBe('invalid_owed');
  });
  it('refuses an order that is not a permutation', () => {
    expect(code({ order: ['fees', 'interest'] as Bucket[] })).toBe('invalid_order');
    expect(code({ order: ['fees', 'fees', 'principal'] as Bucket[] })).toBe('invalid_order');
    expect(code({ order: ['fees', 'interest', 'tax'] as unknown as Bucket[] })).toBe('invalid_order');
  });
  it('pays exactly the payoff and closes', () => expect(allocate({ owed, paymentCents: 60, order }).loanClosed).toBe(true));
  it('refuses one cent past the payoff', () => expect(code({ paymentCents: 61 })).toBe('exceeds_payoff'));
  it('honours a different order', () => {
    expect(allocate({ owed, paymentCents: 15, order: ['principal', 'fees', 'interest'] }).allocation).toEqual({
      principal: 15, fees: 0, interest: 0,
    });
  });
});
