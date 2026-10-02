#!/usr/bin/env python3
"""Independent re-derivation of every fixture using a DIFFERENT method than build_fixtures.py
(decimal.Decimal @ 60 digits + brute-force simulation + float PMT sanity bound, not Fraction).
Exit 0 only if every frozen fixture in fixtures/ agrees. Stdlib only."""
import calendar, datetime as dt, glob, json, math, os, sys
from decimal import Decimal, ROUND_HALF_UP, getcontext
getcontext().prec = 60
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")
fails = []


def load(p): return json.load(open(os.path.join(ROOT, p)))
def chk(ok, msg):
    if not ok: fails.append(msg)
def q(x): return int(Decimal(x).quantize(Decimal(1), rounding=ROUND_HALF_UP))
def add_months(d, k):
    y, m = divmod(d.month - 1 + k, 12); y, m = d.year + y, m + 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))

# ---- amortization
for p in sorted(glob.glob(os.path.join(ROOT, "amortization", "*.json"))):
    f = json.load(open(p)); i, e = f["input"], f["expected"]
    P, apr, n = i["principal_cents"], Decimal(i["apr_bps"]), i["term_months"]
    disb = dt.date.fromisoformat(i["disbursement_date"])
    r = apr / Decimal(120000)
    pay = q(Decimal(P) / n) if r == 0 else q(P * r / (1 - (1 + r) ** (-n)))
    chk(pay == e["installment_cents"], f"{f['id']} installment {pay} != {e['installment_cents']}")
    if r > 0:  # float PMT sanity: within 1 cent of the closed form
        fp = P * float(r) / (1 - (1 + float(r)) ** (-n))
        chk(abs(fp - pay) <= 1, f"{f['id']} float PMT sanity {fp} vs {pay}")
    bal, ti = Decimal(P), 0
    for row in e["schedule"]:
        k = row["n"]; intr = q(bal * r)
        princ = int(bal) if k == n else pay - intr
        chk(row["interest_cents"] == intr and row["principal_cents"] == princ and row["payment_cents"] == princ + intr, f"{f['id']} row {k} amounts")
        bal -= princ; ti += intr
        chk(row["remaining_balance_cents"] == int(bal) >= 0, f"{f['id']} row {k} balance")
        chk(row["due_date"] == add_months(disb, k).isoformat(), f"{f['id']} row {k} due date")
    chk(bal == 0, f"{f['id']} does not amortize to 0")
    chk(sum(x["principal_cents"] for x in e["schedule"]) == P, f"{f['id']} principal sum")
    chk(e["total_interest_cents"] == ti and e["total_paid_cents"] == P + ti, f"{f['id']} totals")
    chk(abs(e["final_payment_adjustment_cents"]) <= n, f"{f['id']} final adjustment implausibly large")

# ---- accrual
def cum(P, apr, d): return q(Decimal(P) * apr * d / (Decimal(10000) * 365))
for p in sorted(glob.glob(os.path.join(ROOT, "accrual", "*.json"))):
    f = json.load(open(p)); i, e = f["input"], f.get("expected")
    apr = Decimal(i["apr_bps"])
    if f["id"] in ("AC1", "AC2", "AC4"):
        prev = 0
        for row in e["entries"]:
            c = cum(i["principal_cents"], apr, row["day_number"])
            chk(row["cumulative_cents"] == c and row["entry_cents"] == c - prev, f"{f['id']} day {row['day_number']}")
            chk(row["date"] == (dt.date.fromisoformat(i["principal_effective_date"]) + dt.timedelta(days=row["day_number"])).isoformat(), f"{f['id']} date")
            prev = c
        chk(sum(x["entry_cents"] for x in e["entries"]) == e["total_cents"] == cum(i["principal_cents"], apr, i["days"]), f"{f['id']} total")
    if f["id"] == "AC1":
        chk(f["rejected_alternative"]["total_cents"] == 30 * q(Decimal(100000) * apr / (Decimal(10000) * 365)), "AC1 naive total")
    if f["id"] == "AC3":
        segs = [(100000, 10), (90000, 20)]
        tot = [cum(P, apr, d) for P, d in segs]
        chk(tot == e["segment_totals_cents"] and sum(tot) == e["total_cents"] == sum(x["entry_cents"] for x in e["entries"]), "AC3 totals")
    if f["id"] == "AC5":
        posted = 0
        for run in f["runs"]:
            d = (dt.date.fromisoformat(run["run_date"]) - dt.date.fromisoformat(i["principal_effective_date"])).days
            exp = [(k, cum(i["principal_cents"], apr, k) - cum(i["principal_cents"], apr, k - 1)) for k in range(posted + 1, d + 1)]
            chk([(x["day_number"], x["entry_cents"]) for x in run["expected_entries"]] == exp, f"AC5 run {run['run_date']}")
            posted = max(posted, d)

