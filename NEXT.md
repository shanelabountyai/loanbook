# NEXT

## Pick up here: Phase 1, task 1.3 — Chart of accounts

Model: **Opus 5.5** (the project pin). Sonnet is defensible: this item is a lookup table with no arithmetic.

Load `fixtures/ledger/chart_of_accounts.json`; expose each account's normal side and `requires_loan_id` (D8).
Failing test first, against the fixture. It goes in `src/ledger/`, beside `money.ts`.
Then 1.4 (entry validation) uses both: `assertCents` already throws `non_integer_amount`, the code case I9 expects.

Task list: `docs/phase-1-tasks.md`. Fixtures: `fixtures/ledger/`.

## State at handoff (2026-09-29)

- Tasks 1.1 and 1.2 done. 1.2 is commit 8af7814: `src/ledger/money.ts`, `tests/unit/money.test.ts` (38 tests),
  and a lint rule in `eslint.config.mjs` that makes `/`, `Math.round`, `toFixed` and `parseFloat` errors in
  `src/ledger/**` outside `money.ts`. The rule was proven against a deliberate violation.
- Local: lint, typecheck, `fixtures:check`, `ledger:verify` green; money tests 38/38.
- **The local full sweep was red, 192/195, and the cause was the machine, not the code.** Three failures, all in
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
