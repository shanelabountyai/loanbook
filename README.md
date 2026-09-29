# LoanBook — Microloan Servicing

> **Scope honesty:** Learning project, synthetic data only. Real lending is regulated (TILA/Reg Z disclosures, state usury caps, servicing rules); this project models the *accounting mechanics*, makes no compliance claims, and must never touch real borrowers or real money.

Small fixed-term installment loans ($500–$5,000) serviced on an append-only, double-entry ledger. See `prd-loanbook-microloan.md`, `docs/decisions.md`, `docs/phase-1-tasks.md`, and `CLAUDE.md`.

## Built on saas-foundation

> Cloned from saas-foundation v1.2.0. Port 4700. Upgrade with `npm run foundation:status`; template-owned paths are listed in the template's plan §3.2.

The foundation supplies sign-in, orgs and roles, the audit log, CI and the Playwright setup. Its layout, module removal and upgrade steps are in the template's own README. LoanBook's code lives in clone-owned paths only.

## Commands

Needs Node 22+, Python 3 (the fixture oracle, stdlib only) and a local Postgres 17.

| Command | What it does |
|---|---|
| `npm run db:setup` | creates `loanbook` and `loanbook_test`, writes `.env.local` and `.env.test`, migrates both |
| `npm test` | vitest against the local test database |
| `npm run ledger:verify` | proves the book balances; exits non-zero on any imbalance (placeholder until task 1.9) |
| `npm run fixtures:check` | regenerates the fixtures, re-derives them a second way, and fails on any diff |
| `npm run lint` / `typecheck` | ESLint and `tsc` |
| `npm run dev` | http://localhost:4700 |
