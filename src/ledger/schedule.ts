// The amortization schedule (D3): pure, derived on read, never stored. It is the plan; the ledger is the truth (D4).

import { addMonthsClamped, assertDate } from './calendar';
import { assertBps, assertCents, roundHalfUp } from './money';

export type ScheduleErrorCode = 'invalid_principal' | 'invalid_rate' | 'invalid_term' | 'degenerate_schedule';

export class ScheduleError extends Error {
  constructor(readonly code: ScheduleErrorCode) {
    super(code);
  }
}

export interface ScheduleTerms {
  principalCents: number;
  aprBps: number;
  termMonths: number;
  disbursementDate: string;
}

export interface ScheduleRow {
  n: number;
  dueDate: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  remainingBalanceCents: number;
}

export interface Schedule {
  installmentCents: number;
  finalPaymentCents: number;
  finalPaymentAdjustmentCents: number;
  totalInterestCents: number;
  totalPaidCents: number;
  rows: ScheduleRow[];
}

// Monthly rate = aprBps / (10000 × 12).
const MONTHLY = 120_000n;

/**
 * Annuity P·r·(1+r)^n / ((1+r)^n − 1) with r = a / 120000, multiplied through by 120000^n so it is one exact
 * fraction: P·a·(120000+a)^n / (120000·((120000+a)^n − 120000^n)). Rounded once. APR 0 is P / n.
 */
function installment(principal: bigint, apr: bigint, term: bigint): number {
  if (apr === 0n) return roundHalfUp(principal, term);
  const grown = (MONTHLY + apr) ** term;
  return roundHalfUp(principal * apr * grown, MONTHLY * (grown - MONTHLY ** term));
}

export function buildSchedule(terms: ScheduleTerms): Schedule {
  const principalCents = assertCents(terms.principalCents);
  const aprBps = assertBps(terms.aprBps);
  const { termMonths } = terms;
  const disbursementDate = assertDate(terms.disbursementDate);
  if (principalCents <= 0) throw new ScheduleError('invalid_principal');
  if (aprBps < 0) throw new ScheduleError('invalid_rate');
  if (!Number.isSafeInteger(termMonths) || termMonths <= 0) throw new ScheduleError('invalid_term');

  const installmentCents = installment(BigInt(principalCents), BigInt(aprBps), BigInt(termMonths));
  const rows: ScheduleRow[] = [];
  let balance = principalCents;
  for (let n = 1; n <= termMonths; n++) {
    const interestCents = roundHalfUp(BigInt(balance) * BigInt(aprBps), MONTHLY);
    const final = n === termMonths;
    // The final row pays off whatever is left, absorbing every earlier row's rounding (the penny problem).
    const principalPart = final ? balance : installmentCents - interestCents;
    // D14: every row before the last must pay some principal and leave some for the last row to close.
    if (!final && (principalPart <= 0 || principalPart >= balance)) throw new ScheduleError('degenerate_schedule');
    balance -= principalPart;
    rows.push({
      n,
      dueDate: addMonthsClamped(disbursementDate, n),
      paymentCents: interestCents + principalPart,
      interestCents,
      principalCents: principalPart,
      remainingBalanceCents: balance,
    });
  }

  const totalInterestCents = rows.reduce((sum, r) => sum + r.interestCents, 0);
  const totalPaidCents = principalCents + totalInterestCents;
  // Every row but the last pays exactly the installment.
  const finalPaymentCents = totalPaidCents - installmentCents * (termMonths - 1);
  return {
    installmentCents,
    finalPaymentCents,
    finalPaymentAdjustmentCents: finalPaymentCents - installmentCents,
    totalInterestCents,
    totalPaidCents,
    rows,
  };
}