# ---- waterfall (independent loop: consume in order via running remainder)
def alloc(state, pay, order):
    if pay <= 0: return {"error": "non_positive_payment"}
    if pay > sum(state.values()): return {"error": "exceeds_payoff", "payoff_cents": sum(state.values())}
    rem, out = pay, {}
    for b in order:
        out[b] = state[b] if rem >= state[b] else rem
        rem -= out[b]
    assert rem == 0
    return out
for p in sorted(glob.glob(os.path.join(ROOT, "waterfall", "*.json"))):
    f = json.load(open(p)); e = f["expected"]; s = f["input"]["owed_before"]; pay = f["input"]["payment_cents"]
    got = alloc(s, pay, f["config"]["waterfall_order"])
    if "error" in got:
        chk(e.get("error") == got["error"], f"{f['id']} error")
        continue
    chk(e["allocation"] == got, f"{f['id']} allocation")
    chk(sum(got.values()) == pay, f"{f['id']} allocation sum")
    chk({b: s[b] - got[b] for b in s} == e["remaining"], f"{f['id']} remaining")
    L = e["journal_lines"]
    chk(sum(l["debit"] for l in L) == sum(l["credit"] for l in L) == pay, f"{f['id']} journal balance")
    chk(len(L) == 1 + sum(1 for v in got.values() if v > 0), f"{f['id']} one line per bucket touched")

# ---- payoff (independent: day-by-day simulation of the cumulative rule, not the segment formula)
def sim_interest(P0, apr, disb, pays, through):
    P, start, total, prev = P0, disb, 0, 0
    day = disb
    while day < through:
        day += dt.timedelta(days=1)
        n = (day - start).days
        c = cum(P, apr, n)
        total += c - prev; prev = c
        for pd, pa in pays:                       # payment applies after the day's accrual; reduced principal from D+1
            if pd == day and pa["principal"] > 0:
                P -= pa["principal"]; start, prev = day, 0
    return total, P
for p in sorted(glob.glob(os.path.join(ROOT, "payoff", "*.json"))):
    f = json.load(open(p)); i, e = f["input"], f["expected"]
    pays = [(dt.date.fromisoformat(x["date"]), x["allocation"]) for x in i["payments"]]
    d0 = dt.date.fromisoformat(i["disbursement_date"])
    paid = lambda k: sum(a[k] for _, a in pays)
    accq, P = sim_interest(i["principal_cents"], i["apr_bps"], d0, pays, dt.date.fromisoformat(i["as_of"]))
    accp, _ = sim_interest(i["principal_cents"], i["apr_bps"], d0, pays, dt.date.fromisoformat(i["accrual_posted_through"]))
    fees = i["fees_assessed_cents"] - paid("fees")
    chk(e["principal_cents"] == P, f"{f['id']} principal")
    chk(e["interest_cents"] == accq - paid("interest"), f"{f['id']} interest")
    chk(e["posted_interest_cents"] == accp - paid("interest"), f"{f['id']} posted interest")
    chk(e["pending_accrual_cents"] == e["interest_cents"] - e["posted_interest_cents"], f"{f['id']} pending")
    chk(e["fees_cents"] == fees, f"{f['id']} fees")
    chk(e["total_cents"] == P + e["interest_cents"] + fees, f"{f['id']} total")
po = {x["id"]: x for x in (load(f"payoff/PO{k}.json") for k in range(1, 5))}
chk(po["PO1"]["expected"]["interest_cents"] == load("accrual/AC4_first_installment_period.json")["expected"]["entries"][-1]["cumulative_cents"], "PO1 interest == AC4 total")
chk(po["PO3"]["expected"]["total_cents"] == load("waterfall/WF7.json")["input"]["payment_cents"], "PO3 total == WF7 payment")
chk(po["PO4"]["expected"]["total_cents"] == 100000, "PO4 principal only")

