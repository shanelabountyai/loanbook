# Fixtures

Frozen expected values. Tests **read** these; product code must never generate them.

| Dir | Covers | PRD |
|-----|--------|-----|
| `ledger/` | chart of accounts, entry validation (valid / 9 invalid / append-only / reversal), trial balance TB1, `ledger:verify` failure cases VF1–VF4 | P0-1 |
| `amortization/` | AM1–AM5 (`.json` + `.csv` for spreadsheet comparison) | P0-2 |
| `accrual/` | AC1–AC5 | P0-3 |
| `waterfall/` | WF1–WF10 (default order), WFB3/5/10 (second order) | P0-4 |
| `payoff/` | PO1–PO4 (accrual-day quote, quote after a principal reduction, quote with a fee, disbursement-day quote) | P0-6 |
| `delinquency/` | DQ1–DQ5 (on-time, never paid through every band boundary, short payment, catch-up, two missed installments); per-day DPD and state plus late-fee events | P0-5 |

Conventions: amounts are integer cents; rates are basis points; dates are ISO `YYYY-MM-DD`. Journal lines in waterfall fixtures should be compared as an unordered set (plus the cash line).

## Provenance and how they were checked

- `tools/build_fixtures.py` generates them with exact rational arithmetic (`fractions.Fraction`).
- `tools/verify_fixtures.py` re-derives every value a **different way** (`decimal` at 60 digits, brute-force simulation, a float PMT bound, cross-fixture consistency such as TB1 accruals == AC4 and TB1 payment == WF1) and must print `OK`.
- Run: `python3 tools/build_fixtures.py && python3 tools/verify_fixtures.py`

These were script-computed, not done in a spreadsheet. The PRD's learning point is hand-computing one table yourself: rebuild **AM1** in a spreadsheet (`amortization/AM1.csv` is the answer key) and check it to the cent before Phase 2.

## Rules
- Never edit a fixture to make a failing test pass. If a fixture is wrong, fix the rule in `docs/decisions.md` first, regenerate, and review the diff.
