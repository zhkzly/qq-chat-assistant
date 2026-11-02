# DSH Problem Backlog — Read-Only Cross-Component Audit

### B12 — arrangementHandling emission quality: disposition=used without evidence refs survives bounded repair — P1 (live, 2026-11-02)
On replay-job-change-later-recall s2 the live adoption validator correctly rejected a response claiming disposition=used whose evidenceRefs cited no delivered declaration sourceId (mqa-registry.cjs:227), and the repair guide named the fix — but the bounded repair round did not recover (arrangement_handling_evidence_missing, step failed). Root: the model emits arrangementHandling on non-arrangement contexts without understanding the evidence contract; the wire schema description alone is insufficient. Levers: (1) copy-ready example in the schema description showing used+evidenceRefs citing the declaration sourceId; (2) parse-time completion — when exactly one declaration was delivered and the response's evidenceRefs are empty but content matches the declaration, auto-fill the ref like the lookup completion pattern; (3) only surface the field when a declaration was actually delivered (deliveredDeclarationMaterials gate) so non-arrangement contexts never see it.
## Live user-reported additions (2026-11-01 evening, real desktop usage)

### B10 — QQ-local deletions never propagate to stored sources — P1
User reports deleted QQ messages still influence the assistant. Discovery honors source.deleted (conversation-discovery.cjs:7) but ingestion is append-only: nothing observes QQ-side local deletions or reconciles the stored set against the currently visible history. Recall/exclusion have paths; local deletion has none. Fix ownership: M1 observation log must ingest via reconciliation (visible-vs-stored diff -> monotonic tombstones), not blind append.

### B11 — Failed/partial generations may persist as stale discussion content — P1 (needs characterization)
User reports that after a model generation failed mid-discussion and the question was re-asked, the stale failed content still influenced later turns. Suspect: failed/partial outputs stored as companion discussion turns without lifecycle cleanup. Characterize in integration phase (candidate/discussion store failure-path lifecycle); no conclusion yet.

- Date: 2026-11-01
- Auditor: DSH parallel read-only problem hunter (no production code modified)
- Worktree: `dsh-goal` @ `612a497` ("Record completed intermediate-version reviews and integration policy")
- Scope: full `src/` audit (63 modules, ~10.3k lines) plus targeted `ui/app.js` reads, against the ingestion → storage → context assembly → budget → model client → output validation → server pipeline.
- Evidence class: **source-only static analysis**, plus one **synthetic in-process probe** (Problem 5). No desktop integration and no live model calls were performed. Line numbers refer to the audited commit.

## Relationship to the three known symptom streams

Three implementation streams already cover: (1) speaker misattribution on emotional disclosure, (2) context-budget blocking of long inputs, (3) memory gating that rejects local corrections as stable preferences. Everything below is **outside** those streams: adjacent triggers, latent hazards, and guard gaps that the three fixes will not touch. Frozen-case references use `goals/assistant-improvement/goal.json` stage case ids.

Severity: **P0** user-visible wrong behavior · **P1** reliability / correctness under realistic conditions · **P2** latent hazard or contract weakness.

---

## Problems (sorted)

### 1. Silent truncation of the user's standing instruction; legacy reply pipeline truncates and drops history with no omission signal — P1

**Affected goal capabilities:** communication_quality (standing style preference partially lost), memory_continuity (style continuity), reliability.

**Evidence (reachable path):**
- `src/controller.cjs:228` — `if (typeof instruction === 'string' && instruction.slice(0,2000)!==this.instruction) { ...; this.instruction = instruction.slice(0, 2000); ... }` — the standing response preference (设置里的长期口吻要求) is silently clamped to 2000 chars. No UI echo, no warning, no truncation marker.
- `src/model.cjs:64` — `userInstruction:redact(instruction).slice(0,2000)` (same clamp on the legacy wire).

**Evidence (latent compat path, currently unreachable from the controller — verified by grep that `Controller.model` is never invoked):**
- `src/model.cjs:30` `records.slice(-60)`; `:33` older matches `.slice(-12)`; `:38` `let budget = 18000` (chars); `:40` `redact(message.text).slice(0, 1800)`; `:41` `if (budget < text.length) break;` — per-message silent truncation and a silent stop once the char budget is exhausted. There is **no** omission counter, unlike the main pipeline (`src/context/selection.cjs:65-70` `deferredContext`, `:158` explicit "没有静默截断" error; `src/context/budget-manifest.cjs:24`).

