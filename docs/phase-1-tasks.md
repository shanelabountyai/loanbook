# Phase 1 — Ledger core + `ledger:verify`

Goal: the invariant holds before anything else exists (PRD P0-1). Fixtures: `fixtures/ledger/`. Do tasks in order; each starts with a failing test.

- [x] **1.1 Scaffold.** Clone of saas-foundation v1.2.0 on port 4700 (decisions D10), local `loanbook` and `loanbook_test` databases, npm scripts (`test`, `ledger:verify`, `fixtures:check`), CI running all three on every push, README banner verbatim. `ledger:verify` is a placeholder that fails as soon as a ledger table exists; task 1.9 replaces it.
- [x] **1.2 Money guard.** `money` module: integer-cent type/validator (reject floats, bools, non-ints). Rounding function lands here as the single home, but is only exercised in Phase 2.
- [x] **1.3 Chart of accounts.** Load `fixtures/ledger/chart_of_accounts.json`; expose normal side and `requires_loan_id`.
- [x] **1.4 Entry validation (domain).** Pass `entry_validation.json`: V1–V3 accepted; I1–I9 rejected with the exact error codes.
- [x] **1.5 Schema + DB enforcement.** Tables for entries and lines; deferred constraint enforcing debits = credits per entry; triggers rejecting UPDATE/DELETE/late-INSERT on existing entries (A1–A3). Re-run I1–I9 **directly against the DB** (bypassing the service) and confirm rejection.
- [x] **1.5b Disbursement fixture.** V1 posts `Dr loans_receivable 100000 / Cr cash 100000` and reads back identically (PRD P0-1 bullet 3). *Done 2026-09-29: `readEntry` in `src/ledger/read.ts`; every amount read goes through `centsFromNumeric` in `money.ts`.*
- [x] **1.6 Posting service.** Single write path; atomic; no other code inserts lines. *Done 2026-09-29: `postEntry` in `src/ledger/post.ts`; a lint rule refuses ledger writes anywhere else in `src/` and `scripts/`.*
- [x] **1.7 Derived balances.** Account balances and per-loan balances computed from lines. Pass TB1 exactly (totals, balances, per-loan). *Done 2026-09-30: `trialBalance` in `src/ledger/balances.ts`, one `GROUPING SETS` read signed by normal side in Postgres.*
- [x] **1.8 Reversals.** Reversing entry swaps sides, references original; nets to zero; second reversal rejected (`already_reversed`). Pass the `reversal` block. *Done 2026-09-30 (D13); VF3 now a test.*
- [x] **1.9 `ledger:verify`.** *(Built straight after 1.5, decided 2026-09-29: a red gate skips the CI tests. The reversal check lands with 1.8.)* Checks: every entry balances; system debits = credits; receivable lines carry `loan_id`; per-loan sub-ledgers sum to control accounts; reversals reference existing entries. Passes TB1 (`ok`); fails VF1–VF4 with exit ≠ 0 and the expected code + id. Verify tampered data is loaded *below* the service (raw SQL). *Done 2026-09-29 for VF1, VF2 and VF4; VF3 (`dangling_reversal`) done with 1.8 on 2026-09-30.*
- [x] **1.10 CI gate.** Pipeline fails if `ledger-verify` or `fixtures-check` fails. Prove it by pushing a deliberately unbalanced fixture on a throwaway branch. *Done 2026-09-30: throwaway PR #1, closed and deleted. Run 36733144653 (TB1 cash debit +1 cent) red at `fixtures:check`; run 36733495180 (unbalanced entry planted below the triggers) red at `ledger:verify` with `unbalanced_entry` and `unbalanced_ledger`. Both skipped vitest and Playwright. Phase 1 exit criteria checked the same day: all met.*

**Exit criteria:** all `fixtures/ledger/*` cases pass at both service and DB layers; `ledger:verify` clean on TB1 and correctly failing on VF1–VF4; CI enforces it; no balance stored anywhere.

**Before Phase 2:** recompute `fixtures/amortization/AM1.csv` by hand in a spreadsheet and match it to the cent.
