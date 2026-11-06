# Evaluation-setting fidelity implementation

Open [the offline summary](index_CN.html), or read [the design and critique](design-review_CN.md). This work prepares two separate settings while retaining the existing checkpoint replay:

- [Empty-start stream](../../evals/assistant-stream/README.md): four fictional episodes, two contrast families, normal product ingestion/requests/scheduled work through the replaceable adapter.
- [Controlled relation diagnosis](../../evals/memory-decisions/README.md): sixteen fictional cases, eight contrast families, a portable decision contract and an explicit read-only Luna bridge. It is a proposed decision component, not the production memory writer or a JEV integration.
- [Checkpoint replay](../../evals/assistant/REPLAY.md): existing raw-prefix reconstruction, now with a frozen engineering preparation receipt separate from behavioral review.

## Validation

`validation-evidence.json` records 98 focused offline checks and 40 compatibility checks, all passing. `npm run check` and `git diff --check` also passed. `seed-provenance-audit.json` records the actual verification of 20 seed references; semantic labels require separate calibration. The tests retain incorrect-role/time/use/body and source-drift negative controls, actual CLI setup failures and a standalone bridge import regression.

The parent executed bounded pilots with the unchanged selected `gpt-6-luna` profile. There were 12 actual HTTP attempts in total: five in the original stream pilot, five in the final frozen stream pilot, and two controlled component decisions. A preceding component CLI initialization failure dispatched no request and is separately retained. JEV was not called. All quality review fields remain ungraded; no speed or quality improvement is established.

Provider payloads and credentials are not copied into this report folder. Actual fictional pilot run/transport artifacts and the immutable source bundle remain in the `/tmp` paths recorded in `validation-evidence.json`. The compact report records their hashes and counts. A future archive should preserve the authorized artifacts separately rather than copy production chat databases or settings into Git.

## Review-driven revisions

The frozen live bundle retains the original provisional component contract and the old stream source metadata. Independent data review did not inspect live predictions. Later component reference/semantics clarification, setup-error hardening and stream source-hash attestation are recorded as new revisions, not retroactive quality scores. See the component `reference-revisions/` and stream `versions/v1/` / `provenance-v2.json` artifacts.

Sequential backend replay does not establish native desktop behavior, in-flight concurrent changes, restart persistence or causal human adoption. Controlled candidates do not establish production retrieval. These limitations are intentional and appear in the setting receipts.

## Reproduce report-only checks

```bash
python3 docs/eval-setting-fidelity-20261105/verify_seeds.py
python3 docs/eval-setting-fidelity-20261105/record_validation.py
python3 docs/eval-setting-fidelity-20261105/build_index.py
```

The second command reads the already recorded `/tmp` test and pilot artifacts; it does not rerun models. The first checks local fictional sources; the third creates a static offline HTML page. Model runs require the explicit runner flags documented in each setting.
