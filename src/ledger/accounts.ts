// The chart of accounts (decision D8). Held to `fixtures/ledger/chart_of_accounts.json` by
// tests/unit/accounts.test.ts; the fixture is the oracle, so this file never reads it.

export type Side = 'debit' | 'credit';
export type AccountType = 'asset' | 'equity' | 'income' | 'expense';

type Account = { type: AccountType; normal: Side; requiresLoanId: boolean };

/** Receivable and write-off accounts are per-loan sub-ledgers: an entry touching one must carry a loan id. */
export const CHART = {
  cash: { type: 'asset', normal: 'debit', requiresLoanId: false },
  loans_receivable: { type: 'asset', normal: 'debit', requiresLoanId: true },
  interest_receivable: { type: 'asset', normal: 'debit', requiresLoanId: true },
  fees_receivable: { type: 'asset', normal: 'debit', requiresLoanId: true },
  lender_capital: { type: 'equity', normal: 'credit', requiresLoanId: false },
  interest_income: { type: 'income', normal: 'credit', requiresLoanId: false },
  fees_income: { type: 'income', normal: 'credit', requiresLoanId: false },
  write_offs: { type: 'expense', normal: 'debit', requiresLoanId: true },
} as const satisfies Record<string, Account>;

export type AccountName = keyof typeof CHART;

/** Own keys only, so `toString` and `constructor` are not accounts. */
export const isAccount = (name: unknown): name is AccountName =>
  typeof name === 'string' && Object.hasOwn(CHART, name);