**Trigger / reproduction:** (a) Submit an instruction longer than 2000 chars via `/api/options`; compare what the model receives (`payload.taskContext.responsePreference`) with what the user typed. (b) Any future consumer of `generate()` with >60 messages or a >1800-char message: the tail disappears without any marker.

**Fix direction:** clamp with feedback (reject, or persist + surface "已截断"), and either delete the legacy `generate/contextFor` path or give it the same omission markers as the main pipeline.

**Frozen-case link:** `cm-stable-preference-quoted-wish`, `conv-share-own-material-missing` (preference/style continuity guards).

### 2. Primary model response never checks `finish_reason === 'length'`; only the repair response does — P1

**Affected goal capabilities:** delivery_provenance (draft planning failing validation), communication_quality, reliability. Compounds symptom (2) by burning repair budget.

**Evidence:**
- `src/model-json.cjs:64-68` — `readModelOutput` maps `finishReason` into metadata but only rejects **empty** text when `finish_reason === 'length'` (`model_output_truncated`).
- `src/assistant-model.cjs:575-588` — the primary response is parsed with no `finishReason` gate; truncation is caught only implicitly because truncated JSON usually fails to parse and enters the format-repair flow.
- `src/assistant-model.cjs:675` — the gate exists only for the **repair** output: `if(repairedOutput.metadata.finishReason === 'length'){...throw...}`.
- Compounding hazard: `src/model-json.cjs:23-44` — `parseModelJson` scans for any single balanced `{...}` embedded in prose and accepts it if exactly one candidate parses. A length-truncated response that happens to contain one complete leading object can therefore be admitted as valid, silently discarding the model's lost tail.

**Trigger / reproduction:** configure a model that hits `max_tokens: 2200` (`src/assistant-model.cjs:97`) on a large planning request (long QQ context, verbose JSON). Observable effects: (a) an unnecessary format-repair HTTP attempt (extra task-ledger attempt from `request-budget.cjs:96-107`), or (b) rare silent loss of tail fields when a balanced object precedes the cut.

**Fix direction:** apply the same `finishReason === 'length'` rejection to the primary response before parsing; treat brace-scan recovery as unavailable when `finishReason === 'length'`.

**Frozen-case link:** `coverage-observed-output-feedback`, `coverage-feedback-current-material` (both baseline failures were "planning failed validation / no first output").

### 3. Compaction eligibility floor leaves a 6–12 KB band where an over-budget request can neither compact nor succeed — P1

**Affected goal capabilities:** memory_continuity (`coverage-long-single-source`, `coverage-long-private-consultation`), communication_quality. This is a *distinct* trigger from the budget fix stream: the compaction trigger threshold itself.

**Evidence:**
- `src/discussion-compaction.cjs:80` — `if (originalBytes < 12000 && !(pressure && originalBytes >= 6000 && candidateBytes >= 12000)) return null;` — below 12000 bytes of fresh private text, compaction never plans unless there is also ≥12000 bytes of structured candidates.
- `src/controller.cjs:531-537` — when `buildContext` throws the capacity error and no compaction plan exists, the capacity error is rethrown to the user verbatim (`if(!plan){ if(capacityError) throw capacityError; ... }`).
- Net effect: a single private message (or short recent private history) of ~6–12 KB combined with a large selected QQ layer overflows `byteBudget`/`byteLimit` with no compaction escape and no progressive QQ-layer bounding — the user sees "当前问题或最新完整来信超过上下文预算，请分段处理".

**Trigger / reproduction:** paste a ~8 KB private consultation request while a long QQ history is selected and the recent-exchange layer is already near its 12000-byte exchange limit (`src/context/planning-view.cjs:132`).

**Fix direction:** when `overflow` is true, lower the floor (the plan already receives `overflow`), or progressively bound the optional QQ/history layers instead of failing when the mandatory floor fits.

**Frozen-case link:** `coverage-long-single-source`, `coverage-long-private-consultation`.

### 4. Feedback binding trusts the client's `requestId`/`targetRef` without a liveness cross-check against the displayed candidate — P1

**Affected goal capabilities:** delivery_provenance (`coverage-feedback-current-material`, `coverage-observed-output-feedback`).

