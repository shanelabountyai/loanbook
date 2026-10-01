// Payment allocation (decision D7): each bucket takes min(remaining payment, owed), in the
// configured order. Pure, no database, no rounding (it is subtraction). Held to
// `fixtures/waterfall/` by tests/unit/waterfall.test.ts.

import { assertCents } from './money';

export const BUCKETS = ['fees', 'interest', 'principal'] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Buckets = Record<Bucket, number>;

export type WaterfallErrorCode = 'non_positive_payment' | 'exceeds_payoff' | 'invalid_owed' | 'invalid_order';

/** Codes match `fixtures/waterfall/`. `non_integer_amount` arrives as a MoneyError. */
export class WaterfallError extends Error {
  constructor(
    readonly code: WaterfallErrorCode,
    readonly payoffCents?: number,
  ) {
    super(code);
  }
}

export type Allocation = { allocation: Buckets; remaining: Buckets; loanClosed: boolean };

/** `order` is an argument, never a constant here: the order is configuration (PRD P0-4). */
export function allocate({ owed, paymentCents, order }: { owed: Buckets; paymentCents: number; order: readonly Bucket[] }): Allocation {
  if (order.length !== BUCKETS.length || !BUCKETS.every((b) => order.includes(b))) throw new WaterfallError('invalid_order');
  let payoff = 0;
  for (const b of BUCKETS) {
    const cents = assertCents(owed[b]);
    if (cents < 0) throw new WaterfallError('invalid_owed');
    payoff = assertCents(payoff + cents);
  }
  const payment = assertCents(paymentCents);
  if (payment <= 0) throw new WaterfallError('non_positive_payment');
  if (payment > payoff) throw new WaterfallError('exceeds_payoff', payoff);

  const allocation = { fees: 0, interest: 0, principal: 0 };
  const remaining = { ...owed };
  let left = payment;
  for (const b of order) {
    const take = Math.min(left, owed[b]);
    allocation[b] = take;
    remaining[b] = owed[b] - take;
    left -= take;
  }
  return { allocation, remaining, loanClosed: payment === payoff };
}
