import pg from 'pg';

// Task 1.1 placeholder. Task 1.9 replaces the body with the real checks (docs/phase-1-tasks.md).
// It passes only while no ledger table exists, so it cannot stay quietly green once there is a book to verify.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query<{ tablename: string }>(
  `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~* '(ledger|journal)'`,
);
await client.end();
if (rows.length) {
  console.error(`ledger:verify: not implemented, but ledger tables exist (${rows.map((r) => r.tablename).join(', ')}). Build task 1.9.`);
  process.exit(1);
}
console.log('ledger:verify: ok (no ledger tables yet, nothing to verify)');
