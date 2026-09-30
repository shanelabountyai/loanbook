// Derived balances (task 1.7). Nothing here is stored: every figure is a sum of ledger lines, read in one
// statement so totals, accounts and loans come from one snapshot. Held to
// fixtures/ledger/TB1_trial_balance.json by tests/integration/ledger-balances.test.ts.
//
// A balance is signed by the account's normal side, in Postgres on the exact numeric; every amount then
// crosses into JavaScript through centsFromNumeric.

import type { ClientBase } from 'pg';
import { CHART, type AccountName } from './accounts';
import { centsFromNumeric } from './money';

const ACCOUNTS = Object.keys(CHART) as AccountName[];
const CREDIT_NORMAL = ACCOUNTS.filter((a) => CHART[a].normal === 'credit');
/** What a borrower owes: the per-loan asset accounts. write_offs carries a loan id too, but is an expense. */
const RECEIVABLES = ACCOUNTS.filter((a) => CHART[a].requiresLoanId && CHART[a].type === 'asset');

type Receivable = (typeof RECEIVABLES)[number];
export type TrialBalance = {
  totalDebitsCents: number;
  totalCreditsCents: number;
  balancesCents: Record<AccountName, number>;
  perLoanCents: Record<string, Record<Receivable, number>>;
};

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export async function trialBalance(db: Pick<ClientBase, 'query'>): Promise<TrialBalance> {
  const { rows } = await db.query<{ account: AccountName | null; loanId: string | null; set: number; debits: string; credits: string; balance: string }>(
    `SELECT l."account", e."loanId", GROUPING(l."account", e."loanId") AS set,
            coalesce(sum(l."debitCents"), 0)::text AS debits,
            coalesce(sum(l."creditCents"), 0)::text AS credits,
            coalesce(sum(CASE WHEN l."account" = ANY($1) THEN l."creditCents" - l."debitCents"
                              ELSE l."debitCents" - l."creditCents" END), 0)::text AS balance
       FROM "LedgerLine" l LEFT JOIN "LedgerEntry" e ON e."id" = l."entryId"
      GROUP BY GROUPING SETS ((), (l."account"), (l."account", e."loanId"))`,
    [CREDIT_NORMAL],
  );

  const result: TrialBalance = { totalDebitsCents: 0, totalCreditsCents: 0, balancesCents: zeros(ACCOUNTS), perLoanCents: {} };
  for (const r of rows) {
    if (r.set === 3) {
      result.totalDebitsCents = centsFromNumeric(r.debits);
      result.totalCreditsCents = centsFromNumeric(r.credits);
    } else if (r.set === 1) {
      result.balancesCents[r.account!] = centsFromNumeric(r.balance);
    } else if (r.loanId && (RECEIVABLES as string[]).includes(r.account!)) {
      (result.perLoanCents[r.loanId] ??= zeros(RECEIVABLES))[r.account as Receivable] = centsFromNumeric(r.balance);
    }
  }
  return result;
}
