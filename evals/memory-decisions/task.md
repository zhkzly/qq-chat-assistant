# Initial contract (frozen)
- Objective: provide an executable, architecture-independent component diagnostic for relations among old/new raw memory evidence.
- Preserve speaker, source identity/time, source availability and provisional review annotations; never pass reference labels to an evaluated adapter.
- Keep actual adapter outputs and failures; no automatic semantic verdict or end-to-end claim.
- Default commands are offline; real provider work requires an explicit live adapter and remains separate from project runtime replay.
- Do not change product code, existing cases/rubrics, provider configuration or another agent's files.
- Acceptance seeds: `evals/memory-understanding/cases.jsonl`, `evals/assistant/context-memory.jsonl`, and `evals/assistant/replay/withdrawal-v2.jsonl`.

## Additions
- The user's current AGENTS.md makes mutation-license checks optional. Boundary tests and fixed leakage/failure controls provide the evidence for this change.
- Owned files are limited to this dataset directory, its CLI/test, and the component setting document.
- Parent expanded ownership to `scripts/eval-memory-decisions-luna-adapter.cjs`: explicit read-only selected Luna settings, one bounded HTTP per decision, global cap including failures, actual request/response evidence, and injected-fetch tests. This worker issued no real provider calls.
- Source-review correction: later report time is not change-over-time. The temporary running and repeated quotation references retain this distinction; references remain provisional and ungraded.
- The parent standalone live entrypoint caught a shared-module initialization cycle before any HTTP dispatch. A real subprocess regression reproduced the partial VERSION/OUTPUT_SCHEMA exports; moving export initialization before main() fixed the boundary without changing prompts or criteria.
- Post-pilot engineering hardening: adapter module/factory/identity failures now finalize incomplete artifacts before any decision dispatch. Unobserved HTTP counts stay unknown; no frozen live bundle was rerun or edited.
- Independent raw-data review found ambiguous provisional axes. The original v1 references, public contract and runtime hashes were saved before a v2 reference correction. All raw runtime stimuli remain unchanged; no live decisions were inspected.
