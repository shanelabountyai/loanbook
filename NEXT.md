# NEXT

## Pick up here: Phase 1, task 1.6 — posting service

Model: **Opus 5.5** (the project pin). Single write path for money.

Single write path; atomic; no other code inserts lines. Build it on `assertValidEntry` (1.4) and write in
one transaction at one level (the A3 trigger refuses lines written under a savepoint the entry was not).
Read back with `readEntry` (1.5b). Failing test first: V1-V3 accepted, I1-I9 refused by the service with
the fixture's codes.

Then, in order: 1.7, 1.8 (adds the reversal check to verify, and turns VF3 from `todo` to a test), 1.10.
Task list: `docs/phase-1-tasks.md`. Fixtures: `fixtures/ledger/`.

## State at handoff (2026-09-29)

- 1.5b done: `src/ledger/read.ts` (`readEntry`, returns `null` for an unknown id) and `centsFromNumeric` in
  `money.ts`, the one read edge: accepts `-?digits` with optional all-zero scale, refuses any fraction,
  exponent or whitespace, then `assertCents`. Tests: `tests/integration/ledger-read.test.ts` (2) and 13 new in
  `tests/unit/money.test.ts`. Mutants killed: reading a fraction as whole, and `ORDER BY position DESC`.
  **Survived:** dropping `ORDER BY` entirely, because Postgres walks the `(entryId, position)` unique index
  and returns position order anyway. The `ORDER BY` stays; no test can force that plan. Local: lint,
  typecheck, both gates, 8 ledger/unit files 145/145 plus the `todo`. No local full sweep; CI owns it.

- Tasks 1.1 to 1.5 and 1.9 done. 1.9: `src/ledger/verify.ts` (the checks), `scripts/ledger-verify.ts` (prints
  and exits), `tests/integration/ledger-verify.test.ts` (7 tests and 1 `todo`). Four checks: each entry
  balances, the ledger balances, per-loan accounts carry a loan id, sub-ledgers sum to the control account.
  All four run in one read-only `REPEATABLE READ` transaction. Every run prints
  `reversal check pending task 1.8`, pass or fail. The test was proven by turning each check off in turn:
  each one turned it red (VF1 for the two balance checks, VF2 and VF4 for the other two).
- **Evidence for 1.9, and the first full sweep over 1.5.** CI run 36628825666 green on 946d2fc: vitest 33
  files 269/269 plus 1 `todo` (235 at task 1.4, + 27 from 1.5, + 7 from 1.9), Playwright 10/10,
  `fixtures:check` and `ledger:verify` both passing, both jobs with no failed or skipped step. Local: lint,
  typecheck and both gates green; 5 files 112/112 plus the `todo`. No local full sweep was run.

- 1.5 is commit 3f24884: `prisma/schema/ledger.prisma`, migration
  `20260929000000_ledger_init`, and `tests/integration/ledger-db.test.ts` (27 tests, raw SQL on its own `pg`
  connection). Tables `LedgerEntry` and `LedgerLine`. Per line: four CHECK constraints named for their fixture
  codes. Per entry: a deferred constraint trigger (line count, loan id, balance, in the service's order).
  Append-only: triggers on UPDATE and DELETE, and on INSERT of a line into an entry from an earlier
  transaction. Every rejection carries its code in the error's `constraint` field; append-only uses
  `append_only`. The test was proven against a weakened test database: one CHECK dropped and three triggers
  disabled failed 7 of 27, then restored and green. `prisma migrate diff` against the schema: no difference.
- Evidence for 1.5: CI run 36628825666 (above) is its full sweep. Run 36627480484 on 3f24884 stopped at the
  gate as designed, with vitest and Playwright skipped.
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
- Where LoanBook code goes: clone-owned paths only. `prisma/schema/ledger.prisma` and its own migrations,
  domain code in `src/ledger/`, tests outside `tests/invariants`.

## Decisions made

- `ledger:verify` reports every finding, not the first, and exits 1 on any (2026-09-29).
- A ledger that does not balance is `unbalanced_ledger`. The fixture names no code for it; it comes with
  `unbalanced_entry` in VF1, and alone only if lines exist whose sums cancel per entry but not overall.
- **VF2 and VF4 raise the same pair of findings**, `missing_loan_id` and `control_account_mismatch`. The loan
  id is on the entry (D8), not the line, so the fixture's "drop the tag from a line" is done on the entry,
  and an entry without a tag is always also a line missing from its sub-ledger. The two checks would come
  apart only if lines carried their own loan id. The test pins the pair, in `ALSO`.
- Verify compares in Postgres on the exact numeric and never turns an amount into a JavaScript number.
- The test loads tampered books with `SET LOCAL session_replication_role = replica`, inside the loading
  transaction, so the triggers are back on at commit. A test holds that.

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
