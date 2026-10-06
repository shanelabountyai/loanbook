import { describe, expect, it } from 'vitest';
import { MoneyError, assertBps, assertCents, centsFromNumeric, decimalCents, formatCents, formatMoney, roundHalfUp } from '@/ledger/money';

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

describe('centsFromNumeric: the read edge (D12)', () => {
  it.each([
    ['0', 0],
    ['100000', 100000],
    ['-1500', -1500],
    ['100000.000000000000000000000000000000', 100000],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('reads %s', (text, cents) => {
    expect(centsFromNumeric(text)).toBe(cents);
  });

  // A ::bigint cast would turn 10.5 into 11 without a word; this refuses it.
  it.each([
    ['a fraction', '10.5'],
    ['a fraction below a cent', '100000.000000000000000000000000000001'],
    ['past the safe range', '9007199254740992'],
    ['empty', ''],
    ['exponent notation', '1e5'],
    ['a lone point', '100.'],
    ['NaN', 'NaN'],
    ['whitespace', ' 100'],
  ])('refuses %s', (_, text) => {
    expect(code(() => centsFromNumeric(text))).toBe('non_integer_amount');
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

describe('formatCents (display)', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [1500, '$15.00'],
    [123456, '$1234.56'],
    [-1205, '-$12.05'],
  ])('%i is %s', (c, s) => expect(formatCents(c)).toBe(s));
  it('refuses a fraction', () => expect(() => formatCents(1.5)).toThrow(MoneyError));
});

describe('formatMoney and decimalCents (display)', () => {
  it.each([
    [0, '$0.00', '0.00'],
    [99999, '$999.99', '999.99'],
    [100000, '$1,000.00', '1000.00'],
    [106782, '$1,067.82', '1067.82'],
    [123456789, '$1,234,567.89', '1234567.89'],
    [-100005, '-$1,000.05', '-1000.05'],
  ])('%i is %s and %s', (c, m, d) => {
    expect(formatMoney(c)).toBe(m);
    expect(decimalCents(c)).toBe(d);
  });
});
