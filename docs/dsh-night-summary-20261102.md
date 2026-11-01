# DSH Night Iteration Summary (2026-11-01 evening → 2026-11-02 early)

## Bottom line
Two rounds ACCEPTED (002d, sv-002). The structural rewrite is fully merged to main (cf11770 → 3386226 → 84b8326 → polish increments), 1928 tests green, and the running assistant picks it up on next QQ restart. Overnight live iteration is PAUSED on one external dependency: your local model proxy (cli-proxy-api on :8317, up 1d14h) returns HTTP 500 on every model call since ~23:00. Restart it in the morning and the queued campaign resumes with one command.

## Accepted rounds (evidence in .goal-runs/)
- 002d — coverage-long-private-consultation reached BOTH steps (7/7 usable): overlay/quarantine memory write path fixed the frozen "correction rejected as stable preference → journal jam" failure. Baseline physically cannot execute under current model latency (old 60s hardcode).
- sv-002 — coverage-long-single-source usable at BOTH steps: the adopted draft now contains the declared arrangement VERBATIM ("可以呀，周六三点半以后我有空，一起去看看" + recording detail). Four patch rounds never got past retrieval-without-consumption; the MQA consumption contract + live adoption validation + declaration riding closed it.
- Guards: zero regressions across all rounds; strict candidate preference semantics proved case-safe (owner-noted preferences applied throughout).

## Structural rewrite now on main (14 components)
Observation log (B2/B10) · overlay storage + write gate (B1) · maintenance orchestrator · staged retrieval with batched range reads (B9) · context compiler: request analyzer + MQA matrix (B5) + admission ladder (B4) + budget authority with call split (B6/B9) + identity entailment (B2) · contract registry + user text envelope (B3/B7) · presentation-bound feedback (B8). Plus parity harness (13 tests) pinning compiler-vs-legacy behavior as a permanent regression contract, with 3 real CC1 bugs found and fixed tonight (short-message mis-digestion b1, feedback material mis-reporting b2, shim budget wiring b3).

## Queued (ready to run)
1. mc-sweep — memory_continuity stage: 11 targets + 3 guards, rounds frozen, merged baseline dir built (14 cases, 80 recorded baseline calls). Candidate run attempted at ~23:40 but aborted by the proxy 500s; rerun when proxy is back.
2. cq-sweep — communication_quality stage: 19 targets + 2 guards, frozen.
3. validateArrangementHandling live wiring residual: response-side consumer exists (polish); wire-contract enum injection remains an optional lever.
4. Optional-layer retirement: parity report (docs/dsh-parity-report.md §6) lists the layer-by-layer port order; selection.cjs stays live until each layer's gap key disappears.
5. Lifecycle criterion for memory_continuity acceptance needs a daytime desktop validation (host restart / contact switch / reopen) — cannot be synthesized.

## User-reported symptoms follow-up
- Deleted messages influencing context: B10 fix (reconciliation tombstones) is in the merged observation log — needs desktop confirmation after you use the new build for a day.
- "Stale failed content" (B11): characterization found failed generations do NOT persist content; the one real residue (crash-left pending run mirrors) got store.markInterruptedRuns() at startup. If you see stale influence again, capture the turn IDs — next suspect is successful-but-poor rounds, which are by-design history.

## Environment notes
- modelTimeoutMs=300000 and memoryMaintenanceBatches=20 are set in data/settings.json (backup: settings.json.bak-20261101-timeout). The 929-entry journal backlog clears in ~2 manual maintenance clicks after restart.
- Restart cli-proxy-api, then restart QQ+assistant, then "重试整理记忆" — that order clears every known issue.