# ---- delinquency (independent: bisect on cumulative sums, thresholds from the fixture's own band table)
import bisect
for p in sorted(glob.glob(os.path.join(ROOT, "delinquency", "*.json"))):
    f = json.load(open(p)); i, e = f["input"], f["expected"]
    due = [dt.date.fromisoformat(r["due_date"]) for r in i["schedule"]]
    cum = [sum(r["payment_cents"] for r in i["schedule"][:k + 1]) for k in range(len(due))]
    pays = [(dt.date.fromisoformat(x["date"]), x["cents"]) for x in i["payments"]]
    mins = [b["min_dpd"] for b in i["bands"]]
    def dpd_on(D):
        k = bisect.bisect_right(cum, sum(c for d, c in pays if d <= D))   # first installment not covered
        return (D - due[k]).days if k < len(due) and due[k] < D else 0
    charged, fees = set(), []
    for row in e["days"]:
        D = dt.date.fromisoformat(row["date"]); x = dpd_on(D)
        chk(row["dpd"] == x, f"{f['id']} {row['date']} dpd {row['dpd']} != {x}")
        chk(row["state"] == i["bands"][bisect.bisect_right(mins, x) - 1]["state"], f"{f['id']} {row['date']} state")
        paid = sum(c for d, c in pays if d <= D)
        for k in range(len(due)):                                           # every uncovered installment past grace exit, once
            if k not in charged and (D - due[k]).days >= 11 and paid < cum[k]:
                charged.add(k); fees.append(dict(installment=k + 1, date=row["date"], cents=i["late_fee_cents"]))
    chk(e["fees"] == fees, f"{f['id']} fees {e['fees']} != {fees}")
    chk([r["date"] for r in e["days"]] == [(dt.date.fromisoformat(e["days"][0]["date"]) + dt.timedelta(days=k)).isoformat() for k in range(len(e["days"]))], f"{f['id']} days contiguous")
dq = {x["id"]: x for x in (load(f"delinquency/DQ{k}.json") for k in range(1, 6))}
chk(all(r["state"] == "current" for r in dq["DQ1"]["expected"]["days"]) and not dq["DQ1"]["expected"]["fees"], "DQ1 always current, no fees")
chk({r["dpd"] for r in dq["DQ2"]["expected"]["days"]} >= {0, 1, 10, 11, 59, 60, 89, 90, 119, 120}, "DQ2 hits every band boundary")
chk(dq["DQ2"]["expected"]["days"][-1]["dpd"] > 120, "DQ2 runs past 120")
chk(len(dq["DQ5"]["expected"]["fees"]) == 2, "DQ5 fee twice")
chk(len(dq["DQ4"]["expected"]["fees"]) == 2, "DQ4 installment 3 never fined")
chk(any(r["date"] == "2026-04-20" and r["dpd"] == 0 for r in dq["DQ4"]["expected"]["days"]) and any(r["date"] == "2026-04-19" and r["state"] == "delinquent_60" for r in dq["DQ4"]["expected"]["days"]), "DQ4 delinquent_60 -> current in one payment")
chk(any(r["date"] == "2026-04-10" and r["dpd"] == 26 for r in dq["DQ5"]["expected"]["days"]), "DQ5 oldest moves to installment 2")
chk(any(r["date"] == "2026-02-16" and r["dpd"] == 1 for r in dq["DQ3"]["expected"]["days"]), "DQ3 clock not reset")

