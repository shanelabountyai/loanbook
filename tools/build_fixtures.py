#!/usr/bin/env python3
"""Fixture ORACLE for LoanBook. Generates the frozen JSON/CSV fixtures under fixtures/.

This is NOT product code. It exists to produce expected values with exact rational
arithmetic (fractions.Fraction) so the product implementation can be tested against
numbers it did not produce. Do not import it from the product; do not port it line by
line -- write the product test-first against the frozen fixtures instead.

Rules encoded here are defined in docs/decisions.md (D1-D9, D17-D20, D22-D25). Stdlib only, Python >= 3.9.
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

# ---------------------------------------------------------------- payoff (D17)
def accrued(P0, apr, disb, payments, through):
    """Interest accrued through `through` (inclusive): one cumulative-rounded segment per
    principal level; a segment starts on the date of the payment that reduced principal (D5, D6)."""
    segs, P, start = [], P0, disb
    for pd, pc in payments:
        if pc["principal"] > 0:
            segs.append((P, start, pd)); P -= pc["principal"]; start = pd
    segs.append((P, start, None))
    total = 0
    for sp, s, e in segs:
        end = min(e, through) if e else through
        days = max((end - s).days, 0)
        total += cum_interest(sp, apr, days)
    return total, P


def payoff(P0, apr, disb, payments, fees_assessed, posted_through, as_of):
    paid = lambda k: sum(pc[k] for _, pc in payments)
    acc_q, P = accrued(P0, apr, disb, payments, as_of)
    acc_p, _ = accrued(P0, apr, disb, payments, posted_through)
    interest, posted = acc_q - paid("interest"), acc_p - paid("interest")
    fees = fees_assessed - paid("fees")
    return dict(principal_cents=P, interest_cents=interest, fees_cents=fees, total_cents=P + interest + fees,
                posted_interest_cents=posted, pending_accrual_cents=interest - posted)


L1D = dt.date(2026, 1, 15)
ac3_pay = allocate(st(0, 329, 100000), 10329, CFG_A)["allocation"]   # AC3: 329 interest + 10000 principal on 01-25
PO = [
    ("PO1", "Quote on an accrual day: L1 on 2026-02-15 (31 days), accrual posted through 02-14; the quote includes the 02-15 day, so it equals the 01-15 -> 02-15 accrual of AC4 (1019)",
     dict(payments=[], fees=0, posted="2026-02-14", as_of="2026-02-15")),
    ("PO2", "Quote mid-segment after a principal reduction: the AC3 payment (01-25: 329 interest + 10000 principal) leaves 90000; quote on 02-05 is 11 days into segment 2, posted through 02-04",
     dict(payments=[("2026-01-25", ac3_pay)], fees=0, posted="2026-02-04", as_of="2026-02-05")),
    ("PO3", "Quote with a fee outstanding: PO1 plus the 1500 late fee; total equals the WF7 payment that closes the loan",
     dict(payments=[], fees=1500, posted="2026-02-15", as_of="2026-02-15")),
    ("PO4", "Quote on the disbursement day: nothing accrues (D6), so the quote is the principal alone",
     dict(payments=[], fees=0, posted="2026-01-15", as_of="2026-01-15")),
]
for fid, desc, s in PO:
    pays = [(dt.date.fromisoformat(d), pc) for d, pc in s["payments"]]
    pays = [(d, dict(fees=pc.get("fees", 0), interest=pc.get("interest", 0), principal=pc.get("principal", 0))) for d, pc in pays]
    out = payoff(100000, 1200, L1D, pays, s["fees"], dt.date.fromisoformat(s["posted"]), dt.date.fromisoformat(s["as_of"]))
    dump(f"payoff/{fid}.json", dict(id=fid, description=desc,
         input=dict(principal_cents=100000, apr_bps=1200, disbursement_date=L1D.isoformat(),
                    payments=[dict(date=d.isoformat(), allocation=pc) for d, pc in pays],
                    fees_assessed_cents=s["fees"], accrual_posted_through=s["posted"], as_of=s["as_of"]),
         expected=out))

# ---------------------------------------------------------------- delinquency (D18, D19)
BANDS = [(120, "default_recommended"), (90, "delinquent_90"), (60, "delinquent_60"), (11, "delinquent_30"), (1, "grace"), (0, "current")]
LATE_FEE, GRACE_EXIT = 1500, 11
AM1_ROWS = AM_OUT["AM1"][1]


def band(dpd):
    return next(s for lo, s in BANDS if dpd >= lo)


def dq_day(rows, pays, D):
    """D19: oldest installment past due on D whose cumulative scheduled amount exceeds cumulative cash received."""
    paid, cum = sum(c for d, c in pays if d <= D), 0
    for r in rows:
        cum += r["payment_cents"]
        if dt.date.fromisoformat(r["due_date"]) < D and paid < cum:
            return (D - dt.date.fromisoformat(r["due_date"])).days
    return 0


def dq_fees(rows, pays, last):
    """One fee per installment, on the day its DPD reaches 11, if still unsatisfied by cash received through that day."""
    out, cum = [], 0
    for r in rows:
        cum += r["payment_cents"]
        D = dt.date.fromisoformat(r["due_date"]) + dt.timedelta(days=GRACE_EXIT)
        if D <= last and sum(c for d, c in pays if d <= D) < cum:
            out.append(dict(installment=r["n"], date=D.isoformat(), cents=LATE_FEE))
    return out


DQ = [
    ("DQ1", "On time: every installment paid in full on its due date; current every day, no fees",
     [(r["due_date"], r["payment_cents"]) for r in AM1_ROWS], "2026-01-15", "2026-07-20"),
    ("DQ2", "Nothing ever paid, day by day to day 125 of installment 1: every band boundary (DPD 0/1/10/11/59/60/89/90/119/120); the clock runs from the oldest installment while later ones fall due; a fee at each grace exit",
     [], "2026-02-10", "2026-06-20"),
    ("DQ3", "Short payment: 10000 of 17255 on the due date does not reset the clock (DPD 1 the next day); 7255 on 03-01 (DPD 14, fee already posted on 02-26) completes the cumulative cover and recomputes to current",
     [("2026-02-15", 10000), ("2026-03-01", 7255)], "2026-02-10", "2026-03-20"),
    ("DQ4", "Catch-up: nothing paid until 04-20 (DPD 64, delinquent_60), then 3 installments (51765) in one payment recompute to current the same day; installment 3 is covered before its grace exit so it never takes a fee",
     [("2026-04-20", 51765)], "2026-02-10", "2026-04-30"),
    ("DQ5", "Two missed installments: DPD from the oldest, a fee for each (02-26, 03-26); one installment paid on 04-10 moves the oldest to installment 2 (DPD 26), not to current and not to the newest",
     [("2026-04-10", 17255)], "2026-02-10", "2026-04-20"),
]
for fid, desc, pays, first, last in DQ:
    pays = [(dt.date.fromisoformat(d), c) for d, c in pays]
    d0, d1 = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
    days = [dict(date=(d0 + dt.timedelta(days=k)).isoformat(), dpd=dq_day(AM1_ROWS, pays, d0 + dt.timedelta(days=k)),
                 state=band(dq_day(AM1_ROWS, pays, d0 + dt.timedelta(days=k)))) for k in range((d1 - d0).days + 1)]
    dump(f"delinquency/{fid}.json", dict(id=fid, description=desc,
         input=dict(loan="AM1", schedule=[dict(n=r["n"], due_date=r["due_date"], payment_cents=r["payment_cents"]) for r in AM1_ROWS],
                    payments=[dict(date=d.isoformat(), cents=c) for d, c in pays], late_fee_cents=LATE_FEE,
                    bands=[dict(min_dpd=lo, state=s) for lo, s in reversed(BANDS)]),
         expected=dict(days=days, fees=dq_fees(AM1_ROWS, pays, d1))))

# ---------------------------------------------------------------- capstone (D22)
def money(c): return f"${c // 100}.{c % 100:02d}"


def capstone(pays, last):
    """L1's life day by day: accrual for D, then a fee dated D, then a payment on D (D6, D20). A payment of None
    is the payoff: the whole of what is owed after D's accrual (D17). Returns ledger entries, payments, fees."""
    P0, apr = 100000, 1200
    cash = [(d, c) for d, c in pays if c is not None]
    fees = dq_fees(AM1_ROWS, cash, last)
    owed, P, start, posted = st(0, 0, P0), P0, L1D, 0
    entries = [dict(date=L1D.isoformat(), kind="disbursement", cents=P0)]
    paid = []
    D = L1D
    while D < last:
        D += dt.timedelta(days=1)
        c = cum_interest(P, apr, (D - start).days)
        if c > posted:
            entries.append(dict(date=D.isoformat(), kind="accrual", cents=c - posted)); owed["interest"] += c - posted; posted = c
        for f in fees:
            if f["date"] == D.isoformat():
                entries.append(dict(date=f["date"], kind="late_fee", cents=f["cents"])); owed["fees"] += f["cents"]
        for d, c in pays:
            if d != D: continue
            amt = sum(owed.values()) if c is None else c
            a = allocate(owed, amt, CFG_A)
            paid.append(dict(date=D.isoformat(), cents=amt, payoff=c is None, owed_before=dict(owed),
                             allocation=a["allocation"], remaining=a["remaining"], loan_closed=a["loan_closed"]))
            entries.append(dict(date=D.isoformat(), kind="payment", cents=amt, split=a["allocation"]))
            owed = dict(a["remaining"])
            if a["allocation"]["principal"] > 0:
                P, start, posted = P - a["allocation"]["principal"], D, 0
    return entries, paid, fees, owed


