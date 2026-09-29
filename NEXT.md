# NEXT

## Pick up here: Phase 1, task 1.5 — Schema + DB enforcement

Model: **Opus 5.5** (the project pin). Constraint triggers on the money tables; do not drop to Sonnet.

Tables for entries and lines in `prisma/schema/ledger.prisma`, with the enforcement as hand-written SQL in
the migration, the way `prisma/migrations/20260923100000_audit_append_only` does it. Failing test first:
I1 to I9 and A1 to A3 from `fixtures/ledger/entry_validation.json`, sent as raw SQL so nothing in
`src/ledger/entry.ts` can catch them first.

- Balance and line count are per entry, so they go in a deferred constraint trigger (checked at commit).
- One positive side and the amount sign are per line: plain `CHECK` constraints.
- Append-only: triggers rejecting UPDATE, DELETE, and an INSERT of a line into an entry that already exists (A3).
- **I9 cannot be left to the column type.** Measured on local Postgres 17: `INSERT` of `10.5` into an `integer`
  column succeeds and stores `11` (and `-10.5` stores `-11`). An `Int` column rounds a float silently, which is
  the one thing non-negotiable 4 forbids. Decide how the DB layer refuses it, and write the rule into
  `docs/decisions.md` before the migration.
- The fixture says "match on error code" at the DB layer too. Decide how a constraint carries the code
  (constraint name or `RAISE ... USING`) before writing twelve of them.
- This task turns `ledger:verify` red until 1.9 lands. That is deliberate (see below).

Task list: `docs/phase-1-tasks.md`. Fixtures: `fixtures/ledger/`.

## State at handoff (2026-09-29)

- Tasks 1.1 to 1.4 done. 1.4 is commit 0f48b26: `src/ledger/entry.ts` and `tests/unit/entry.test.ts`
  (22 tests). `assertValidEntry(entry)` throws `EntryError` with the code, except `non_integer_amount`, which
  arrives as the `MoneyError` from `assertCents`; a caller matches on `.code` of either. Input is
  `{ loanId, lines: [{ account, debitCents, creditCents }] }`. Local: entry, accounts and money tests 78/78,
  lint, typecheck, `fixtures:check` and `ledger:verify` green. No local full sweep was run; CI owns it.
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
- `ledger:verify` is still the placeholder. It fails as soon as a table named like `ledger` or `journal`
  exists, so task 1.5 turns the gate red until task 1.9 lands. That is deliberate.
- Where LoanBook code goes: clone-owned paths only. `prisma/schema/ledger.prisma` and its own migrations,
  domain code in `src/ledger/`, tests outside `tests/invariants`.

## Decisions made

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