# ---- capstone (independent: state as running balances, one loop per day; DPD and fees from the DQ check above)
cp = load("capstone/CP1.json"); i, e = cp["input"], cp["expected"]
d0, last = dt.date.fromisoformat(i["disbursement_date"]), dt.date.fromisoformat(i["run_through"])
sched = load("amortization/AM1.json")["expected"]["schedule"]
due = [dt.date.fromisoformat(r["due_date"]) for r in sched]
cum_due = [sum(r["payment_cents"] for r in sched[:k + 1]) for k in range(len(sched))]
want = {x["date"]: x for x in i["payments"]}
P, seg, prev, fees, intr, charged, cash, got_pays, lines = i["principal_cents"], d0, 0, 0, 0, set(), [], [], []
acc_run, acc_total, n_acc, fee_list = None, 0, 0, []
def m(c): return f"${Decimal(c) / 100:.2f}"
lines.append(f"{d0} Disbursed {m(i['principal_cents'])}")
D = d0
while D < last:
    D += dt.timedelta(days=1)
    x = q(Decimal(P) * i["apr_bps"] * (D - seg).days / (Decimal(10000) * 365)) - prev  # `cum` is shadowed by the DQ check
    prev += x; intr += x; acc_total += x
    if x: n_acc += 1; acc_run = [acc_run[0] if acc_run else D, D, (acc_run[2] if acc_run else 0) + x]
    paid_now = sum(c for _, c in cash)
    for k in range(len(due)):
        if k not in charged and (D - due[k]).days == 11 and paid_now < cum_due[k]:
            charged.add(k); fees += i["late_fee_cents"]; fee_list.append(dict(installment=k + 1, date=D.isoformat(), cents=i["late_fee_cents"]))
            lines.append(f"{acc_run[0]} to {acc_run[1]} Interest accrued {m(acc_run[2])}"); acc_run = None
            lines.append(f"{D} Late fee {m(i['late_fee_cents'])}")
    w = want.get(D.isoformat())
    if w:
        before = dict(fees=fees, interest=intr, principal=P)
        amt = sum(before.values()) if w.get("payoff") else w["cents"]
        a = alloc(before, amt, i["waterfall_order"])
        got_pays.append(dict(date=D.isoformat(), cents=amt, payoff=bool(w.get("payoff")), owed_before=before, allocation=a,
                             remaining={b: before[b] - a[b] for b in before}, loan_closed=amt == sum(before.values())))
        fees, intr = fees - a["fees"], intr - a["interest"]
        if a["principal"]: P, seg, prev = P - a["principal"], D, 0
        cash.append((D, amt))
        lines.append(f"{acc_run[0]} to {acc_run[1]} Interest accrued {m(acc_run[2])}"); acc_run = None
        lines.append(f"{D} Payment {m(amt)}: fees {m(a['fees'])}, interest {m(a['interest'])}, principal {m(a['principal'])}")
if acc_run: lines.append(f"{acc_run[0]} to {acc_run[1]} Interest accrued {m(acc_run[2])}")
lines.append(f"{last} Owed {m(fees + intr + P)}: fees {m(fees)}, interest {m(intr)}, principal {m(P)}")
chk(e["payments"] == got_pays, "CP1 payments")
chk(e["fees"] == fee_list, "CP1 fees")
chk(e["owed_at_end"] == dict(fees=fees, interest=intr, principal=P) == dict(fees=0, interest=0, principal=0), "CP1 closes to zero")
chk(e["statement"] == lines, "CP1 statement")
T = e["totals"]
chk(T == dict(cash_received_cents=sum(c for _, c in cash), interest_income_cents=acc_total, fees_income_cents=len(fee_list) * i["late_fee_cents"], accrual_entries=n_acc), "CP1 totals")
chk(T["cash_received_cents"] == i["principal_cents"] + T["interest_income_cents"] + T["fees_income_cents"], "CP1 cash = principal + interest + fees")
for row in e["days"]:
    Dd = dt.date.fromisoformat(row["date"]); k = bisect.bisect_right(cum_due, sum(c for d, c in cash if d <= Dd))
    chk(row["dpd"] == ((Dd - due[k]).days if k < len(due) and due[k] < Dd else 0), f"CP1 {row['date']} dpd")
chk({r["state"] for r in e["days"]} == {"current", "grace", "delinquent_30"}, "CP1 visits current, grace, delinquent_30")
chk(got_pays[-1]["payoff"] and dt.date.fromisoformat(got_pays[-1]["date"]) < due[-1], "CP1 payoff is early")

