import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeEach, expect, it } from 'vitest';
import pg from 'pg';
import { runStatus } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postEntry } from '@/ledger/post';
import { verifyLedger } from '@/ledger/verify';

// Task 4.3 (D20): runStatus assesses the late fee once per missed installment at grace exit, against DQ1-DQ5.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const second = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = Promise.all([client.connect(), second.connect()]);
afterAll(async () => {
  await client.end();
  await second.end();
});
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
});

const dir = 'fixtures/delinquency';
const am1 = JSON.parse(readFileSync('fixtures/amortization/AM1.json', 'utf8')).input;

type Fx = { id: string; input: { payments: { date: string; cents: number }[] }; expected: { days: { date: string }[]; fees: { installment: number; date: string; cents: number }[] } };

async function setup(fx: Fx) {
  const { loanId } = await createLoan(client, {
    principalCents: am1.principal_cents,
    aprBps: am1.apr_bps,
    termMonths: am1.term_months,
    disbursementDate: am1.disbursement_date,
  });
  for (const p of fx.input.payments) {
    await postEntry(client, {
      date: p.date,
      loanId,
      memo: 'payment',
      lines: [
        { account: 'cash', debitCents: p.cents, creditCents: 0 },
        { account: 'loans_receivable', debitCents: 0, creditCents: p.cents },
      ],
    });
  }
  return loanId;
}

const feesOf = (xs: { installment: number; date: string; cents: number }[]) => xs.map(({ installment, date, cents }) => ({ installment, date, cents }));

for (const f of readdirSync(dir)) {
  const fx: Fx = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  it(`${fx.id}: fees posted day by day match the fixture, once each`, async () => {
    const loanId = await setup(fx);
    const posted: ReturnType<typeof feesOf> = [];
    for (const d of fx.expected.days) {
      const today = await runStatus(client, { asOf: d.date });
      for (const p of today) expect(p.date).toBe(d.date); // a fee lands on its grace-exit day, not later
      posted.push(...feesOf(today));
    }
    expect(posted).toEqual(fx.expected.fees);
    expect(await runStatus(client, { asOf: fx.expected.days.at(-1)!.date })).toEqual([]);
    const owed = await owedCents(client, loanId);
    expect(owed.fees).toBe(fx.expected.fees.reduce((s, x) => s + x.cents, 0));
    expect((await verifyLedger(client)).findings).toEqual([]);
  });
}

it('one run far past the end catches up every missed fee, dated at each grace exit', async () => {
  const fx: Fx = JSON.parse(readFileSync(`${dir}/DQ2.json`, 'utf8'));
  await setup(fx);
  expect(feesOf(await runStatus(client, { asOf: '2026-06-20' }))).toEqual(fx.expected.fees);
});

it('two runs racing leave one fee per installment', async () => {
  const fx: Fx = JSON.parse(readFileSync(`${dir}/DQ2.json`, 'utf8'));
  const loanId = await setup(fx);
  await Promise.all([runStatus(client, { asOf: '2026-06-20' }), runStatus(second, { asOf: '2026-06-20' })]);
  const { rows } = await client.query(`SELECT "installment" FROM "LedgerEntry" WHERE "loanId" = $1 AND "kind" = 'late_fee' ORDER BY 1`, [loanId]);
  expect(rows.map((r) => r.installment)).toEqual([1, 2, 3, 4]);
  expect((await verifyLedger(client)).findings).toEqual([]);
});

it('the database refuses a second fee for an installment and an installment on a non-fee entry', async () => {
  const fx: Fx = JSON.parse(readFileSync(`${dir}/DQ1.json`, 'utf8'));
  const loanId = await setup(fx);
  const fee = { date: '2026-02-26', loanId, kind: 'late_fee' as const, installment: 1, lines: [{ account: 'fees_receivable' as const, debitCents: 1, creditCents: 0 }, { account: 'fees_income' as const, debitCents: 0, creditCents: 1 }] };
  await postEntry(client, fee);
  await expect(postEntry(client, fee)).rejects.toMatchObject({ constraint: 'already_fee_assessed' });
  await expect(postEntry(client, { ...fee, installment: 2, kind: null })).rejects.toMatchObject({ constraint: 'invalid_installment' });
});

const run = (...args: string[]) => spawnSync('node_modules/.bin/tsx', ['scripts/status.ts', ...args], { encoding: 'utf8' });

it('npm run status: --as-of required, prints each fee, exit 1 on a refusal, re-run posts none', async () => {
  const fx: Fx = JSON.parse(readFileSync(`${dir}/DQ3.json`, 'utf8'));
  await setup(fx);
  expect(run().status).toBe(1);
  expect(run('--as-of', 'tomorrow').status).toBe(1);
  const r = run('--as-of', '2026-02-26');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('installment 1 late fee 1500 cents dated 2026-02-26');
  expect(r.stdout).toContain('1 late fees posted');
  expect(run('--as-of', '2026-02-26').stdout).toContain('0 late fees posted');
});
