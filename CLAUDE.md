# CLAUDE.md — LoanBook

Learning project: double-entry ledger, amortization, accrual on an injected clock, payment waterfalls, delinquency states. **Synthetic data only. Never real borrowers or money. No compliance claims.** Keep the scope-honesty banner verbatim in README.md.

Read first: `prd-loanbook-microloan.md` (what), `docs/decisions.md` (rules the PRD left open — authoritative), `fixtures/README.md` (frozen expected values). Current work: `docs/phase-1-tasks.md`.

## Non-negotiables
1. **Balances are derived, never stored as mutable truth.** No balance columns. Balance = sum of ledger lines.
2. **Ledger is append-only.** Corrections are reversing entries that reference the original. No UPDATE/DELETE of entries or lines, enforced at the DB layer.
3. **Every entry balances** (debits = credits, ≥2 lines, each line exactly one positive side) — enforced at write time in the service **and** in the database.
4. **Integer cents and integer basis points only.** No floats in any money path. Non-integers are rejected at the boundary.
5. **One rounding rule (half up), one module.** No `round()`, no ad-hoc rounding elsewhere. Round once from an exact quantity.
6. **Time is injected.** Nothing reads the system clock in domain code; pass a clock/date. Jobs (accrual, status) take an `as_of` date.
7. **`ledger:verify` gates everything** and runs in CI on every push. If it fails, nothing else merges.
8. **Nothing sets loan state by hand.** State is computed from ledger + schedule + clock.

## Working rules
- **TDD order:** entry balancing → amortization → accrual → waterfall → payoff → delinquency. Write the failing test against a fixture first.
- **Fixtures are frozen.** Tests read `fixtures/`; code never generates them. Never edit a fixture to make a test pass — if a rule is wrong, change `docs/decisions.md` first, regenerate with `tools/build_fixtures.py`, confirm `tools/verify_fixtures.py` prints OK, and review the diff.
- `tools/build_fixtures.py` is a test oracle, not product code. Don't import or port it; implement from the rules in `docs/decisions.md`.
- Phase gate: don't start the next phase until the current phase's exit criteria pass. Phases: 1 ledger+verify → 2 amortization+accrual → 3 waterfall+payoff → 4 delinquency+views+P1.
- Money-affecting rule changes need a line in `docs/decisions.md`.
- Small commits; one concern each. Note seams for non-goals (variable rate, refinancing) but don't build them.
- Ask before adding dependencies; prefer stdlib for money math.
- **Model is pinned to Opus 5.5** in `.claude/settings.json` (global default is Sonnet 5.5). This is money logic; drop to Sonnet only for an item with no new logic (scaffold, docs). Decided 2026-09-29.

## Stack
TypeScript on a clone of saas-foundation v1.2.0: Next.js 16, Prisma 7, PostgreSQL 17, vitest, Playwright. Port 4700. Conventions follow storage business and rental business (`Int` cents named `...Cents`, basis points named `...Bps`). DB-level balance check via deferred constraint trigger; append-only via triggers, both as hand-written SQL in Prisma migrations. Python only in `tools/` (the oracle); product money math is pure integer. Template-owned paths (`src/core/**`, `tests/invariants/**`, core migrations) are never edited here. Decided in `docs/decisions.md` D10.

## Commands (create in Phase 1, task 1)
- `npm test` — full test suite (vitest, local `loanbook_test` database)
- `npm run ledger:verify` — exits non-zero on any imbalance, missing loan_id, dangling reversal, or control-account mismatch
- `npm run fixtures:check` — `python3 tools/build_fixtures.py && python3 tools/verify_fixtures.py && git diff --exit-code fixtures/`

## Definition of done (any task)
Tests green, `ledger-verify` clean, no float or stray rounding in money paths, decisions doc updated if a rule changed.
