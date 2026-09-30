import { parseArgs } from 'node:util';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';

// The accrual run (task 2.6). `--as-of` is required: domain code never reads the clock (non-negotiable 6),
// and neither does this script. Prints entries and cents posted per loan; exits 1 on any error.

const { values } = parseArgs({ options: { 'as-of': { type: 'string' } } });
const asOf = values['as-of'];
if (!asOf) {
  console.error('accrue: --as-of YYYY-MM-DD is required (no default, never today)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const posted = await runAccrual(client, { asOf });
  const perLoan = new Map<string, { entries: number; cents: number }>();
  for (const p of posted) {
    const t = perLoan.get(p.loanId) ?? { entries: 0, cents: 0 };
    perLoan.set(p.loanId, { entries: t.entries + 1, cents: t.cents + p.amountCents });
  }
  for (const [loanId, t] of perLoan) console.log(`accrue: loan ${loanId}: ${t.entries} entries, ${t.cents} cents`);
  console.log(`accrue: as of ${asOf}: ${posted.length} entries posted across ${perLoan.size} loans`);
} catch (e) {
  console.error(`accrue: FAIL ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