# ---- fee waiver (independent: fees by the day-by-day grace-exit check, the pool as a date-sorted ledger,
#      a waiver tried as a candidate line and kept only if every running balance from its date on stays >= 0)
wv = load("waiver/WV1.json"); i, e = wv["input"], wv["expected"]
d0, last, fee_amt = dt.date.fromisoformat(i["disbursement_date"]), dt.date.fromisoformat(i["run_through"]), i["late_fee_cents"]
pays = [(dt.date.fromisoformat(x["posted_on"]), x["payment"]) for x in i["events"] if "payment" in x]
sched = load("amortization/AM1.json")["expected"]["schedule"]
due = [dt.date.fromisoformat(r["due_date"]) for r in sched]
cum_due = [sum(r["payment_cents"] for r in sched[:k + 1]) for k in range(len(sched))]
book, charged, fees, waived, got = [], set(), [], {}, []
def ok_from(lines, start):
    totals, run = {}, 0
    for d, c in lines: totals[d] = totals.get(d, 0) + c
    for d in sorted(totals):
        run += totals[d]
        if d >= start and run < 0: return False
    return True
D = d0
while D < last:
    D += dt.timedelta(days=1)
    for k in range(len(due)):
        if k not in charged and (D - due[k]).days == 11 and sum(c for d, c in pays if d <= D) < cum_due[k]:
            charged.add(k); fees.append(dict(installment=k + 1, date=D.isoformat(), cents=fee_amt)); book.append((D.isoformat(), fee_amt))
    for x in (x for x in i["events"] if x["posted_on"] == D.isoformat()):
        if "payment" in x:
            take = min(x["payment"], sum(c for _, c in book)); book.append((x["posted_on"], -take))
            got.append(dict(fees_paid=take, fees_owed_after=sum(c for _, c in book))); continue
        f = next((f for f in fees if f["installment"] == x["waive"].get("fee")), None)
        if x["reason"].strip() == "": err = "reason_required"
        elif f is None: err = "not_a_fee"
        elif x["date"] < f["date"]: err = "before_fee"
        elif f["installment"] in waived: err = "already_reversed"
        elif not ok_from(book + [(x["date"], -f["cents"])], x["date"]): err = "fee_paid"
        else: err = None
        if err: got.append(dict(error=err, fees_owed_after=sum(c for _, c in book))); continue
        waived[f["installment"]] = x["date"]; book.append((x["date"], -f["cents"]))
        got.append(dict(memo=f"Fee waived {m(f['cents'])} (installment {f['installment']}): {x['reason'].strip()}", fees_owed_after=sum(c for _, c in book)))
chk(e["fees"] == fees, "WV1 fees")
chk(e["results"] == got, "WV1 results")
chk(e["totals"] == dict(fees_assessed_cents=len(fees) * fee_amt, fees_waived_cents=len(waived) * fee_amt,
                        fees_paid_cents=sum(r.get("fees_paid", 0) for r in got), fees_owed_at_end=sum(c for _, c in book),
                        fees_income_cents=(len(fees) - len(waived)) * fee_amt), "WV1 totals")
chk({r.get("error") for r in got} >= {"reason_required", "not_a_fee", "fee_paid", "already_reversed", "before_fee"}, "WV1 every refusal")
chk(sum(c for d, c in book if d <= "2026-04-28") == 500 and sum(c for d, c in book if d <= "2026-05-26") == 1500, "WV1 back-dated case is real")
chk(any(f["installment"] == 4 for f in fees) and 4 in waived and len(fees) == 3, "WV1 a waived installment is not fined again")

# ---- write-off (independent: the loan as a list of dated ledger lines; owed, interest and the last entry date are
#      sums and maxima over it; principal for day D is loans_receivable dated before D; DPD by bisect)
wo = load("writeoff/WO1.json"); i, e = wo["input"], wo["expected"]
d0, last, fee_amt, apr = dt.date.fromisoformat(i["disbursement_date"]), dt.date.fromisoformat(i["run_through"]), i["late_fee_cents"], Decimal(i["apr_bps"])
sched = load("amortization/AM1.json")["expected"]["schedule"]
due = [dt.date.fromisoformat(r["due_date"]) for r in sched]
cum_due = [sum(r["payment_cents"] for r in sched[:k + 1]) for k in range(len(sched))]
led = [(d0, "loans_receivable", i["principal_cents"])]          # (date, account, debit - credit)
REC = dict(fees="fees_receivable", interest="interest_receivable", principal="loans_receivable")
def bal(acct, before=None): return sum(c for d, a, c in led if a == acct and (before is None or d < before))
def owed_now(): return {b: bal(a) for b, a in REC.items()}
def wo_dpd(D, cash):
    k = bisect.bisect_right(cum_due, sum(c for d, c in cash if d <= D))
    return (D - due[k]).days if k < len(due) and due[k] < D else 0
