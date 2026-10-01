import { parseArgs } from 'node:util';
import pg from 'pg';
import { runStatus } from '@/ledger/delinquency';

// The late-fee run (task 4.3). `--as-of` is required: domain code never reads the clock (non-negotiable 6),
// and neither does this script. Prints each fee posted; exits 1 on any error.

const { values } = parseArgs({ options: { 'as-of': { type: 'string' } } });
const asOf = values['as-of'];
if (!asOf) {
  console.error('status: --as-of YYYY-MM-DD is required (no default, never today)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const posted = await runStatus(client, { asOf });
  for (const f of posted) console.log(`status: loan ${f.loanId}: installment ${f.installment} late fee ${f.cents} cents dated ${f.date}`);
  console.log(`status: as of ${asOf}: ${posted.length} late fees posted`);
} catch (e) {
  console.error(`status: FAIL ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