def statement(entries, owed, as_of):
    out, run = [], None
    for e in entries + [None]:
        if e and e["kind"] == "accrual":
            run = [run[0], e["date"], run[2] + e["cents"]] if run else [e["date"], e["date"], e["cents"]]
            continue
        if run:
            out.append(f"{run[0]} to {run[1]} Interest accrued {money(run[2])}"); run = None
        if e is None: break
        if e["kind"] == "disbursement": out.append(f"{e['date']} Disbursed {money(e['cents'])}")
        if e["kind"] == "late_fee": out.append(f"{e['date']} Late fee {money(e['cents'])}")
        if e["kind"] == "payment":
            s = e["split"]
            out.append(f"{e['date']} Payment {money(e['cents'])}: fees {money(s['fees'])}, interest {money(s['interest'])}, principal {money(s['principal'])}")
    out.append(f"{as_of} Owed {money(sum(owed.values()))}: fees {money(owed['fees'])}, interest {money(owed['interest'])}, principal {money(owed['principal'])}")
    return out


CP_LAST = dt.date(2026, 7, 1)
CP_PAYS = [("2026-02-15", X), ("2026-03-15", 10000), ("2026-03-20", X - 10000), ("2026-05-01", X), ("2026-06-20", 2 * X), ("2026-07-01", None)]
cp_pays = [(dt.date.fromisoformat(d), c) for d, c in CP_PAYS]
cp_entries, cp_paid, cp_fees, cp_owed = capstone(cp_pays, CP_LAST)
cp_cash = [(dt.date.fromisoformat(p["date"]), p["cents"]) for p in cp_paid]
assert cp_fees == dq_fees(AM1_ROWS, cp_cash, CP_LAST)  # the payoff's cash changes no fee
dump("capstone/CP1.json", dict(
    id="CP1", description="Capstone: L1 (AM1 terms) from disbursement to early payoff, run day by day (accrual, then the late-fee job, then any payment). "
                          "Six payments: on time (02-15); short, 10000 of 17255 (03-15); the shortfall inside grace (03-20, DPD 5, no fee); "
                          "installment 3 missed, fee at grace exit 04-26, paid late 05-01; installment 4 missed, fee 05-26, caught up with installment 5 in one payment 06-20; "
                          "payoff on 07-01 at the quote, before installment 6 falls due. Every receivable ends at zero.",
    input=dict(loan="AM1", principal_cents=100000, apr_bps=1200, term_months=6, disbursement_date=L1D.isoformat(),
               waterfall_order=CFG_A, late_fee_cents=LATE_FEE, run_through=CP_LAST.isoformat(),
               payments=[dict(date=d, cents=c) if c is not None else dict(date=d, payoff=True) for d, c in CP_PAYS]),
    expected=dict(
        payments=cp_paid, fees=cp_fees,
        days=[dict(date=(L1D + dt.timedelta(days=k)).isoformat(), dpd=dq_day(AM1_ROWS, cp_cash, L1D + dt.timedelta(days=k)),
                   state=band(dq_day(AM1_ROWS, cp_cash, L1D + dt.timedelta(days=k)))) for k in range((CP_LAST - L1D).days + 1)],
        totals=dict(cash_received_cents=sum(c for _, c in cp_cash),
                    interest_income_cents=sum(e["cents"] for e in cp_entries if e["kind"] == "accrual"),
                    fees_income_cents=sum(f["cents"] for f in cp_fees),
                    accrual_entries=sum(1 for e in cp_entries if e["kind"] == "accrual")),
        owed_at_end=cp_owed,
        statement=statement(cp_entries, cp_owed, CP_LAST.isoformat()))))

