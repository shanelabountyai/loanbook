import pg from 'pg';
import { verifyLedger } from '@/ledger/verify';

// The gate (CLAUDE.md non-negotiable 7). Exits 1 on any finding; the checks are in src/ledger/verify.ts.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { findings, entries, debits, credits } = await verifyLedger(client).finally(() => client.end());

for (const f of findings) {
  const where = f.entryId ? ` entry ${f.entryId}` : f.account ? ` account ${f.account}` : '';
  console.error(`ledger:verify: FAIL ${f.code}${where}: ${f.detail}`);
}
if (findings.length) {
  console.error(`ledger:verify: ${findings.length} finding(s) in ${entries} entries`);
  process.exit(1);
}
console.log(`ledger:verify: ok (${entries} entries, debits ${debits} = credits ${credits})`);
