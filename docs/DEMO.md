# LoanBook demo script

Scope: learning project, synthetic data only, no compliance claims. Say that first; it is also on every screen.

## Setup (once, about 2 minutes)

```bash
npx dotenv -e .env.local -- prisma migrate deploy   # local dev DB must have every migration
npm run seed:demo              # accounts + 7-loan demo book in Acme Studio (idempotent)
npm run ledger:verify          # expect: ledger:verify: ok (N entries, debits X = credits X)
npm run dev                    # http://localhost:4700
```

- `DEMO_MODE=1` must be set in `.env.local` (it is; `/demo` 404s without it).
- Sign in at **http://localhost:4700/demo**, never the email link (dev mail only lands in the `CapturedMessage` table).
- Accounts (all `@acme.demo.test`): servicer `owner@`; borrowers `mara@`, `devon@`, `priya@`, `tomas@`, `ines@`, `jonas@`. Click the email on `/demo`; no password.
- The seed only runs against a local database (the app refuses a cloud one). Loan IDs are random per seed, so pick loans by state, not by ID.
- "Today" is the machine date. States move as days pass (a late fee posts when the status job runs): run `npm run status -- --as-of $(date +%F)` to bring the book up to today.

## The walk (about 6 minutes)

**1. Book overview** (sign in as `owner@`, then Loans in the nav).
Total outstanding split into principal / interest / fees, each tagged with its ledger account. Seven loans: three current, delinquent, one default-recommended, one written off. Click a column heading to sort the list, a state chip to filter it; **Light / dark** in the banner flips the theme. Say: *"Nothing here is stored. Every number is the sum of ledger lines, computed when the page loads."*

**2. Time travel.** Change the as-of date to `2026-09-30` (or click a quarter-end chip).
The buckets change: a loan that is delinquent today is in grace. The bar shows you are not looking at today. Say: *"Same ledger, same code, a different day. State and days past due are derived, so nobody can set them by hand."*

**3. Aging report** (Trace by age).
Balance by days-past-due band, split principal / interest / fees; the total equals the overview total. Expand a band for its loans.

**4. Loan detail** (open the default-recommended loan, ~158 days past due).
Terms, state badge, owed now, schedule vs actuals (paid / partly / missed distinguishable without colour), then the ledger. Daily accruals fold into one row per run (click to expand). Point at the debit and credit columns and that each entry balances. Waive a late fee with a reason and watch the reversal appear, tagged with the entry it reverses.

**5. Statement** (open one from the borrower side).
Sign out, sign in as `mara@`: she sees only her two loans, each with its state and next payment due, in plain words (principal, interest, fees), never account names. Open a statement and click **Download CSV**. Say: *"A borrower can see where every dollar of every payment went."*

**6. The gates** (terminal).

```bash
npm run ledger:verify
npm run fixtures:check
```

Say: *"This runs in CI on every push. If it fails, nothing merges."*

## What to concede before you're asked

- Synthetic data only; not a lending product. Real lending adds TILA/Reg Z disclosures, usury caps and servicing rules that this does not model.
- Changing the as-of date resets the loan list's sort and state filter.
- "Next payment due" on the borrower's list is the oldest installment her cash has not covered (schedule against cash); fees and accrued interest are on the statement, not in that figure.
- Waive and write-off post dated today, whatever the as-of date shows. Write-off needs a reason and a confirm box and only appears when the loan is default_recommended; waive appears beside each unreversed late fee.
- Not deployed. Local only, by design.
- A written-off loan has no recovery path: a later payment is refused (`exceeds_payoff`).
- The clock is injected everywhere, so "today" is whatever the as-of control says; the seed uses the machine date.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/demo` is a 404 | `DEMO_MODE` is not `1` in `.env.local`; restart the dev server |
| `/demo` lists no users | run `npm run seed:demo` |
| Seed prints "Demo book skipped" | the account seed has not run, or Acme org is missing: run `npm run seed:demo` again |
| Seed prints "already seeded" | the book exists; to reseed, recreate the local database and re-run migrate deploy then seed |
| Migration error / missing column | `npx dotenv -e .env.local -- prisma migrate deploy` |
| Sign-in POST returns 403 with curl | send an `Origin: http://localhost:4700` header (browser does this) |
| Port 4700 busy | another dev server: `lsof -ti :4700` |
| `ledger:verify` fails | stop; do not demo. The ledger is the product |