# ---------------------------------------------------------------- simulated book (D23)
def life(P0, apr, rows, disb, pays, last):
    """One loan day by day, disbursement through `last`, in job order: accrual for D, then a fee dated D (cash and
    principal as posted before D's payment), then any payment on D (None = the D17 quote). D23: once principal is
    repaid the loan is closed: DPD 0 and no fee, whatever the schedule says."""
    owed, P, start, posted, cash, fees, paid, states, n_acc = st(0, 0, P0), P0, disb, 0, [], [], [], [], 0
    D = disb
    while D <= last:
        c = cum_interest(P, apr, (D - start).days)
        if c > posted:
            owed["interest"] += c - posted; posted = c; n_acc += 1
        cum = 0
        for r in rows:
            cum += r["payment_cents"]
            if P > 0 and dt.date.fromisoformat(r["due_date"]) + dt.timedelta(days=GRACE_EXIT) == D and sum(x for _, x in cash) < cum:
                fees.append(dict(installment=r["n"], date=D.isoformat(), cents=LATE_FEE)); owed["fees"] += LATE_FEE
        for d, c in pays:
            if d != D: continue
            amt = sum(owed.values()) if c is None else c
            a = allocate(owed, amt, CFG_A)
            assert "error" not in a, (D, a)
            paid.append(dict(date=D.isoformat(), cents=amt, allocation=a["allocation"], loan_closed=a["loan_closed"]))
            owed, cash = dict(a["remaining"]), cash + [(D, amt)]
            if a["allocation"]["principal"] > 0:
                P, start, posted = P - a["allocation"]["principal"], D, 0
        s = band(0 if P == 0 else dq_day(rows, cash, D))
        if not states or states[-1]["state"] != s: states.append(dict(date=D.isoformat(), state=s))
        D += dt.timedelta(days=1)
    return dict(payments=paid, fees=fees, states=states, owed_at_end=owed,
                interest_income_cents=sum(p["allocation"]["interest"] for p in paid) + owed["interest"], accrual_entries=n_acc)


