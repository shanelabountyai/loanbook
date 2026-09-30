# NEXT

## Pick up here: Phase 2 exit check, then Phase 3

2.6 done (2026-09-30): `scripts/accrue.ts` + `npm run accrue -- --as-of YYYY-MM-DD` (`--as-of` required, never
defaults to today; per-loan `entries, cents` lines plus a total; exit 1 on missing/invalid date or any error).
Test `tests/integration/accrue-script.test.ts` (2) runs the script as a person does: two loans five days apart, 31-day
run, totals against `cumulativeInterestCents`, `verifyLedger` clean, re-run posts 0; missing and bad `--as-of` exit 1 and
write nothing. Local: lint, typecheck, both gates, unit + integration 23 files 294/294. CI run 36764692631 green on a2c9e41: vitest 43 files 392/392 (390 + 2), Playwright 10/10, both gates passing.
Next: verify Phase 2 exit criteria (docs/phase-2-tasks.md) against CI, then Phase 3 (waterfall + payoff); model **Opus 5.5**.

## Earlier: task 2.6 brief (done above)

2.5 done (2026-09-30, D15): migration `20260930200000_ledger_accrual_kind` (`LedgerEntry.kind`, CHECK `invalid_kind`,
partial unique index `already_accrued` on (`loanId`, `date`) where `kind = 'accrual'`), applied to both local
databases, schema diff empty. `postEntry` takes optional `kind`. `runAccrual(db, { asOf })` in `src/ledger/accrue.ts`
returns `{ loanId, date, amountCents, entryId }[]`; on `already_accrued` it stops that loan (the racing winner owns it).
Test `tests/integration/accrual-run.test.ts` (9): AC5 three runs, AC3 in two runs and in one, AC4 1019 via
`trialBalance`, DB refusal (`already_accrued`, `invalid_kind`), two racing runs, a 0-cent day carried, disbursement
day and an undisbursed loan accrue nothing, bad `asOf`. Mutants killed: D6 same-day effect (2 red), no segment reset
(2), per-day rounding (5), no posted-day skip (2), index dropped from the test DB (2). Survived, equivalent: the SQL
`< asOf` as `<=` (the loop never consumes a line dated `asOf`). Local: lint, typecheck, both gates, unit + ledger +
loan + accrual 16 files 251/251. CI run 36760869177 green on f84782e: vitest 42 files 390/390 (381 + 9), Playwright 10/10, both gates passing.
For 2.6: `scripts/accrue.ts` wrapping `runAccrual`, `--as-of` required, print per-loan counts, exit non-zero on error;
model **Sonnet** is defensible (wiring, no new money logic), Opus if the two-loan test grows logic.

2.4 done (2026-09-30): `src/ledger/accrual.ts`, pure. `cumulativeInterestCents(principalCents, aprBps, days)` =
`roundHalfUp(P·a·d, 3650000)`, one exact fraction rounded once (D4, 365 in leap years too).
`accrueSegment({ principalCents, aprBps, effectiveDate, days })` returns the fixture's rows (`date` = effective + d,
`dayNumber`, `cumulativeCents`, `entryCents` = cumulative(d) − cumulative(d−1), D5). Inputs refused up front:
`non_integer_amount`, `non_integer_rate`, `invalid_rounding_input` (negative principal or rate), `invalid_count`
(negative or fractional days), `invalid_date`. Test `tests/unit/accrual.test.ts` (16): AC1, AC2, AC4 every entry
and total; AC3's two segments 329 + 592, every entry; 986 not 990; 1019 against 1000; 366 days = 12033. Mutants
killed: per-day rounding (4 red), 366 denominator (7 red). Local: lint, typecheck, both gates, unit 173/173. CI run 36747934484 green on 3d7302b: vitest 41 files 381/381 (365 + 16), Playwright 10/10, both gates passing.
For 2.5: the run needs only `cumulativeInterestCents` (entry = cumulative(day) − accrual already posted in the
segment); `accrueSegment` is the fixture-shaped view. Model: **Opus 5.5** (idempotency, DB index, D6).

