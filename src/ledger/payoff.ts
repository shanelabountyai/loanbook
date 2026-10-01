// Payoff quote (task 3.4, D17): what paying the loan off on `asOf` costs. Owed from the ledger (fees,
// posted interest, principal) plus the accrual days through `asOf` the run has not posted yet, by the same
// cumulative rule as the run (D5, D15). Posts nothing, stores nothing: same ledger and date, same quote.

import type { ClientBase } from 'pg';
import { accrualDue } from './accrue';
import { EntryError } from './entry';
import { owedCents } from './owed';

export type PayoffQuote = {
  loanId: string;
  asOf: string;
  principalCents: number;
  interestCents: number; // posted + pending
  feesCents: number;
  totalCents: number;
  postedInterestCents: number;
  pendingAccrualCents: number;
};

/** Needs a connection that is not in a transaction: both reads run in one repeatable-read snapshot. */
export async function payoffQuote(db: Pick<ClientBase, 'query'>, { loanId, asOf }: { loanId: string; asOf: string }): Promise<PayoffQuote> {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const { rowCount } = await db.query('SELECT 1 FROM "Loan" WHERE "id" = $1', [loanId]);
    if (!rowCount) throw new EntryError('unknown_loan');
    const pendingAccrualCents = (await accrualDue(db, loanId, asOf)).reduce((sum, a) => sum + a.amountCents, 0);
    const owed = await owedCents(db, loanId);
    const interestCents = owed.interest + pendingAccrualCents;
    return {
      loanId,
      asOf,
      principalCents: owed.principal,
      interestCents,
      feesCents: owed.fees,
      totalCents: owed.principal + interestCents + owed.fees,
      postedInterestCents: owed.interest,
      pendingAccrualCents,
    };
  } finally {
    await db.query('ROLLBACK'); // read-only: nothing to commit
  }
}
