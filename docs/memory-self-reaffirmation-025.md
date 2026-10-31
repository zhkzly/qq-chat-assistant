# Same-identity understanding transitions (candidate 025)

This candidate fixes transaction preparation for the captured fictional V4
memory writer failure. It does not change the scheduler, observer, HTTP quota,
provider, replay adapter, raw cases, or QQ manual-send boundary.

The frozen comparison plan is
`.goal-runs/context-046-evidence-backed-understanding/supplemental-memory-reaffirm-followup-plan.json`
in the coordinator checkout. The candidate starts at
`e4491d27f9b07c0ab9d71aa4090bdaf96890ee49`, on
`feature/memory-self-reaffirm-025`.

## Cause and transition contract

Captured HTTP 4, 14, and 15 all returned valid outer existing IDs together with
single self-target transitions. Preparation previously staged the old and new
states as two writes under the same ID, then rejected their different semantic
signatures. HTTP 4 contains two reaffirmations. HTTP 14/15 also explicitly mark
the dated circumstance superseded under its original ID. This is normal pending
source-journal work, not a semantic recovery loop or a provider HTTP failure.

`prepareRelationshipPatch` now distinguishes these operations:

| Input | Persisted behavior |
| --- | --- |
| Single-target reaffirm, with matching outer ID/version | One active revision of that same typed record. |
| Single-target reaffirm, without outer ID | The target supplies the identity; no new successor is invented. |
| Self-target supersede with explicit `lifecycle:superseded` | One inactive revision preserving the original interpretation, support, and evidence dates. Proposed historical wording remains in transition audit. |
| Distinct successor or multi-target merge, with no outer ID | Separate successor plus explicit versioned predecessor transitions. |
| Mismatched outer/target IDs, conflicting versions, duplicate or ambiguous reaffirm targets, or active self-supersede | Reject before any relationship or journal write. |

Reaffirm retains canonical proposition text. The writer's supplied wording is
kept in `transition.proposal`; a paraphrase does not need exact text equality.
Entity, assertion/attribution, applicability, condition, validity, and event
occurrence fields must still agree. The program does not prove that a proposed
paraphrase or an added source semantically supports the existing proposition.
That remains a model and independent-output evaluation boundary.

Additional supplied corroborating evidence can be added after all necessary
old and new originals are read. Existing authority filtering still prevents a
private question from becoming contact-stated evidence. Canonical
`firstEvidenceAt`, `lastEvidenceAt`, and `reportedAt` use admitted source dates;
reviewing old originals alone cannot advance them. Genuine new support may
advance evidence/report clocks without changing `validFrom`, `validUntil`, or
`occurredAt`. A later report never supplies a missing event occurrence time or
changes its original QQ observation authority. The existing relationship view,
context catalog, selection, and search consume these existing timestamp fields;
there is no separate timestamp ledger.

All necessary original bodies, exact revision hashes, account/contact scope,
offered prior identities, object versions, source journal checks, and the store
transaction CAS remain required. Transitions are excluded from proposition
signatures but retained in transition and revision audit. Explicit competing
writes to the same identity reject atomically rather than being silently
coalesced because their proposition signatures happen to match.

## Evidence

`tests/fixtures/memory-self-reaffirmation.json` retains the actual fictional
HTTP 1/4/14/15 proposals and the original transport SHA-256. The offline test
reconstructs the QQ original, source times, ordinary question, exact m1/m2
version-1 prestate, and c1 delivery through production
`prepareMemoryRequest`/decode/`Store.applyMemoryBatch`.

The pre-change RED is retained under
`.goal-runs/memory-self-reaffirm-025-red/captured-http4.tap`: exit 1 with
`invalid_memory_result / Conflicting relationship updates for one record`.
The final 36-check zero-HTTP run is under
`.goal-runs/memory-self-reaffirm-025-green/boundaries-held.tap`. Full actual
decoded batches, requests, receipts, and before/after records for the three
captured writes are in its `captured/` directory. Additional checks cover
paraphrases, new corroboration, report versus occurrence clocks, complete
originals, stale versions/revisions, foreign scope, missing/partial originals,
competing updates, distinct successors, and multi-target merge.

The held backend hash and final commands/artifacts are recorded in
`.goal-runs/memory-self-reaffirm-025-green/handoff.json`. The local replay
directories retain all errors and unexecuted steps. Default synthetic replay
is product integration evidence only. No live call, semantic rating, or actual
desktop QQ integration is claimed. Replay quality review and integrated full
suite verification belong to the coordinator.
