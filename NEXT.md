# NEXT

## Pick up here: Phase 1, task 1.4 — Entry validation (domain)

Model: **Opus 5.5** (the project pin). This one is rule logic with exact error codes; do not drop to Sonnet.

Pass `fixtures/ledger/entry_validation.json`: V1 to V3 accepted, I1 to I9 rejected with the exact code.
Failing test first, driven by the fixture cases. Pure function in `src/ledger/`, no database (that is 1.5).
The pieces already exist:

- `isAccount(name)` in `src/ledger/accounts.ts` gives `unknown_account` (I7).
- `CHART[name].requiresLoanId` gives `missing_loan_id` (I8). **`loan_id` is on the entry, not the line.**
- `assertCents` in `src/ledger/money.ts` throws `non_integer_amount` (I9).

Still to write: `unbalanced`, `too_few_lines`, `line_must_have_exactly_one_side`, `non_positive_amount`.
Read each invalid case for which code it expects before fixing the order of the checks: a case that breaks
two rules names only one code.

Task list: `docs/phase-1-tasks.md`. Fixtures: `fixtures/ledger/`.

## State at handoff (2026-09-29)

- Tasks 1.1, 1.2 and 1.3 done. 1.3 is commit a098eaf: `src/ledger/accounts.ts` and
  `tests/unit/accounts.test.ts` (18 tests). Local: accounts and money tests 56/56, lint, typecheck,
  `fixtures:check` and `ledger:verify` green. No local full sweep was run; CI owns it.
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
