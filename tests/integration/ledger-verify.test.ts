import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import tb1 from '../../fixtures/ledger/TB1_trial_balance.json';
import fixture from '../../fixtures/ledger/verify_failures.json';
import { verifyLedger } from '@/ledger/verify';

// Task 1.9: the gate. Each case is checked twice: the findings from verifyLedger, exactly, and the
// exit code and output of the script CI runs. Tampered books are loaded below the rules, on this
// file's own connection: the triggers from task 1.5 refuse them otherwise. CHECK constraints stay
// on, and no case here needs one off.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('ROLLBACK');
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry"'); // row triggers do not fire on TRUNCATE
});

type Entry = {
  id: string;
  date: string;
  loan_id: string | null;
  memo?: string;
  lines: { account: string; debit: number; credit: number }[];
};

/** Turns the triggers off for the rest of the transaction (superuser only; the local and CI roles are). */
const belowTheRules = () => client.query('SET LOCAL session_replication_role = replica');

/** One transaction. Returns the database id given to each fixture id. */
const load = async (entries: Entry[], { tampered }: { tampered: boolean }) => {
  const ids = new Map<string, string>();
  await client.query('BEGIN');
  if (tampered) await belowTheRules();
  for (const e of entries) {
    const id = randomUUID();
    ids.set(e.id, id);
    await client.query('INSERT INTO "LedgerEntry" ("id", "date", "loanId", "memo") VALUES ($1, $2, $3, $4)', [
      id,
      e.date,
      e.loan_id,
      e.memo ?? null,
    ]);
    for (const [position, l] of e.lines.entries()) {
      await client.query(
        `INSERT INTO "LedgerLine" ("id", "entryId", "position", "account", "debitCents", "creditCents")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [id, position, l.account, l.debit, l.credit],
      );
    }
  }
  await client.query('COMMIT');
  return ids;
};

/** The script as CI runs it, against this process's database. */
const runScript = () => spawnSync('node_modules/.bin/tsx', ['scripts/ledger-verify.ts'], { encoding: 'utf8' });

describe('ledger:verify passes a sound book', () => {
  it('an empty ledger is clean (the gate runs on a freshly migrated database in CI)', async () => {
    expect(await verifyLedger(client)).toEqual({ findings: [], entries: 0, debits: '0', credits: '0' });
    expect(runScript().status).toBe(0);
  });

  it('TB1 is clean, loaded through the rules, and its totals are the fixture’s', async () => {
    await load(tb1.entries, { tampered: false });
    const { expected } = tb1;
    expect(await verifyLedger(client)).toEqual({
      findings: [],
      entries: tb1.entries.length,
      debits: String(expected.total_debits_cents),
      credits: String(expected.total_credits_cents),
    });
    const run = runScript();
    expect([run.status, run.stderr]).toEqual([0, '']);
    expect(run.stdout).toContain(expected.verify_result);
    expect(run.stdout).toContain(String(expected.total_debits_cents));
  });
});

// What else each tampered book sets off, beside the code the fixture expects. The loan id is on the
// entry (D8), so an entry without one is also a line missing from its sub-ledger: VF2 and VF4 raise
// the same pair. An unbalanced entry unbalances the ledger.
const ALSO: Record<string, string[]> = {
  VF1: ['unbalanced_ledger'],
  VF2: ['control_account_mismatch'],
  VF4: ['missing_loan_id'],
};

describe('ledger:verify fails a tampered book (verify_failures.json)', () => {
  it('covers every case in the fixture', () => {
    expect(fixture.cases.map((c) => [c.id, c.expect.code])).toEqual([
      ['VF1', 'unbalanced_entry'],
      ['VF2', 'missing_loan_id'],
      ['VF3', 'dangling_reversal'],
      ['VF4', 'control_account_mismatch'],
    ]);
  });

  it.todo('VF3 dangling_reversal: waits for task 1.8, which adds the column the check reads');

  it.each(fixture.cases.filter((c) => c.id !== 'VF3').map((c) => [c.id, c.expect.code, c] as const))(
    '%s: %s',
    async (caseId, code, c) => {
      const ids = await load(c.entries, { tampered: true });
      if (c.tamper) {
        // The fixture drops the tag from a line; here the tag is the entry's.
        expect(c.tamper.set_line_loan_id_null).toBe(0);
        await client.query('BEGIN');
        await belowTheRules();
        await client.query('UPDATE "LedgerEntry" SET "loanId" = NULL WHERE "id" = $1', [ids.get(c.tamper.entry_id)]);
        await client.query('COMMIT');
      }
      const entryId = c.expect.entry_id && ids.get(c.expect.entry_id);
      const where = entryId ? { entryId } : { account: c.expect.account };

      const { findings } = await verifyLedger(client);
      expect(findings).toContainEqual(expect.objectContaining({ code, ...where }));
      expect(findings.map((f) => f.code).sort()).toEqual([code, ...ALSO[caseId]!].sort());

      const run = runScript();
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(code);
      expect(run.stderr).toContain(entryId ?? c.expect.account);
    },
  );

  it('the triggers are back on once a tampered load has committed', async () => {
    await load(fixture.cases[0]!.entries, { tampered: true });
    const refused = await client
      .query('UPDATE "LedgerEntry" SET "memo" = $1', ['edited'])
      .then(() => 'accepted', (err: pg.DatabaseError) => err.constraint);
    expect(refused).toBe('append_only');
  });
});
