# QQ Assistant scenario evaluation proposal and design review

Open `index.html` in a browser. It embeds the architecture viewer and all report data, source excerpts, proposed scoring dimensions and the fictional walkthrough. It needs no server or installed package. External citations require Internet access; links to the original source files require this checkout.

The user steered this review toward scenario-derived scoring dimensions and dataset construction with Luna as the proposed fast system-under-test model. The first page reflects that direction. The proposed 24 episodes have **not** been constructed or executed. No Luna/provider call, production database access, QQ operation, model configuration change or Goal activation was performed.

## Evidence

- `report-data.json`: current-source mechanism notes, critical questions and primary public benchmark citations, checked on 2026-11-05.
- `evaluation-proposal_CN.json`: five behavioral dimensions, 0/1/2 anchors, critical errors, a proposed source mix, baselines and an illustrative split between runtime input and reviewer-only criteria.
- `source-evidence.json`: bounded source excerpts with per-file SHA-256 identities. The baseline Git revision is `b74e11168f9be340aac30b72d832c099b8c8aeab`; pre-existing untracked work is not identified by that commit and has its own captured hashes.
- `local-dataset-check.json`, `local-replay-inventory.json`, `local-memory-inventory.json`: actual offline validation/inventory command results. These are not semantic evaluations. The captured replay inventory contains 43 cases / 89 steps; the memory observation inventory contains 4 cases / 8 steps.
- `scorer-probe.json`: a bounded VM evaluation of the scoring fragment extracted from the pre-existing `scripts/memory-bench-run.cjs`. One fixed correct output scores `pass`; two fixed incorrect outputs score `pass`; another incorrect output scores `pass_weak`. This establishes a scoring-logic gap, not the quality of any actual model output. The original script was not changed or run.
- `architecture.json`, `architecture.html`: an Archify architecture specification and delivered viewer. All nine artifact checks passed with no composition errors/warnings. Diagram source evidence is supplied in the report because this checkout has no configured public origin to pin in the diagram viewer.
- `architecture.visual-check.json`: four desktop viewport checks passed; smallest/largest light/dark screenshots were captured. The automated receipt retains `visualReview: pending` by design; the large light screenshot was inspected separately during authoring.
- `report-ui-check.json`: report tabs, dimension selection, benchmark search/filter, fictional trace, evidence filter, embedded viewer and dark theme passed. All six tabs were checked for horizontal containment at 1440x900, 1920x1080 and 390x844. Selected desktop and mobile screenshots were inspected.
- `evidence-manifest.json`: hashes for the authored report, data, viewer and captured evidence.

## Rebuild

`python3 docs/context-memory-review-20261105/build_report.py` regenerates the report from the existing local inputs and refreshes source snapshots. It does not call a model or run a product replay.

`node docs/context-memory-review-20261105/check_report.cjs` checks only the report in an isolated temporary Chrome profile. It does not start the product. The temporary profile is removed after the check. Screenshot and receipt files are written beside the report.

Architecture edits require fresh Archify validation/delivery. The delivered viewer was not modified after successful acceptance.

## Interpretation limits

The public benchmarks are recommended as source material and cross-checks, not as authority to replace the QQ Assistant's use case. Changed role mappings, Chinese translations, added authorization/actual-send variants, question cutoffs and scoring protocols must be recorded as adaptations. Their scores are not interchangeable with official leaderboard scores. Do not feed gold answers, evidence annotations or reviewer criteria to the system under test.

No new durable memory was written during this brainstorm. Recommendations are proposals, not user decisions.
