import { describe, expect, it } from 'vitest';
import { MoneyError, assertBps, assertCents, roundHalfUp } from '@/ledger/money';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MoneyError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('assertCents (D1, D11)', () => {
  it.each([0, 1, -1, 100000, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])('accepts %s', (v) => {
    expect(assertCents(v)).toBe(v);
  });

  it.each([
    ['a float', 100.5],
    ['a tiny fraction', 0.1 + 0.2],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['past the safe range', Number.MAX_SAFE_INTEGER + 1],
    ['true', true],
    ['false', false],
    ['a numeric string', '100'],
    ['a bigint', 100n],
    ['null', null],
    ['undefined', undefined],
    ['an object', { cents: 100 }],
  ])('rejects %s', (_, v) => {
    expect(code(() => assertCents(v))).toBe('non_integer_amount');
  });
});

describe('assertBps (D1, D11)', () => {
  it('accepts an integer rate', () => {
    expect(assertBps(1200)).toBe(1200);
  });

  it.each([12.5, true, '1200', NaN])('rejects %s', (v) => {
    expect(code(() => assertBps(v))).toBe('non_integer_rate');
  });
});

describe('roundHalfUp (D2)', () => {
  it.each([
    // [numerator, denominator, cents]
    [0n, 1n, 0],
    [7n, 1n, 7],
    [1n, 2n, 1], // ties go up: banker's rounding would give 0
    [3n, 2n, 2],
    [5n, 2n, 3], // banker's rounding would give 2
    [49n, 100n, 0],
    [51n, 100n, 1],
    [100000n * 1200n, 120000n, 1000], // D3: L1 period 1 schedule interest
    [100000n * 1200n * 1n, 10000n * 365n, 33], // D5: one day on $1,000 @ 12% is 32.88
    [100000n * 1200n * 30n, 10000n * 365n, 986], // AC1: 30 days, exact then rounded
    [100000n * 1200n * 31n, 10000n * 365n, 1019], // D4: L1 period 1 accrued
  ])('%s / %s -> %s', (n, d, cents) => {
    expect(roundHalfUp(n, d)).toBe(cents);
  });

  it.each([
    ['a negative quantity', -1n, 2n],
    ['a zero denominator', 1n, 0n],
    ['a negative denominator', 1n, -2n],
    ['a result past the safe range', BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1n],
  ])('rejects %s', (_, n, d) => {
    expect(code(() => roundHalfUp(n, d))).toBe('invalid_rounding_input');
  });
});
