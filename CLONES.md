# Clones

Every project cloned from this template, and the release it is on. Update the row when a clone upgrades.

| Clone | Repo | Version | Notes |
|---|---|---|---|
| tradepost | [shanelabountyai/tradepost](https://github.com/shanelabountyai/tradepost) (private) | v1.0.1 | first clone, 2026-09-25; provider = org (clone D-001) |
| pulseboard | [shanelabountyai/pulseboard](https://github.com/shanelabountyai/pulseboard) (private) | v1.2.0 | 2026-09-26, merged v1.2.0 2026-09-28; product = org, `/ingest` authenticated by hashed write key (clone D-001/D-003) |
| callboard | [shanelabountyai/callboard](https://github.com/shanelabountyai/callboard) (private) | v1.0.1 | 2026-09-26; onsite event staffing, port 4600; `Person` never needs a `User` (magic links per person per event), templates registered into the notifications module at runtime |
| loanbook | [shanelabountyai/loanbook](https://github.com/shanelabountyai/loanbook) (private) | v1.2.0 | 2026-09-29; microloan servicing on an append-only double-entry ledger, port 4700; not deployed, synthetic data only |

**Portfolio scorecard artifact:** https://claude.ai/artifact/TognMvisj8T9GNQGtE9MbJ (data `audit/scorecard.json`, built by `audit/build-scorecard.py`, page from `audit/scorecard.template.html`; republish to the same URL after each release or batch of SEC fixes).
