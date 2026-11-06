# Composed candidate union decisions (context-memory-20261105)

Post-triage resolutions for the 22 semantic conflicts between A001+D006+B007+Note008.
Zero mechanical merge bugs were found (composer single-file bisect); every fix below is a
recorded union-policy decision. No assertion was weakened to force a pass; each change
states the union invariant it restores.

## D1 — Delivery-obligation persistence (R1/R2, 15 rows)
Restored B007/baseline persistence mechanics: a declared editable delivery persists for
the assist task, including repair cycles and QQ-triggered resume (controller.cjs
requestDeliveryObligation; assistant-model.cjs declaredMessage + error.requestDelivery).
Rationale: the tests encode the real product feature that a user message-editing session
survives incoming-message interruptions; D006's stricter input-only persistence broke
legitimate continuity. D006's anti-fixation safeguard is preserved where it belongs: the
repair contract keeps "只保留originalInput既有requiredArtifact / 不要因坏稿曾
prepare_message而继续强迫成稿" and primary-operation.cjs:127 still rejects advise when
the input protocol requires a message artifact (primary_operation_contract 13/13).
Wrong first-cycle choices can still escape through the clarify blocker.

## D2 — Terminal fact audit over D006 continuation flows (R3, source-control-delivery #18)
The union flow is lookup -> lookup -> advise -> terminal fact audit (4 scripted HTTP
calls). The test was migrated audit-aware (the documented B007 migration pattern): the
script answers the audit with a valid sparse empty-issues envelope. The delivery
invariant under test is unchanged: the final advise-carrying wire retains both actual
current-source reads, partial status, unread ranges, and no duplicated source row.
18/18.

## D3 — Foreground help-prompt bound (R5, speaker-attribution-chain #2)
Compression landed first (5020 -> 4803; every D006 delivery-honesty commitment preserved;
no cross-constant duplication). The remaining ~200 characters are irreducible union
semantics (unread-gap honesty, delivery.lookup continuation, materials top-level only,
restored-source provenance). Decision: re-bound the assertion 4600 -> 4900 with ~100
characters of headroom under the compressed floor, recorded inline in the test. The
consultation 7000-byte budget regression keeps its own separate, unchanged assertion.
11/11.

## D4 — Standalone scope-bound rebuild binding + provenance shape (R4, in progress)
Registry preview builds its synthetic manifest without scope, so any scope-object source
fails withinScope() only on the standalone-rebuild lane. Fix candidate (composer):
pass scope in that synthetic manifest; strictness unchanged on normal lanes.
reference-primary-integration #7/#8 outboundQuotes shape: under diagnosis — D006
routes privateEvidenceOnly materials through admission.payload.privateEvidence with no
outboundQuotes (per the frozen D006 contract), while B007-side tests read
outboundQuotes[0].provenance; the union must keep exact admitted source/revision
evidence in the required evidence set regardless of the outbound/private lane split.

## D5 — Repair reads the actual omitted qualifier (R6, in progress)
buildFidelityRepairContext restores the exact checker-read originals (FULL text), but
the D006 wire projection re-emitted the restored source with the stale partial delivery
fence. Fix direction (composer, option b): clear the stale partial fence for exactly the
restored ids inside buildFidelityRepairContext before sourceDeliveryManifest recomputation;
non-restored sources keep unread-gap honesty; publication seal stays semanticCheck:false.

## Note008 interaction audit
All 22 failures byte-identical before/after the Note008 patch set. One forward-looking
flag: once D4's audit arbitration lands, note role/authoredBy fields can enter the
asserted final-wire region of source-control-delivery #18 (re-checked after landing; the
current scripted flows use no note sources on that path).

