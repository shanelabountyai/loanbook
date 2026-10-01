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

# ---- ledger
coa = {a["account"]: a for a in load("ledger/chart_of_accounts.json")["accounts"]}
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