2.3 done (2026-09-30): `prisma/schema/loan.prisma`, migration `20260930100000_loan_init` (applied to both local
databases, schema diff empty). `Loan` holds terms only (id TEXT, `principalCents`, `aprBps`, `termMonths`,
`disbursementDate`, `createdAt`); CHECKs `invalid_principal`, `invalid_rate`, `invalid_term`; UPDATE/DELETE refused
by `Loan_append_only`, which reuses `ledger_append_only()` (code `append_only`). `createLoan(db, terms)` in
`src/ledger/loan.ts` calls `buildSchedule` first (so D14 and every input rule refuse before any write), inserts,
then posts the disbursement through `postEntry`; returns `{ loanId, entryId }`. Test `tests/integration/loan.test.ts`
(10): L1 stored and disbursed as V1, per-loan receivable 100000, verify clean; no balance column; six refusals
writing nothing; the DB CHECKs and append-only by raw SQL. Mutants killed: validation removed (6 red), sides
swapped (1), trigger dropped (1), rate CHECK dropped (1 more). Local: lint, typecheck, both gates, unit + ledger +
loan 14 files 226/226. CI run 36746080606 green on 8b175ee: vitest 40 files 365/365 (355 + 10), Playwright 10/10, both gates passing.
Next: 2.4 accrual math, pure. Model: **Opus 5.5** (money rounding, D4/D5).

- 2.1 done: `src/ledger/calendar.ts` (`assertDate`, `addDays`, `daysBetween`, `addMonthsClamped`). CI run
  36734894305 green on 7bb13d1.
- 1.10 done: the gate proven on throwaway PR #1 (closed, branch deleted). Run 36733144653: TB1 cash debit
  +1 cent, red at `fixtures:check` (the diff shows `500001` rebuilt as `500000`). Run 36733495180: fixture
  restored, an unbalanced entry (Dr loans_receivable 100 / Cr cash 99) planted by psql under
  `session_replication_role = replica` just before the gate, red at `ledger:verify` with `unbalanced_entry`
  and `unbalanced_ledger`, exit 1. Both runs skipped vitest and Playwright. Nothing changed on `main`'s
  `ci.yml`: the gate steps were already in place; CI only runs on `main` pushes and PRs, hence the draft PR.

## State at handoff (2026-09-30)

- 1.8 done (D13): column `LedgerEntry.reversesEntryId`, migration `20260930000000_ledger_reversal` (unique index
  `already_reversed`, self foreign key `dangling_reversal`), applied to both local databases, schema diff empty.
  `reverseEntry(db, { entryId, date, memo })` in `post.ts` reads the original, swaps each line's sides, keeps
  its loan id, and maps the unique violation to `EntryError('already_reversed')`; unknown id is
  `dangling_reversal`. `postEntry` and it share one private `write`. `readEntry` returns `reversesEntryId`.
  `verify.ts` has a fifth check, `dangling_reversal`; the script's `pending task 1.8` line is gone.
  Tests: `tests/integration/ledger-reversal.test.ts` (7: the fixture's reversal, net zero, second refused,
  a race leaves one, unknown refused, and both DB rules by raw SQL). VF3 in `ledger-verify.test.ts` is
  now a test, no `todo` left. Mutants killed: no swap (2 red), no code mapping (2), no verify check (1),
  unique index dropped from the test DB (3). Local: lint, typecheck, `fixtures:check`, `ledger:verify`,
  9 ledger and unit files 150/150. No local full sweep (load average 43); CI owns it: run 36732044338 green on b350246, vitest 37 files 307/307 and no `todo` (299 + 7 new + VF3), Playwright 10/10, `fixtures:check` and `ledger:verify` passing, both jobs successful.