cash, fees, got, n_acc, wo_date = [], [], [], 0, None
bands_dq = load("delinquency/DQ1.json")["input"]["bands"]
seg_of = lambda D: max([d for d, a, c in led if a == "loans_receivable" and d < D])
D = d0
while D < last:
    D += dt.timedelta(days=1)
    P, s = bal("loans_receivable", D), seg_of(D)
    acc = q(Decimal(P) * apr * (D - s).days / (Decimal(10000) * 365)) + sum(c for d, a, c in led if a == "interest_income" and c < 0 and d > s)  # accrual credits are negative
    if acc > 0: led += [(D, "interest_receivable", acc), (D, "interest_income", -acc)]; n_acc += 1
    for k in range(len(due)):
        if bal("loans_receivable") > 0 and (D - due[k]).days == 11 and sum(c for _, c in cash) < cum_due[k]:
            fees.append(dict(installment=k + 1, date=D.isoformat(), cents=fee_amt)); led += [(D, "fees_receivable", fee_amt), (D, "fees_income", -fee_amt)]
    for x in (x for x in i["events"] if x["posted_on"] == D.isoformat()):
        if "payment" in x:
            a = alloc(owed_now(), x["payment"], i["waterfall_order"])
            if "error" in a: got.append(dict(error=a["error"])); continue
            got.append(dict(allocation=a)); cash.append((D, x["payment"])); led.append((D, "cash", x["payment"]))
            led += [(D, REC[b], -c) for b, c in a.items() if c]
            continue
        wd = dt.date.fromisoformat(x["date"])
        if not x["reason"].strip(): err = "reason_required"
        elif wo_date: err = "already_written_off"
        elif any(d > wd for d, _, _ in led): err = "backdated"
        elif wd > D: err = "accrual_pending"
        elif [b["state"] for b in bands_dq if wo_dpd(wd, cash) >= b["min_dpd"]][-1] != "default_recommended": err = "not_in_default"
        else: err = None
        if err: got.append(dict(error=err)); continue
        o = owed_now(); wo_date = wd
        L = []
        for b, dr in (("principal", "write_offs"), ("interest", "interest_income"), ("fees", "fees_income")):
            if o[b]: L += [dict(account=dr, debit=o[b], credit=0), dict(account=REC[b], debit=0, credit=o[b])]; led += [(wd, dr, o[b]), (wd, REC[b], -o[b])]
        got.append(dict(written_off=o, memo=f"Written off {m(sum(o.values()))}: {x['reason'].strip()}", lines=L))
chk(e["fees"] == fees, "WO1 fees")
chk(e["results"] == got, "WO1 results")
chk(owed_now() == e["totals"]["receivables_at_end"] == dict(fees=0, interest=0, principal=0), "WO1 receivables zero")
chk(e["totals"] == dict(cash_received_cents=sum(c for _, c in cash), accrual_entries=n_acc, write_offs_cents=bal("write_offs"),
                        interest_income_cents=-bal("interest_income"), fees_income_cents=-bal("fees_income"), receivables_at_end=owed_now()), "WO1 totals")
chk(bal("write_offs") + sum(c for _, c in cash) == i["principal_cents"] + e["totals"]["interest_income_cents"] + e["totals"]["fees_income_cents"], "WO1 loss + cash = principal + income")
for row in e["days"]:
    Dd = dt.date.fromisoformat(row["date"])
    want = (wo_dpd(wo_date, cash), "written_off") if wo_date and Dd >= wo_date else (wo_dpd(Dd, cash), [b["state"] for b in bands_dq if wo_dpd(Dd, cash) >= b["min_dpd"]][-1])
    chk((row["dpd"], row["state"]) == want, f"WO1 {row['date']} state")
chk({r.get("error") for r in got} >= {"reason_required", "backdated", "not_in_default", "accrual_pending", "already_written_off", "exceeds_payoff"}, "WO1 every refusal")
chk(not any(f["installment"] == 6 for f in fees) and not any(d > wo_date for d, a, _ in led if a == "interest_receivable"), "WO1 nothing accrues or is charged after")