BK_START, BK_END = dt.date(2026, 1, 1), dt.date(2026, 12, 31)
BEHAVIORS = ["on_time", "chronic_late", "payoff_early", "default"]


def book_loan(i):
    """Loan i of 40: terms and behavior vary by index, nothing random, so the fixture is stable byte for byte."""
    beh, P, apr, n = BEHAVIORS[i % 4], 50000 + (i * 7 % 10) * 25000, [900, 1200, 1800, 2400, 3600][i % 5], [6, 12, 9][i % 3]
    disb = BK_START + dt.timedelta(days=i % 28)
    rows = schedule(P, apr, n, disb)[1]
    due = [dt.date.fromisoformat(r["due_date"]) for r in rows]
    on_time = [(d, r["payment_cents"]) for d, r in zip(due, rows)]
    if beh == "on_time": pays = on_time[:-1] + [(due[-1], None)]                                   # D9: the last one is the quote
    if beh == "chronic_late":                                                                      # 3-26 days late, fee from 11
        late = [dt.timedelta(days=3 + (5 + 7 * k + i) % 24) for k in range(n)]
        pays = [(d + l, c) for (d, c), l in zip(on_time[:-1], late)] + [(due[-1] + late[-1], None)]
    if beh == "payoff_early": m = 2 + i % 3; pays = on_time[:m] + [(due[m - 1] + dt.timedelta(days=10 + i % 10), None)]
    if beh == "default": pays = on_time[:i % 3]                                                    # then nothing, ever
    pays = [(d, c) for d, c in pays if d <= BK_END]
    return dict(behavior=beh, principal_cents=P, apr_bps=apr, term_months=n, disbursement_date=disb.isoformat(),
                payments=[dict(date=d.isoformat(), cents=c) if c is not None else dict(date=d.isoformat(), payoff=True) for d, c in pays]), rows, pays


