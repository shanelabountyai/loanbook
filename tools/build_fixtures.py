#!/usr/bin/env python3
"""Fixture ORACLE for LoanBook. Generates the frozen JSON/CSV fixtures under fixtures/.

This is NOT product code. It exists to produce expected values with exact rational
arithmetic (fractions.Fraction) so the product implementation can be tested against
numbers it did not produce. Do not import it from the product; do not port it line by
line -- write the product test-first against the frozen fixtures instead.

Rules encoded here are defined in docs/decisions.md (D1-D9). Stdlib only, Python >= 3.9.
"""
import calendar, csv, datetime as dt, json, os
from fractions import Fraction

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")


def rhu(x: Fraction) -> int:
    """The ONE rounding rule: round half up, to integer cents. Non-negative inputs only."""
    assert x >= 0
    return (2 * x.numerator + x.denominator) // (2 * x.denominator)


def add_months(d: dt.date, k: int) -> dt.date:
    y, m = divmod(d.month - 1 + k, 12)
    y, m = d.year + y, m + 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def installment(P, apr_bps, n):
    r = Fraction(apr_bps, 120000)  # monthly rate = APR/12
    if r == 0:
        return rhu(Fraction(P, n))
    return rhu(P * r / (1 - (1 + r) ** (-n)))


def schedule(P, apr_bps, n, disb):
    pay, bal, rows = installment(P, apr_bps, n), P, []
    for k in range(1, n + 1):
        interest = rhu(Fraction(bal * apr_bps, 120000))
        princ = bal if k == n else pay - interest
        rows.append(dict(n=k, due_date=add_months(disb, k).isoformat(),
                         payment_cents=princ + interest, interest_cents=interest,
                         principal_cents=princ, remaining_balance_cents=bal - princ))
        bal -= princ
    return pay, rows


def cum_interest(P, apr_bps, days):
    """Exact actual/365 simple interest for `days` on P, rounded once, half up."""
    return rhu(Fraction(P * apr_bps * days, 10000 * 365))


def accrual_days(P, apr_bps, start, days):
    out, prev = [], 0
    for i in range(1, days + 1):
        c = cum_interest(P, apr_bps, i)
        out.append(dict(date=(start + dt.timedelta(days=i)).isoformat(), day_number=i,
                        cumulative_cents=c, entry_cents=c - prev))
        prev = c
    return out


def dump(path, obj):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")


