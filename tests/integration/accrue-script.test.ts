import { afterAll, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { cumulativeInterestCents } from '@/ledger/accrual';
import { createLoan } from '@/ledger/loan';
import { verifyLedger } from '@/ledger/verify';

// Task 2.6: `npm run accrue` as a person runs it: --as-of required, per-loan counts printed, exit 1 on error.
// Two loans disbursed five days apart, a 31-day run. No installment is posted, so each loan is one segment
// and its total is cumulative interest for the days elapsed (oracle: the pure function tested in 2.4).

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
});

const run = (...args: string[]) => spawnSync('node_modules/.bin/tsx', ['scripts/accrue.ts', ...args], { encoding: 'utf8' });
const terms = { aprBps: 1200, termMonths: 6 };

it('posts every loan through --as-of, prints counts per loan, and leaves the ledger clean', async () => {
  const a = await createLoan(client, { ...terms, principalCents: 100000, disbursementDate: '2026-01-15' });
  const b = await createLoan(client, { ...terms, principalCents: 250000, disbursementDate: '2026-01-20' });
  const r = run('--as-of', '2026-02-15');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`loan ${a.loanId}: 31 entries, ${cumulativeInterestCents(100000, 1200, 31)} cents`);
  expect(r.stdout).toContain(`loan ${b.loanId}: 26 entries, ${cumulativeInterestCents(250000, 1200, 26)} cents`);
  expect(r.stdout).toContain('57 entries posted across 2 loans');
  expect((await verifyLedger(client)).findings).toEqual([]);

  const again = run('--as-of', '2026-02-15');
  expect(again.status).toBe(0);
  expect(again.stdout).toContain('0 entries posted across 0 loans');
});

it('refuses a missing or invalid --as-of with exit 1, and never defaults to today', async () => {
  await createLoan(client, { ...terms, principalCents: 100000, disbursementDate: '2026-01-15' });
  const missing = run();
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('--as-of');
  const bad = run('--as-of', '2026-02-30');
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('accrue: FAIL');
  expect((await client.query('SELECT 1 FROM "LedgerEntry" WHERE "kind" = \'accrual\'')).rowCount).toBe(0);
});
