# Initial contract (frozen)
- Objective: prepare a separately identified streaming E2E setting that starts empty and drives the actual project adapter through chronological raw events.
- Only the adapter owns product imports; reviewer criteria never enter its calls.
- New assistant answers come from runtime requests; the runner never restores authored assistant turns or derived memory.
- Explicit idle events may observe normally scheduled work; pending/error state and native deadlines remain visible.
- No provider/QQ/configuration changes or paid calls are in this implementation scope.
- Acceptance sources: existing `scripts/eval-memory-understanding.cjs`, `scripts/eval-qq-adapter.cjs`, and raw fictional cases in `evals/memory-understanding/` and `evals/assistant/replay/withdrawal-v2.jsonl`.

## Additions
- User permits ordinary functional validation without mandatory mutation checks. This implementation uses focused data-boundary and adapter tests.
- Product-backed negative assertion found an existing runtime trace field collision: `emit` details named `event` replace its event-label field for source withdrawal. The stream checks the stable source ID and actual public-source removal; the main agent was notified. Runtime source remains outside this worker's ownership.
- Parent requested metadata-only post-pilot seed attestation: freeze original data bytes, add source-file SHA checks and cited ID verification, retain unaltered runtime/reviewer values, and do no paid rerun. The original source bundle v1 is immutable.
