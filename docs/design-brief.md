# LoanBook: design brief

For Claude Design. Everything you need is in this file; you won't have the codebase.

## What it is

LoanBook is a servicing ledger for small loans (about $500 to $5,000, 3 to 12 months). It records every movement of money as balanced double-entry bookkeeping, and it computes every balance and loan state from that record on demand. Nothing is stored and edited by hand.

It is a **learning project with synthetic data only**. It never touches real borrowers or real money and makes no compliance claims. This banner appears on every screen, word for word:

> **Scope honesty:** Learning project, synthetic data only. Real lending is regulated (TILA/Reg Z disclosures, state usury caps, servicing rules); this project models the *accounting mechanics*, makes no compliance claims, and must never touch real borrowers or real money.

## Who uses it

- **Servicer** (operations staff at the lending org): watches the whole book, finds late loans, and explains any balance down to the cent. Uses it on a desktop for hours at a time, so density beats whitespace.
- **Borrower**: sees only their own loans and a statement for each. Opens it occasionally, possibly on a phone. Needs to see plainly what they paid, where each payment went, and what they still owe.

## The idea the design should carry

**Every number can be traced.** A balance is always the sum of ledger lines, so any total on screen should look like it can be opened up, and the line-level view should feel like the source of truth rather than a back-office dump. The tone is a well-kept accounting ledger: calm, exact, and readable. It should not look like a fintech marketing site or a trading dashboard.

**Time travel.** Every servicer screen takes an **as-of date**, and the whole screen shows the book as it stood on that day: states, days past due and balances. This is the demo's best moment. The date control should be prominent, always visible, and obvious when it is set to a day other than today.

## Screens

The app already has an org shell (top nav with org switcher and account menu). Design the content area of these screens:

### 1. Book overview (servicer)
- Header: as-of date control, and total outstanding split into principal, interest and fees.
- Delinquency buckets: one row per state with loan count and outstanding amount. Clicking a bucket filters the loan list.
- Loan list: loan ID, borrower (synthetic name), state, days past due, outstanding. Sortable. Links to loan detail.
- Sample: 40 loans; at year end 28 current, 1 grace, 1 delinquent_30, 10 default_recommended.

### 2. Aging report (servicer, new)
- The portfolio's outstanding balance by days-past-due band (current, 1–10, 11–59, 60–89, 90–119, 120+, written off), split into principal, interest and fees per band, with totals that reconcile to the book overview total.
- Per-loan rows under each band, collapsible.
- An aging chart is welcome if it earns its place; the table is the deliverable.

### 3. Loan detail (servicer)
- Terms: principal, APR, term, disbursement date. Example: $1,000.00 at 12.00% APR over 6 months, disbursed 2026-01-15, monthly payment $172.55.
- Status as of the date: state badge and days past due.
- Owed now: principal, interest and fees.
- **Schedule vs actuals:** installment #, due date, scheduled amount, amount covered so far. Paid, partly paid and missed installments should be distinguishable without relying on colour alone.
- **Ledger:** date, memo, account, debit, credit. Hundreds of rows, most of them daily interest accruals, so consecutive accruals should fold into one expandable row such as "Interest accrued 01-16 to 02-15: 31 days" (with the summed amount). Corrections appear as reversing entries linked to the entry they reverse, never as edits.
- Actions (servicer): waive a late fee (requires a reason) and write off a defaulted loan (requires a reason; confirm it, because it cannot be undone).
- Link to the statement.

### 4. Statement (borrower; servicer sees the same page)
- Each payment with its date, amount and split across fees, interest and principal.
- Fees charged and fees waived (with the reason).
- Closing balance owed.
- **Download CSV** button.
- Must work on a phone: the payment table has to read cleanly at 375 px.
- Sample payment history (the capstone loan): 02-15 $172.55 · 03-15 $100.00 (short) · 03-20 $72.55 · late fee $15.00 on 04-26 · 05-01 $172.55 · late fee on 05-26 · 06-20 $345.10 · 07-01 payoff $205.07. Total paid $1,067.82 = $1,000.00 principal + $37.82 interest + $30.00 fees.

### 5. Borrower's loan list
- A short list of their loans, each showing state, next due date and amount owed, linking to the statement. There are usually one or two loans.

## Loan states

These are computed and never set by hand. They need a consistent badge treatment that escalates without becoming alarmist:

| State | Meaning |
|---|---|
| current | nothing past due |
| grace | 1–10 days past due, no fee yet |
| delinquent_30 | 11–59 days past due; a $15.00 late fee is charged on day 11 |
| delinquent_60 | 60–89 days |
| delinquent_90 | 90–119 days |
| default_recommended | 120+ days; a servicer may write it off |
| written_off | written off; terminal, with days past due frozen |

Display names should be human (for example "Delinquent 30+"), but the underlying key stays visible somewhere for the servicer.

## Ledger accounts

`cash`, `loans_receivable` (principal), `interest_receivable`, `fees_receivable`, `interest_income`, `fees_income`, `write_offs`. Servicers see these names. Borrowers never do; they see "principal", "interest" and "fees".

## Money display rules

- Always dollars and cents, `$1,067.82`, with tabular (monospaced) figures and right-aligned columns.
- Never round or abbreviate on these screens: no "$1.1k". Every figure is exact to the cent.
- APR is shown as a percentage to two decimals (stored in basis points: 1200 → 12.00%).
- Dates are ISO (`2026-03-20`) in tables. A friendlier format is fine in headers.
- Zero is shown as `$0.00`, not blank, except in the debit and credit columns, where the empty side stays blank.

## Constraints

- Built with Next.js server components and plain semantic HTML tables. Keep client-side JavaScript to small islands: the date picker, row expansion and sorting. The app has no styling at all today, so propose the system (tokens, type, table styles, badges) as well as the screens.
- Light and dark themes.
- Accessibility: WCAG AA contrast, state conveyed by text as well as colour, and real `<table>` semantics with header cells.
- No bank branding, logos, trust seals or compliance badges. Name the app "LoanBook" and use a neutral demo org such as "Northwind Microlending".

## What to send back

1. A small design system: colour and type tokens, a table style, state badges, and a money cell.
2. The five screens at desktop width, plus the statement at 375 px.
3. The as-of control in its "today" state and its "viewing a past date" state.
4. The folded and expanded accrual row, and a reversal pair in the ledger.