bk_in, bk_out = [], []
for i in range(40):
    loan, rows, pays = book_loan(i)
    bk_in.append(dict(n=i + 1, **loan))
    bk_out.append(dict(n=i + 1, **life(loan["principal_cents"], loan["apr_bps"], rows, dt.date.fromisoformat(loan["disbursement_date"]), pays, BK_END)))
dump("book/BK1.json", dict(
    id="BK1", description="Simulated book (PRD success metric): 40 loans over 2026, ten each on_time, chronic_late (3-26 days late, the last "
                          "payment the quote), payoff_early (quote 10-19 days after installment 2-4) and default (0-2 payments, then none). "
                          "Run day by day: create loans on their disbursement day, accrual, the late-fee job, then payments. States are "
                          "transitions (a new row only when the state changes). D23: a repaid loan is closed, current, and takes no fee.",
    input=dict(start=BK_START.isoformat(), run_through=BK_END.isoformat(), waterfall_order=CFG_A, late_fee_cents=LATE_FEE, loans=bk_in),
    expected=dict(loans=bk_out, totals=dict(
        cash_received_cents=sum(p["cents"] for l in bk_out for p in l["payments"]),
        interest_income_cents=sum(l["interest_income_cents"] for l in bk_out),
        fees_income_cents=sum(f["cents"] for l in bk_out for f in l["fees"]),
        accrual_entries=sum(l["accrual_entries"] for l in bk_out),
        states_at_end={s: sum(1 for l in bk_out if l["states"][-1]["state"] == s) for _, s in reversed(BANDS)}))))

# ---------------------------------------------------------------- fee waiver (D24)
def waivers(events, last):
    """L1 day by day: the fee for D, then what is posted on D in order. Only fees_receivable is tracked: a payment
    takes fees first (CFG_A), a waiver reverses one whole fee if the pooled balance covers it on its date and after."""
    cash = [(dt.date.fromisoformat(e["posted_on"]), e["payment"]) for e in events if "payment" in e]
    fees = dq_fees(AM1_ROWS, cash, last)
    pool, waived, out = [], set(), []   # (date, change in fees_receivable), in posting order

    def owed(through=None): return sum(c for d, c in pool if through is None or d <= through)
    D = L1D
    while D < last:
        D += dt.timedelta(days=1)
        pool += [(f["date"], f["cents"]) for f in fees if f["date"] == D.isoformat()]
        for e in (e for e in events if e["posted_on"] == D.isoformat()):
            if "payment" in e:
                take = min(e["payment"], owed()); pool.append((e["posted_on"], -take))
                out.append(dict(fees_paid=take, fees_owed_after=owed())); continue
            fee = next((f for f in fees if f["installment"] == e["waive"].get("fee")), None)
            err = ("reason_required" if not e["reason"].strip() else "not_a_fee" if fee is None
                   else "before_fee" if e["date"] < fee["date"] else "already_reversed" if fee["installment"] in waived
                   else "fee_paid" if any(owed(d) < fee["cents"] for d in {e["date"]} | {d for d, _ in pool if d >= e["date"]})
                   else None)
            if err:
                out.append(dict(error=err, fees_owed_after=owed())); continue
            waived.add(fee["installment"]); pool.append((e["date"], -fee["cents"]))
            out.append(dict(memo=f"Fee waived {money(fee['cents'])} (installment {fee['installment']}): {e['reason'].strip()}", fees_owed_after=owed()))
    return fees, out, len(waived) * LATE_FEE


