# NEXT

## Pick up here: Phase 1, task 1.9 — `ledger:verify` (pulled forward)

Model: **Opus 5.5** (the project pin). This is the gate every later task stands behind; do not drop to Sonnet.

Replace the placeholder in `scripts/ledger-verify.ts` with the real checks, against the tables that now exist.
Failing test first, from `fixtures/ledger/`: TB1 passes (`ok`), VF1 to VF4 each fail with exit code not 0 and
the expected code and id.

- Checks to build now: every entry balances; system debits = credits; receivable lines carry a loan id;
  per-loan sub-ledgers sum to the control accounts. **The reversal check (dangling reference) waits for task
  1.8**, which adds the column it reads. Say so in the script and leave that VF case marked as pending 1.8,
  not silently skipped.
- **The database now refuses the tampered data the VF cases need.** Unbalanced entries and a missing loan id
  are refused by triggers, so the test has to load them below the rules:
  `SET session_replication_role = replica` on the loading connection turns the triggers off for that session
  (superuser only; the local and CI roles are). CHECK constraints stay on, which is fine: no VF case needs a
  float or an unknown account. Confirm that against the fixtures before relying on it.
- Amounts are `DECIMAL(65,30)` (D12), so `pg` returns `"100000.000000000000000000000000000000"`. Cast in the
  SQL (`sum("debitCents")::bigint`) and pass the result through `assertCents`. That read edge does not exist
  yet; this task or 1.5b writes it, once, in `src/ledger/`.
- `ledger:verify` reads `.env.local` (database `loanbook`) locally and `loanbook_test` in CI. The test needs a
  way to point the script at the test database.
- When this lands, CI goes green again and runs vitest and Playwright. Check that run: it is the first full
  sweep over task 1.5's code.

Then, in order: 1.5b, 1.6, 1.7, 1.8 (adds the reversal check to verify), 1.10.
Task list: `docs/phase-1-tasks.md`. Fixtures: `fixtures/ledger/`.

## State at handoff (2026-09-29)

