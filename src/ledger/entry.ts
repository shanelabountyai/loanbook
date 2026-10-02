// Write-time validation of a journal entry: it balances, has at least two lines, and each line has
// exactly one positive side. Pure, no database. Held to `fixtures/ledger/entry_validation.json`
// by tests/unit/entry.test.ts.

import { CHART, isAccount, type AccountName } from './accounts';
import { assertCents } from './money';

export type EntryErrorCode =
  | 'too_few_lines'
  | 'unknown_account'
  | 'line_must_have_exactly_one_side'
  | 'non_positive_amount'
  | 'missing_loan_id'
  | 'unbalanced'
  | 'already_reversed'
  | 'dangling_reversal'
  | 'accrual_pending'
  | 'unknown_loan'
  | 'reason_required'
  | 'not_a_fee'
  | 'before_fee'
  | 'fee_paid';

/** Codes match `fixtures/ledger/entry_validation.json`. `non_integer_amount` arrives as a MoneyError. */
export class EntryError extends Error {
  constructor(readonly code: EntryErrorCode) {
    super(code);
  }
}

type Line<Account> = { account: Account; debitCents: number; creditCents: number };

export type EntryInput = { loanId?: string | null; lines: Line<string>[] };
export type Entry = { loanId?: string | null; lines: Line<AccountName>[] };

/**
 * Throws on the first rule broken, so an entry that breaks several names one code. Order: line
 * count, then each line in turn (account, integer cents, sides, loan id), then the balance.
 * Only the line count coming before the balance is fixed by the fixture (I2); the rest is this
 * function's choice. A negative side is `non_positive_amount` whatever the other side holds.
 */
export function assertValidEntry(entry: EntryInput): asserts entry is Entry {
  if (!Array.isArray(entry.lines) || entry.lines.length < 2) throw new EntryError('too_few_lines');

  let debits = 0;
  let credits = 0;
  for (const { account, debitCents, creditCents } of entry.lines) {
    if (!isAccount(account)) throw new EntryError('unknown_account');
    const debit = assertCents(debitCents);
    const credit = assertCents(creditCents);
    if (debit > 0 && credit > 0) throw new EntryError('line_must_have_exactly_one_side');
    if (debit < 0 || credit < 0 || debit + credit === 0) throw new EntryError('non_positive_amount');
    if (CHART[account].requiresLoanId && !entry.loanId) throw new EntryError('missing_loan_id');
    // guarded, so totals past the safe integer range are refused rather than compared
    debits = assertCents(debits + debit);
    credits = assertCents(credits + credit);
  }
  if (debits !== credits) throw new EntryError('unbalanced');
}
