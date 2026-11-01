# QQ Assistant — Context & Memory Subsystem Greenfield Redesign (DSH Track)

- Role: subsystem greenfield designer (architecture track). This document is the only write; no production code, `evals/`, or QQ state is modified.
- Mandate: full redesign freedom for the **memory subsystem** and the **context management subsystem**, driven by the four-round live-comparison / blind-review / user-test bottleneck evidence (B1–B8 below). Not bound by existing component boundaries; `goals/assistant-improvement/goal.json` (v2026-10-30.2) remains the constitution.
- Inputs inspected: `AGENTS.md`, `goals/assistant-improvement/goal.json`, `docs/dsh-target-architecture.md`, `docs/dsh-problem-backlog.md`, `docs/available-resources_CN.md`, `docs/integration-checkpoint-2026-11-01_CN.md`, `evals/assistant/rubric.json` + `evals/assistant/REPLAY.md` + `evals/assistant/replay/coverage-v2.jsonl` (read-only), and source: `src/speaker-identity.cjs`, `src/context/evidence-digest.cjs`, `src/context/selection.cjs`, `src/context/draft-material.cjs`, `src/model-response-format.cjs`, `src/memory-engine.cjs`, `src/store.cjs` (applyMemoryBatch / batch builders), `src/experience-store.cjs` (addFeedback), `src/controller.cjs` (assist / configure), `src/context/catalog.cjs`, `src/primary-operation.cjs`, `package.json` scripts, tests inventory, git history through `f0b6b51`.
- Evidence status: **source-only design reasoning** grounded in the frozen case definitions and the parent-provided bottleneck list (four live rounds + blind review + user testing). It is not conversational-quality evidence, not a round acceptance, and not a Goal-completion claim. Every behavioral expectation in §6 must be re-established under the goal-round process (frozen replay + independent blinded review).

---

## 0. Executive summary

Target in one sentence: **an append-only observation log as the sole identity/time/disclosure authority feeding (a) a memory subsystem where the model only proposes observation-bound content while program code owns classification, authority and journal progress, and (b) a context subsystem that compiles each request from an explicit intent → material-requirement → admission/degradation plan under one budget authority — so that identity is entailed, corrections are scoped overlays, preferences are user-owned, materials are mandatory by question type, and no answer can be blocked or silently degraded by budget without an explainable manifest.**

### Bottleneck → structural guarantee

| # | Bottleneck (hard evidence) | Structural soil eliminated | Guarantee that replaces it |
| --- | --- | --- | --- |
| B1 | Memory write path lets the generation model propose + classify + attest authority in one step; all-or-nothing acceptance; local correction misread as stable preference → journal jam → help unreachable | Model-authored `kind:preference` + `explicitPreference` attestation; batch-level reject (only preference codes quarantine today) | **Decision-split write gate**: model proposes observation-bound content only; program classifies scope/stability; corrections are a distinct record kind (scoped overlay) with narrowest-default scope; stability promotion is user-attested only; per-record receipts with generalized partial commit; journal always advances (§2.2) |
| B2 | Identity encoded ~7 ways and re-derived per layer; private input lacks speaker marking; "压力很大" attributed to the contact; self+stated unguarded | Parallel `direction/role/speaker/subject/attribution/assertionKind/sourceSpeaker` each trusted somewhere | **Observation log as sole identity authority** (immutable speaker at ingestion); every derived artifact references observation ids; holder labels are *entailed* from evidence closures at render time; `stated` claims require the subject's own speech in closure — enforced once, consumed everywhere (§2.1, §3.4; extends landed stream A) |
| B3 | Prompt protocol text and deep validators defined twice and drifting: legal lookup forms rejected, repair rounds lack executable guidance, deterministic info (IDs/ranges) model-assembled | Hand-written protocol strings (`MEMORY_SYSTEM`, rule texts) parallel to hand-written decoders | **Contract Registry codegen**: one versioned contract per model exchange generates the tool schema (with enums for every model-choosable reference), the validator, the prompt fragments, and payload-specific repair guides; copy-ready lookup handles make ID assembly unnecessary (§3.5; this is the charter of `dsh-struct-wire`) |
| B4 | Mandatory floor disconnected from the degradation ladder: >6000B private sources never admitted whole, group over-budget falls back, digest entries shadow declarations; answer hard-blocked | Fixed per-layer soft caps + whole-source admission thresholds + special-case compaction gate | **Requirement-driven compiler**: per-item ladder (verbatim → ranged → digest → digest-declarations → directory/marker) ordered by declared material requirement; floor = current interaction only; every large private source always enters the ladder; degradation recorded per step (§3.1–3.3; generalizes landed stream B) |
| B5 | No material-type × question-type × authorization-level mapping: declared arrangements not mandatory for invitation-type answers → model emits confirmation questions | Material admissibility implicit in prompt rules (`declarationRule` text is a patch, not a structure) | **MQA matrix as a first-class structure**: intent classes × material classes → admission policy + authorization tier + representation floor; compiler injects mandatory materials; output contract has consumption-required fields (`arrangementHandling`) checked by the draft validator (§3.2) |
| B6 | Memory / answer / compression budget paths with three different logics; preparation completes but the answer is blocked | `assistantContextBytes` + `assistantRequestBytes` + `memoryInputBytes` + compaction floor owned by different modules with different fit semantics | **One Budget Authority**: single service owning all byte budgets with one measure→allocate→degrade→manifest vocabulary, instantiated per consumer; TaskLedger stays separate (HTTP cost); every memory-admitted artifact has a guaranteed representation tier in the answer path (§3.3) |
| B7 | Standing instruction silently clamped to 2000 chars; legacy reply path truncates/drops without omission markers | Clamp-without-acknowledge at `controller.cjs:228` / `model.cjs:64`; unmarked legacy budget path | **No-silent-loss envelope**: one choke point for all user-authored text (deliver whole / deliver with explicit truncation marker + overflow handle / reject loudly); standing instruction becomes a user-owned preference record rendered through the material pipeline; legacy `generate()` path removed or wrapped (§2.1 preference ontology, §3.5) |
| B8 | Feedback binding trusts client `requestId`/`targetRef`; after regeneration feedback can bind to the old artifact version | Optional `expectedDigest`; requestId-only legacy resolution; client-side sessionStorage binding | **Server-minted presentation identity**: candidate session mints an immutable `presentationId` per displayed candidate; feedback API requires it (or artifactRef+digest) and the server resolves the target; stale feedback surfaces an explicit re-bind notice instead of riding along (§2.5) |

