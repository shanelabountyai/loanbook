import pg from 'pg';
import { verifyLedger } from '@/ledger/verify';

// The gate (CLAUDE.md non-negotiable 7). Exits 1 on any finding; the checks are in src/ledger/verify.ts.
// The reversal check is not built: task 1.8 adds the column it reads. Every run says so, so a green
// gate is never read as covering it.
const PENDING = 'reversal check pending task 1.8';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { findings, entries, debits, credits } = await verifyLedger(client).finally(() => client.end());

for (const f of findings) {
  const where = f.entryId ? ` entry ${f.entryId}` : f.account ? ` account ${f.account}` : '';
  console.error(`ledger:verify: FAIL ${f.code}${where}: ${f.detail}`);
}
if (findings.length) {
  console.error(`ledger:verify: ${findings.length} finding(s) in ${entries} entries (${PENDING})`);
  process.exit(1);
}
console.log(`ledger:verify: ok (${entries} entries, debits ${debits} = credits ${credits}; ${PENDING})`);