**Evidence:**
- `src/experience-store.cjs:390-395` (`addFeedback`) — with no `targetRef`, the target is resolved by `requestId` alone via `_legacyTarget`; the version check `if (args.expectedDigest && target?.bodyDigest !== args.expectedDigest)` is **optional**; when several artifacts share the `requestId`, the feedback is still stored with `targetStatus:'missing'` and later hydrated as an evaluation target.
- `src/experience-store.cjs:683` — `context()` falls back to the two most recent feedback records for **any** query (`(matchedFeedback.length ? matchedFeedback : available.slice(-2))`), so a mis-bound feedback keeps riding along as context.
- `ui/app.js:615` — `const targetRef=feedbackTargetRef||(cached?.requestId===requestId?cached.targetRef:null)` — the client caches target bindings in `sessionStorage`; after a regeneration (new turn, same client state) a stale `requestId` can bind the feedback to the previous artifact revision.

**Trigger / reproduction:** generate a candidate, regenerate (candidate session invalidates), then submit feedback from the stale UI state; inspect `experience_objects.feedback` `targetRef` — it names the older artifact while the user commented on the newer one. Idempotency itself is handled (`clientEventId`, `experience-store.cjs:385-389`); the binding identity is the gap.

**Fix direction:** require `expectedDigest` (or an `artifactRef`) for artifact feedback and reject when it does not match the newest artifact of that `requestId`; ignore `targetStatus:'missing'` feedback in `context()` evaluation targets unless explicitly selected.

**Frozen-case link:** `coverage-feedback-current-material` (invented quotation attributed to current material), `coverage-observed-output-feedback`.

### 5. Discovery raw-source fallback attributes a QQ source with missing `direction` to "self" — P2 (dynamically reproduced)

**Affected goal capabilities:** speaker attribution hygiene across all stages; navigation directory truthfulness.

**Evidence:**
- `src/conversation-discovery.cjs:38` — `const sourceSpeaker=source.type==='qq'?(source.direction==='incoming'?'contact':'self'):...` — unknown direction collapses to **self** instead of **undetermined**.
- Synthetic probe (in-process, this audit): calling `discoverConversationEvidence` with `{id:'qq:111',type:'qq',text:'压力很大…',use:'discussion',revision:'r1'}` (no direction) returns directory entry `speaker:"self"`; with `direction:'incoming'` it returns `"contact"`.
- Today every store-produced QQ source carries `direction` (`src/store.cjs:682`, `src/context/source-snapshot.cjs:55`), so this is latent — but the module is a public API also used by replay adapters that rebuild sources directly, and a future producer that omits direction would silently flip the speaker in the navigation directory.

**Fix direction:** map missing direction to `'undetermined'`.

**Frozen-case link:** `coverage-emotional-disclosure` (attribution family), guardrail for stream (1).

### 6. Source revision excludes sender identity, so a corrected speaker field never invalidates derived memory — P2

**Affected goal capabilities:** memory_continuity lifecycle/migration fidelity (goal.json `evidence.lifecycle.requirement` explicitly verifies migration of original IDs/identity).

**Evidence:**
- `src/store.cjs:21-26` — `sourceRevision` strips `sequence, senderUid, senderUin` from the QQ revision hash (deliberate, per comment).
- `src/store.cjs:17-19` — `messageEvidence` (the change detector in `add()`) strips only `sequence, senderUid` and **keeps** `senderUin`. The two identities disagree.
- Consequence path: if a normalization fix or migration ever corrects sender fields on stored messages, `add()` flags `invalidates = true` (messageEvidence differs) and wipes companion-derived state, but the source revision is unchanged, so `_syncMemoryPass` (`src/store.cjs:749-750`) takes the record-equality branch and derived memory rows stay bound to a revision that no longer represents the corrected attribution.

**Trigger / reproduction (migration scenario the goal contract requires testing):** take a baseline fictional DB, rewrite a message's `senderUid`/`senderUin` (simulating an ingestion fix), reload; observe that memory records survive with unchanged `sourceRevisions` while the message rows changed.

**Fix direction:** include a canonical speaker-role fingerprint in `sourceRevision`, or treat sender-field corrections as `'correct'` operations in `_syncMemoryPass`.

**Frozen-case link:** `coverage-observed-qq-recall`, stage-2 lifecycle acceptance criteria (goal.json).

