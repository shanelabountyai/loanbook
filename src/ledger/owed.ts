// What one loan owes right now (task 3.2): the per-loan receivables from trialBalance, i.e. the sum of
// ledger lines. Nothing stored. Interest owed is interest_receivable (accrued), not the schedule's interest (D4).

import type { ClientBase } from 'pg';
import { trialBalance } from './balances';
import type { Buckets } from './waterfall';

/** A loan with no lines owes nothing; the ledger cannot tell it from an unknown id. */
export async function owedCents(db: Pick<ClientBase, 'query'>, loanId: string): Promise<Buckets> {
  const r = (await trialBalance(db)).perLoanCents[loanId];
  return { fees: r?.fees_receivable ?? 0, interest: r?.interest_receivable ?? 0, principal: r?.loans_receivable ?? 0 };
}
