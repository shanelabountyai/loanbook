import { parseArgs } from 'node:util';
import pg from 'pg';
import { PAYMENT_ORDER } from '@/ledger/config';
import { postPayment } from '@/ledger/payment';

// A payment (task 3.6). All three flags required: domain code never reads the clock (non-negotiable 6).
// Prints the split; exits 1 on any refusal (accrual_pending, exceeds_payoff, ...).

const { values } = parseArgs({ options: { loan: { type: 'string' }, date: { type: 'string' }, cents: { type: 'string' } } });
const { loan, date, cents } = values;
if (!loan || !date || !cents || !/^-?\d+$/.test(cents)) {
  console.error('pay: --loan <id> --date YYYY-MM-DD --cents N are all required (integer cents, no default, never today)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const r = await postPayment(client, { loanId: loan, date, paymentCents: Number(cents), order: PAYMENT_ORDER });
  const { fees, interest, principal } = r.allocation;
  console.log(`pay: loan ${loan} on ${date}: ${cents} cents = fees ${fees}, interest ${interest}, principal ${principal}`);
  console.log(`pay: remaining fees ${r.remaining.fees}, interest ${r.remaining.interest}, principal ${r.remaining.principal}${r.loanClosed ? ' (loan closed)' : ''}`);
} catch (e) {
  console.error(`pay: FAIL ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`.replace(/\s+/g, ' '));
  process.exitCode = 1;
} finally {
  await client.end();
}
