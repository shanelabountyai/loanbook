// Payment posting (task 3.3, D16): read what is owed, allocate, post one entry, all in one transaction
// under a row lock on the loan, so two racing payments cannot both be allowed against the same owed amount.

import type { ClientBase } from 'pg';
import { accrualDue } from './accrue';
import { EntryError } from './entry';
import { owedCents } from './owed';
import { postEntryInTx } from './post';
import { allocate, BUCKETS, type Allocation, type Bucket } from './waterfall';

const RECEIVABLE = { fees: 'fees_receivable', interest: 'interest_receivable', principal: 'loans_receivable' } as const;

export type Payment = { loanId: string; date: string; paymentCents: number; order: readonly Bucket[] };

/**
 * Posts Dr cash / Cr one receivable per bucket touched, with the loan id. Needs a connection that is not
 * in a transaction. Throws `accrual_pending` (EntryError) if accrual through `date` is not yet posted (D6),
 * WaterfallError / MoneyError from `allocate`, or the database's error after rolling back.
 */
export async function postPayment(db: Pick<ClientBase, 'query'>, p: Payment): Promise<Allocation & { entryId: string }> {
  await db.query('BEGIN');
  try {
    // ponytail: Loan rows are append-only by trigger; FOR UPDATE takes the lock without firing it.
    await db.query('SELECT 1 FROM "Loan" WHERE "id" = $1 FOR UPDATE', [p.loanId]);
    if ((await accrualDue(db, p.loanId, p.date)).length > 0) throw new EntryError('accrual_pending');
    const result = allocate({ owed: await owedCents(db, p.loanId), paymentCents: p.paymentCents, order: p.order });
    const entryId = await postEntryInTx(db, {
      date: p.date,
      loanId: p.loanId,
      memo: `Payment ${p.loanId} ${p.date}`,
      lines: [
        { account: 'cash', debitCents: p.paymentCents, creditCents: 0 },
        ...BUCKETS.filter((b) => result.allocation[b] > 0).map((b) => ({ account: RECEIVABLE[b], debitCents: 0, creditCents: result.allocation[b] })),
      ],
    });
    await db.query('COMMIT');
    return { ...result, entryId };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