- 1.7 done: `src/ledger/balances.ts`, `trialBalance(db)` returns `{ totalDebitsCents, totalCreditsCents,
  balancesCents, perLoanCents }`. It is one statement with `GROUPING SETS ((), (account), (account, loanId))`,
  so all three views come from one snapshot. The balance is signed by normal side in Postgres, and every amount
  goes through `centsFromNumeric`. Every chart account appears, zero if it has no lines. Test
  `tests/integration/ledger-balances.test.ts` (2): TB1 is posted through `postEntry` and matches `expected`
  exactly, and an empty ledger gives all zeros and no loans. Mutants killed: normal side ignored, write_offs in
  the per-loan view, wrong grouping set, credit side dropped. Local: lint, typecheck, both gates, 8 ledger
  and unit files 142/142 plus the `todo`. No local full sweep; CI owns it:
  run 36730676698 green on 68ba958, vitest 36 files 299/299 plus 1 `todo` (297 + 2 new), Playwright 10/10,
  `fixtures:check` and `ledger:verify` passing, both jobs successful.

- 1.6 done: `src/ledger/post.ts`, `postEntry(db, { date, loanId, memo, lines })` returns the new id.
  Validates with `assertValidEntry` before touching the database, then BEGIN, entry, lines in order, COMMIT;
  ROLLBACK and rethrow on any error. Test `tests/integration/ledger-post.test.ts` (13): V1-V3 posted and read
  back identically through `readEntry`; I1-I9 refused with the fixture's code and nothing written; a failure
  on the second line insert rolls the entry back and leaves the connection usable. Mutants killed: no
  validation (9 red), no ROLLBACK (1), no BEGIN (4), reversed positions (3).
  `eslint.config.mjs`: a `WRITES` rule refuses `INSERT INTO "Ledger...` literals and Prisma's
  `ledgerEntry`/`ledgerLine` accessors across `src/**` and `scripts/**`, except `post.ts`. Proven on planted
  violations in `src/ledger` and `scripts`. Local: lint, typecheck, both gates, ledger + unit files 158/158
  plus the `todo`. No local full sweep; CI owns it: run 36631656561 green on 4be6765, vitest 35 files
  297/297 plus 1 `todo` (284 + 13 new), Playwright 10/10, `fixtures:check` and `ledger:verify` passing, both
  jobs with no failed or skipped step.

- 1.5b done: `src/ledger/read.ts` (`readEntry`, returns `null` for an unknown id) and `centsFromNumeric` in
  `money.ts`, the one read edge: accepts `-?digits` with optional all-zero scale, refuses any fraction,
  exponent or whitespace, then `assertCents`. Tests: `tests/integration/ledger-read.test.ts` (2) and 13 new in
  `tests/unit/money.test.ts`. Mutants killed: reading a fraction as whole, and `ORDER BY position DESC`.
  **Survived:** dropping `ORDER BY` entirely, because Postgres walks the `(entryId, position)` unique index
  and returns position order anyway. The `ORDER BY` stays; no test can force that plan. Local: lint,
  typecheck, both gates, 8 ledger/unit files 145/145 plus the `todo`. No local full sweep; CI owns it:
  run 36630488191 green on b270c35, vitest 34 files 284/284 plus 1 `todo` (269 + 15 new), Playwright 10/10,
  `fixtures:check` and `ledger:verify` passing, both jobs with no failed or skipped step.

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

- 2.3: `LedgerEntry.loanId` is not a foreign key to `Loan` — ledger fixtures and tests post for loans with no
  row. Revisit if a check "every loan id in the ledger has a Loan row" is wanted; that belongs in `ledger:verify`,
  not a FK. Refinancing seam: a new terms row naming the one it supersedes, never an UPDATE.

- Per-loan balances (1.7) are the receivables only (asset accounts that require a loan id): loans, interest,
  fees. `write_offs` carries a loan id but is an expense, not what the borrower owes. It is left out, as TB1's
  `per_loan_cents` does. A loan appears once it has a line on a receivable. Untagged lines are left to verify.

- `postEntry` owns its transaction; the caller's connection must not already be in one (a surrounding BEGIN
  would be committed by it). Composing several entries atomically waits for the task that needs it (payment
  waterfall, Phase 3).
- The single-write-path rule lives in `eslint.config.mjs`. Flat config replaces a rule set twice rather than
  merging it, so `ROUNDING` and `WRITES` are constants and each block carries the full list for its files.
- Tests stay outside the write rule: tampered books and the 1.5b read test load rows below the service.

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
