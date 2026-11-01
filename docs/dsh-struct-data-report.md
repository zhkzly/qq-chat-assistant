# D1 Data-Layer Report — Observation Log + Memory Model (M1/M2 storage)

- Stream: `dsh-struct-data` (worktree `.worktrees/dsh-struct-data`, branch `feature/dsh-struct-data`, base `dsh-goal` @ `f0b6b51`).
- Alignment: build package **P0/D1** of `docs/dsh-subsystem-redesign.md` (§4.3): `src/memory/observation-log.cjs` + `migrateObservations` + baseline-DB upgrade tests with speaker-fingerprinted revisions, plus the M2 storage half (overlay storage, first-class quarantine, preference-upgrade proposals) and bottlenecks **B9** (batched range reads) and **B10** (local-deletion reconciliation) as directed by the coordinator.
- Verification status: **full `npm test` green (exit 0, zero failures)** on the final tree; every changed test carries an inline structural-reason comment; no assertion was weakened (several were strengthened, e.g. preference authority is now asserted through the authorization channel instead of batch refusal). No live replay was run (lead's responsibility). Evidence class: deterministic synthetic tests only.
- Evidence boundary: this report is source-level structural work. Nothing here claims conversational quality, Goal completion, or desktop behavior.

## 1. What landed

### 1.1 M1 — Observation Log (`src/memory/observation-log.cjs`, schema v3)

**Structure.** Two tables plus an audit trail:

- `observation_events(seq, scope_key, event_id, observation_id, kind, record, recorded_at)` — **append-only, enforced by SQLite triggers** (UPDATE/DELETE abort with `observation_events is append-only`). Event kinds: `observed | revised | recalled | excluded | redacted`. Event ids are content-addressed (the wall-clock `at` is metadata, never identity), so reconciliation replays and baseline backfills are deterministic and idempotent.
- `observation_bodies(scope_key, observation_id, revision, descriptor, text)` — the redactable current body per observation. Privacy operations (recall, forget, user deletion) drop the body row and append a tombstone event whose digest proves what existed — matching the previous `memory_sources` tombstone retention exactly (no new plaintext retention).
- `observation_migrations(scope_key, version, record)` — one backfill receipt per scope.

**Identity.** Each `observed`/`revised` event freezes `speaker`/`heldBy` via `speaker-identity.cjs`'s `observationSpeaker` (the derivation library absorbed as the single authority). A speaker change is legal only with an explicit `identityChanged` event carrying `previousIdentity` (backlog #6 soil: sender-role corrections become visible history instead of silently drifting).

**Revisions.** `revisionOf(source)` = content hash **including a canonical speaker-role fingerprint** `hash({type, speaker, role, direction})`. Consequences (tested): flipping who spoke changes the revision (derived memory invalidates); late scoped-sender-id *enrichment* without a role change keeps the revision stable (the deliberate enrichment carve-out is preserved). `Store.sourceRevision` and `messages.messageEvidence` both delegate/align to this formula (the messageEvidence/sourceRevision strip-set disagreement from backlog #6 is fixed).

**Reconciliation.** `Store._rawMemorySources` now (1) derives the ingest-store set (`_deriveSources`, the unchanged `sourcesFor` shape), (2) reconciles the log (`reconcile`: new ids → `observed`, changed digests → `revised`, vanished ids → `recalled`/`excluded`), then (3) returns the log projection **in the exact legacy shape and order** (log-internal metadata — speaker/heldBy/observedAt/lastEventAt/bodyDigest — stays in the log so persisted rows never churn on view metadata). Every mutation path funnels through `_writeCompanion → _syncMemory → _rawMemorySources`, so the log cannot drift; a parity test asserts fold == derivation after a mixed mutation sequence.

**Pre-log tombstones.** Lifecycle that predates the log (a recall or exclusion that happened under the legacy store) is recorded during backfill as a tombstone event *without inventing an observed body*.

**B10 — local-deletion reconciliation.** `Store.reconcileVisibleMessages(scope, visible)` compares a refresh's delivered visible QQ window against stored non-recalled messages; a stored message missing **inside the window** (between the window's earliest/latest by the canonical `compare`) gets a monotonic tombstone (`message_deletions`, reason `locally_deleted`) plus an observation-log `excluded` event, and disappears from every derived view while its raw row stays for audit. Messages outside the window are never inferred deleted (pagination-safe). `Controller.loadLatest` calls it with each delivered page. Tombstones are monotonic: a stale later copy cannot resurrect a deleted message.

**B9 — batched range reads.** `ObservationLog.readRanges(scope, requests≤32)` returns exact ranges + continuation metadata for many sources in **one program round trip** — the data-layer primitive the controller/wire streams can use to stop spending one model call per lookup.

### 1.2 Migration (§6.1 Phase A + speaker-fingerprint cutover, Phase 4)

Schema `user_version` 2 → 3, all inside the constructor transaction:

1. New tables (observation log, `memory_quarantine`, `preference_upgrade_proposals`, `correction_overlays`, `revision_cutover_map`, `message_deletions`).
2. `_remapSpeakerFingerprintedRevisions()`: recompute every `memory_sources` revision under the fingerprinted formula; move **live** revision pointers in lockstep — journal pending rows, `memory_dependencies`, and a deep remap of `*Revisions` maps and {sourceId, revision} refs across `memory_records`, `memory_gaps`, `discussion_compactions`, `experience_objects`, `companion`. Only exact old-hash matches are replaced (idempotent; unknown revisions are left to the existing staleness machinery, never silently rewritten). Historical receipts stay untouched.
3. `revision_cutover_map` persists old→new hashes so the semantic-signature anti-resurrection check can retry candidate signatures under legacy hashes (`relationship-store.cjs`); without this, pre-cutover retirements would lose protection (found by `memory-self-supersede-lifecycle` upgrade tests).
4. Observation-log backfill is lazy (first `_rawMemorySources`/`migrateObservations`), deterministic, idempotent.

### 1.3 M2 storage — corrections as overlays, preferences user-owned, first-class receipts

**Overlay corrections (`src/memory/correction-overlay.cjs` + `correction_overlays` table).** `correctRelationshipClaim` no longer rewrites or replaces the target claim. `correct` writes an `annotate` overlay; `withdraw` writes a `suppress` overlay plus bookkeeping (`suppressedByOverlayId`, retired-signature append for anti-resurrection) — the record body, version, evidence and wording stay untouched. Views resolve at read time (`relationshipView`/`personUnderstanding`): correction wins inside scope; evidence currency wins everywhere (a stale overlay renders as a visible `staleCorrection`, not applied); a correction overtaken by later legitimate re-review renders `priorCorrection.status='needs_current_interpretation'` with the current text winning. Scope kinds are origin-bound: user corrections may claim `record`/`until_evidence`; model/program corrections are always narrow (`next_exchange|topic|episode`).

**Decision-split preference gate (B1).** On the **model write path** (`applyMemoryBatch`):
- `kind:'preference'` items never commit — they land as first-class `preference_candidate` receipts; the batch still commits and **the journal always advances** (the `memory_preference_attestation_required` failure class disappears from the write path; the wire's `explicitPreference` flag is a deprecated no-op, accepted and stripped).
- `applicabilityKind:'recurring'` claims binding user behavior (`subject='self'` or `aspect='stated_preference'`) degrade to evidence-bound `unspecified` + a candidate receipt. Contact/dyad recurring *observations* are untouched (a "she always…" pattern is not a user preference).
- Quarantine receipts are first-class rows in `memory_quarantine` (status `candidate|dismissed|rejected`), surfaced by `quarantinedProposals` and counted in `memoryStatus` (`preferenceCandidates`, `pendingPreferenceUpgrades`).

**User-owned durability channel.** `preference_upgrade_proposals` materialize from candidates (grouped by subject/aspect/normalized text) with a program repetition counter (`count≥3 && distinctBatches≥2 → eligibleForProgramWidening`); single explicit declarations are pending immediately (user-confirmable, never auto-applied). `resolvePreferenceUpgrade(scope,{id,decision})`: `authorize` writes the recurring claim through the normal foreground gate (speech-attribution + `assertPreferenceAuthority`), so feedback-backed candidates still cannot launder into durability (`cm-stable-preference-quoted-wish` family); `dismiss` closes the proposal. User preference notes remain the other durable channel, unchanged.

### 1.4 Consumer contract (for stream 3 / greenfield consumers)

```js
// Identity authority (all downstream consumers read these, never re-derive):
store.observationLog                                   // ObservationLog
observations = store.observationLog.project(scope)     // Observation[] (live+dead, sorted by (at,id))
live      = store.observationLog.liveObservations(scope)   // Observation[] (adds speaker,heldBy,observedAt,lastEventAt,bodyDigest)
one       = store.observationLog.observationById(scope, id)   // Observation|null
identity  = store.observationLog.identityOf(scope, id)     // {speaker,heldBy,basis}|null (frozen)
closure   = store.observationLog.closure(scope, ids)       // Observation[]; throws on unavailable/stale lineage
events    = store.observationLog.events(scope)             // frozen audit trail (append-only)
invariant = store.observationLog.verifyInvariants(scope)   // {appendOnlyEnforced,identityStable,eventCount,version}
receipt   = store.observationLog.migrationReceipt(scope)

Observation = { ...legacySourceShape /* id,type,text,at,role,direction,use,messageId?,kind?,version?,evidenceSourceIds?,evidenceRevisions?,... */,
                revision /* fingerprinted */, deleted: boolean, speaker, heldBy, observedAt, lastEventAt }

// Sources for the memory/context pipeline (legacy shape preserved):
sources = store.memorySources(scope)            // == _rawMemorySources: reconciled log projection, legacy order

// B9 batched continuation reads (one round trip, no model call):
results = store.observationLog.readRanges(scope, [{sourceId,start,end}, ...])   // ≤32
//   -> {sourceId, available, revision?, start?, end?, text?, totalLength?, reason?}

// B10 deletion reconciliation (Controller.loadLatest already calls it):
{tombstoned} = store.reconcileVisibleMessages(scope, visibleNormalizedMessages)
ids          = store.locallyDeletedMessageIds(scope)   // Set<messageId> (monotonic)

// M2 overlays:
overlay      = store.applyCorrectionOverlay(scope, {targetRecordId,targetVersion,targetKind?,operation:'annotate'|'suppress',content?,sourceIds,sourceRevisions,scope:{kind,bound?},origin})
overlays     = store.correctionOverlays(scope, {activeOnly=false})
ok           = store.retireCorrectionOverlay(scope, id)
// View resolution is internal to relationshipView/personUnderstanding: corrected claims carry
// {correctedByOverlay:{overlayId,issuedAt,sourceIds}, originalText}; suppressed carry {lifecycle:'withdrawn',suppressedByOverlay}.

// Preference candidates / upgrades:
entries     = store.quarantinedProposals(scope, {status})        // first-class receipts
ok          = store.dismissQuarantinedProposal(scope, id)
proposals   = store.preferenceUpgradeProposals(scope, {status})  // {id,status,subject,aspect,text,occurrences[],evidenceSourceIds[],repetition:{count,distinctBatches,eligibleForProgramWidening}}
decision    = store.resolvePreferenceUpgrade(scope, {id, decision:'authorize'|'dismiss'})

// Signature helper (shared by write path and any future remap):
sig = semanticSignature(type, semantic, sourceIds, sourceRevisions)   // exported from relationship-store.cjs
```

**Ownership rules:** the log owns identity/time/lifecycle truth; `memory_sources` remains the memory pipeline's materialized snapshot; overlays own correction semantics; only the user channel (notes, upgrade confirmation) can mint durable preferences; the program owns classification, counting, tombstones and journal progress.

### 1.5 Tests (new)

- `tests/observation-log.test.cjs` (12): append-only triggers; identity frozen across revisions; mechanical speaker split; recall tombstones; projection parity after mixed mutations; fingerprint invalidation vs enrichment stability; deterministic backfill (identical event ids across identical builds); closure lineage + loud failure; batched range reads (B9); idempotent `migrateObservations`; B10 tombstone + monotonicity + window safety; B10 discovery unavailability.
- `tests/observation-migration.test.cjs` (4, design-named): deterministic event stream across byte-identical baseline copies; ids/times/disclosure/recall identity preserved through upgrade; event-idempotent reopen; scope enumeration.
- `tests/correction-overlay-scope.test.cjs` (6): no-rewrite correction; stale-source overlay not applied; overtaken correction flagged; origin-bound scopes; suppression + anti-resurrection; overlay retirement restores the original view.
- `tests/preference-candidate-lifecycle.test.cjs` (5): model recurring degrades to unspecified + candidate; repetition counter thresholds; authorize-through-foreground-gate; dismiss; deprecated wire flag inert.

## 2. Eliminated structural soil (mapped to the mandate)

| Soil | Elimination |
| --- | --- |
| Model proposes + classifies + attests in one step (B1) | Preference classification removed from the model write scope entirely; candidates + user/program channels own durability; journal always advances |
| Corrections as record rewrites | Scoped additive overlays; the corrected record keeps identity/version/evidence/wording |
| 7 parallel identity encodings re-derived per layer | One frozen identity at ingestion; consumers read the log; `sourcesFor` output keeps the legacy shape for compatibility while identity itself is no longer re-derivable from mutable fields |
| Revisions blind to speaker-role corrections (backlog #6) | Speaker-role fingerprint inside every revision + identity-change events + aligned change detector |
| B9: lookup round-trips burn the shared call budget | `readRanges` gives program-side batched continuation reads |
| B10: local deletions invisible (append-only ingest, no reconciliation) | Window-scoped monotonic tombstones wired into every refresh |
| Quarantine receipts buried in batch payloads | First-class rows with lifecycle, counters and a decision API |

## 3. Design deviations / conflicts recorded for arbitration

1. **Module placement of M2 storage**: design §4.2 lists `dsh-struct-data` for M1+M2-storage; I placed `correction-overlay.cjs` in `src/memory/` beside the log. If MW1 (`dsh-memory-write`) prefers it under its own tree, move is mechanical.
2. **Observation event/body split**: the design names one `observations` table; I split events (append-only, digest-bearing) from bodies (redactable) because privacy operations must erase plaintext while history stays auditable — a single append-only table cannot do both. Semantically compatible with the design's M1 contract.
3. **Degraded recurring claims stay as records**: the design says model recurring proposals become candidates only; I additionally keep an evidence-bound `unspecified` claim (misclassification degrades to narrower recording instead of vanishing), matching `dsh-target-architecture.md` §2.2. If MW1 wants candidates-only, the degrade branch in `relationship-store.cjs` `attempt()` is the single switch.
4. **Wire keeps the deprecated `explicitPreference` field** (accepted, stripped) rather than rejecting it — old-prompt-shaped responses must not burn a correction round (B9-adjacent economics). C6/W1 owns the final wire shape.
5. **Anti-resurrection legacy retry** adds a `revision_cutover_map` table not in the design; scoped strictly to pre-cutover signature comparisons and inert for new data.

## 4. Residual risks

- **Revision literal churn**: every persisted revision hash changes once at upgrade. All live pointers are remapped in lockstep and verified by the baseline-DB tests, but any *external* consumer that pinned raw hashes (exports, research archives) will see new values — intentional (backlog #6) but must be communicated.
- **Signature remap is best-effort**: the legacy-retry covers signatures whose refs match current refs (the common self-supersede/retire shapes); exotic pre-cutover transitions with different ref sets could still miss anti-resurrection and would resurface as duplicates for semantic review, not as corruption.
- **B10 window inference**: a provider that returns sparse windows (holes without deletions) would tombstone falsely. The read layer currently returns contiguous pages; if the host ever paginates oddly, the within-window rule is the place to tighten (e.g. require adjacency).
- **Overlay read-resolution cost**: `relationshipView` now folds overlays per call; volumes are small (user corrections), but a hot path materializing views per request should cache per companion revision.
- **Migration surface**: ~15 legacy tables are touched by the cutover walk; covered by five independent baseline-upgrade test families (009b4aa, 038, 039, 040, 041 fixtures), yet any schema added by parallel streams before integration needs its rows added to the walk.
- **Preference UX**: candidates and upgrade proposals are surfaced via store APIs and `memoryStatus` only; the UI/server surface for user confirmation is another stream's work — until it exists, single-declaration durable preferences require the notes channel.

## 5. Predicted impact on the 38-case acceptance surface (hypotheses for goal-round verification, not claims)

- **`coverage-long-private-consultation` (B1/Flow C)**: the memory preparation can no longer jam on a misfiled preference — candidates commit, the journal advances, the request round stays reachable (deterministically reproduced in `tests/local-correction-memory-scope.test.cjs`).
- **`cm-local-correction-continuity`**: corrections are additive overlays; the stable record is never rewritten (asserted), and narrow scopes cannot leak across topics (scope kinds origin-bound; closed-topic guards unchanged).
- **`cm-stable-preference-quoted-wish`**: quoted/contact/feedback lineages cannot reach the durable lane — authority is enforced at authorization time, not just at write time (stronger than before).
- **`coverage-observed-qq-recall` / withdrawal family**: recall/exclusion tombstones are now first-class history with deterministic migration; pre-log recalls are recorded without invented bodies.
- **`coverage-emotional-disclosure` (Flow A)**: identity is frozen once and entailment rendering (landed stream A) now consumes a stored authority rather than a per-request re-derivation — the remaining parallel-assertion consumers disappear as streams adopt the log API.
- **`coverage-long-single-source` / B9**: program-side batched range reads remove the lookup round-trip pressure; the ladder itself is stream B/C work.
- **Neutral-to-positive**: all other cases rely on unchanged read shapes; the full frozen suite (synthetic transport) is green.
- **B10 (new)**: locally deleted messages disappear from discovery/context with explainable tombstones; raw history is preserved for audit.

## 6. Verification commands

```
npm test                 # full suite, exit 0 (includes the four new test files)
node tests/observation-migration.test.cjs   # D1 baseline-DB upgrade scenario (frozen 009b4aa builder)
```
