# Initial contract (frozen)
- Objective: distinguish checkpoint reconstruction from scheduled-history replay and expose verifiable history preparation before claiming project-matched evaluation.
- Preserve the existing raw cases, reviewer criteria, product behavior, selected provider, approval settings and live-run opt-in.
- Persist preparation evidence separately from blinded quality review; never treat completed preparation as accurate understanding.
- Keep real QQ, credentials and production databases outside this work.
- Scope: adapter preparation receipts, runtime contract/configuration identity, CLI evidence export and focused offline tests; no JEV integration or paid run.
- Acceptance source: `scripts/eval-qq-adapter.cjs` open/restore/maintenance and `scripts/eval-runtime-session.cjs` normalization/archive boundaries; existing `tests/eval-qq-adapter.test.cjs` fixtures.

## Additions
- Mutation checks are optional under the user's current AGENTS.md. Ordinary boundary and integration tests provide the necessary evidence here.
- Existing root task/checklist/decision files and earlier report artifacts are pre-existing work and will not be overwritten.
- Negative tests first exposed the missing receipt. A follow-up fixture revealed that capped retries create more transport invocations than forwarded model requests; the receipt now reports forwarded, blocked and total invocation counts separately rather than weakening the accounting assertion.
- Independent architecture review confirmed source-contract/configuration identity gaps. Preserve frozen backend hashes, add contract identity, and reject source drift before each new episode.
- The user then selected both settings and explicitly authorized parallel agents; prior permission to test with Luna supports the bounded boundary pilots. Scope expanded from the initial no-paid-run plan to at most 12 E2E plus 2 component HTTP attempts, with no JEV calls or configuration changes. Every attempt and old runner identity is retained; no semantic ratings are assigned.
- Independent raw-data review, without model-output access, found overly narrow provisional references. Definitions and source provenance are refined separately; frozen live inputs/results are not overwritten or relabelled as quality evidence.
- Parallel implementation briefly exposed an unfinished bridge during a combined test run; that log is superseded by the completed bridge regression, not counted as a product failure. A real standalone CLI then exposed a circular export boundary; it was repaired and retained as a pre-network initialization failure with a subprocess regression.