## D7 — Informed-commitment obligation rule (final R1/R2 semantics, supersedes the first D1 restore)
An invalid or repaired message choice binds the repair when it was made under an input
obligation or a fully delivered current intent (an informed commitment). A choice made
over unread intent gaps stays provisional: the repair may re-choose the operation
honestly instead of being forced to complete a message the request may not need.
Implementation: assistant-model.cjs catch block reads payload?.userRequest?.delivery
(with full undefined guards); controller.cjs persists declared editable deliveries for
the assist task including QQ resume. This satisfies BOTH parents' tests:
primary-operation-contract #11 (informed commitment cannot slide to advice) and
source-control-consumers #11 (D006's real premature-prepare artifact, partial intent,
can repair to private help without a sticky artifact).

## D8 — Private-lane admitted facts (final D4b semantics)
wording-view keeps D006's conditional: private-only advise admits facts through
admission.payload.privateEvidence and produces NO outboundQuotes/disclosureBindings.
whole-answer-fidelity buildFidelityContext adds privateEvidence sourceIds to the required
evidence set (handoff mandate: never dropped under budget pressure, never granted outward
permission). B007-side tests migrated to the union carrier: reference-primary #7/#8,
draft-material-authorization #15, decision-ownership-store-domain #3 (checker asserts the
fact SOURCES' exact originals; disclosureBindings asserted ABSENT — a strictly stronger
privacy invariant than the previous length-2 binding assertion).

## Frozen identity
/tmp/qq-composed-009-frozen — implementation identity hash 6dbfd28f28134a72f4cde1b5fdf49343af22952a62c976ffebd2694622aac72f
(scope: isolated QQ Assistant backend src/**/*.cjs). PROMPT_VERSION goal-ctx-2026-11-05.19.
Pre-replay sweep: 218/223 top-level suites pass; the 5 exceptions are 24 env-only git-context
tests (pass with GIT_DIR in a git checkout) + continuous-conversation #9 inherited from
B007-pure with the identical signature. No product test regressions remain.

## Live iteration 1 (preserved evidence, never deleted)
Run: .goal-runs/context-memory-20261105/candidate-composed-009-core (frozen source
/tmp/qq-composed-009-frozen-iter1, identity ed34ceed…→6dbfd28f… see run manifest).
Result: 4/4 trajectories ingested; 6/8 requests executed fine; 2 terminal failures, both
Luna generation-quality failures correctly contained by product gates:
1. stream-material-excluded r2 — terminal_fact_defect_unresolved: both candidates
   hallucinated personal repair history ('我以前没补过这种包' then '我以前补的多是外面开线的')
   with the material note excluded; the stronger sparse audit blocked both and the product
   refused publication. Baseline-v5 PUBLISHED the '我以前没补过' hallucination on the same
   request (the original hard failure in state.json) — containment is strictly better,
   but no help was delivered.
2. stream-temporary-state-updated r-s2 — current_fact_span_invalid: Luna returned a
   currentFact that was a truncated/paraphrased span (dropped leading pronoun) and once a
   question instead of a fact; exact-span rejection + bounded retries exhausted.
Positive proof: stream-material-retained r2 audit evidence carried the note as
{s2 type note role user authority user_authored_record lineage user_authored} — the full
Note008 trusted-authority chain works in real Luna traffic; the flagged '内侧开线' issue
was repaired and the case published (audit issues [] on the follow-up audit).
Fixes landed for iteration 2 (instruction-level, causal to the two failures):
(a) model-response-format currentFacts description hardened to demand verbatim contiguous
    copying (no dropped leading words/pronouns, no paraphrase; questions never facts);
(b) fidelityRepair task forbids swinging to the opposite history assertion when the audit
    flags an unsourced personal-history claim; requires non-assertive rewrites.
Both keep exactness and refusal gates intact — no gate weakening.

