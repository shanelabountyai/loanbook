# PRD: LoanBook — Microloan Servicing

**Sample business:** "LoanBook," servicing small fixed-term installment loans ($500–$5,000) for a community lender
**Status:** Draft v1.0 — PM + loan-servicing-operator review baked in
**Learning objectives:** double-entry ledger accounting, amortization schedule generation, interest accrual on an injected clock, payment allocation waterfalls, delinquency states

---

## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. Real lending is regulated (TILA/Reg Z disclosures, state usury caps, servicing rules); this project models the *accounting mechanics*, makes no compliance claims, and must never touch real borrowers or real money. Banner verbatim in the README.

## Problem Statement

Every prior project charges money; none *accounts* for it. Servicing a loan means answering, at any moment and provably: what was borrowed, what's accrued, what was paid, where did each payment go, and what pays it off today. The industry answer is double-entry bookkeeping — every movement recorded as balanced debits and credits — and it's the foundation under all fintech. The builder lesson: money as an append-only, self-verifying ledger rather than mutable balance columns.

## Goals

1. Every financial event (disbursement, accrual, payment, fee, waiver, payoff) exists only as balanced ledger entries; balances are always *derived*, never stored as mutable truth.
2. Amortization schedules generate correctly for standard fixed-rate installment loans.
3. Payments allocate through a defined waterfall (fees → interest → principal) with every allocation visible.
4. A payoff quote for any date is exact and reproducible.
5. **(Builder goal)** Double-entry modeling, financial math with integer cents, invariant testing.

## Non-Goals

- Origination/underwriting/credit scoring (loans enter the system approved, with terms)
- Variable rates, revolving credit, refinancing (fixed-rate installment only; note seams)
- Real payment rails, ACH, collections outreach (mock payments; dunning *states* only)
- Regulatory disclosures/documents (see banner)
- Investor/portfolio accounting (single lender's book)

## Requirements — Must-Have (P0)

**P0-1: Double-entry ledger core** *(core learning artifact #1)*
Chart of accounts (cash, loans_receivable, interest_income, fees_income, write_offs…); journal entries with ≥2 lines; every entry's debits equal credits, enforced at write time.
- [ ] Unbalanced entries are rejected at the API and DB layer; entries are append-only (corrections are reversing entries, never edits)
- [ ] Account balances are computed from entries; a `ledger:verify` command proves system-wide debits = credits and per-loan sub-ledgers reconcile — the invariant test that gates every other feature
- [ ] Disbursing a $1,000 loan writes: debit loans_receivable 100000¢ / credit cash 100000¢ (fixture-tested)

**P0-2: Amortization schedule generation** *(core learning artifact #2)*
Standard amortization: fixed monthly payment from principal, APR, term; schedule rows show payment #, due date, interest portion, principal portion, remaining balance.
- [ ] Fixtures match hand-calculated (spreadsheet) schedules to the cent, including the final-payment rounding adjustment (the classic penny problem — the last payment absorbs rounding drift)
- [ ] All math in integer cents with a single documented rounding rule (half-up), applied in one module

**P0-3: Interest accrual**
Daily simple-interest accrual on outstanding principal (actual/365), run as a scheduled command on the injected clock.
- [ ] Accrual run is idempotent per (loan, date); each run writes ledger entries (debit interest_receivable / credit interest_income)
- [ ] A 30-day simulated month's accrued interest matches the hand-computed fixture to the cent

**P0-4: Payment allocation waterfall** *(core learning artifact #3)*
Incoming payment allocates: late fees → accrued interest → principal; partial payments allocate as far as they reach; overpayments reduce principal (and recompute payoff).
- [ ] Each payment produces one journal entry with a line per bucket touched; the borrower-facing history shows the split
- [ ] Waterfall order is configuration, not code (a second config permutation is fixture-tested to prove it)
- [ ] Fixtures cover: exact payment, short payment, payment with fees outstanding, overpayment

**P0-5: Delinquency state machine**
`current → grace (1–10 days past due) → delinquent_30/60/90 → default_recommended`; late fee assessed once per missed installment at grace exit.
- [ ] States derive from the ledger + schedule on the injected clock — a status job computes them; nothing sets them by hand
- [ ] A catch-up payment recomputes state correctly (delinquent_60 → current in one fixture)

**P0-6: Payoff quote**
For any quote date: outstanding principal + accrued-through-date interest + unpaid fees.
- [ ] Quote for date D, paid on D, zeroes the loan exactly (round-trip fixture); the payoff entry closes all sub-accounts
- [ ] Quotes are reproducible: same inputs, same output, logged

**P0-7: Servicing views**
Loan detail (schedule vs. actuals, ledger view, state), book overview (portfolio outstanding, delinquency buckets), borrower statement (payments, allocations, balance) — role-split borrower/servicer using the two-role pattern.

## Nice-to-Have (P1)

Fee waivers (reversing entries with reason) · write-off flow (default → write_off ledger treatment) · CSV statement export · portfolio aging report.

## Success Metrics (seeded)

- `ledger:verify` clean across a simulated 12-month book (40 loans, mixed behaviors: on-time, chronic-late, payoff-early, default)
- Amortization + accrual + waterfall + payoff fixtures: 100% to the cent
- Delinquency states match hand-classified fixtures on every simulated day
- Capstone: one loan's full life — disburse, 6 payments (one short, one late with fee, one catch-up), early payoff — narrated entirely from ledger entries

## Phasing

1. Ledger core + verify (nothing else until the invariant holds) — 2. Amortization + accrual — 3. Waterfall + payoff — 4. Delinquency + views + P1.

## Build Notes for Claude Code

CLAUDE.md: house conventions + **balances are derived, never stored mutable**, **corrections are reversing entries**, **one rounding rule, one module**, **run `ledger:verify` in CI on every push**. TDD order: entry balancing → amortization fixtures → waterfall. Build the spreadsheet fixtures *by hand first* — hand-computing an amortization table once is itself the lesson that makes the code reviewable.