# ---------------------------------------------------------------- amortization
AM = [
    ("AM1", "Baseline: $1,000 @ 12.00% APR, 6 months (also the capstone loan L1)", 100000, 1200, 6, dt.date(2026, 1, 15)),
    ("AM2", "Max principal $5,000 @ 18.50%, 12 months: penny-problem drift lands in the final payment", 500000, 1850, 12, dt.date(2026, 3, 10)),
    ("AM3", "Zero-interest edge: $500 / 7 does not divide evenly; final payment absorbs the rounding", 50000, 0, 7, dt.date(2026, 6, 1)),
    ("AM4", "Month-end clamping: disbursed Jan 31, due dates clamp to last day of shorter months ($2,500 @ 24%, 18 mo)", 250000, 2400, 18, dt.date(2026, 1, 31)),
    ("AM5", "Single installment: $500 @ 12%, 1 month", 50000, 1200, 1, dt.date(2026, 2, 27)),
]
AM_OUT = {}
for fid, desc, P, apr, n, disb in AM:
    pay, rows = schedule(P, apr, n, disb)
    AM_OUT[fid] = (pay, rows)
    tot_int = sum(r["interest_cents"] for r in rows)
    dump(f"amortization/{fid}.json", dict(
        id=fid, description=desc,
        input=dict(principal_cents=P, apr_bps=apr, term_months=n, disbursement_date=disb.isoformat()),
        expected=dict(installment_cents=pay, final_payment_cents=rows[-1]["payment_cents"],
                      final_payment_adjustment_cents=rows[-1]["payment_cents"] - pay,
                      total_interest_cents=tot_int, total_paid_cents=P + tot_int, schedule=rows)))
    with open(os.path.join(ROOT, f"amortization/{fid}.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)

X = AM_OUT["AM1"][0]  # AM1 installment, used by accrual/waterfall/ledger fixtures
L1_DISB = dt.date(2026, 1, 15)

# ---------------------------------------------------------------- accrual
d1 = accrual_days(100000, 1200, L1_DISB, 30)
naive = 30 * rhu(Fraction(100000 * 1200, 10000 * 365))
dump("accrual/AC1_30day_month.json", dict(
    id="AC1", description="30-day simulated month, $1,000 @ 12%, actual/365, no payments. Total is exact-then-rounded (986), NOT 30 x rounded daily (990).",
    input=dict(principal_cents=100000, apr_bps=1200, principal_effective_date=L1_DISB.isoformat(), days=30),
    expected=dict(total_cents=d1[-1]["cumulative_cents"], entries=d1),
    rejected_alternative=dict(rule="round each day independently", total_cents=naive,
                              why="drifts +4 cents in one month; cumulative rounding is exact at every checkpoint")))

d2 = accrual_days(100000, 1200, dt.date(2028, 2, 1), 29)
dump("accrual/AC2_leap_year.json", dict(
    id="AC2", description="Actual/365 across Feb 29 2028: denominator stays 365; day count is actual",
    input=dict(principal_cents=100000, apr_bps=1200, principal_effective_date="2028-02-01", days=29),
    expected=dict(total_cents=d2[-1]["cumulative_cents"], entries=d2)))

s1 = accrual_days(100000, 1200, L1_DISB, 10)
s2 = accrual_days(90000, 1200, L1_DISB + dt.timedelta(days=10), 20)
dump("accrual/AC3_principal_change.json", dict(
    id="AC3", description="Principal drops 100000 -> 90000 on 2026-01-25 (payment applied AFTER that day's accrual; new principal effective 01-26). Each principal segment rounds independently.",
    input=dict(segments=[dict(principal_cents=100000, principal_effective_date="2026-01-15", through="2026-01-25"),
                         dict(principal_cents=90000, principal_effective_date="2026-01-25", through="2026-02-14")], apr_bps=1200),
    expected=dict(segment_totals_cents=[s1[-1]["cumulative_cents"], s2[-1]["cumulative_cents"]],
                  total_cents=s1[-1]["cumulative_cents"] + s2[-1]["cumulative_cents"], entries=s1 + s2)))

d4 = accrual_days(100000, 1200, L1_DISB, 31)
dump("accrual/AC4_first_installment_period.json", dict(
    id="AC4", description="L1 first period 2026-01-15 -> 2026-02-15 = 31 days. Accrued (actual/365) differs from schedule interest (APR/12) -- see decisions D4.",
    input=dict(principal_cents=100000, apr_bps=1200, principal_effective_date="2026-01-15", days=31),
    expected=dict(total_cents=d4[-1]["cumulative_cents"],
                  schedule_interest_cents=AM_OUT["AM1"][1][0]["interest_cents"], entries=d4)))

dump("accrual/AC5_idempotency_and_catchup.json", dict(
    id="AC5", description="Same run date twice writes nothing the 2nd time; a run after a skipped day posts every missing day through run date",
    input=dict(principal_cents=100000, apr_bps=1200, principal_effective_date=L1_DISB.isoformat()),
    runs=[dict(run_date="2026-01-16", expected_entries=[d1[0]]),
          dict(run_date="2026-01-16", expected_entries=[]),
          dict(run_date="2026-01-18", expected_entries=[d1[1], d1[2]])],
    expected_cumulative_after_all_runs_cents=d1[2]["cumulative_cents"]))

# ---------------------------------------------------------------- waterfall
CFG_A = ["fees", "interest", "principal"]   # PRD default
CFG_B = ["interest", "fees", "principal"]   # second permutation (proves order is config)
ACCT = dict(fees="fees_receivable", interest="interest_receivable", principal="loans_receivable")


def allocate(state, pay, order):
    if pay <= 0:
        return dict(error="non_positive_payment")
    owed = dict(state)
    if pay > sum(owed.values()):
        return dict(error="exceeds_payoff", payoff_cents=sum(owed.values()))
    left, alloc = pay, {}
    for b in order:
        take = min(left, owed[b]); alloc[b] = take; left -= take
    remaining = {b: owed[b] - alloc[b] for b in owed}
    lines = [dict(account="cash", debit=pay, credit=0)] + \
            [dict(account=ACCT[b], debit=0, credit=alloc[b]) for b in order if alloc[b] > 0]
    return dict(allocation=alloc, remaining=remaining, journal_lines=lines, loan_closed=all(v == 0 for v in remaining.values()))


def st(f, i, p): return dict(fees=f, interest=i, principal=p)


W = [
    ("WF1", "Exact scheduled payment, no fees", CFG_A, st(0, 1019, 100000), X),
    ("WF2", "Short payment: does not even cover accrued interest", CFG_A, st(0, 1019, 100000), 800),
    ("WF3", "Scheduled payment with a $15 late fee outstanding", CFG_A, st(1500, 1019, 100000), X),
    ("WF4", "Overpayment: extra $200 reduces principal", CFG_A, st(0, 1019, 100000), X + 20000),
    ("WF5", "Short payment that only reaches part of the fee", CFG_A, st(1500, 1019, 100000), 1000),
    ("WF6", "Payment exactly covers fees + interest; principal untouched (no principal line)", CFG_A, st(1500, 1019, 100000), 2519),
    ("WF7", "Payment equals payoff exactly: closes the loan", CFG_A, st(1500, 1019, 100000), 102519),
    ("WF8", "Payment $0.01 over payoff: rejected (no credit balances)", CFG_A, st(1500, 1019, 100000), 102520),
    ("WF9", "Zero payment: rejected", CFG_A, st(0, 1019, 100000), 0),
    ("WF10", "Boundary: fee cleared, interest partly paid", CFG_A, st(1500, 1019, 100000), 2000),
    ("WFB3", "CONFIG B (interest -> fees -> principal): same input as WF3", CFG_B, st(1500, 1019, 100000), X),
    ("WFB5", "CONFIG B: same input as WF5 -- interest now absorbs the short payment", CFG_B, st(1500, 1019, 100000), 1000),
    ("WFB10", "CONFIG B: same input as WF10 -- interest cleared first, fee partly paid", CFG_B, st(1500, 1019, 100000), 2000),
]
WF_OUT = {}
for fid, desc, order, state, pay in W:
    WF_OUT[fid] = allocate(state, pay, order)
    dump(f"waterfall/{fid}.json", dict(id=fid, description=desc,
         config=dict(waterfall_order=order), input=dict(owed_before=state, payment_cents=pay),
         expected=WF_OUT[fid]))

# ---------------------------------------------------------------- ledger
COA = [
    dict(account="cash", type="asset", normal="debit"),
    dict(account="loans_receivable", type="asset", normal="debit", requires_loan_id=True),
    dict(account="interest_receivable", type="asset", normal="debit", requires_loan_id=True),
    dict(account="fees_receivable", type="asset", normal="debit", requires_loan_id=True),
    dict(account="lender_capital", type="equity", normal="credit"),
    dict(account="interest_income", type="income", normal="credit"),
    dict(account="fees_income", type="income", normal="credit"),
    dict(account="write_offs", type="expense", normal="debit", requires_loan_id=True),
]
dump("ledger/chart_of_accounts.json", dict(accounts=COA))


def line(a, d=0, c=0): return dict(account=a, debit=d, credit=c)


entries = [
    dict(id="E001", date="2026-01-01", loan_id=None, memo="Fund lender cash", lines=[line("cash", 500000), line("lender_capital", 0, 500000)]),
    dict(id="E002", date="2026-01-15", loan_id="L1", memo="Disburse L1 $1,000", lines=[line("loans_receivable", 100000), line("cash", 0, 100000)]),
]
for i, e in enumerate(d4):
    entries.append(dict(id=f"E{3 + i:03d}", date=e["date"], loan_id="L1", memo=f"Accrue day {e['day_number']}",
                        lines=[line("interest_receivable", e["entry_cents"]), line("interest_income", 0, e["entry_cents"])]))
pay_e = dict(id=f"E{3 + len(d4):03d}", date="2026-02-15", loan_id="L1", memo="Payment 1 (WF1 split)",
             lines=WF_OUT["WF1"]["journal_lines"])
entries.append(pay_e)
acc_total = d4[-1]["cumulative_cents"]
prin_paid = WF_OUT["WF1"]["allocation"]["principal"]
dump("ledger/TB1_trial_balance.json", dict(
    id="TB1", description="L1 from funding through first payment. Debits must equal credits; per-loan sub-ledger must reconcile to control accounts.",
    entries=entries,
    expected=dict(
        total_debits_cents=sum(l["debit"] for e in entries for l in e["lines"]),
        total_credits_cents=sum(l["credit"] for e in entries for l in e["lines"]),
        balances_cents=dict(cash=500000 - 100000 + X, loans_receivable=100000 - prin_paid,
                            interest_receivable=0, fees_receivable=0, lender_capital=500000,
                            interest_income=acc_total, fees_income=0, write_offs=0),
        per_loan_cents=dict(L1=dict(loans_receivable=100000 - prin_paid, interest_receivable=0, fees_receivable=0)),
        verify_result="ok")))

dump("ledger/entry_validation.json", dict(
    description="Write-time validation. Each case must be rejected at the API AND at the DB layer (or accepted, where noted). Match on error code.",
    valid=[
        dict(id="V1", note="PRD disbursement fixture: $1,000", entry=entries[1]),
        dict(id="V2", note="Fee assessed ($15 late fee)", entry=dict(id="X", date="2026-03-27", loan_id="L1", memo="Late fee",
             lines=[line("fees_receivable", 1500), line("fees_income", 0, 1500)])),
        dict(id="V3", note="Multi-line entry: payment split into 3 credits", entry=dict(id="X", date="2026-03-15", loan_id="L1", memo="Payment",
             lines=WF_OUT["WF3"]["journal_lines"])),
    ],
    invalid=[
        dict(id="I1", error="unbalanced", note="debit 100 vs credit 99", entry=dict(id="X", date="2026-01-15", loan_id="L1", lines=[line("loans_receivable", 100), line("cash", 0, 99)])),
        dict(id="I2", error="too_few_lines", note="single line", entry=dict(id="X", date="2026-01-15", loan_id="L1", lines=[line("cash", 100)])),
        dict(id="I3", error="too_few_lines", note="no lines", entry=dict(id="X", date="2026-01-15", loan_id="L1", lines=[])),
        dict(id="I4", error="line_must_have_exactly_one_side", note="both debit and credit on one line", entry=dict(id="X", date="2026-01-15", loan_id="L1", lines=[line("cash", 100, 100), line("loans_receivable", 100, 0), line("lender_capital", 0, 100)])),
        dict(id="I5", error="non_positive_amount", note="zero-value line", entry=dict(id="X", date="2026-01-15", loan_id="L1", lines=[line("cash", 0, 0), line("loans_receivable", 0, 0)])),
        dict(id="I6", error="non_positive_amount", note="negative amount", entry=dict(id="X", date="2026-01-15", loan_id="L1", lines=[line("cash", -100), line("loans_receivable", 0, -100)])),
        dict(id="I7", error="unknown_account", note="account not in chart", entry=dict(id="X", date="2026-01-15", loan_id="L1", lines=[line("petty_cash", 100), line("cash", 0, 100)])),
        dict(id="I8", error="missing_loan_id", note="receivable account without loan_id", entry=dict(id="X", date="2026-01-15", loan_id=None, lines=[line("loans_receivable", 100), line("cash", 0, 100)])),
        dict(id="I9", error="non_integer_amount", note="floats never allowed", entry=dict(id="X", date="2026-01-15", loan_id="L1", lines=[line("cash", 10.5), line("lender_capital", 0, 10.5)])),
    ],
    append_only=[
        dict(id="A1", action="update_entry_line", expect="rejected"),
        dict(id="A2", action="delete_entry", expect="rejected"),
        dict(id="A3", action="insert_line_into_existing_entry", expect="rejected"),
    ],
    reversal=dict(note="A correction is a new entry with debits/credits swapped, referencing the original; net effect zero",
                  original=entries[1],
                  reversing_entry=dict(id="X2", date="2026-01-16", loan_id="L1", memo="Reverse E002", reverses_entry_id="E002",
                                       lines=[line("loans_receivable", 0, 100000), line("cash", 100000, 0)]),
                  expected_balances_after_both=dict(loans_receivable=0, cash=0)),
    duplicate_reversal_rejected=dict(note="A second reversal of the same entry_id must be rejected", error="already_reversed")))

dump("ledger/verify_failures.json", dict(
    description="Tampered ledgers injected BELOW the API (direct DB write / fixture load). `ledger:verify` must exit non-zero and report the code + entry id.",
    cases=[
        dict(id="VF1", expect=dict(code="unbalanced_entry", entry_id="E900"), entries=[
            dict(id="E900", date="2026-01-15", loan_id="L1", lines=[line("loans_receivable", 100), line("cash", 0, 99)])]),
        dict(id="VF2", expect=dict(code="missing_loan_id", entry_id="E901"), entries=[
            dict(id="E901", date="2026-01-15", loan_id=None, lines=[line("loans_receivable", 100), line("cash", 0, 100)])]),
        dict(id="VF3", expect=dict(code="dangling_reversal", entry_id="E902"), entries=[
            dict(id="E902", date="2026-01-15", loan_id="L1", reverses_entry_id="E404", lines=[line("cash", 100), line("loans_receivable", 0, 100)])]),
        dict(id="VF4", expect=dict(code="control_account_mismatch", account="loans_receivable"),
             note="Per-loan sub-ledger sum != GL control balance (simulated by dropping loan tag on a stored line)",
             entries=[dict(id="E903", date="2026-01-15", loan_id="L1", lines=[line("loans_receivable", 100), line("cash", 0, 100)])],
             tamper=dict(entry_id="E903", set_line_loan_id_null=0)),
    ]))
print("fixtures written; AM1 installment =", X)
