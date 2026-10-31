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
| Self-target supersede with explicit `lifecycle:superseded` | One inactive revision preserving the original interpretation, support, and evidence dates. The latest proposed wording remains in transition audit while its sources remain available. |
| Distinct successor or multi-target merge, with no outer ID | Separate successor plus explicit versioned predecessor transitions. |
| Mismatched outer/target IDs, conflicting versions, duplicate or ambiguous reaffirm targets, or active self-supersede | Reject before any relationship or journal write. |

Reaffirm retains canonical proposition text. The writer's supplied wording is
kept in the latest `transition.proposal`; a paraphrase does not need exact text equality.
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
signatures. `revisions` retains version, signature, operation, and review-time
metadata; `transition.proposal` retains only the latest proposed wording. This
is not a recoverable history of every paraphrase. Canonical wording and its
revision-bound original support remain the factual record. Explicit competing
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

## Post-review lifecycle correction

Pre-review source `58858d2c44fffac0c75a2cb3183514246d80c389` has backend hash
`6843582469cd697db6aadc7c23c4595f8564ef1ea9971cd2cd4ce8a14733aeff`.
It is preserved along with its earlier failures and checks. Two independently
supported lifecycle defects are corrected after that freeze:

- Self-supersession retains the old active semantic signature in
  `retiredSemanticSignatures`, as explicit retirement already did. An idless,
  transitionless replay of the same original proposition is a no-op, including
  processor reindex and a later user question citing the original. These opaque
  keys are excluded from the memory writer's model payload. New actual direct
  support can establish a separately versioned understanding, including an
  explicit `change_over_time` successor. Its evidence clock comes from that
  source; the old fact keeps its original dates.
- A same-identity transition now records its own `sourceIds` and exact closure
  `sourceRevisions`. The existing `memory_dependencies` index contains both
  canonical fact support and transition support. Decision-only edit, recall,
  or withdrawal removes the latest proposal and its decision references, marks
  an inactive interpretation `inactive_decision_needs_review`, and retains its
  inactive lifecycle and retirement keys. Fact provenance, dates, and the
  original-read coverage for surviving fact sources remain separate. Losing
  fact support still takes the existing full-record invalidation path; activity
  withdrawal still leaves the existing uncertainty gap rather than restoring
  a previous acceptance.

Existing pre-review same-identity rows are repaired from their saved revision
metadata and exact original-read coverage before invalidation or public reads.
The repair uses saved source revisions, not a new attestation or report date.
If its decision originals are already unavailable, the proposal is removed on
the first candidate read. No new table, schema version, model call, scheduler,
or recovery platform is introduced. An inactive reason that needs review stays
inactive; the existing active-record recovery scheduler does not automatically
reactivate it.

The new fictional regression checks are in
`tests/memory-self-supersede-lifecycle.test.cjs`. The pre-fix RED run retained
10 checks with 7 failures at
`.goal-runs/memory-self-reaffirm-025-postreview-red/lifecycle.tap`.
The original zero-HTTP green run includes 12 checks, including two databases
created by the actual frozen pre-review Store, at
`.goal-runs/memory-self-reaffirm-025-postreview-green/lifecycle-migration-held.tap`.
Its original generation artifacts and pre-candidate database copies remain
preserved. Default tests now restore those actual old states from portable
fictional JSON snapshots:

- `tests/fixtures/self-supersede-pre-review-available.json`
- `tests/fixtures/self-supersede-pre-review-withdrawn.json`

Each fixture binds source revision `58858d2`, backend hash `68435824...`, the
original database byte SHA-256, the logical snapshot SHA-256, and the exact
old record IDs, before/historical metadata, source revisions, and dates.
The logical snapshot contains the schema, rowids, every table row, SQLite
sequence, and `user_version`. Restoring it can produce different database file
bytes; the test verifies the complete logical hash before opening the current
Store. It also directly verifies that the old row lacks retirement keys and
decision dependency fields/index entries before any candidate migration.
No current Store constructs or edits the old fixture state.

`node tests/memory-self-supersede-lifecycle.test.cjs` runs all 12 checks with
zero skips by default. It needs no baseline checkout, pre-existing temporary
path, or `QQ_SELF_SUPERSEDE_BASELINE_ROOT`. The evidence run explicitly unsets
that variable and is retained at
`.goal-runs/memory-self-reaffirm-025-portable-fixtures/default-lifecycle-held.tap`.
The two first-public-read upgrade checks still cover decision indexing then
withdrawal, an already withdrawn decision, proposal privacy, retirement
barriers, original clocks, and reindexing. The separate raw snapshot check
replaces the former current-Store-created simulated old row.

`tests/fixtures/self-supersede-legacy-store.cjs` remains an optional standalone
proof generator for an explicitly supplied immutable pre-review `src/`.
It takes a JSON configuration file naming `sourceRoot`, `filename`,
`resultFile`, and `withdrawBeforeUpgrade`; it is not invoked by default tests.
The existing actual-generation evidence is retained rather than regenerated
or substituted with a current Store.

OpenViking retrieval for withdrawal/dependency lifecycle returned source-only
product design and UI/review trajectories, with no matching invalidation
implementation evidence. Those hits do not justify a new architecture here;
the correction follows the actual Store dependency and transaction consumers.
All checks and default replays remain functional or synthetic integration
evidence. Actual conversational quality, live comparisons, and desktop QQ
integration remain outside this post-review correction's evidence.
