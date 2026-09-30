// The checks behind `ledger:verify` (task 1.9). Held to fixtures/ledger/TB1_trial_balance.json and
// verify_failures.json by tests/integration/ledger-verify.test.ts.
//
// Every comparison is made by Postgres, on the exact numeric. No amount becomes a JavaScript number
// here: amounts come back as text, for the message only. It trusts no trigger and no constraint,
// and reads lines first, so a line whose entry is gone is still counted.

import type { ClientBase } from 'pg';
import { CHART } from './accounts';

export type VerifyCode =
  | 'unbalanced_entry'
  | 'unbalanced_ledger'
  | 'missing_loan_id'
  | 'control_account_mismatch'
  | 'dangling_reversal';
export type Finding = { code: VerifyCode; entryId?: string; account?: string; detail: string };
export type VerifyResult = { findings: Finding[]; entries: number; debits: string; credits: string };

const PER_LOAN = Object.entries(CHART)
  .filter(([, account]) => account.requiresLoanId)
  .map(([name]) => name);

const TAGGED = `coalesce(e."loanId", '') <> ''`;
const NET = `l."debitCents" - l."creditCents"`;

export async function verifyLedger(db: Pick<ClientBase, 'query'>): Promise<VerifyResult> {
  // One snapshot for all five checks, so a book being written to cannot fail against itself.
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const findings: Finding[] = [];

    const unbalanced = await db.query<{ id: string; debits: string; credits: string }>(
      `SELECT l."entryId" AS id, trim_scale(sum(l."debitCents"))::text AS debits, trim_scale(sum(l."creditCents"))::text AS credits
         FROM "LedgerLine" l GROUP BY l."entryId"
       HAVING sum(l."debitCents") <> sum(l."creditCents") ORDER BY 1`,
    );
    for (const r of unbalanced.rows) {
      findings.push({ code: 'unbalanced_entry', entryId: r.id, detail: `debits ${r.debits}, credits ${r.credits}` });
    }

    const { rows: totals } = await db.query<{ entries: number; debits: string; credits: string; balanced: boolean }>(
      `SELECT (SELECT count(*)::int FROM "LedgerEntry") AS entries,
              trim_scale(coalesce(sum("debitCents"), 0))::text AS debits,
              trim_scale(coalesce(sum("creditCents"), 0))::text AS credits,
              coalesce(sum("debitCents"), 0) = coalesce(sum("creditCents"), 0) AS balanced
         FROM "LedgerLine"`,
    );
    const { entries, debits, credits, balanced } = totals[0]!;
    if (!balanced) findings.push({ code: 'unbalanced_ledger', detail: `debits ${debits}, credits ${credits}` });

    const untagged = await db.query<{ id: string; accounts: string }>(
      `SELECT l."entryId" AS id, string_agg(DISTINCT l."account", ', ' ORDER BY l."account") AS accounts
         FROM "LedgerLine" l LEFT JOIN "LedgerEntry" e ON e."id" = l."entryId"
        WHERE l."account" = ANY($1) AND NOT ${TAGGED}
        GROUP BY l."entryId" ORDER BY 1`,
      [PER_LOAN],
    );
    for (const r of untagged.rows) {
      findings.push({ code: 'missing_loan_id', entryId: r.id, detail: `touches ${r.accounts} and has no loan id` });
    }

    // The control balance is every line on the account; the sub-ledgers are the lines that name a loan.
    const control = await db.query<{ account: string; control: string; loans: string }>(
      `SELECT l."account", trim_scale(sum(${NET}))::text AS control,
              trim_scale(coalesce(sum(${NET}) FILTER (WHERE ${TAGGED}), 0))::text AS loans
         FROM "LedgerLine" l LEFT JOIN "LedgerEntry" e ON e."id" = l."entryId"
        WHERE l."account" = ANY($1)
        GROUP BY l."account"
       HAVING sum(${NET}) <> coalesce(sum(${NET}) FILTER (WHERE ${TAGGED}), 0) ORDER BY 1`,
      [PER_LOAN],
    );
    for (const r of control.rows) {
      findings.push({
        code: 'control_account_mismatch',
        account: r.account,
        detail: `control balance ${r.control}, per-loan sub-ledgers sum to ${r.loans}`,
      });
    }

    const dangling = await db.query<{ id: string; reverses: string }>(
      `SELECT e."id", e."reversesEntryId" AS reverses FROM "LedgerEntry" e
        WHERE e."reversesEntryId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" o WHERE o."id" = e."reversesEntryId") ORDER BY 1`,
    );
    for (const r of dangling.rows) {
      findings.push({ code: 'dangling_reversal', entryId: r.id, detail: `reverses ${r.reverses}, which does not exist` });
    }

    return { findings, entries, debits, credits };
  } finally {
    await db.query('ROLLBACK');
  }
}