# ---- simulated book (independent: Decimal schedule, running balances, bisect DPD; D23 closed = principal 0)
bk = load("book/BK1.json"); bi, be = bk["input"], bk["expected"]
names = ["current", "grace", "delinquent_30", "delinquent_60", "delinquent_90", "default_recommended"]
last, fee_amt = dt.date.fromisoformat(bi["run_through"]), bi["late_fee_cents"]
chk(len(bi["loans"]) == 40 and all(sum(1 for l in bi["loans"] if l["behavior"] == b) == 10 for b in ("on_time", "chronic_late", "payoff_early", "default")), "BK1 40 loans, 10 per behavior")
for l, x in zip(bi["loans"], be["loans"]):
    tag, P0, apr, n = f"BK1 loan {l['n']}", l["principal_cents"], Decimal(l["apr_bps"]), l["term_months"]
    d0, r = dt.date.fromisoformat(l["disbursement_date"]), Decimal(l["apr_bps"]) / Decimal(120000)
    inst, bal, sched = q(P0 * r / (1 - (1 + r) ** (-n))), Decimal(P0), []
    for k in range(1, n + 1):
        it = q(bal * r); pr = int(bal) if k == n else inst - it; bal -= pr; sched.append(pr + it)
    due = [add_months(d0, k) for k in range(1, n + 1)]
    cumd = [sum(sched[:k + 1]) for k in range(n)]
    want = {p["date"]: p for p in l["payments"]}
    P, seg, prev, fees, intr, paid_cash, charged, got, fl, st_rows, n_acc, inc = P0, d0, 0, 0, 0, 0, set(), [], [], [], 0, 0
    D = d0
    while D <= last:
        a_day = q(Decimal(P) * apr * (D - seg).days / (Decimal(10000) * 365)) - prev
        prev += a_day; intr += a_day; inc += a_day; n_acc += a_day > 0
        for k in range(n):
            if P and k not in charged and (D - due[k]).days == 11 and paid_cash < cumd[k]:
                charged.add(k); fees += fee_amt; fl.append(dict(installment=k + 1, date=D.isoformat(), cents=fee_amt))
        w = want.get(D.isoformat())
        if w:
            before = dict(fees=fees, interest=intr, principal=P)
            amt = sum(before.values()) if w.get("payoff") else w["cents"]
            a = alloc(before, amt, bi["waterfall_order"])
            chk("error" not in a, f"{tag} {D} payment refused")
            got.append(dict(date=D.isoformat(), cents=amt, allocation=a, loan_closed=amt == sum(before.values())))
            fees, intr, paid_cash = fees - a["fees"], intr - a["interest"], paid_cash + amt
            if a["principal"]: P, seg, prev = P - a["principal"], D, 0
        k = bisect.bisect_right(cumd, paid_cash)
        dd = 0 if P == 0 or k >= n or due[k] >= D else (D - due[k]).days
        s = names[bisect.bisect_right([0, 1, 11, 60, 90, 120], dd) - 1]
        if not st_rows or st_rows[-1]["state"] != s: st_rows.append(dict(date=D.isoformat(), state=s))
        D += dt.timedelta(days=1)
    chk(x["payments"] == got, f"{tag} payments"); chk(x["fees"] == fl, f"{tag} fees"); chk(x["states"] == st_rows, f"{tag} states")
    chk(x["owed_at_end"] == dict(fees=fees, interest=intr, principal=P), f"{tag} owed at end")
    chk(x["interest_income_cents"] == inc and x["accrual_entries"] == n_acc, f"{tag} interest income, accrual entries")
    chk(sum(g["cents"] for g in got) == P0 - P + inc - intr + len(fl) * fee_amt - fees, f"{tag} cash = principal + interest + fees repaid")
    if l["behavior"] == "default": chk(st_rows[-1]["state"] == "default_recommended", f"{tag} default reaches default_recommended")
    if l["behavior"] == "payoff_early": chk(P == 0 and got[-1]["date"] < due[-1].isoformat() and st_rows == [dict(date=l["disbursement_date"], state="current")], f"{tag} early payoff closes, current throughout")
    if P == 0: chk(st_rows[-1]["state"] == "current" and fees == intr == 0, f"{tag} closed loan current, owes nothing")
