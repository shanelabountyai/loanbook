// The one home for money representation and rounding (decisions D1, D2, D11).
// Cents and basis points are integer `number`s; nothing else in src/ledger divides or rounds.

export type MoneyErrorCode = 'non_integer_amount' | 'non_integer_rate' | 'invalid_rounding_input';

/** Codes match `fixtures/ledger/entry_validation.json` where the fixture names one. */
export class MoneyError extends Error {
  constructor(readonly code: MoneyErrorCode) {
    super(code);
  }
}

function assertInteger(value: unknown, code: MoneyErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new MoneyError(code);
  return value;
}

/** Boundary guard for an amount in cents. Sign is the caller's rule, not this one's. */
export const assertCents = (value: unknown) => assertInteger(value, 'non_integer_amount');

/**
 * The read edge: a Postgres numeric, as the text `pg` returns, to whole cents (D12). Trailing zero
 * scale is fine ("100000.000..."); any fraction is refused, never rounded as a ::bigint cast would.
 */
export function centsFromNumeric(text: string): number {
  const whole = /^(-?\d+)(?:\.0+)?$/.exec(text)?.[1];
  return assertCents(whole === undefined ? NaN : Number(whole));
}

/** Boundary guard for a rate in basis points (1200 = 12.00%). */
export const assertBps = (value: unknown) => assertInteger(value, 'non_integer_rate');

/**
 * Round half up to whole cents, once, from an exact quantity given as numerator / denominator.
 * Non-negative quantities only: "half up" is ambiguous below zero and no rule in D3-D9 rounds a negative.
 */
export function roundHalfUp(numerator: bigint, denominator: bigint): number {
  if (numerator < 0n || denominator <= 0n) throw new MoneyError('invalid_rounding_input');
  // floor(n/d + 1/2); bigint division truncates, which is floor for a non-negative quantity
  const cents = Number((2n * numerator + denominator) / (2n * denominator));
  return assertInteger(cents, 'invalid_rounding_input');
}

/** Display only: whole cents as dollars by string, never through a float ("-$12.05"). */
export function formatCents(value: number): string {
  const digits = String(Math.abs(assertCents(value))).padStart(3, '0');
  return `${value < 0 ? '-' : ''}$${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Display only, for screens: formatCents with thousands separators ("$1,067.82"). Statement text keeps the plain form (frozen fixtures). */
export const formatMoney = (value: number): string => formatCents(value).replace(/\B(?=(\d{3})+\.)/g, ',');

/** Plain decimal dollars for CSV ("1067.82", "-12.05"): no symbol, no separators. */
export const decimalCents = (value: number): string => formatCents(value).replace('$', '');