---

## 1. Design constitution and inheritance decisions

Binding rules taken from `goal.json` and `AGENTS.md`: no sending/auto-reply of any kind; scope binding with string QQ IDs; privacy floors (credentials/real chats out of Git and archives); frozen raw cases and behavioral criteria stay architecture-independent ("never give derived expected understandings or case criteria to the assistant"); each candidate rebuilds its own state from raw observations; schema/migration changes require the baseline-DB upgrade test; synthetic replay never proves quality; `iteration_policy.architecture_rewrite_allowed: true` with the paired warning against both preserving a faulty architecture to minimize diffs and rewriting for rewrite's sake.

Relationship to `docs/dsh-target-architecture.md` (inherit / extend / overturn, each with a reason):

| Target-arch decision | Disposition here | Reason |
| --- | --- | --- |
| Identity by entailment (M3) | **Inherit, promote to data layer** | Landed as `speaker-identity.cjs` (stream A) and working; the greenfield move is making the observation projection the *stored* authority instead of a per-request view, which is exactly the in-flight `dsh-struct-data` charter |
| Partial commit with quarantine (M1) | **Inherit, generalize** | Current quarantine covers only preference-gate codes; B1 evidence requires per-record receipts for *all* record kinds plus corrections as overlays (landed stream C scoped-corrections work is the seed) |
| Guaranteed-degrade ladder (M2) | **Inherit, re-order by requirement** | Landed digest tier works, but B4 shows the ladder is still *admission-shaped* (whole-source thresholds) rather than *requirement-shaped*; the compiler must treat required evidence classes as first-class |
| Preferences out of model write scope | **Inherit, complete it** | `explicitPreference` attestation still asks the *model* to attest; the model must not even propose the flag (only candidates pending user attestation) |
| Merge discovery/searchMemory/relationshipView (M4) | **Inherit** | B4/B5 retrieval confusion is one symptom of three rankers; one retrieval service with hard filters first |
| Compaction demoted to ladder step | **Inherit** | Backlog #3 (6–12KB compaction dead band) is residual evidence the special-case gate must go |
| Reject full event-store rewrite of goals/topics/runs (Q8) | **Inherit (keep)** | No B1–B8 evidence implicates the companion document's shape; rebuildability is already contractually imposed by `evidence.sut` |
| TaskLedger unchanged (Q9) | **Inherit** | Cost accounting is a separate concern; B6 is about *byte-budget logic*, not HTTP accounting |
| Read-path writes moved out of `_getCompanion` | **Inherit** | Contract hygiene; folded into maintenance orchestrator (§2.4) |
| Digest with lookup handles; copy-ready | **Inherit, extend to declarations as MQA materials** | `evidence-digest.cjs` declarations become one *material class* in the MQA matrix rather than a text rule inside the digest |

Overturned or newly introduced here (with reasons): the MQA matrix (new — nothing in the target architecture maps question types to mandatory materials; B5 evidence demands it); the Contract Registry codegen as a whole subsystem boundary (new — B3 evidence shows dual definition is the failure mode, so single-source generation is the only structural fix); the Budget Authority as one service (target arch said "one ContextBudget object" for context only; B6 evidence extends the requirement to memory/compaction paths); feedback presentation identity (new; B8 evidence).

---

## 2. Memory subsystem (greenfield)

### 2.1 Fact model

Four layers, each with one owner and one authority:

```
Observation (append-only; sole authority for speaker / time / text / disclosure)
  id            qq:<messageId> | private:<turnId> | note:<id> | feedback:<id> | external:<id>
  scope         {accountUid, accountUin, peerUid, peerUin}   (as today)
  kind          qq_message | private_turn | note | feedback | external_input
  speaker       account_owner | contact | undetermined        (immutable; from normalize()'s
               verified scoped-author match; NEVER defaulted — fixes backlog #5 class)
  heldBy        = speaker (whose state this utterance directly evidences)
  occurredAt    source time (msg time / turn createdAt / note writtenAt)
  recordedAt, revision (content hash INCLUDING a canonical speaker-role fingerprint
               — fixes backlog #6: sender corrections must invalidate derived memory)
  text (content-addressed; redaction happens on the wire only), use, deleted/excluded
               (monotonic tombstones: recall / user exclusion / withdrawal)
  replyTo?      verified quote target (round, don't drop sub-second anchors — backlog #7)
  thirdParties? names quoted inside the text — opaque refs, never self/contact
  presentationId?  (feedback kind only) server-minted identity of the displayed candidate

Claim (typed derived fact; versioned; the logical knowledge layer)
  subject       self | contact | dyad      (a *checked hypothesis*, never render authority)
  aspect, assertionKind (stated|reported|observed|hypothesis), epistemicStatus
  applicability { scope: local|episode|topic|recurring|conditional|until_evidence, condition? }
  validFrom/validUntil, occurredAt / reportedAt / knowledgeChangedAt kept separate
  evidence      [{observationId, span}]   → closure speaker set ⇒ entailment holder label
  transitions   reaffirm|supersede|contest|merge with expectedVersion CAS, retired signatures

Overlay (correction; additive, scoped — never a preference reclassification)
  target        { kind: claim|behavior_pattern|interpretation, id? }
  scope         { kind: episode|topic|next_exchange|until_evidence, bound? }  (narrowest default)
  issuedAt, evidence (the correction utterance itself, always an observation)

Preference (user-owned ontology; outside the model's write scope entirely)
  aspect        style | boundary | topic | tempo | sharing
  text, attestation { observationId of the user's explicit statement | UI attestation event }
  lifecycle     user edit / disable only; standing instruction lives here (B7)
  model role    may file *candidates* pending attestation; never active records
```

Design notes:

- **Corrections and preferences are orthogonal** (scope × stability). "这次别把她的每句话拆成好几个问题" files as an Overlay with `scope.kind=next_exchange` or `episode`; misclassification therefore degrades to "recorded narrower" instead of "rejected" (B1's soil). Promotion to recurring happens only by (a) explicit user attestation or (b) program-detected repetition — N independent corrections from distinct episodes, counted by code, *proposed* to the user, never auto-applied.
- **Derived layers are rebuildable from observations.** Claims, overlays, navigation episodes and preference candidates are deterministic projections plus model-reviewed content; the eval contract (`evidence.sut`) already requires rebuild-from-raw, and corruption protection (§2.4) leans on it.
- **Identity is established once.** `speaker-identity.cjs` (stream A) becomes the single vocabulary consumed by the observation layer, the write gates, the renderer and the fidelity audit; `role/speaker/direction/sourceSpeaker` in downstream views become *derived read-only projections*, and any consumer still reading them is a parity-test failure (B2 soil removal completed).
- **Third-party mentions** stay opaque (`thirdParties`), making "a quoted colleague's experience is not her experience" mechanically checkable.

### 2.2 Write gate — which decisions are program-owned

The generation model proposes **content** bound to observation aliases; **everything else is a program decision**. This is the B1 elimination core.

| Decision | Owner | Mechanism |
| --- | --- | --- |
| ID minting, alias mapping, revision binding | program | deterministic (`s#/c#/m#` wire, content hashes) |
| Who said it / about whom it directly evidences | program | observation `speaker` (immutable); `stated` requires subject's own speech in closure (`assertSpeechAttribution`, enforced once) |
| What was said (proposition text + evidence spans) | **model proposes** | decode validates span membership + alias existence |
| Aspect / subject guess | **model proposes** | checked against closure; a `stated` claim without the subject's own words is demoted to `reported` *or* quarantined with a receipt — never silently accepted |
| Applicability scope (local/episode/topic/…) | program classifies | structural rules: correction markers → overlay narrowest scope; source kind; repetition counter across distinct episodes; dated circumstances stay dated |
| Stability promotion (recurring preference) | **user only** | attestation channel; model's `explicitPreference` flag is deleted from the wire; `assertPreferenceAuthority` remains as legacy-data audit |
| Supersession/transition validity | program | expectedVersion CAS + retired semantic signatures + decision-evidence completeness (as today) |
| Batch admission / journal advance | program | per-record validation → per-record receipts → journal always advances past sources whose remaining proposals are all quarantined |

Failure handling: **generalized partial commit**. Validate each proposal independently → commit the valid set transactionally → quarantine invalid ones into receipts `{field, code, message, allowedShape, allowedChoices}` (the wire-error vocabulary already exists; today's preference-only quarantine set `PREFERENCE_GATE_CODES` is removed in favor of per-kind validators). Atomicity is kept only where semantically required: a transition chain (supersede/contest/merge targets + successor) commits or quarantines **as a unit**, so a quarantined supersede cannot leave both predecessor and successor active. The single model correction round stays as an optimization (per `llm_correction_loop_best_practices`: one retry, never load-bearing), not the only path to progress.

### 2.3 Retrieval — composed filters first, semantic candidates second

One retrieval service replaces the three rankers (discovery term-overlap, `memory-search` rank, `relationshipView` rank):

1. **Hard filters (SQL, precise, never bypassed):** scope, observation kind, speaker, time window, withdrawal/exclusion tombstones, disclosure/authorization tier. Result: a legal candidate set with exact provenance.
2. **Lexical rank:** SQLite FTS5 with CJK bigram tokenization, time-decay, anchor/reply neighborhoods (existing `policy.cjs` logic absorbed here).
3. **Semantic candidates (optional, gap-driven):** `doubao-embedding-vision` vectors for observations and claim texts (index in SQLite via `sqlite-vec` or a local cosine table — see §7 limits). Used **only** to reorder/augment the stage-1 legal set; a vector hit can never admit a filtered-out source. Index rows carry the observation revision; revision mismatch ⇒ stale entry dropped and re-embedded (stale-index recovery is a required test per `available-resources_CN.md`).
4. **Narrow typed decisions (optional):** JEV (`typesafe/jev-1.14`) for e.g. "is candidate X relevant to question type Y" — batched, cached by input hash, invoked on change, never per-request full-history; probabilities are hints, never facts/authorization (resource doc constraint).

Candidate evaluation is explainable: every returned item carries `{matchedStages, lexicalScore?, semanticScore?, decay, reasons[]}`, consumed by the context compiler's manifest. Adoption of stages 3–4 follows the resource doc's gap rule: retain a same-input baseline without the capability; record model versions, retrieval evidence, misjudgments, latency, call volume and final help quality — not just recall counts.

### 2.4 Maintenance lifecycle

- **Journal review batches** (as today, ≤24k source bytes / ≤32 sources default) with the §2.2 gate; batches shrink via the Budget Authority (§3.3), not a private fit loop.
- **Correction integration pass:** overlays are applied at read time inside their scope; a widening proposal (repetition rule fires) creates a preference *candidate* visible in the UI.
- **Expiry/applicability pass:** `validUntil`, `until_evidence` and dated applicability are recomputed against `asOf` at read (already partly so in `relationship-store`); stale understandings render as `needs_current_interpretation`, never silently current.
- **Withdrawal:** recall/exclusion tombstones propagate to derived layers as *loss provenance* (keep the landed `evidenceLoss` machinery): affected claims rescope to `until_evidence` + review flag, or retire with the original wording preserved.
- **Corruption protection:** (a) derived layers rebuildable from observations — determinism fixture replays the observation log through maintenance and diffs the derived state; (b) speaker fingerprint inside the revision hash so an ingestion-side sender correction invalidates derived rows (backlog #6); (c) quarantine-rate metric with an alert threshold — persistent model misfiling is a protocol problem, not a data problem (target-arch counterexample 3).
- Read-path writes move out of `_getCompanion` into explicit maintenance passes (target-arch Q8).

### 2.5 Feedback binding

- The candidate session mints `presentationId = hash(scope, candidateId, artifactVersion, displayedAt)` at display time and returns it to the UI; the UI sends it back with feedback (no client-side target caching).
- `addFeedback` requires `presentationId` (or `{artifactRef, expectedDigest}`); the server resolves the target and rejects mismatches with an explicit `stale_feedback_target` notice + re-bind flow ("which version are you commenting on?"). requestId-only legacy resolution is removed.
- Feedback is stored as an **observation** (`kind=feedback`, `speaker=account_owner`, `presentationId`), so it inherits the whole lifecycle: withdrawal redaction (existing), retrieval filtering, and entailment rendering.
- `context()` evaluation targets include only lexically matched or explicitly selected feedback (removes the unconditional `slice(-2)` ride-along, backlog #8).

---

## 3. Context management subsystem (greenfield)

### 3.1 Requirement-driven compilation pipeline

```
(1) RequestAnalyzer (program; lexical anchors + goal/topic context; optional cheap model/ JE V confirm)
      → ContextRequest { intentClass, anchors(replyFocus|images), requiredEvidenceClasses,
                        feedbackTargets, wants(discovery|methods|materials|…) }
(2) MQA lookup: intentClass × materialClass → admission policy + authorization tier + representation floor
(3) CandidateGatherer: unified retrieval (§2.3) + direct references (anchors, topic bindings,
                      feedback targets, protected pending reviews)
(4) Admission/Compiler: per-item ladder ordered by requirement priority; floor = current interaction
      ladder: verbatim → ranged excerpt(+continuation) → structural digest(+per-entry handles)
              → digest declarations(+handles) → directory entry / explicit missing-marker
(5) BudgetAuthority: measure → allocate → degrade → manifest (single owner of all byte budgets)
(6) ExtractionContract per admitted item: what is present / absent / unknown + copy-ready lookup handle
(7) IdentityRenderer: per-fragment holder labels entailed from evidence closures (speakerBasis)
(8) Contract-generated wire: enums for every model-choosable reference; consumption-required fields
```

Key invariants:

- **The compiler always returns a deliverable plan.** The only hard failure is a genuinely unusable current request text (below the minimal envelope) — everything else degrades, each step recorded in `manifest.degradation` (`{step, appliedTo, recoveredBytes, remainingNeed, lookupHandle}`). The current-interaction floor (intent + anchor exchange + delivery policy) is never dropped to make room for background evidence; conversely **background evidence never blocks the floor** (B4).
- **Large private sources always enter the ladder.** The >6000-byte whole-admission threshold and the compaction eligibility floor (backlog #3's 6–12KB dead band) disappear: any required material has a digest tier available, and model-driven discussion compaction is just one (high-quality, optional) ladder step for discussion groups, never a feasibility gate.
- **Every memory-admitted artifact has a representation tier in the answer path** (B6 asymmetry fix): the same Budget Authority that admitted a memory artifact guarantees it at least a digest/directory tier in the answer context, so "memory preparation finished but the answer was blocked" is structurally impossible.

### 3.2 MQA matrix — material type × question type × authorization level (B5, first-class structure)

A versioned registry (`mqa-registry`), not prompt text. Sketch of the initial content:

```
intentClasses: invitation_arrangement | availability_check | personal_share | experience_recount |
  emotional_support | repair | reconnect | work_handoff | learning_help | goal_change |
  feedback_continue | boundary_check | generic_consultation

materialClasses (typed, each with an extractor): declared_arrangement (user-stated
  availability/willingness + near-time), availability_state, preference(aspect),
  personal_fact, experience_event, contact_statement, third_party_report, closed_topic,
  goal_record, feedback_target, boundary_control

authorizationTiers: T0 public_qq | T1 current_permission (current complete user statement)
  | T2 declared_shareable (user pre-declared) | T3 private_planning | T4 never_outbound

rows (examples):
  invitation_arrangement × declared_arrangement → MANDATORY, tier ≥T1, floor: digest_declaration
  invitation_arrangement × availability_state    → MANDATORY, tier ≥T1, floor: digest_declaration
  invitation_arrangement × boundary_control      → MANDATORY negative control (never violate)
  emotional_support     × contact_statement      → MANDATORY, T0, floor: ranged
  personal_share        × personal_fact          → SELECTED, T2/T3 with per-fragment authorization
                                                   binding (existing draft-material protocol)
  ANY                   × closed_topic           → NEGATIVE-MANDATORY (render closed marker;
                                                   must not resurrect — cm-closed-topic guard)
  ANY                   × third_party_report     → SELECTED, T3, entailment label user_report
```

Enforcement is **structural, in the output contract** (B5's core): for `invitation_arrangement` requests the wire gains a consumption-required field

```
arrangementHandling: { disposition: used|conflict|stale|missing, evidenceRefs[], reason? }
```

and the draft validator enforces: if a current, non-expired declared arrangement was delivered and `disposition !== 'used'`, a concrete `reason` is mandatory. The model can no longer *choose* to generate a confirmation question over a declared arrangement without stating why — the confirmation question remains available exactly when `disposition ∈ {conflict, stale, missing}`. The digest `declarationRule` text (stream B) is retired into this structure; declaration extractors (`declarationSentences`) become the `declared_arrangement` material extractor.

### 3.3 Budget Authority (B6)

One service (`budget-authority.cjs`), three instantiations (answer context, memory batch, compaction call), one vocabulary:

```
BudgetAuthority.create({ payloadBytes, serializedRequestBytes, allocations: {exchange, privateLayer,
  relationship, directory, … named, each with floor/soft values}, degradationOrder })
  measure(obj) → bytes (payload + serialized request both owned here)
  fits(obj) → boolean
  plan(requirements) → Plan        // guaranteed-deliverable: never null for non-floor content
  manifest → { inputBytes, byteBudget, serializedTextRequestBytes, allocations[],
               degradation: [{step, appliedTo, recoveredBytes, remainingNeed, lookupHandle}] }
```

- The two-cap `fits()` stays but is owned in exactly one place; today's six soft reservations become named allocations with declared priority order.
- `memoryInputBytes` batch fitting calls the same service (replacing `fitMemoryBatch`'s private loop); the correction-echo degradation ladder already implemented there becomes a shared degradation step.
- TaskLedger (`request-budget.cjs`) is unchanged: HTTP attempts/usage are cost accounting, a different concern (target-arch Q9).
- Compaction calls budget through the same service and is skipped (not fatal) when headroom is absent.

### 3.4 Identity-entailed rendering (B2 completion)

`holderBasis` / `speakerBasis` rendering (landed) is extended to **every** prompt fragment that carries derived content: claims, episodes, activity evidence, feedback targets, materials, digest entries. A fragment whose closure contains zero contact-speaker observations physically cannot render a contact attribution. `subject`/`attribution` fields remain model proposals but are only *checked* against the closure. The remaining B2 soil — consumers still reading legacy `role/speaker/direction` projections and discovery's default-to-self — is removed by making the observation layer the only authority and failing parity tests on stragglers (per §2.1).

### 3.5 Prompt strategy — structure guarantees instead of rule text (B3)

- **Contract Registry** (`src/contracts/`): one versioned definition per model exchange (`memory_result`, `assistant_result`, `draft_result`, `fidelity_result`, `discussion_compaction_result`, lookup round-trips, MQA consumption fields). From each contract, codegen produces: (a) the tool/response JSON schema **with enums for every model-choosable reference** — offered ids, activity refs, candidate paths, operation/kind choices; (b) the machine validator; (c) the prompt fragment text; (d) the repair guide: for any validator error, the exact allowed values *for that payload* (generalizing today's `allowedChoices` for activity refs to all enum'd fields).
- **Deterministic information is never model-assembled.** All ids/ranges/revisions are enum-selected or copied verbatim from copy-ready lookup handles (stream B r3's `{sourceIds, offset, maxChars}` objects become the universal continuation form — including query-form lookups with `maxChars`).
- **Drift is structurally impossible** because prompt text and validators are the same artifact; the parity harness (§4.3 W1) replays recorded valid outputs and previously-rejected malformed outputs against the generated pair.
- **No-silent-loss envelope** (B7): a single `UserTextEnvelope` wraps every user-authored input (standing instruction, request text, notes): deliver whole, or deliver with `truncated: {deliveredChars, totalChars, overflowHandle}` and a UI warning, or reject loudly. The 2000-char instruction clamp becomes a preference record with a full-text store; the legacy `model.cjs generate/contextFor` path (currently unreachable) is deleted rather than wrapped.

---

## 4. Component decomposition and parallel build plan

### 4.1 Components (responsibility · contract · state ownership · lifecycle · consumers)

| # | Component | Responsibility / key contract | State owned | Lifecycle / invalidation | Consumers |
| --- | --- | --- | --- | --- | --- |
| M1 | **Observation Log** | append/tombstone/project; immutable speaker; speaker-fingerprinted revision; sole identity authority | `observations` table (new) | append-only; tombstones monotonic; projections derived | M2–M5, C3, fidelity, UI, replay adapter |
| M2 | **Claim/Overlay/Preference stores** | typed facts, scoped overlays, user-owned preferences; versioned supersession; read-time applicability recompute | claim/overlay/preference tables (evolution of `memory_records`/notes) | versioned; withdrawal ⇒ rescope+loss provenance; rebuildable from M1 | retrieval, compiler, UI relationship view |
| M3 | **Write Gate** | decision-split validators (§2.2); per-record receipts; generalized partial commit; transition-chain atomicity | receipts/quarantine tables | per batch; journal always advances | memory maintenance, replay preparation |
| M4 | **Retrieval Service** | hard filters → lexical rank → optional semantic/JEV candidates; explainable manifests | FTS index (+optional vector index) | invalidated by revision change (speaker fingerprint included) | compiler, discovery views, UI search |
| M5 | **Maintenance Orchestrator** | journal batches, correction integration, expiry passes, semantic recovery, quarantine-rate metric | journal/schedule state (existing tables) | single-flight per scope; epoch-guarded | controller background loop, adapter preparation |
| C1 | **Request Analyzer** | ContextRequest inference (intent class, required evidence classes); optional cheap confirm | none (cache keyed by request hash) | per request | compiler |
| C2 | **MQA Registry** | intent × material → admission/tier/floor; consumption-field contracts | versioned registry data | explicit version bumps; frozen per candidate identity | compiler, draft validator |
| C3 | **Context Compiler** | requirement-driven admission + ladder + extraction contracts; never-refuse invariant | none (per-request plan) | frozen per request; `rebuildForRequest` | assist pipeline |
| C4 | **Budget Authority** | unified byte-budget ownership + degradation vocabulary + manifest | none (per instantiation) | per request/batch/call | compiler, memory batches, compaction |
| C5 | **Identity Renderer** | closure-entailed holder labels on every fragment | none | per render | compiler, fidelity, memory wire |
| C6 | **Contract Registry / Wire Compiler** | contracts → schema+validator+prompt fragments+repair guides; copy-ready handles; parity harness | contract sources (versioned) | contract version = candidate identity input | all model exchanges |
| C7 | **UserTextEnvelope** | no-silent-loss wrapper for user-authored text | none | per input | controller configure/assist, notes |
| F1 | **Feedback Binder** | presentationId minting, server-side resolution, stale re-bind, feedback-as-observation | presentation ids in candidate session | per display; immutable once minted | experience store, server route, UI |

### 4.2 Absorption by the in-flight streams

| Stream (in flight) | Charter in this design | Absorbs |
| --- | --- | --- |
| `dsh-struct-data` (observation log data layer) | Build M1 + M2 storage evolution + migration/rebuild machinery + speaker-fingerprinted revisions | M1, M2 (storage half), §6.1 migration package D1 |
| `dsh-struct-wire` (contract layer) | Build C6 + C7 + wire encodings (aliases, handles, enums) + validator generation + repair guides; presentationId API contract | C6, C7, M3's *validator generation* (validation logic from contracts), F1's API contract |

No other component is absorbable by those two streams without charter creep. **New streams required:** `dsh-memory-write` (M3 gate logic + M5 orchestrator rework), `dsh-retrieval` (M4), `dsh-ctx-compile` (C1+C2+C3+C4+C5 + draft-validator consumption fields), `dsh-feedback-bind` (F1 vertical slice: candidate-session mint, server route, experience-store resolution — small). Rationale: each has a distinct verification surface (write receipts / retrieval quality / compiled-context parity / feedback identity) and each can start immediately against today's tables using thin shims, then swap to the struct-stream outputs at integration.

### 4.3 Parallel build packages (implementation-ready)

Interfaces are named so an implementation stream can open the files today; all new modules live behind the existing controller/server seams so the replay adapter keeps working throughout (§6.3).

**P0 — start immediately, no dependencies:**

- **W1 (dsh-struct-wire): `src/contracts/` + `src/wire/compile.cjs`** — contract DSL (JSON, versioned), generators `compileSchema(c)`, `compileValidator(c)`, `compilePromptFragments(c)`, `repairGuide(c, error, payload)`; port the five existing exchanges first (`memory_result`, `assistant_result`, `draft_result`, `fidelity_result`, `discussion_compaction_result`). Acceptance: `tests/contract-parity.test.cjs` — every recorded valid replay output passes the generated validator; every previously rejected malformed output (from run diagnostics) fails with the same code; generated prompt fragments byte-stable under a golden fixture. Also `UserTextEnvelope` (`src/wire/user-text-envelope.cjs`) with the three delivery modes.
- **D1 (dsh-struct-data): `src/memory/observation-log.cjs`** — DDL (`observations`), `append`, `tombstone`, `project(sourcesFor-shape)`, speaker-fingerprinted `revisionOf`; `migrateObservations(store)` building the log from current `messages`+companion tables; `tests/observation-migration.test.cjs` implementing the goal's baseline-DB upgrade scenario (§6.1). Acceptance: projection parity with today's `sourcesFor` on the fictional fixture DBs; sender-field correction invalidates revisions.

**P1 — start immediately in parallel (shimmed against current tables):**

- **MW1 (dsh-memory-write): `src/memory/write-gate.cjs`** — per-record validators generated from W1 contracts + program-owned classifiers (scope classifier, repetition counter, preference-attestation channel); overlay record type; generalized quarantine replacing `PREFERENCE_GATE_CODES`; journal-advance fix. Acceptance: unit fixtures for every quarantine code; the frozen `coverage-long-private-consultation` preparation reaches help (goal-round verified later); transition-chain atomicity fixture.
- **RT1 (dsh-retrieval): `src/memory/retrieval-service.cjs`** — `retrieve({scope, filters, query, anchors, asOf, tiers}) → {items, manifest}` over M1 (shim: current tables); FTS5+CJK bigram; embedding provider interface `src/memory/embedding-provider.cjs` (doubao `/plan/v3` adapter, fictional-isolated trial only, revision-keyed cache, stale-drop) behind a disabled flag; optional JEV decision adapter `src/memory/jev-decisions.cjs` (batch+cache, hash-keyed). Acceptance: filter-correctness fixtures (withdrawn/excluded/undetermined speaker never returned); same-input baseline comparison retained per the resource doc.
- **CC1 (dsh-ctx-compile): `src/context/request-analyzer.cjs` + `src/context/mqa-registry.cjs` + `src/context/budget-authority.cjs`** then compiler rework of `selection.cjs` — ContextRequest inference (lexical anchors first; model confirm optional), MQA registry data + `consumptionFields` contracts wired into W1, Budget Authority with the three instantiations, ladder re-order by requirement, compaction-floor dead band removal. Acceptance: `assistant-budget-degradation.test.cjs` extended (every oversized scenario produces a plan + manifest, no throw except minimal-envelope); MQA fixtures: declared-arrangement present ⇒ `arrangementHandling.reason` required when unused; overflow checklist tests green.
- **FB1 (dsh-feedback-bind): presentationId` in `candidate-session.cjs`, mandatory resolution in `experience-store.addFeedback`, server route change, stale re-bind notice. Acceptance: regenerate-then-feedback fixture binds to the newest artifact or surfaces stale; `context()` no longer hydrates unmatched `slice(-2)` feedback.

**Integration order:** W1+D1 schema freeze → MW1/RT1/CC1/FB1 swap shims for real M1 projections → single integration candidate → full 38-case synthetic replay (`eval:replay`) → goal-round live verification per stage. Each package is independently revertible at a module boundary; every stage keeps the frozen dataset guards listed in §6.2.

---

## 5. Necessity interrogation (six questions per new component)

| Component | Necessity / evidence | Consumer | Boundary | Lifecycle | Conflict resolution | Counterexample that would refute it |
| --- | --- | --- | --- | --- | --- | --- |
| M1 Observation Log | B2/B8 evidence: identity must be single-sourced; rebuild contract already implies it | all | owns append/tombstone only; no derived semantics | append-only; monotonic tombstones | authoritative over every derived view | if any B1–B8 fix lands without it, demote to view (revisit at integration) |
| M2 Claim/Overlay/Preference | B1: correction≠preference requires orthogonal scope×stability | retrieval, compiler, UI | logical semantics only; storage via M1 projections | versioned; rescope-on-withdrawal | correction wins in scope; evidence currency wins outside; both ⇒ `until_evidence`+flag | overlay leakage across topics ⇒ scope keys wrong (closed-topic/goal-change guards must fail loudly) |
| M3 Write Gate | B1: journal jam; attestation-by-model | maintenance, adapter | validation+classification only; no model calls | per batch; receipts persist | chain-atomicity vs partial commit per §2.2 | quarantine-rate > threshold across frozen dataset ⇒ protocol, not architecture |
| M4 Retrieval Service | B4/B5: three rankers = unowned relevance; target-arch Q2 | compiler, discovery, UI | read-only over M1/M2 | index invalidated by revision | explainable manifest wins disputes | if FTS-only recall suffices on frozen cases, defer embedding tier (resource-doc gap rule) |
| M5 Maintenance Orchestrator | journal/recovery scheduling exists and works; needs gate/lifecycle integration | controller, adapter | scheduling only | single-flight, epoch-guarded | orchestrator never overrides gate receipts | none pending; simplest component |
| C1 Request Analyzer | B5: intent must be classified before requirements exist | compiler | inference only; never material selection | per request (+cache) | model confirm over lexical guess | persistent misclassification on frozen pairs ⇒ add confirm round or fall back to `generic_consultation` |
| C2 MQA Registry | B5 core evidence | compiler, draft validator | data + policy; no code paths | versioned; frozen per candidate | registry floor is minimum, compiler may exceed | a frozen case where mandatory material crowds out the floor ⇒ floor wins, material degrades to marker |
| C3 Context Compiler | B4: admission-shaped ladder blocked answers | assist pipeline | one request → one plan | frozen per request | requirement priority order fixed in registry | evidence-starved answers post-ladder ⇒ fidelity audit catches; digest-only synthetic review before acceptance |
| C4 Budget Authority | B6: three logics; asymmetric block | compiler, memory, compaction | byte budgets only; never HTTP | per instantiation | single owner ⇒ no cross-path disputes | none plausible; keep TaskLedger separate (cost ≠ context) |
| C5 Identity Renderer | B2; landed and reviewed | compiler, fidelity, wire | pure render | per render | closure truth over asserted labels | no delta on attribution ablation ⇒ revert rendering, investigate prompt position (target-arch counterexample 1) |
| C6 Contract Registry | B3: dual definition is the failure mode | every model exchange | generation only; validators run where they run today | contract version ⇒ candidate identity | generated pair cannot disagree by construction | codegen can't express a constraint ⇒ hand-written validator with a drift test and a TODO contract |
| C7 UserTextEnvelope | B7 evidence | controller, notes | user-authored text only | per input | envelope marker over silent clamp | none |
| F1 Feedback Binder | B8 evidence | experience store, server, UI | identity only; not feedback semantics | per display | newest presentation wins; stale ⇒ notice | none |

Explicitly **rejected as unnecessary** (goal `no_shortcut` guard in reverse): full event-store rewrite of goals/topics/runs (target-arch Q8 reasoning holds — no bottleneck implicates it); a permanent planner/brainstorm role; any new workflow platform; auto-applied preference promotion; embedding as a default-on data flow.

---

## 6. Migration and validation

### 6.1 Stock data migration + baseline-DB upgrade test

Required by `goal.json evidence.lifecycle.requirement` whenever persisted schema or migration logic changes — this redesign changes both.

1. **Phase A (projection):** `observations` built as a derived projection over current `messages` + companion turns/notes/feedback (`sourcesFor` shape) with `speaker` promoted to a stored immutable column; reads go through M1; writes still target legacy tables. Zero behavior change; parity fixtures on fictional DBs.
2. **Phase B (dual-write behind flag):** ingestion writes both; M2 claim/overlay/preference stores begin receiving writes through M3; legacy `memory_records` keep functioning for read parity.
3. **Phase C (ownership transfer):** derived layers rebuilt from observations through maintenance (determinism diff ≈ 0 except documented quarantine/classification changes); legacy preference-classified items become *attestation candidates* surfaced to the user (never silently active, never silently dropped).
4. **Speaker-fingerprint cutover:** revision hash gains the speaker-role fingerprint; derived rows whose closure speaker set would change are flagged `needs_revalidation` and routed to semantic recovery — never silently kept (backlog #6's latent hazard becomes an explicit pass).
5. **Baseline upgrade test (`tests/observation-migration.test.cjs`, and the same scenario under the goal round):** create a fictional DB with the baseline implementation (commit `009b4aa` code), run the candidate upgrade, verify original QQ message IDs as strings, event/report time separation, disclosure purpose (authored-note permissions), withdrawal/recall tombstones, and feedback identity (source time, actual-output references) all survive; raw-prefix rebuild alone does not satisfy this (per goal wording).

Rollback: phases are flag-gated; legacy tables remain authoritative until C; rollback = flag off + journal replay reprocesses.

### 6.2 38-case acceptance surface mapping

Structural guarantees per stage main-objective (cases from `goal.json stages`; every claim below still requires goal-round replay + independent blinded review before acceptance):

- **delivery_provenance** ("usable actual drafts/private help while preserving source, disclosure and actual-output feedback identity"): F1 (B8) preserves feedback identity across regeneration; C6 repair guides (B3) prevent planning-validation dead ends — directly targets the two baseline failures `coverage-observed-output-feedback` and `coverage-feedback-current-material`; C7 (B7) keeps standing instructions whole; MQA tiers govern `cm-generated-invitation-vs-actual`, `coverage-material-note-exclusion`; tombstone lifecycle governs `coverage-private-source-withdrawal`, `coverage-observed-qq-recall`; guards `conv-share-own-material-missing`, `cm-conditional-expression-scope`, `coverage-emotional-disclosure` must stay green.
- **memory_continuity** ("long and changing histories, dated/scope-correct memory, lifecycle separate from controlled preparation"): M3 (B1) unblocks `coverage-long-private-consultation`; C3+C4 (B4/B6) unblock `coverage-long-single-source` and the compaction dead band; overlays scope `cm-local-correction-continuity`, `cm-new-job-corrects-old-understanding`; dated applicability governs `cm-dated-fatigue-current-unknown`; negative-mandatory closed topics govern `cm-closed-topic-not-restored`; preference ownership governs `cm-stable-preference-quoted-wish`; recall tombstones govern `coverage-observed-qq-recall`; long-history recall cases `replay-mixed-history-reciprocity`, `replay-job-change-later-recall` and guards (`coverage-permanent-goal-change`, withdrawal/exclusion, both feedback cases) must not regress.
- **communication_quality** ("natural, useful, personal help following purpose, mutual willingness, uncertainty"): C2 mandatory materials (B5) target `conv-puzzle-explicit-invite`, `cm-ambiguous-interest-critical-availability`, `coverage-warm-reciprocity`, `cm-generated-invitation-vs-actual`; C5 entailment (B2) targets `coverage-emotional-disclosure`, `coverage-misunderstanding-repair`, `coverage-ambiguity-*`; C7 preference rendering targets `conv-share-own-material-missing`, `cm-stable-preference-quoted-wish`; all paired opposite cases (welcome/refusal, explicit/ambiguous, available/missing, friendship/work/learning vs romance) remain the discrimination surface.

Per-bottleneck expected improvements (hypotheses to verify, not claims): B1→`coverage-long-private-consultation`, `cm-local-correction-continuity`; B2→`coverage-emotional-disclosure` attribution family; B3→`coverage-observed-output-feedback`, `coverage-feedback-current-material` (planning-validation failures), repair-economy metrics; B4→`coverage-long-single-source`, overflow checklist; B5→`conv-puzzle-explicit-invite`, `cm-generated-invitation-vs-actual`, `coverage-warm-reciprocity`; B6→ both long cases + attempt-count economics; B7→`cm-stable-preference-quoted-wish`, `conv-share-own-material-missing`; B8→ both feedback cases + `coverage-feedback-current-material`.

### 6.3 Replay adapter boundary compatibility

`evals/assistant/REPLAY.md` fixes the adapter protocol (v1: `open/advanceTo/observe/observePrivate/respond/configure/withdrawSources/drainOutputs/currentOutput/diagnostics/close`) and the output shape; the dataset and criteria are architecture-independent and **not modified** (evals read-only honored). The SUT contract this design preserves:

- `scripts/eval-qq-adapter.cjs` is the replaceable boundary; the new architecture either extends it against the new internal seams (controller `assist`, store, maintenance checkpoints) or ships its own adapter — REPLAY.md explicitly allows a new adapter, never a rewritten dataset.
- Controlled preparation (prefix memory-maintenance checkpoints counting toward the HTTP cap) must remain expressible: M5 exposes the same "run maintenance to completion" entry point; the observation log makes `open(initial)` rebuild-from-raw natural (already contractually required).
- Frozen-input invariants that must survive every stage: source time, authored-note permissions/disclosure, actual-output feedback references (now bound via presentationId — the adapter's feedback paths gain the new field mechanically), string QQ IDs end-to-end, withdrawal semantics, and "never give derived expected understandings or case criteria to the assistant".

---

## 7. Resources and imported conclusions — applicability and limits

- **JEV (`typesafe/jev-1.14`, OpenRouter alpha)** — applicable to *narrow typed decisions only* (candidate relevance to a question class, next-read choice). Limits (per `docs/available-resources_CN.md`, which binds): no chat-body generation; probabilities never treated as facts or authorization; batch/change-triggered with cached applicability, never per-request full-history calls; never filters out counter-evidence or corrections; workflow, permissions, source revisions and side effects stay program-owned; alpha API stability unverified — pin and record versions; retain a no-JEV same-input baseline.
- **ARK Agent Plan embedding (`doubao-embedding-vision`, `/plan/v3`)** — applicable as *candidate encoding combined with* keyword/time/source filtering (M4 stage 3). Limits: remote encoding is a new data flow — fictional isolated trial first, real data only within existing authorization; embeddings never replace time/scope/withdrawal/disclosure filters; index must survive deletion and stale-recovery tests; docs page was client-rendered — verify request/response fields at integration; `sqlite-vec` is pre-v1 (author README) — investigate bindings, don't assume stability; a local cosine table is the fallback.
- **Anthropic context-engineering guidance** (effective context engineering; cookbook) — supports progressive disclosure (ladder + lookup handles) and "smallest high-SNR context" over preload. Limit: their setting has no per-party disclosure permissions, no speaker-attribution guarantee, no no-send boundary; recipes are not copied wholesale.
- **MemGPT/Letta (arXiv:2310.08560)** — memory-hierarchy paging supports digest+lookup as a local deterministic paging design. Limit: MemGPT pages by model-initiated calls; this product caps model-driven reads (≤2 lookups) because each read spends HTTP budget and touches private data — paging here is program-owned.
- **Internal conclusions** (`context_engineering_core_principles`, `llm_correction_loop_best_practices`/`llm_cannot_self_correct`, prior context-priority review) — treated as leads and verified against current source; the one-retry correction rule is why M3's retry stays an optimization, not a gate. `dsh-target-architecture.md` §2/§3 reasoning is inherited where §1 says so; its M4 merge precondition (fix flows first) is respected by the P1 shimming strategy.
- **Rubric/constraints** (`rubric.json` hard-failure rules, goal boundaries) — these are the *constitution*, not imported conclusions: nothing in this design may weaken a disclosure boundary to make a case pass.

---

## 8. Risks and explicitly unresolved items

1. **MQA intent misclassification** could make the wrong materials mandatory. Mitigation: lexical-first classifier, optional model/ JEV confirm, `generic_consultation` fallback, paired-case guards. Residual: measured only on visible frozen cases — no unseen-holdout claim possible (goal wording).
2. **Quarantine flood** if the model persistently misfiles proposals: quarantine-rate metric + threshold; wire tightening via W1 contracts. (Target-arch counterexample 3.)
3. **Never-refuse ladder can starve answers of evidence** → hallucination risk shifts to the fidelity audit. Digest-only synthetic requests must be reviewed before CC1 acceptance; if decision-critical detail (e.g. per-item display permissions) is lost within the lookup budget, raise the digest-backed lookup budget before considering model-side summarization (target-arch counterexample 2).
4. **Embedding/JEV adoption risk** (new external data flow, alpha/pre-v1 deps): disabled-by-default, fictional-first, baseline-retained; the architecture functions fully without them (M4 stages 3–4 optional by construction).
5. **Overlay over-application** across topics: scope keys + closed-topic/changed-goal guards must fail loudly; if leakage appears, widen the key, don't narrow the mechanism.
6. **Contract codegen expressiveness**: some constraints (cross-field semantic checks like activity-time bases) may not be declarable; hand-written extensions carry a drift test and remain in the registry as explicit TODO contracts.
7. **Migration surface**: ~15 legacy memory tables; phase-gated with parity fixtures, but the attestation-candidate backlog (legacy preference-classified items awaiting user attestation) is real user-visible work with no silent default.
8. **In-flight stream charters are asserted here, not negotiated**: `dsh-struct-data`/`dsh-struct-wire` have no landed code at this commit; if their actual scope differs, §4.2's absorption table is the renegotiation surface (components M3-logic/M4/C1–C5/F1 are the non-absorbable core).
9. **Residual B2/B3 soil**: landed stream A/B code still has consumers of legacy projections and hand-written protocol fragments; completion is enforced by parity tests, but until then both soils partially persist — tracked, not hidden.
10. **Unresolved by design**: exact JEV decision schemas; final vector-index choice (sqlite-vec vs local table); whether `memory-search`'s UI surface needs a compatibility shim during RT1; the fate of `conversation-discovery`'s cohort caps (≤2 per subject:aspect) in the merged ranker — must be preserved until the initiative/reconnect frozen cases prove a merged ranker safe without them.

---

## 9. Boundaries honored

No production code modified (this file is the only write); `evals/` read-only; no QQ sending/forwarding/auto-reply/simulated keys at any layer of this design; drafts remain manual; scope binding, string QQ IDs, stale-result discarding and privacy floors unchanged and strengthened (speaker fingerprints, authorization tiers, tombstone propagation); no credentials or real chat data in this document; evidence class labeled source-only throughout; independent output evaluation stays blind to everything herein.

---

## Appendix A — Coordinator addendum: bottleneck B9 (post-design evidence)

Added by the DSH coordinator after delivery; same evidence class (live replay, round dsh-mc-002d live-6).

**B9 — Continuation reads and delivery retries share one per-request model-call budget.** Observed on coverage-long-private-consultation s1: 2 lookup continuations (valid sourceIds form) + 3 prepare_message attempts (first missing authorityRef, judged invalid) exhausted the 4-call ceiling; the control run without declaration-bearing evidence completed the same case. Structural soil: (a) retrieval lookups are model round-trips, so navigable evidence invites more round-trips; (b) invalid-delivery retries and lookups draw from the same budget.

Design implications (extend, do not replace):
- C4 Budget Authority governs call-count budgets per purpose (retrieval continuations vs delivery attempts vs repairs) as explicitly as byte budgets, split visible in the manifest.
- C6 parse-time completion remains the primary lever: every deterministic malformation fixed parse-side saves a model call.
- M4/RT1 prefer batched program-side retrieval: one round-trip returning multiple ranges.
Expected-improving cases: coverage-long-private-consultation, coverage-long-single-source.