WV_LAST = dt.date(2026, 6, 10)
WV_EVENTS = [  # a waiver names its fee by installment, or a non-fee entry by the payment's date
    dict(posted_on="2026-02-15", payment=X),
    dict(posted_on="2026-03-27", waive=dict(fee=2), date="2026-03-27", reason="   "),
    dict(posted_on="2026-03-27", waive=dict(payment="2026-02-15"), date="2026-03-27", reason="goodwill"),
    dict(posted_on="2026-04-01", payment=1000),
    dict(posted_on="2026-04-01", waive=dict(fee=2), date="2026-04-01", reason="partly paid"),
    dict(posted_on="2026-04-27", waive=dict(fee=2), date="2026-04-27", reason="hardship"),
    dict(posted_on="2026-04-27", waive=dict(fee=2), date="2026-04-27", reason="hardship again"),
    dict(posted_on="2026-04-27", waive=dict(fee=3), date="2026-04-27", reason="pool too small"),
    dict(posted_on="2026-05-01", payment=X),
    dict(posted_on="2026-05-27", waive=dict(fee=3), date="2026-04-28", reason="back-dated"),
    dict(posted_on="2026-05-27", waive=dict(fee=4), date="2026-05-20", reason="before the fee"),
    dict(posted_on="2026-05-27", waive=dict(fee=4), date="2026-05-27", reason="servicer error"),
]
wv_fees, wv_out, wv_waived = waivers(WV_EVENTS, WV_LAST)
dump("waiver/WV1.json", dict(
    id="WV1", description="Fee waivers on L1 (AM1 terms), run day by day (accrual, the late-fee job, then what is posted that day in order). "
                          "Fees for installments 2, 3, 4. Refused: blank reason; a payment is not a fee; fee 2 partly paid (1000 of 1500) "
                          "with nothing else owed; fee 2 a second time; fee 3 when the pool holds 500; fee 3 back-dated to 04-28, which "
                          "the pool covers today (1500) but not on 04-28 (500); fee 4 dated before it was assessed. Waived: fee 2 once fee 3 "
                          "makes the pool 2000, fee 4 on 05-27. The late-fee job never re-assesses a waived installment (4 is still unpaid at 06-10).",
    input=dict(loan="AM1", principal_cents=100000, apr_bps=1200, term_months=6, disbursement_date=L1D.isoformat(),
               waterfall_order=CFG_A, late_fee_cents=LATE_FEE, run_through=WV_LAST.isoformat(), events=WV_EVENTS),
    expected=dict(fees=wv_fees, results=wv_out, totals=dict(
        fees_assessed_cents=sum(f["cents"] for f in wv_fees), fees_waived_cents=wv_waived,
        fees_paid_cents=sum(r.get("fees_paid", 0) for r in wv_out), fees_owed_at_end=wv_out[-1]["fees_owed_after"],
        fees_income_cents=sum(f["cents"] for f in wv_fees) - wv_waived))))

# ---------------------------------------------------------------- write-off (D25)
def write_offs(events, last):
    """L1 day by day in job order: accrual for D, the fee job, then what is posted on D in order. A write-off zeroes
    every receivable: principal to write_offs, unpaid interest and fees back out of their income. Principal is then
    zero, so nothing accrues and no fee is charged (D23)."""
    P0, apr = 100000, 1200
    owed, P, start, posted, cash, fees, out, wo, last_entry, n_acc = st(0, 0, P0), P0, L1D, 0, [], [], [], None, L1D, 0
    D = L1D
    while D < last:
        D += dt.timedelta(days=1)
        c = cum_interest(P, apr, (D - start).days)
        if c > posted:
            owed["interest"] += c - posted; posted = c; n_acc += 1; last_entry = D
        cum = 0
        for r in AM1_ROWS:
            cum += r["payment_cents"]
            if P > 0 and dt.date.fromisoformat(r["due_date"]) + dt.timedelta(days=GRACE_EXIT) == D and sum(x for _, x in cash) < cum:
                fees.append(dict(installment=r["n"], date=D.isoformat(), cents=LATE_FEE)); owed["fees"] += LATE_FEE; last_entry = D
        for e in (e for e in events if e["posted_on"] == D.isoformat()):
            if "payment" in e:
                a = allocate(owed, e["payment"], CFG_A)
                if "error" in a: out.append(dict(error=a["error"])); continue
                out.append(dict(allocation=a["allocation"]))
                owed, cash, last_entry = dict(a["remaining"]), cash + [(D, e["payment"])], D
                if a["allocation"]["principal"] > 0:
                    P, start, posted = P - a["allocation"]["principal"], D, 0
                continue
            date = dt.date.fromisoformat(e["date"])
            err = ("reason_required" if not e["reason"].strip() else "already_written_off" if wo
                   else "backdated" if date < last_entry else "accrual_pending" if date > D
                   else "not_in_default" if band(dq_day(AM1_ROWS, cash, date)) != "default_recommended" else None)
            if err:
                out.append(dict(error=err)); continue
            pairs = [("write_offs", "loans_receivable", owed["principal"]), ("interest_income", "interest_receivable", owed["interest"]),
                     ("fees_income", "fees_receivable", owed["fees"])]
            out.append(dict(written_off=dict(owed), memo=f"Written off {money(sum(owed.values()))}: {e['reason'].strip()}",
                            lines=[l for dr, cr, c in pairs if c for l in (line(dr, c), line(cr, 0, c))]))
            owed, P, start, posted, wo, last_entry = st(0, 0, 0), 0, D, 0, date, D
    days = []
    for k in range((last - L1D).days + 1):
        Dk = L1D + dt.timedelta(days=k)
        if wo and Dk >= wo: days.append(dict(date=Dk.isoformat(), dpd=dq_day(AM1_ROWS, cash, wo), state="written_off"))
        else: days.append(dict(date=Dk.isoformat(), dpd=dq_day(AM1_ROWS, cash, Dk), state=band(dq_day(AM1_ROWS, cash, Dk))))
    return fees, out, days, n_acc