### 7. `replyTo` time anchor silently dropped when not an exact whole-second multiple — P2

**Evidence:** `src/messages.cjs:42` — `reply.timestamp % 1000 === 0 ? reply.timestamp : null`; and `:45` re-derives seconds via `String(timestamp / 1000)`. A millisecond-precision anchor (or a provider that emits sub-second values) is discarded rather than rounded; quote resolution then relies on identity/sequence alone (`src/context/policy.cjs:94-107` — still safe, but the time anchor and the `clockAnomaly`/elapsed machinery lose one signal).

**Fix direction:** round to the nearest second instead of dropping.

### 8. Recent local feedback is injected as an evaluation target for every query — P2

**Evidence:** `src/experience-store.cjs:683` — when no feedback lexically matches the query, `available.slice(-2)` (the two most recent feedback records) are hydrated as `evaluationTargets`. They are labeled with constraints (`:697-698`), so this is a bias/budget concern rather than a correctness break: every assist request carries the latest local corrections even when irrelevant.

**Fix direction:** require a lexical match or an explicit `feedbackIntentId` for inclusion.

---

## Category audit matrix ("查过/没查过 + 证据")

| # | Fault mode | Verdict | Key evidence |
|---|---|---|---|
| 1 | Speaker/holder attribution lost in transformation/serialization/compaction/default override | **1 latent finding (P2 #5)**; main chain verified clean | QQ→source role/direction set at `store.cjs:682`; `speaker` attached in `source-snapshot.cjs:56,69`; timeline rows carry `speaker` with a direction fallback `timeline-view.cjs:22`; memory wire replaces sender IDs with semantic `author` aliases (self/contact/a#) `memory-engine.cjs:70-79`; compaction quotes require `quote.role === turn.role` `discussion-compaction.cjs:31,109`. Default-override hazard only in `conversation-discovery.cjs:38`. |
| 2 | Silent truncation of long inputs anywhere in the pipeline | **2 findings (P1 #1, #2 adjacent)**; main pipeline verified non-silent | Partial delivery is marked with continuation pointers `source-delivery.cjs:22-27`; omission counters `selection.cjs:65-70`, `budget-manifest.cjs:30`; explicit refusal-to-truncate errors `selection.cjs:158`, `wording-view.cjs:91`, `assistant-model.cjs:563,652`; memory batches segment with resumable journal cursors `store.cjs:886-899`. Exceptions found: instruction clamp (#1), primary-output length gate (#2); by-design bounded previews: discovery `short()` 110 chars with `requiresOriginalRead` (`conversation-discovery.cjs:13,50`), retrieval hint cap 4000 documented as non-evidence (`policy.cjs:114-116`). |
| 3 | Stale async results reused after contact/account switch | **audited, no finding** | Epoch guards `controller.cjs:67-75,119-135`; `current()` revalidates scope/epoch/revision/model binding/consent/context generation `controller.cjs:474-477`; memory maintenance `active()` `controller.cjs:413`; candidate session scope+revision+TTL binding `candidate-session.cjs:42-47`; HTTP-route scope guards `server.cjs:58,65,83-89,139-140,145-146`; task ledger scope mismatch `request-budget.cjs:27-31`; ledger recovers interrupted tasks on boot `server.cjs:184`. |
| 4 | Feedback bound to wrong turn / wrong source id | **1 finding (P1 #4)** | Idempotency via `clientEventId` verified `experience-store.cjs:385-389`; feedback-continue dedupe `controller.cjs:312-315`; continuation binds `feedbackIntentId` to the selected reference `controller.cjs:321-330` + `assistant-model.cjs:506`. Gap: optional `expectedDigest` and requestId-only legacy resolution `experience-store.cjs:390-395`. |
| 5 | Source chain broken after recall/exclusion; QQ message ID numeric/string corruption | **audited, no finding** (one latent note: #6 revision identity) | Recall cannot be undone by stale copies `store.cjs:140-143`; recalled messages leave sources, create gaps, invalidate artifacts/records `store.cjs:712-745`, `experience-store.cjs:612-657`; exclusions enforced in `_rawMemorySources` `store.cjs:680-686`; lookup re-checks liveness `controller.cjs:708-715`; fidelity checker refuses non-admitted fragments `whole-answer-fidelity.cjs:117-119,196,269-271`. IDs stay strings end-to-end (`store.cjs:133`, `messages.cjs:56`, `source-handles.cjs` handle mapping, `server.cjs:59-60`); BigInt only for ordering `messages.cjs:87-90`, `controller.cjs:200`. |
| 6 | Timezone / ordering / deadline errors making old look new | **audited, no finding** (P2 #7 minor) | All persisted times are UTC ISO; viewer zone validated `planning-view.cjs:94-95`; local display only at anchors `timeline-view.cjs:17-21`; future timestamps flagged `clockAnomaly` `timeline-view.cjs:19`; relative-time anchoring rule `assistant-model.cjs:25`; claim applicability recomputed against `asOf` `relationship-store.cjs:247`; memory protocol separates occurrence/report/knowledge-change clocks `memory-engine.cjs:17,203`. |
| 7 | Races between auto-load and manual actions | **audited, no finding** | Single-threaded Node with synchronous SQLite and `_atomic` transactions `store.cjs:250-255`; history tasks guarded by epoch+task symbols `controller.cjs:162-218`; ingest invalidates in-flight assists and bounds resumes `controller.cjs:136-158`; retry timer cleared on invalidation `controller.cjs:284`; feedback continuation keyed map `controller.cjs:340-342`; maintenance single-flight guard `memory-engine.cjs:265-269`. |
| 8 | Peer message content executed as instructions (prompt injection) | **audited, no finding** (defense-in-depth note) | Peer text only ever occupies data lanes (`sources`, directory previews, discussion reads); every system prompt frames records as untrusted data: `model.cjs:10`, `memory-engine.cjs:15`, `discussion-compaction.cjs:15`, image rule `assistant-model.cjs:48`, `help-behavior.cjs:13,25`; repair payloads mark `invalidResponse` as diagnostics-not-instructions `assistant-model.cjs:515,538`; tool results are inert envelopes `model-response-format.cjs:135`. Note: `redact()` is applied at every producer boundary I traced; the wire (`source-handles.cjs:23`) clones `text` verbatim — future producers must keep the redact invariant. |
| 9 | Compaction distortion: bindings lost, conclusions untraceable | **audited, no finding** (P1 #3 threshold) | Quotes must be literal spans of the identified field with role match `discussion-compaction.cjs:31-53`; turn fingerprints + source revisions bound and revalidated on every reuse `discussion-compaction-store.cjs:114-125,141-151`; candidates preserved via `candidatesForCompaction` + protected refs `:109-111,127-148`; folded originals stay lookup-addressable `planning-view.cjs:236-242`; uncovered older groups remain explicit (`deferredDiscussion` `selection.cjs:383`). |
| 10 | Memory write gating bypasses | **audited, no finding** | The only model-driven writer is `applyMemoryBatch` with delivered-source, revision, coverage and preference-attestation checks `store.cjs:994-1086` (preference attestation `:1031`, originals coverage `:1038-1041`); foreground `relationshipPatch` is removed from the result envelope `model-response-format.cjs:130` and queued only as `pending_original_review` `store.cjs:783-794` + `selection.cjs:444` (read-only authority labels); stable preferences require `assertPreferenceAuthority` `provenance.cjs:20-22` at every write (`store.cjs:326,1031`, `relationship-store.cjs:148-149`); user actions apply only on literal-command match or explicit confirmation `assistant-actions.cjs:39-68,143-158`; model experience proposals land as `candidate` only `experience-store.cjs:575-587`; program-created heuristic links are labeled `candidate`/`unlinked`, never confirmed (`experience-store.cjs:479-484`). |

## Out-of-scope / not audited

- `ui/app.js` was read only where the server contract required it (feedback, speaker rendering, suggest flow); a full UI audit was not performed.
- `evals/`, `goals/` tooling, and the Electron/QQ host integration (launcher, native reader) were not audited.
- No dynamic tests were run against the SQLite store or the model HTTP stack beyond the single discovery probe; all other claims are source citations.

## Suggested verification order

1. #2 (one-line guard, immediate reliability win, protects both draft streams).
2. #4 (feedback identity — directly guards the frozen feedback cases the first stage depends on).
3. #3 (compaction floor — distinct trigger for the budget family).
4. #1 (instruction clamp + legacy path disposition).
5. #5/#6/#7/#8 (latent hardening; #6 belongs in the stage-2 migration test).