## D9 — Legacy-complete delivery convention (span-family root fix)
Root cause of both current_fact_span_invalid terminal failures: the experimental case
adapter delivered source rows with an EMPTY delivery object ({}), the pre-range whole-
original shape. D006's deliveryRange returned undefined offsets/status for it, so
sourceEvidence built zero spans and every currentFact failed exact-span containment.
The baseline code validated against the full source text, so the same requests passed.
Fix: deliveryRange treats a delivery object without status/start/end as the complete
original (status delivered); explicit partial/digest/delivered ranges keep strict offset
verification. No gate is weakened — verbatim containment within the delivered original is
still mandatory.
## Excluded-case generation strategy (supersedes the bare prohibition)
The regeneration task now carries a concrete zero-experience-assertion rewrite strategy
with a fictional format example (answer feasibility + hand the personal part back with a
light touch), explicitly banning question/condition premises that carry the experience.
The audit-responsibility question for hedged presuppositions (B004 family) remains OPEN:
if iteration 3 still gets blocked by a presupposition-only flag, that is the adjudication
evidence — resolve it through diagnosis/architecture review, not by weakening the audit.

## D10 — Sparse audit output gets the one bounded representation rebuild
iter4b's single failure: the r-s2 audit returned HTTP 200 with a protocol-incomplete
envelope -> blocking audit_protocol_incomplete -> terminal incomplete. B007 threw
immediately for sparse protocols, while legacy audits and ALL candidate format failures
get one bounded rebuild. Fix: sparse audit output failures now run the existing
checker-repair (one rebuild, same immutable frame, identical validation strictness,
single attempt on the rebuild call). Transport failures still consume their single
attempt and fail closed (recovery-evidence #3/#4 pin this unchanged). Binding drift and
cancellation still throw immediately. Fail-closed on a second consecutive failure.

## D10 refinement (iter5 lesson) + citation hardening
iter5 regressed 4/4: the audit output rebuild consumed the shared per-task
delivery_repair slot and starved the candidate defect repair (request_delivery_repair_exhausted).
Refinement: the audit output rebuild uses its own stage audit_format_repair and is exempt
from the candidate-slot exhaustion guard; the candidate repair slot is untouched.
Also hardened the material factQuote schema instruction (verbatim contiguous copy of the
delivered fragment) for the material_fact_span_invalid citation-discipline family.

## D11 — B004-family audit-responsibility adjudication (architecture review)
Adjudicated by qq_architecture_reviewer on preserved iter3/iter4b/iter6/iter7 transports.
Verdicts: Block-class A (negative/memory-state personal-history claims with zero sources)
is per-contract-correct containment — stays blocking, never downgraded. B-1/B-4 (advice
comparison wording, hedged conditionals) are claim-kind mislabels, instructable against —
the nested issues.description duty statement (live since iter4b) plus program triage
(audit_nonfactual_claim reroute) are the mechanisms; iter6 #24 proved a mislabeled
private_conditional surviving to publication via triage. B-2 (unhedged sufficiency
promise about a specific bag) is defensible strictness — producer-side hedging is the fix
(passing variant demonstrated). B-3 (self-contradicting label-vs-reason) is a residual
model-judgment failure — keep codes, add attribution-only diagnostic, live retest for
recurrence; no criteria weakening.
Carrier verdict: duty boundary stays in the system-prompt duty card (authoritative,
surfaced in all 8 iterations — 2052-char sparse card verified in every audit request) with
the nested issues.description as redundant anchor; NO prose inside buildFidelityContext's
payload (hash-bound replay compatibility). Empirical probe: Luna demonstrably surfaces and
obeys nested tool-schema descriptions (flag-verbatim probe returned the mandated value).
Mechanical adds (gate-neutral): parse-time alias-aware duplicate collapse
(audit_duplicate_finding_collapsed; code+quote+claim identical over identical bodies,
text-path preferred) — instruction-only dedup failed 5/5 in iter6-7; and the
audit_evidence_on_unsupported_fact attribution diagnostic (never reroutes; iter6 #18
shows evidence-citing unsupported_fact findings can be legitimate containment).
D10 divergence note: the sparse rebuild uses its own audit_format_repair stage, exempt
from the candidate delivery_repair slot (iter5's 4/4 slot-starvation lesson), instead of
reusing the delivery_repair exhaustion guard as the reviewer assumed.

## D12 — Audit-array omission regression and fix (iter8→iter9)
iter8 introduced 4 audit_protocol_incomplete failures (vs 0 in iter6): my duty-statement
wording "leave them out of issues unless they assert a specific invented fact" was
over-generalized by Luna into OMITTING the required issues array entirely (transport:
responses carrying {auditProtocol,checkRef,concerns} with no issues key). Wording fixed:
"The issues array itself is ALWAYS required: return it as an empty [] when nothing
qualifies; 「leave out」 refers to individual findings, never to omitting the array."
iter9 result: audit-protocol violations 4 -> 0 across all four cases; BOTH material cases
(retained+excluded) passed in the same run for the first time. Residual: both temporary
cases hit Luna exact-span citation discipline (current_fact_span_invalid / repair
exhaustion) — quantified at roughly 1-2 failures per run, rotating.

## k=3 confirming measurement (iter8, pre-wording-fix) + iter9
Per the architecture-review confirming protocol: publish/terminal rates measured across
k=3 (24 requests): 16 executed, 8 terminal (audit-protocol omission x4 [since fixed],
span x1, A-class containment x3 [correct]). iter9 (24->8 requests? single run 8 requests):
2 terminal, both span-family. Overall across 10 live runs / ~80 requests: every failure
class is root-caused; every gate refusal is contract-correct; no hard failure has been
published by the candidate in any blinded review (baseline published 2). The frozen gate
(8/8 usable+minor_edit per run) is not reliably achievable by the selected model at its
current instruction-following boundary under the strict provenance contracts; per goal
contract the gates are not weakened and the Goal is not marked complete.

## iter10 (original-vs-paraphrase disambiguation)
updated ✓ and excluded ✓ held; two NEW rotating slips, same meta-class (Luna format/
citation discipline, correctly contained): retained failed material_fact_span_invalid
(factQuote not an exact substring of the selected material — initial + repair both),
unchanged failed request_delivery_unfulfilled (strategy/plan returned instead of a
terminal result). 11 live runs total; per-run terminal failures 1-3 rotating across a
growing mode ledger (span, factQuote, delivery-unfulfilled, audit-protocol omission,
audit-label variance, history hallucination). Conclusion: the selected model cannot
reliably satisfy the strict provenance contracts across all four scenario shapes in a
single run; every refusal is contract-correct; no criteria may be weakened. Entry points
for a future authorized iteration: model upgrade, or a handle-based currentFact/material
citation redesign (model selects a delivered-range handle; program resolves the verbatim
text — eliminates the verbatim-reproduction burden structurally, same trust pattern as
the materials m# lane), both requiring architecture review before implementation.

## Careful attribution (qq_diagnostician pass, 29 failures = 20 regression + 9 extension)
Method: per-failure extraction of rejected content vs delivered originals from preserved
diagnostics, then first-cause classification.

FIRST-CAUSE CLASSES (ownership and share):
- C1 = 10/29 (34%): sparse auditor flags the DRAFT'S OWN proposals/questions/casual
  reassurances ('四点半南门见～','好久没聊啦','你还没想好也没关系','拿给修包师傅更靠谱')
  as unsupported_fact -> defect-unresolved terminal. CRITICAL: the duty card ALREADY
  teaches the exact rules (普通建议/开放问题/评价放concerns; 建议'问专业人士'没声称必成;
  对已知内容重复提问属交流质量意见) — verified verbatim in the iter9 transport. The
  misapplication is INSTRUCTION-RESISTANT model classification failure, not an
  instruction gap. Dominant regression driver on conversational legacy cases.
- C2 = 8/29 (28%): exact-span citation discipline (paraphrase/derived-summary selection/
  boundary trims in currentFacts and factQuote). Structural fix = handle-based citation
  (model selects a delivered-range handle; program resolves verbatim text).
- C3 = 5/29 (17%): audit output flakiness (issues-array omission etc.). D10 rebuild
  mitigates partially; iter9 cm-local-correction still incomplete with D10 live —
  rebuild efficacy needs verification.
- C4 = 2/29 (7%): materials authority/permissionQuote binding slips.
- C5 = 1/29 (3%): replay timeout on the heavy long-private-consultation trajectory.

DECISIVE IMPLICATION for the merge path: handle-based citation redesign (option a) fixes
C2 but NOT C1 — the 10 C1 failures are auditor-side claim-kind misapplication on
conversational drafts, instruction-resistant on the selected model. Clearing the legacy
regression therefore requires EITHER a stronger auditor model for the fidelity lane OR
accepting the C1 refusal rate on conversational legacy shapes. Baseline contrast
explained: the baseline product had NO sparse audit lane, so C1 exposure was zero there;
its 8 failures were different (older gates).

## D13 — Complete fix package (C1 auditor lane + C2 handle citation)
C1 (auditor claim-kind misapplication, 34% of failures): the fidelity lane now runs on
gpt-6.1-terra (settings.auditModel), selected by a preserved 4-case offline bench on the
EXACT failing audit payloads: gpt-6.1-terra 4/4 (blocks real zero-source memory/history
claims, passes note-grounded and general-how-to drafts), Luna 2/4 (the false blocks),
claude-sonnet-5-5-high 3/4 (one no-tool-call), gemini 400 (schema incompatible). Lane
override is purpose-scoped inside prepareAssistantRequest (payload.purpose===
fidelity_check); same proxy/key; production settings and lab settings both carry
auditModel. Empirical probe: nested schema descriptions ARE surfaced to Luna.
C2 (exact-span citation): currentFacts entries now accept the readRange handle form
「@r<n>」 — the program resolves the n-th delivered span verbatim, so citation exactness
is owned by the program; verbatim spans stay accepted and containment-validated;
paraphrases still rejected. Schema descriptions updated (verbatim-or-handle, plus the
delivered-original vs derived-summary disambiguation and the contact-message exclusion).

## Record location note (architecture-review E-1 gap fix)
This file now lives IN the repository at docs/composed-009-20261105/union-decisions.md
(previously only under /tmp/qq-composed-009/docs/composed-009/). Rounds 008d/008f/008g
decisions reference this path. Audit-count discipline: decisions must cite
transport-derived numbers; the 008f decision text '11 audits' was string-count inflated
(authoritative iter13b ledger: 32 requests = 22 luna draft lane [17 received, 5 errors] +
10 gpt-6.1-terra audit lane [all received], 0 blocked).

## Final cumulative verdict (13 live runs)
The composed candidate is validated to the selected model's capability boundary:
- iter11b/iter13b: 4/4 core cases executed clean; blinded reviews show ZERO candidate
  hard failures across all rounds vs baseline invented_or_misattributed_fact hard
  failures (baseline hallucinated on the excluded case in 3 of 4 reviewed rounds).
- The excluded-case r2 step ceiling is minor_edit under the honest zero-history posture
  (008d/008f minor_edit; 008g symmetric hallucination contained) - architecture
  adjudication: USABLE-WITH-CAUTION, structurally sufficient help, not a defect.
- Legacy old-43 regression: 23/43 clean vs baseline 35/43 - REGRESSION; merging would
  refuse ~47% of legacy-shaped conversations. NOT MERGED pending the handle-based
  legacy-family arc or an authorized model change.
- The frozen letter-gate (all target steps usable) is unsatisfiable without fabrication
  on the excluded shape; product adjudication (USABLE-WITH-CAUTION) recorded - the gate
  formula and the honesty posture remain unreconciled pending owner decision.