def line(a, d=0, c=0): return dict(account=a, debit=d, credit=c)


WO_LAST = dt.date(2026, 7, 31)
WO_EVENTS = [
    dict(posted_on="2026-02-15", payment=X),
    dict(posted_on="2026-03-15", payment=5000),
    dict(posted_on="2026-07-10", write_off=True, date="2026-07-10", reason="   "),
    dict(posted_on="2026-07-12", write_off=True, date="2026-07-10", reason="stale date"),
    dict(posted_on="2026-07-12", write_off=True, date="2026-07-12", reason="one day early"),
    dict(posted_on="2026-07-13", write_off=True, date="2026-07-14", reason="tomorrow"),
    dict(posted_on="2026-07-13", write_off=True, date="2026-07-13", reason="borrower unreachable"),
    dict(posted_on="2026-07-14", write_off=True, date="2026-07-14", reason="again"),
    dict(posted_on="2026-07-20", payment=1000),
]
wo_fees, wo_out, wo_days, wo_acc = write_offs(WO_EVENTS, WO_LAST)
wo_done = next(r for r in wo_out if "written_off" in r)["written_off"]
dump("writeoff/WO1.json", dict(
    id="WO1", description="Write-off on L1 (AM1 terms), run day by day (accrual, the late-fee job, then what is posted that day in order). "
                          "Installment 1 paid, 5000 of installment 2 on its due date, then nothing: fees for installments 2-5, DPD 120 "
                          "(default_recommended) on 07-13. Refused: blank reason; dated 07-10 after accrual is posted through 07-12; DPD 119 "
                          "on 07-12; dated 07-14 before that day's accrual; a second write-off. Written off on 07-13: principal to write_offs, "
                          "unpaid interest and fees reversed out of income. Afterwards nothing accrues, installment 6 takes no fee, the loan reads "
                          "written_off (DPD frozen at 120), and a payment is refused exceeds_payoff (no recovery path).",
    input=dict(loan="AM1", principal_cents=100000, apr_bps=1200, term_months=6, disbursement_date=L1D.isoformat(),
               waterfall_order=CFG_A, late_fee_cents=LATE_FEE, run_through=WO_LAST.isoformat(), events=WO_EVENTS),
    expected=dict(fees=wo_fees, results=wo_out, days=wo_days, totals=dict(
        cash_received_cents=sum(e["payment"] for e, r in zip(WO_EVENTS, wo_out) if "payment" in e and "error" not in r),
        accrual_entries=wo_acc, write_offs_cents=wo_done["principal"],
        interest_income_cents=sum(r["allocation"]["interest"] for r in wo_out if "allocation" in r),
        fees_income_cents=sum(r["allocation"]["fees"] for r in wo_out if "allocation" in r),
        receivables_at_end=st(0, 0, 0)))))

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
