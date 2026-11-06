# LoanBook — Microloan Servicing

> **Scope honesty:** Learning project, synthetic data only. Real lending is regulated (TILA/Reg Z disclosures, state usury caps, servicing rules); this project models the *accounting mechanics*, makes no compliance claims, and must never touch real borrowers or real money.

Small fixed-term installment loans ($500–$5,000) serviced on an append-only, double-entry ledger. See `prd-loanbook-microloan.md`, `docs/decisions.md`, `docs/phase-1-tasks.md`, and `CLAUDE.md`.

## Built on saas-foundation

> Cloned from saas-foundation v1.2.0. Port 4700. Upgrade with `npm run foundation:status`; template-owned paths are listed in the template's plan §3.2.

The foundation supplies sign-in, orgs and roles, the audit log, CI and the Playwright setup. Its layout, module removal and upgrade steps are in the template's own README. LoanBook's code lives in clone-owned paths only.

### Row-level security on Neon (optional, `RLS_MODE=enforce`)

`db:setup` gives you two roles locally: the owner (`DATABASE_URL` while RLS is off, `DATABASE_URL_SYSTEM`, `DIRECT_URL`) and
`<name>_app_rw` with `NOBYPASSRLS` (`DATABASE_URL_APP_RW`). To enforce locally, set `DATABASE_URL` to the app_rw URL and
`RLS_MODE=enforce` together: app_rw with RLS off sees no org rows, because off mode sets no org. On Neon, the role the console creates is a `neon_superuser` with `BYPASSRLS`, so the app role is made
in SQL, as the owner, on the branch:

```sql
CREATE ROLE app_rw LOGIN PASSWORD '<generate one>' NOBYPASSRLS NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
```

Then in Vercel: `DATABASE_URL` = app_rw through the pooler (`-pooler` host), `DATABASE_URL_SYSTEM` = the owner through the pooler,
`DIRECT_URL` = the owner without the pooler, `RLS_MODE=enforce`. Run `npm run rls:policies` once for your own org-owned models and
commit the migration; INV-30 fails until you do. The pooler accepts an SQL-created role (spike S4a ran through it).

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
