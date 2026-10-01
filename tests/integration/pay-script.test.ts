import { afterAll, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { cumulativeInterestCents } from '@/ledger/accrual';
import { runAccrual } from '@/ledger/accrue';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { payoffQuote } from '@/ledger/payoff';
import { verifyLedger } from '@/ledger/verify';

// Task 3.6: `npm run pay` as a person runs it, on a two-loan book accrued through 2026-02-15:
// a short payment, an exact (interest only) payment, a payoff, and the refusals.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
});

const pay = (...args: string[]) => spawnSync('node_modules/.bin/tsx', ['scripts/pay.ts', ...args], { encoding: 'utf8' });
const terms = { aprBps: 1200, termMonths: 6 };
const D = '2026-02-15';
const entries = async () => (await client.query('SELECT count(*)::int AS n FROM "LedgerEntry"')).rows[0].n;

async function book() {
  const a = await createLoan(client, { ...terms, principalCents: 100000, disbursementDate: '2026-01-15' });
  const b = await createLoan(client, { ...terms, principalCents: 250000, disbursementDate: '2026-01-20' });
  await runAccrual(client, { asOf: D });
  return { a: a.loanId, b: b.loanId };
}

it('short, exact and payoff payments split by the configured order and leave the ledger clean', async () => {
  const { a, b } = await book();
  const ia = cumulativeInterestCents(100000, 1200, 31);
  const ib = cumulativeInterestCents(250000, 1200, 26);

  const short = pay('--loan', a, '--date', D, '--cents', '500');
  expect(short.status).toBe(0);
  expect(short.stdout).toContain('500 cents = fees 0, interest 500, principal 0');
  expect(short.stdout).toContain(`remaining fees 0, interest ${ia - 500}, principal 100000`);
  expect((await owedCents(client, a)).interest).toBe(ia - 500);

  const exact = pay('--loan', b, '--date', D, '--cents', String(ib));
  expect(exact.status).toBe(0);
  expect(exact.stdout).toContain(`interest ${ib}, principal 0`);
  expect(await owedCents(client, b)).toEqual({ fees: 0, interest: 0, principal: 250000 });

  const quote = await payoffQuote(client, { loanId: a, asOf: D });
  const payoff = pay('--loan', a, '--date', D, '--cents', String(quote.totalCents));
  expect(payoff.status).toBe(0);
  expect(payoff.stdout).toContain('(loan closed)');
  expect(await owedCents(client, a)).toEqual({ fees: 0, interest: 0, principal: 0 });
  expect((await verifyLedger(client)).findings).toEqual([]);
});

it('refuses with exit 1 and writes nothing: missing flags, over payoff, unposted accrual, zero, non-integer', async () => {
  const { a } = await book();
  const before = await entries();
  const total = (await payoffQuote(client, { loanId: a, asOf: D })).totalCents;

  const missing = pay('--loan', a, '--cents', '100');
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('--date');
  expect(pay('--loan', a, '--date', D, '--cents', '10.5').status).toBe(1);

  const over = pay('--loan', a, '--date', D, '--cents', String(total + 1));
  expect(over.status).toBe(1);
  expect(over.stderr).toContain('exceeds_payoff');
  expect(pay('--loan', a, '--date', D, '--cents', '0').stderr).toContain('non_positive_payment');

  const stale = pay('--loan', a, '--date', '2026-03-01', '--cents', '100');
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain('accrual_pending');
  expect(await entries()).toBe(before);
});
