# NEXT

## Pick up here: Phase 1, task 1.2 — Money guard

Model: **Opus 5.5** (the project pin). This is the first item with money logic.

Start by settling `docs/decisions.md` open item 1 (integer money in TypeScript), as a clickable question.
The proposal on the table: cents and bps are `number` guarded by `Number.isSafeInteger` at every boundary;
exact intermediate quantities are `bigint` rationals inside the single rounding module; `/` on money is
banned outside it. Record the answer as D11, then write the failing test first.

Task list: `docs/phase-1-tasks.md`. Fixtures: `fixtures/ledger/`.

## State at handoff (2026-09-29)

- Task 1.1 done. Clone of saas-foundation v1.2.0, port 4700, databases `loanbook` and `loanbook_test`.
- Local gate green: lint, typecheck, `npm test` 157/157, `npm run fixtures:check`, `npm run ledger:verify`.
- CI green on the first push (run 36592364781): both gate steps, vitest, Playwright, and the modules-removed job.
- `ledger:verify` is a placeholder (`scripts/ledger-verify.ts`). It fails as soon as a table named like
  `ledger` or `journal` exists, so task 1.5 turns the gate red until task 1.9 lands. That is deliberate.
- Where LoanBook code goes: clone-owned paths only. `prisma/schema/ledger.prisma` and its own migrations,
  domain code outside `src/core` and `src/modules`, tests outside `tests/invariants`.

## Decisions made this session

- Stack: D10 in `docs/decisions.md`. Not to be reopened.
- Project folder moved from `~/Projects/loanbookmicroloan` to `~/Projects/loanbook`.
- No Makefile; commands are npm scripts.

## Links

- Repo: https://github.com/shanelabountyai/loanbook (private)
- Reusable start file: `~/.claude/docs/project-start.md`
- Not deployed. No Vercel project, no Neon project, nothing that can bill.