T = be["totals"]
chk(T["cash_received_cents"] == sum(p["cents"] for x in be["loans"] for p in x["payments"]) and T["fees_income_cents"] == fee_amt * sum(len(x["fees"]) for x in be["loans"]), "BK1 totals")
chk(T["states_at_end"]["default_recommended"] == 10 and sum(T["states_at_end"].values()) == 40, "BK1 end states")
chk(any(x["states"][-1]["state"] == "current" and sum(x["owed_at_end"].values()) == 0 and any(p["date"] < "2026-07-01" for p in x["payments"][-1:]) for x in be["loans"]), "BK1 a loan closed before July stays current to year end (D23)")

# ---- ledger
coa ={a["account"]: a for a in load("ledger/chart_of_accounts.json")["accounts"]}
def entry_err(en):
    L = en["lines"]
    if len(L) < 2: return "too_few_lines"
    for l in L:
        if not all(isinstance(l[k], int) and not isinstance(l[k], bool) for k in ("debit", "credit")): return "non_integer_amount"
        if l["account"] not in coa: return "unknown_account"
        if l["debit"] > 0 and l["credit"] > 0: return "line_must_have_exactly_one_side"
        if l["debit"] < 0 or l["credit"] < 0 or (l["debit"] == 0 and l["credit"] == 0): return "non_positive_amount"
        if coa[l["account"]].get("requires_loan_id") and not en.get("loan_id"): return "missing_loan_id"
    if sum(l["debit"] for l in L) != sum(l["credit"] for l in L): return "unbalanced"
    return None
v = load("ledger/entry_validation.json")
for c in v["valid"]: chk(entry_err(c["entry"]) is None, f"ledger {c['id']} should be valid: {entry_err(c['entry'])}")
for c in v["invalid"]: chk(entry_err(c["entry"]) == c["error"], f"ledger {c['id']} expected {c['error']} got {entry_err(c['entry'])}")
r = v["reversal"]; bal = {}
for en in (r["original"], r["reversing_entry"]):
    chk(entry_err(en) is None, "reversal entries valid")
    for l in en["lines"]: bal[l["account"]] = bal.get(l["account"], 0) + l["debit"] - l["credit"]
chk(all(bal.get(k, 0) == x for k, x in r["expected_balances_after_both"].items()), "reversal nets to zero")
tb = load("ledger/TB1_trial_balance.json"); bal, per = {}, {}
for en in tb["entries"]:
    chk(entry_err(en) is None, f"TB1 {en['id']} invalid")
    for l in en["lines"]:
        sgn = 1 if coa[l["account"]]["normal"] == "debit" else -1
        d = sgn * (l["debit"] - l["credit"]); bal[l["account"]] = bal.get(l["account"], 0) + d
        if en["loan_id"]: per.setdefault(en["loan_id"], {}); per[en["loan_id"]][l["account"]] = per[en["loan_id"]].get(l["account"], 0) + d
E = tb["expected"]
chk(sum(l["debit"] for en in tb["entries"] for l in en["lines"]) == E["total_debits_cents"] == E["total_credits_cents"] == sum(l["credit"] for en in tb["entries"] for l in en["lines"]), "TB1 totals")
chk(all(bal.get(k, 0) == x for k, x in E["balances_cents"].items()), f"TB1 balances {bal}")
chk(all(per["L1"].get(k, 0) == x for k, x in E["per_loan_cents"]["L1"].items()), "TB1 per-loan")
# cross-fixture: TB1 accrual entries must equal AC4, payment split must equal WF1
ac4 = load("accrual/AC4_first_installment_period.json")["expected"]["entries"]
acc = [en for en in tb["entries"] if en["memo"].startswith("Accrue")]
chk([en["lines"][0]["debit"] for en in acc] == [x["entry_cents"] for x in ac4], "TB1 accruals == AC4")
chk(tb["entries"][-1]["lines"] == load("waterfall/WF1.json")["expected"]["journal_lines"], "TB1 payment == WF1")
chk(load("waterfall/WF1.json")["input"]["payment_cents"] == load("amortization/AM1.json")["expected"]["installment_cents"], "WF1 payment == AM1 installment")
chk(load("waterfall/WF1.json")["input"]["owed_before"]["interest"] == ac4[-1]["cumulative_cents"], "WF1 interest == AC4 total")

n = len(glob.glob(os.path.join(ROOT, "**", "*.json"), recursive=True))
if fails:
    print("FAIL:"); [print(" -", m) for m in fails]; sys.exit(1)
print(f"OK: {n} fixture files re-derived independently, 0 mismatches")