- Tasks 1.1 to 1.5 done. 1.5 is commit 3f24884: `prisma/schema/ledger.prisma`, migration
  `20260929000000_ledger_init`, and `tests/integration/ledger-db.test.ts` (27 tests, raw SQL on its own `pg`
  connection). Tables `LedgerEntry` and `LedgerLine`. Per line: four CHECK constraints named for their fixture
  codes. Per entry: a deferred constraint trigger (line count, loan id, balance, in the service's order).
  Append-only: triggers on UPDATE and DELETE, and on INSERT of a line into an entry from an earlier
  transaction. Every rejection carries its code in the error's `constraint` field; append-only uses
  `append_only`. The test was proven against a weakened test database: one CHECK dropped and three triggers
  disabled failed 7 of 27, then restored and green. `prisma migrate diff` against the schema: no difference.
- **Evidence for 1.5 is local and partial.** Local: the new file plus unit tests and one integration file,
  7 files 124/124; lint, typecheck and `fixtures:check` green. No local full sweep: load average was 46 on 10
  cores with another project's sweep running. CI run 36627480484 on 3f24884: lint, typecheck, migrate and
  `fixtures:check` passed, **`ledger:verify` failed as designed, and vitest and Playwright were skipped**
  because they sit after the gate. No full sweep has run over 1.5 anywhere yet.
- The migration is applied to both local databases, `loanbook` and `loanbook_test`.
- 1.4 is commit 0f48b26: `src/ledger/entry.ts` and `tests/unit/entry.test.ts`
  (22 tests). `assertValidEntry(entry)` throws `EntryError` with the code, except `non_integer_amount`, which
  arrives as the `MoneyError` from `assertCents`; a caller matches on `.code` of either. Input is
  `{ loanId, lines: [{ account, debitCents, creditCents }] }`. Local: entry, accounts and money tests 78/78,
  lint, typecheck, `fixtures:check` and `ledger:verify` green. No local full sweep was run; CI owns it: run
  36624990032 green on 68c228e, vitest 31 files 235/235 (213 + the 22 new), Playwright 10/10, both gates passing.
- 1.3 is commit a098eaf: `src/ledger/accounts.ts` and
  `tests/unit/accounts.test.ts` (18 tests). Local: accounts and money tests 56/56, lint, typecheck,
  `fixtures:check` and `ledger:verify` green. No local full sweep was run; CI owns it: run 36623967561
  green on 3b1fc47, vitest 30 files 213/213 (195 + the 18 new), Playwright 10/10, both gates passing.
- 1.2 is commit 8af7814: `src/ledger/money.ts`, `tests/unit/money.test.ts` (38 tests),
  and a lint rule in `eslint.config.mjs` that makes `/`, `Math.round`, `toFixed` and `parseFloat` errors in
  `src/ledger/**` outside `money.ts`. The rule was proven against a deliberate violation.
- **The last local full sweep (on 8af7814) was red, 192/195, and the cause was the machine, not the code.** Three failures, all in
  `tests/invariants/inv-09-rate-limits.test.ts` (template-owned, untouched): a 20s test timeout, a Prisma
  transaction past its 5000 ms limit, and deadlocks on the next test's TRUNCATE. Load average was 28 to 36 on
  10 cores, with sweeps running in rental business (17 connections) and callboard (10) and an event toolkit
  build. The sweep took 442s. CI is the full-sweep evidence: run 36595320519 green on 8af7814, vitest 29 files
  195/195, Playwright 10/10, `fixtures:check` and `ledger:verify` both passing.
- Before the next local sweep, check `sysctl -n vm.loadavg` and `pg_stat_activity` first.
- `ledger:verify` is still the placeholder, and red since 3f24884 because ledger tables now exist.
- Where LoanBook code goes: clone-owned paths only. `prisma/schema/ledger.prisma` and its own migrations,
  domain code in `src/ledger/`, tests outside `tests/invariants`.

## Decisions made

- D12 (2026-09-29): ledger line amounts are `numeric` under a CHECK, not `Int`. In `docs/decisions.md`, with
  the measurements. Not to be reopened.
- Task order (2026-09-29): 1.9 is built straight after 1.5, ahead of 1.5b to 1.8. Why: CI runs the gate
  before the tests, so a red gate skips vitest and Playwright, and the written order left four tasks with no
  CI sweep. Rejected: keeping the order, and moving vitest above the gate in `ci.yml`.
- DB error codes travel in the `constraint` field, by constraint name or `RAISE ... USING CONSTRAINT`.
- A line that breaks several CHECKs is reported under the first name alphabetically (Postgres's order), not
  the service's order. The fixture's cases each break one rule, so both layers agree on all of them.
- "Same transaction" for A3 is `xmin` against `pg_current_xact_id()`. Under a savepoint the entry's `xmin` is
  the savepoint's id, so entry and lines must be written at the same level or the lines are refused. It
  fails closed. The upgrade is in the migration's comment.
- No reversal column yet; task 1.8 adds it. `LedgerLine.position` holds line order, for 1.5b's read-back.

- Entry validation throws on the first rule broken. Order: line count, then each line in turn (account,
  integer cents, sides, loan id), then the balance. The fixture fixes only line count before balance (I2).
  A negative side is `non_positive_amount` whatever the other side holds. Date and memo are not validated
  in the domain; nothing in the fixture tests them.

- The chart of accounts is a typed table in code, and the test compares it to the fixture. Product code does
  not import from `fixtures/`: the fixture is the oracle, and code that read it would be checked against itself.

- D11 (2026-09-29): integer money is `number` plus `Number.isSafeInteger`; `bigint` only inside the rounding
  module. In `docs/decisions.md`. Not to be reopened.
- `roundHalfUp` refuses negative quantities, as the fixture oracle does. No rule in D3 to D9 rounds a negative.
- Stack: D10. Not to be reopened.
- No Makefile; commands are npm scripts.

## Links

- Repo: https://github.com/shanelabountyai/loanbook (private)
- Reusable start file: `~/.claude/docs/project-start.md`
- Not deployed. No Vercel project, no Neon project, nothing that can bill.
- The old folder `~/Projects/loanbookmicroloan` is retired and safe to delete. Open sessions in `~/Projects/loanbook`.
