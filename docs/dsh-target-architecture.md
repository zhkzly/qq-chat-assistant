# QQ Assistant — Target Architecture (DSH Architecture Review Track)

- Role: `qq_architecture_reviewer` (read-only product review; this document is the only write).
- Scope: whole-product structure review against the Goal contract `goals/assistant-improvement/goal.json` (v2026-10-30.2), which sets `iteration_policy.architecture_rewrite_allowed: true` and explicitly warns against both "preserving a faulty architecture to minimize the diff" and "rewriting components merely to make a large change".
- Inputs inspected: `src/**` (controller, store, memory-engine, relationship-store, context/*, selection, policy, budget-manifest, discussion-compaction, request-budget, assistant-model, whole-answer-fidelity, source-handles/snapshot/delivery, conversation-discovery, provenance, activity-evidence headers), `plugin/**`, `ui/app.js`, `src/server.cjs`, `scripts/eval-qq-adapter.cjs`, the frozen replay dataset (`evals/assistant/replay/coverage-v2.jsonl`), `evals/assistant/rubric.json`, existing docs (`docs/architecture_CN.md`, `docs/context-architecture-map_CN.md`), and the goal's four known failures.
- Evidence status of this document: **source-only design reasoning** grounded in the frozen case definitions. It is not conversational-quality evidence, not a round acceptance, and not a claim of Goal completion. Every proposed check must be run under the goal-round process before any behavioral claim is made.

---

## 0. Executive summary

The pipeline already contains unusually strong provenance machinery (scoped author verification, revision hashes, source closures, publication seals). The three live failure classes are **not** caused by missing provenance features; they are caused by three structural choices:

| Flow | Symptom (frozen case) | Structural root | Source evidence |
| --- | --- | --- | --- |
| A | User's private statement ("压力大" class) attributed to the contact | Identity is re-asserted, not carried: 7+ parallel encodings (`direction`, `role`, `speaker`, `subject`, `attribution`, `assertionKind`, discovery `sourceSpeaker`), each validated at a different layer; derived summaries float free of the speaker of their evidence | `src/context/source-snapshot.cjs` `sourcesFor`; `src/relationship-store.cjs` `prepareRelationshipPatch`; `src/conversation-discovery.cjs` |
| B | `coverage-long-single-source`: answer hard-blocked by context budget | The degradation ladder ends in a **throw**, and the one mitigation that could save a single over-budget required source (discussion compaction) only folds *private discussion turns*, never a single giant source | `src/context/selection.cjs` ("当前问题或最新完整来信超过上下文预算…没有静默截断"), `src/context/budget-manifest.cjs` `finish()`, `src/discussion-compaction.cjs` `planDiscussionCompaction` |
| C | `coverage-long-private-consultation`: memory preparation rejected a local correction filed as a stable preference; help never reached | **All-or-nothing batch commit**: one invalid proposal (preference without authority) rejects the whole batch, the journal cursor never advances, and the replay prefix-preparation loop (and product backoff) treats the queue as stuck | `src/provenance.cjs` `assertPreferenceAuthority`; `src/memory-engine.cjs` `maintainMemory` (`applied.applied === false → break`); `scripts/eval-qq-adapter.cjs` drain loop |

One-sentence target: **an append-only observation log with immutable speaker/holder identity as the only authority, a scoped-fact memory layer where corrections are additive overlays and stable preferences are user-owned (never model-proposed), and a requirement-driven context compiler whose budget degrades evidence quality in an explainable ladder but can never refuse to answer.**

The three most critical structural decisions (justification in §2):

1. **Identity by entailment, not by assertion** — the prompt renderer derives each fragment's holder label from the speaker set of its evidence closure; model-chosen `subject`/`attribution` become *claims to be checked*, not facts to be rendered.
2. **Partial commit with quarantine** — memory batches commit valid records and quarantine invalid ones with per-record receipts; the journal always advances; stable-preference writes leave the memory model's write scope entirely.
3. **A guaranteed-degrade budget ladder** — required evidence degrades verbatim → ranged excerpt → deterministic program digest (with lookup handles); the hard throw survives only for a truly unusable *current request*, never for background evidence.

---

## 1. Current-state map

### 1.1 End-to-end pipeline (as built)

```
desktop QQ (plugin/native-driver, ipc-transport)
   └─ Controller.ingest / loadLatest / loadOlder     [src/controller.cjs]
        normalize() — scope check, sender→direction, string msgIds, reply refs, recall
        [src/messages.cjs]
      └─ Store (SQLite)                              [src/store.cjs]
           messages, coverage, companion{goal,notes,turns,state,topics,runs,feedback,
           pendingActions,actionReceipts}, memory_sources(+revisions), memory_journal,
           memory_records, memory_dependencies, memory_exclusions/gaps/receipts/migrations,
           discussion_compactions, assistant_tasks+model_requests (TaskLedger),
           ExperienceStore tables
      └─ (background) memory maintenance             [src/memory-engine.cjs]
           memory journal → batch (≤24k src bytes, ≤32 sources) → alias wire (s#/c#/m#,
           author self|contact|a#, q# sequences) → model → decode → validate →
           applyMemoryBatch (prepareRelationshipPatch) → typed claims/events + episodes
                                                             [src/relationship-store.cjs]
      └─ (interactive) assist()                       [src/controller.cjs]
           retrievalQuery → searchMemory / relationshipView / topicView / experience /
           conversation-discovery → buildContext       [src/context/planning-view.cjs]
             sourceSnapshot → protected/essential ids → selectPlanningContext
             [src/context/selection.cjs] under contextBudget (payload + serialized
             request fits) with discussion compaction pre-stage
           → assistantModel (multi-pass ≤5, lookup ≤2) [src/assistant-model.cjs]
             s# handle encoding (SourceHandleOwner), parseAssistantStrict,
             draftPlan/answer admission, publication seal, whole-answer-fidelity audit
           → appendTurn + CandidateSession publish     [src/candidate-session.cjs]
      └─ server.cjs (localhost HTTP, bearer, CSP) + ui/app.js (assistant window)
```

### 1.2 Component inventory (responsibility · contract · state ownership · lifecycle)

| Component | Responsibility | Key inputs → outputs | State owned | Lifecycle / invalidation |
| --- | --- | --- | --- | --- |
| `plugin/*` + `native-driver` | Read-only QQ observation, draft-fill | native events → raw msg objects | none | process-bound; no persistence |
| `messages.normalize` | Verified attribution floor | raw + scope → record (direction, sender ids, reply refs, recall) | none | immutable per messageId; recall is monotonic |
| `conversation-discovery` | Keyword-overlap navigation directory | sources + records + query → directory + source refs | none (pure) | per-request |
| `Store` | All persistence; journal; projections | records/turns/notes/goal → companion + memory tables | SQLite (sole owner) | `changedSource(invalidate)` wipes derived state on evidence change; migrations run inside `_getCompanion` reads |
| `memory-engine` | Batch building, wire aliasing, decode validation, one correction attempt | journal batch → model call → validated patch | none (writes via Store) | batch loop; `rejected/error/blocked` → failure backoff |
| `relationship-store` | Typed fact semantics: transitions, activity evidence, preference authority, retirement signatures | patch + delivered sources → versioned claims/events | via Store tables | versioned supersession; retired signatures prevent replay |
| `request-budget (TaskLedger)` | HTTP attempt accounting per task | stage requests → attempts, usage | `assistant_tasks`, `model_requests` | task-scoped; recover on interrupt |
| `policy.cjs` | Recent-window policy, anchor neighborhoods, quote targets, retrieval query | records + settings → plans | none | per-request |
| `source-snapshot / source-delivery` | Canonical source projection + ranged delivery | records/companion → sources with revisions/delivery | none | revision = content hash (QQ minus sequence/sender identity) |
| `planning-view.buildContext` | Orchestrates snapshot, protections, views, budget | options → context{payload, manifest} | none | frozen per request; `rebuildForRequest` for measured rebuild |
| `selection.cjs` | Priority admission under measured budget | candidates → selected sources + layered views | none | per-request; explicit manifest of choices |
| `budget-manifest` | Envelope measurement, final fit check, selection manifest | payload → manifest | none | per-request |
| `discussion-compaction` | Fold old private discussion groups into summary+literal quote refs | turns → compaction record (identity-bound) | `discussion_compactions` | invalidated by goal/topic/model/prompt/protocol binding or turn fingerprints |
| `assistant-model` | Wire encoding, multi-pass loop, output parsing/admission | context → turns + patches + lookups | none | candidate-session-scoped |
| `whole-answer-fidelity` + `publication-seal` | Output grounding audit, disclosure binding | prepared context + result → receipt | receipts in runs/turns | per-publication; source-currency asserts |
| `candidate-session` | Output validity, reuse, private-input sequencing | publishes candidates | in-memory + store turns | invalidated by revision/scope/model/private input |
| `server.cjs` / `ui/app.js` | Local API + assistant window | snapshots, actions | UI-local draft/origin state | scope-bound, localStorage per scope |

### 1.3 Overlaps and contract ambiguities (observed, with consequences)

1. **Identity encoded seven ways.** `direction` (normalize), `role: user|contact` (`sourcesFor`), `speaker: 我|对方` (same), `subject: self|contact|dyad` (claims), `attribution` (speaker|user_report|…), `assertionKind` (stated|reported|observed), `author` aliases in the memory wire, `sourceSpeaker` in discovery. Each layer re-derives or re-trusts identity instead of referencing one immutable fact. Consequences: (a) rendering bugs become possible at each seam (Flow A); (b) validation rules are scattered (`contact+stated` checked in *two* places — `relationship-store` `prepareRelationshipPatch` and `assistant-model` `parseAssistantStrict` — with subtly different matching: one matches `direction === 'incoming' || role === 'contact' || speaker === '对方'`, the other requires `type === 'qq' && role === 'contact'`).
2. **Two byte budgets + one attempt budget + six soft reservations.** `assistantContextBytes` (payload, 48k), `assistantRequestBytes` (serialized request, 64k), `assistantRequestLimit` (TaskLedger attempts), `memoryInputBytes`; soft reservations: exchange 12k, private layer 14k, relationship 7k, optional raw 6k, directory 3.5k, maxAdditionalBytes 12k. The soft caps interact with the measured `fits()` in ways no single component can explain (Flow B's "偶发溢出" — occasional overflow — is this complexity leaking).
3. **Compaction contract gap.** `planDiscussionCompaction` folds *turns* (private discussion groups with assistant content) but a single giant user source (the exhibition hand-note in `coverage-long-single-source`) is not foldable: it is one source, and `lowerBound` in the compaction plan even returns `null` when the minimal request would not fit. So the ladder's only mitigation cannot fire exactly when it is most needed.
4. **Read-path writes.** `Store._getCompanion` performs migrations, feedback-reference normalization, discussion-derived pruning, and task-semantics migration *during reads*, inside transactions. Contract ambiguity: callers cannot know whether a read mutates; failure modes surface far from causes.
5. **All-or-nothing memory commit.** `applyMemoryBatch` applies the whole patch or records an error and the loop breaks. A single misfiled proposal (preference attestation, activity proof, stale target) discards all valid work in the batch and leaves the journal stuck on the same sources (Flow C).
6. **Discovery vs. searchMemory vs. relationshipView ranking.** Three retrieval-ish services with different scoring (`conversation-discovery` term overlap; `memory-search` rank; `relationshipView` rank + activity chains). The assembly calls all of them (`memoryResult`, `index`, `memoryDiscovery`, `relationshipContext`, then `historical` lexical matches inside selection). Consumers cannot state which service owns "what is relevant".
7. **Guard duplication between memory write and assist read.** Preference authority is enforced at memory-write time (`assertPreferenceAuthority` via `prepareRelationshipPatch`), at note-save time (`saveNote`), and at prompt time (`payload.preferences` only from `notes kind=preference`, plus legacy-preference *lookup hints*). Three lifecycles for one semantic.

---

## 2. Target architecture

### 2.1 Identity model — speaker/holder/provenance as first-class, immutable, prompt-surviving

**Principle: identity is established once, at ingestion, by verified scope matching, and everything downstream *references* it. Model outputs never assert who said something; they propose what was said, bound to observation ids.**

- **Observation (append-only, immutable).** Unify what `memory_sources` already approximates into the canonical event record:
  ```
  Observation {
    id            // stable: qq:<messageId> | private:<turnId> | note:<id> | feedback:<id>
    scope         // accountUid/accountUin/peerUid/peerUin — as today
    kind          // qq_message | private_turn | note | feedback
    speaker       // self | contact  — from normalize()'s verified scoped-author match (unchanged, it is already authoritative)
    heldBy        // whose state this utterance *directly* evidences: speaker
    occurredAt    // source time (msg time / turn createdAt)
    recordedAt, revision, text (content-addressed), use, deleted/excluded
    replyTo?      // verified quote target (existing nativeReplyReference logic)
    thirdParties? // names quoted *inside* the text (周师傅, 何阿姨…) — modeled as opaque references, never as self/contact
  }
  ```
  This is not a new database rewrite: it is a strict projection of `messages` + companion turns/notes/feedback (the `sourcesFor` shape) **promoted to the only identity authority**, with `speaker` made immutable and required. Third-party mentions become a typed field so "a quoted colleague's experience is not her experience" (already a memory-system rule) becomes mechanically checkable instead of prompt-hoped.
- **Derived artifacts reference observations; renderers derive labels.** Claims, episodes, material items, compaction quote refs, and prompt fragments keep `evidence: [{observationId, span?}]`. The **renderer** computes `holderLabel(fragment) = speakerSet(evidenceClosure(fragment))` and prints it per fragment, e.g.:
  ```
  [C12 · 她的感受 · reported-by-user] basis: user private statement (private:lp-u1 @09-01) — not her words
  [C13 · 她的感受 · stated-by-her]     basis: qq:4567 @10-01 18:00 (incoming)
  ```
  `subject`/`attribution` remain model-proposed fields, but they are now *checked against the closure*: a fragment whose closure contains zero contact-speaker observations can never render as contact-stated. This converts Flow A from "hope the model files the right labels" into "the prompt physically cannot present a contact attribution without contact evidence".
- **Write gate (extends existing checks).** Keep today's `contact+stated ⇒ requires QQ contact source` rule, but implement it once (in the observation layer) and consume the single implementation everywhere (memory writes, assist-time patches, fidelity audit). The duplicated, subtly different checks in `relationship-store` and `assistant-model` collapse into one.
- **Why not full event sourcing everywhere.** The companion document (goal/topics/turns) already behaves as a foldable projection, and the eval contract requires each candidate to *rebuild state from raw observations* — which this model preserves. A complete event-store rewrite of goals/topics/runs would touch the replay adapter's rebuild path without any of the three failure flows requiring it. Rejected as unnecessary (see §3 Q8).

### 2.2 Memory model — scoped facts with holder+time+source; corrections as overlays; preferences user-owned

- **Keep the typed-fact core.** `subject/aspect/assertionKind/epistemicStatus/applicability(local|temporary|recurring|conditional)/validFrom/validUntil/transitions` with versioned supersession is sound and matches the failure evidence better than a flat memory would. The fix is in *who may write what*, and in *failure handling*, not in the fact schema.
- **Corrections become scoped overlays, not preference rewrites.** A correction ("她没有这样说过" / "这次别把她的每句话拆成好几个问题") is recorded as an additive event:
  ```
  Correction {
    id, issuedAt, sourceObservationIds      // the correction is itself an observation-bound fact
    target: {kind: claim|behavior_pattern|observation_interpretation, id?}
    scope: {kind: episode|topic|next_exchange|until_evidence, bound?}   // default: narrowest
    content                                 // what to override and why
  }
  ```
  Scope defaults to the *narrowest* binding (current topic / next exchange). Widening to recurring happens only by (a) explicit user attestation (the existing `explicitPreference` channel) or (b) a program-detected repetition rule (N independent corrections from distinct episodes, counted by code, proposed to the user — never auto-applied). Stable preference and local correction become **orthogonal dimensions** (scope × stability), so "misclassification" degrades to "recorded with a narrower scope" instead of "rejected".
- **Partial commit with quarantine.** `applyMemoryBatch` becomes: validate each proposal independently → commit the valid set transactionally → quarantine invalid proposals into per-record receipts (code, field, allowedShape — the wire-error vocabulary already exists) visible in `memory_gaps`-style storage → **always advance the journal cursor** for sources whose remaining proposals are all quarantined. Atomicity is retained only where it is semantically required: a transition chain (supersede/contest/merge targets + successor) commits or quarantines **as a unit**. The memory-model correction round (one retry today) stays, but it is now an optimization, not the only path to progress.
- **Preferences leave the model's write scope.** The memory model may no longer emit `kind:'preference'` items or `applicabilityKind:'recurring'` claims that bind user behavior. It may emit *preference candidates* (pending, user-visible). `assertPreferenceAuthority` survives as the audit for legacy data and note-bound preferences, but the entire `memory_preference_attestation_required` failure class disappears from the write path because the model cannot produce it.
- **Provenance of derived text.** Episodes/summaries (navigation layer) keep `requiresOriginalRead` semantics but additionally render with derived holder labels (§2.1), so even navigation cannot misattribute.

### 2.3 Context assembly — requirement-driven selection with a guaranteed degradation ladder

- **Typed ContextRequest.** The request declares its needs explicitly (today this is implicit in ~15 flags): `{intentSource, anchors: replyFocus|images, requiredEvidence: [observationId…] (from admitted plan), topicControls, feedbackTargets, wants: discovery|methods|…}`. The assembler returns a **ContextPlan + Bill of Materials** (the selection manifest already exists; formalize it as the contract between assembly and the model layer).
- **The ladder (per required-evidence item, and globally):**
  1. verbatim admission (existing `boundedSource` full body);
  2. ranged excerpt with explicit delivery metadata + continuation lookup (existing `source-delivery-v1`);
  3. **deterministic program digest** (new): structure-aware extraction — for the exhibition note, per-`第N项` paragraph digest lines (first sentence + key nouns + byte range), marked `derived_digest_needs_lookup` with per-item lookup handles; no model call, no invention, bounded bytes;
  4. navigation-directory entry only (existing discovery projection).
  The model keeps its bounded lookup loop (≤2 today) to pull exact ranges on demand — the ladder makes step 3 the *bridge* that guarantees an answer can always be produced with partial evidence, honestly labeled.
- **No dead end except a genuinely unusable request.** The final `throw` survives for exactly one case: the current request text itself cannot be delivered (already bounded: input ≤16,000 chars). Everything else degrades. "永不静默截断当前交互" is preserved — and strengthened — because the *current interaction* (intent + anchor exchange + delivery policy) is the never-degraded floor; background evidence is what degrades, explicitly.
- **Explainable budget.** `manifest.degradation = [{step, appliedTo, recoveredBytes, remainingNeed, lookupHandle}]` plus today's `inputBytes/byteBudget/serializedTextRequestBytes`. One `ContextBudget` object owns payload bytes and serialized-request bytes (the two-cap `fits()` stays but is owned in one place); layer reservations become named allocations from it; TaskLedger remains the independent HTTP accounting authority (cost control is a different concern from context fitting and should stay separate).
- **Compaction demoted from special pre-stage to ladder step.** Model-driven discussion compaction stays as the *highest-quality* fold for old private discussion groups (its literal-quote contract is excellent), but it no longer gates request feasibility (`compaction_budget_insufficient` as a hard stop disappears): if there is no budget headroom for a compaction call, the request proceeds on the digest ladder instead of failing.

---

## 3. Necessity interrogation (contract-required challenge)

For each component: is it necessary? Who consumes it? Are boundary and lifecycle complete? How does its state/evidence conflict resolve? What counterexample would overturn the design?

- **Q1 normalize()/scopedAuthor — necessary.** Sole verified identity floor; consumed by everything. Lifecycle complete (immutable + monotonic recall). *No change.*
- **Q2 conversation-discovery — currently redundant in part.** Consumers: assembly (`memoryDiscovery`). Overlaps `searchMemory` + `relationshipView` ranking + selection's own `historical` lexical matching. Candidate for **merge into one retrieval service** with one scored index — but only in M4, after the flows are fixed; its directory contract (subject/aspect caps, `requiresOriginalRead`) is the right navigation shape and survives as the merged projection. *Counterexample to merging too early:* if discovery's cohort cap (≤2 per subject:aspect) is load-bearing for breadth, the merged ranker must preserve it — check with the initiative/reconnect frozen cases.
- **Q3 memory-engine batch wire — necessary, partial-commit rework (M1).** Consumer: Store. Its aliasing/anti-injection contract is load-bearing. Its *failure policy* is the Flow C root cause and is redesigned (§2.2). *Counterexample:* if partial commits cause active contradictions (A active while its supersesor also active because the transition quarantined), the chain-atomicity rule must be widened — verify with supersession fixture cases (`activity-uncertainty` docs).
- **Q4 relationship-store typed facts — necessary, keep schema.** Consumers: assembly (`relationshipContext`), personUnderstanding, UI relationship view. Lifecycle: versioned supersession + retired signatures is complete. Change: single source for the contact-stated rule; renderer-side entailment (M3).
- **Q5 notes kind=preference — necessary, becomes the only preference store.** Consumers: assembly `payload.preferences` (priority admission), draft guidance validation. Lifecycle: user-owned, evidence-bound. Aligns with §2.2.
- **Q6 topic-store — necessary.** Current-task continuity with source bindings; consumed by assembly + topic patches. Boundary complete (lifecycle evidence status on goal change). Untouched by the three flows; no redesign (resist rewrite pressure).
- **Q7 discussion-compaction — necessary but demoted (M4).** Its identity binding and literal quoteRefs are strong; its role as *the* overflow savior is the Flow B gap. Becomes ladder step 1.5 for discussion groups; the digest ladder covers single sources.
- **Q8 companion document / event-store rewrite — rejected as unnecessary.** Consumers: UI, assembly, replay rebuild. The eval contract (`evidence.sut`: "each candidate rebuilds its own state from the same raw observations") already imposes rebuildability, which the observation log satisfies. A full event store would churn the replay adapter and migration machinery with no flow requiring it. *Kept:* read-path writes must move out of `_getCompanion` into explicit maintenance passes (cheap, removes ambiguity).
- **Q9 TaskLedger — necessary, unchanged.** HTTP cost is a product constraint (declared caps, maintenance windows). Keeping it separate from context budget is correct ownership separation.
- **Q10 source-handles s# encoding — necessary.** Anti-injection + exact-reference contract; consumed by the wire and decode paths. Unchanged.
- **Q11 whole-answer-fidelity / publication seal — necessary.** The no-fabrication guarantee for outbound text; consumes admitted sources and option admission. With §2.1 it gets cheaper: grounding checks can use closure-derived speakers instead of re-deriving.
- **Q12 ExperienceStore — necessary, out of scope here.** Feedback/learning loop; consumed by assembly + UI. No evidence in the three flows implicates it; leave bounded.
- **Q13 vision-context/media — necessary, untouched.** Consent binding is complete.
- **Q14 server/UI — necessary, untouched** except surfacing `manifest.degradation` (and quarantine receipts) so the user can see *why* an answer used a digest and can open the original.

**State/evidence conflict resolution (cross-cutting):** today conflicts resolve via revision hashes + fingerprints + CAS (`baseRevision`, `contextGeneration`, turn fingerprints, source-currency asserts). The target keeps all of it; overlays add one explicit rule — *a correction wins inside its scope; evidence currency wins everywhere; when both change, the correction is re-scoped to `until_evidence` and flagged for review* (rendered as needs-current-interpretation, which the payload already models for prior directions).

**Counterexamples that would refute the target design (each names its check):**
1. If attribution failures persist after entailment-rendering, the cause is model reading, not structure → ablation: render identical payloads with/without per-fragment provenance lines on the frozen attribution cases; if no delta, revert M3 rendering and investigate prompt position instead.
2. If deterministic digests lose decision-critical detail (e.g., per-item display permissions in the exhibition note) and the model cannot recover it within 2 lookups → raise lookup budget for digest-backed requests or make digests permission-aware; if still failing, Flow B needs model-side summarization with a literal-quote contract (compaction-style) — measurable on `coverage-long-single-source` plus a new "user asks about item 7 specifically" probe.
3. If quarantine floods memory with rejected noise (model persistently misfiling), the write prompt/protocol needs the reclassification rules tightened — detectable as quarantine-rate > threshold across the frozen dataset.
4. If overlay corrections get over-applied across topics (the "don't split her sentences" correction leaking to unrelated topics), scope keys are wrong → counter-case: closed-topic and changed-goal fixtures must stay green (they exist in the dataset).
5. If the never-refuse ladder produces answers so evidence-starved they hallucinate, the fidelity audit should catch it → hard-failure rules in the rubric already cover invented facts; a synthetic digest-only request should be reviewed before accepting M2.

---

## 4. Migration path (staged, verifiable, revertible)

Each stage is a separate candidate identity under the goal-round process; each names its target cases, guardrails, verification, and rollback. Stage order is chosen so each is independently valuable and the frozen dataset guards regression.

| Stage | Change | Covers | Verification (frozen cases + checks) | Rollback |
| --- | --- | --- | --- | --- |
| **M0 Baseline** | None (record current behavior + traces for the three flows; archive run/review JSONs) | — | `eval:replay` on the diagnostic batch + guardrails; unit tests green | n/a |
| **M1 Memory partial commit** | `applyMemoryBatch` commits valid subset; quarantine receipts; preference proposals removed from model write scope; journal always advances; transition chains atomic | **Flow C** (`coverage-long-private-consultation`) | Target: memory preparation progresses; s1/s2 produce reviewable help respecting the correction. Guards: preference-attestation counter-case (must still refuse un-attested stable preferences in notes), supersession/activity fixtures, full `eval:check`. Migration: upgrade fictional baseline DB (per goal `evidence.lifecycle`) | Revert memory-engine apply path (single module boundary); journal replay reprocesses |
| **M2 Budget ladder** | Deterministic digest step + `manifest.degradation`; compaction demoted to optional ladder step (`compaction_budget_insufficient` hard stop removed); single ContextBudget owner | **Flow B** (`coverage-long-single-source`, occasional overflow) | Target: case reaches an answer with digest + lookups; no hard-block except unusable request text. Guards: source-delivery range fidelity cases, no-fabrication hard rules, quote-target cases, overflow checklist tests | Feature-flag each ladder step; flags off restores current behavior |
| **M3 Identity entailment** | Observation projection as sole identity authority; per-fragment provenance rendering; single contact-stated rule; discovery `sourceSpeaker` derived from closure | **Flow A** (attribution swap class) | Target: attribution probe cases (report-vs-stated fixtures) render correct holders; synthetic speaker-swap probe passes. Guards: all long-history cases (no regression in grounding), memory write tests, fidelity audit | Renderer flag: provenance lines off = previous rendering; write-gate flag off = previous validation |
| **M4 Consolidation** | Merge discovery/searchMemory/relationship ranking into one retrieval service (directory contract preserved); move read-path writes out of `_getCompanion`; simplify duplicated preference guards | All flows (hygiene) | Full 38-case dataset + engineering checks + host lifecycle (DB migration check from goal contract) | Component-level revert; pure refactors keep behavior parity tests |

Stage acceptance follows `iteration_policy.stage_acceptance`: accumulated guards may pass across rounds at one candidate identity; a new candidate invalidates and reruns affected evidence. M1–M3 each map to exactly one symptom flow; M4 must not begin before M1–M3 are accepted (it is convenience, not cause).

---

## 5. Evidence boundary and imported-conclusion applicability

**Project-internal evidence (primary for this design):**
- Frozen case definitions and rubric (`evals/assistant/replay/coverage-v2.jsonl`, `rubric.json` v`assistant-help-v1`) — the three flows' failure shapes are read directly from these fixtures, not from production chats (which this role must not access).
- Source reading of the exact throw sites, validation gates, and batch loops listed in §0's table. All file/line references above are from the current worktree.
- Limitation: this is **source-only reasoning**. No claim here establishes conversational quality, desktop behavior, or Goal completion. Behavioral claims require the goal-round replay + independent blinded review process.

**OpenViking prior conclusions (leads, verified against current source before use):**
- `研究结论/context_engineering_core_principles` (Anthropic-derived): minimal-token × high-SNR context; compaction/structured notes/sub-agent isolation; anti-pattern "more context is safer". *Applicability:* supports the ladder and directory-with-lookup design (progressive disclosure over preloading). *Limit:* those principles target generic agent tasks; this product's binding constraints (disclosure permissions, speaker entailment, no-send boundary) are stricter and dominate.
- `研究结论/llm_correction_loop_best_practices` + `llm_cannot_self_correct`: one correction round is an optimization, not a guarantee — supports making the memory wire's single retry non-load-bearing (M1's partial commit), rather than adding more retries.
- `研究结论/context_20261015_context_priority_issue`: the earlier priority review already located budget-blocking as a structural issue; M2 is its structural resolution rather than another priority tweak.
- Drift control: each recalled conclusion was checked against current source (e.g., the 10-15 review's fix suggestions predate `selection.cjs`'s current ladder; the residual gap is exactly the missing digest step).

**External sources (metadata only — direct fetch was DNS-blocked in this environment; treat as unverified leads, cited from search results):**
- Anthropic, "Effective context engineering for AI agents" and the Claude Cookbook context-engineering notes (context window management, compaction, just-in-time retrieval) — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents, https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools. *Why applicable:* same physical constraints (attention budget, context rot) motivate the degradation ladder and lookup-handles. *Limit:* Anthropic's setting has no per-party disclosure permissions and no speaker-attribution guarantee; copying their compaction recipe wholesale would violate this product's no-fabrication/no-leak rules.
- MemGPT/Letta (arXiv:2310.08560) — memory hierarchy (main vs archival context, paging). *Why applicable:* the observation-log + on-demand lookup shape is a paging design; the digest ladder is the local, deterministic version of paging. *Limit:* MemGPT pages by model-initiated function calls; this product deliberately caps model-driven reads (≤2 lookups) because every read spends the user's HTTP budget and touches private data — so paging here must be program-owned.
- Temporal knowledge-graph supersession discussions (search results on supersession vs versioning) — *applicable* to claim transitions (already implemented better here than in those papers: retired semantic signatures, decision-evidence validity). *Limit:* none imported; cited only to note the project's existing mechanism already covers the concern.

**Explicit non-goals / boundaries honored:** no message sending or auto-reply of any kind; drafts remain manual; no QQ installation changes; identity fields never leave local scope (the memory wire's de-scoping is preserved); external research does not become a behavioral passing criterion; the evaluator stays blind to everything in this document.

---

## 6. Answer to the coordinator (summary)

- **Target in one sentence:** observation-log identity (speaker/holder immutable and prompt-surviving), overlay-based corrections with user-owned stable preferences and partial-commit memory writes, and a guaranteed-degrade context budget that explains itself and never refuses for background evidence.
- **Decision 1 (Flow A):** render identity by entailment from evidence closures — misattribution becomes structurally unrenderable rather than validator-caught.
- **Decision 2 (Flow C):** partial memory commits with quarantine + preferences out of model write scope — a misfiled correction degrades to narrower scope; the queue never jams.
- **Decision 3 (Flow B):** deterministic digest ladder step + single budget owner + compaction demoted to optional — coverage of over-budget evidence is guaranteed, honestly labeled, with lookup handles.
- **Flow mapping:** M1→C, M2→B, M3→A, M4→hygiene; each stage independently verifiable and revertible; full-dataset + counter-case guards before any acceptance.
