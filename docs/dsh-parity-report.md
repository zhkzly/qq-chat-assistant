# DSH Parity Report — CC1 Admission Compiler vs Legacy Selection Pipeline

- Role: parity verification engineer (structural, deterministic). Scope: prove — or explicitly record — behavioral equivalence between the CC1 admission compiler (`src/context/admission-compiler.cjs`, design §C3/C4 of `docs/dsh-subsystem-redesign.md`) and the legacy selection pipeline (`src/context/selection.cjs`) over the **optional layers** (discovery, methods, private-conversation grouping, relationship projection, background admission), before the legacy engine can be retired.
- Evidence boundary: **source-only + synthetic in-memory fixtures**. Zero model calls, no `--live` replay, `evals/` untouched. Structural parity is *not* conversational-quality evidence and claims no goal-round acceptance.
- Reproduce: `node tests/dsh-parity-harness.test.cjs` (13 deterministic tests); `DSH_PARITY_REPORT=1 node tests/dsh-parity-harness.test.cjs` prints the observed matrix JSON used in §5.

## 1. Method

For each scenario the harness (`tests/dsh-parity-harness.test.cjs`) runs `buildContext` **once with the CC1 swap neutralized** — a require-time patch of `admission-compiler.selectPlanningContext` that returns the empty legacy surface, which reproduces the exact pre-integration legacy pipeline — while capturing the pristine compiler inputs (`{options, snapshot, candidates}`) at the swap seam. It then runs the real CC1 shim on those same captured inputs. Both deliveries are projected onto comparable descriptors (delivered source tiers, declaration sentences, material outcomes, degradation ledger, layer inventory) and diffed.

Diff taxonomy:

- **(a) by-design difference** — the new chain behaves as the redesign intends (design section cited).
- **(b) regression** — the new chain loses legitimate content the old chain delivered. Must be fixed CC1-side and pinned by a test; the live set is empty after this report's fixes.
- **(c) insignificant** — field naming/ordering only.
- **(gap) documented scope difference** — an optional layer still owned by the legacy engine; a retirement blocker enumerated in §6. Gaps are neither (a) nor (b): they are the recorded retirement debt, each with the design section defining the CC1-side target.

Classification is executable: rules (0)–(6) in the harness fail on any rule violation (a hidden (b) fails the run), and rule (7) fails on any layer difference not recorded in the gap list.

## 2. Coverage matrix

| Scenario | Axes covered |
| --- | --- |
| S1_rich_snapshot | multi-source snapshot (14 QQ messages + private turns), generic consultation |
| S2_declaration_invitation | declared arrangement present, invitation-type request (B5 mandatory material) |
| S3_no_declaration | same request shape without any declaration (missing-material honesty) |
| S4_overbudget | oversized private source under a 6000-byte payload budget (ladder degradation) |
| S5_topic_relationship | closed topic + relationship claims/events/activities projections |
| S6_lookup_feedback | explicit lookups (model read + user source lookup), feedback target with F1 hydration |
| S7_discovery_methods | discovery directory + requested method cards + retrieved memory summaries |

## 3. Category (b) — regressions found and fixed (CC1 side only)

All three were found by this harness and are pinned by deterministic tests in the harness file. The legacy selection pipeline was not modified.

### b1 — `BudgetAuthority.plan()` pass-2 skipped rank-correct upgrades (byte guard)

- Evidence: a background requirement starting at its marker floor (≈452 B of id/type/delivery metadata) could not upgrade to its verbatim rung (172 B) because the upgrade guard `size.bytes <= admission.bytes` treats any smaller rung as a non-upgrade. The scan then took the *digest* rung (926 B) instead — a lower rank than verbatim, more bytes than the marker, plus a bogus `degraded_to_digest` ledger entry with `recoveredBytes: 0`. Every short QQ message (the most common shape) was mis-delivered as a structural digest; the legacy chain delivers those verbatim.
- Fix: pass 2 now scans the rank-descending rungs once and takes the first fitting rung of the highest reachable rank (same-tier enlargement of a ranged floor stays valid); `src/context/budget-authority.cjs`.
- Pins: "fix b1 pin" ×2 (verbatim delivery of a short source; rank-ordered plan upgrade).

### b2 — `materialRequirements` reported an admitted feedback target as `missing`

- Evidence: the MQA outcome builder only filled `sources` for `declared_arrangement`/`availability_state` and `contact_statement` rows, so a `feedback_continue` request with an admitted feedback source always reported `feedback_target:missing` — a false statement on the B5 explainability surface that downstream validators and the manifest read.
- Fix: the compiler retains the resolved feedback sources and reports their tier in the outcome row; `src/context/admission-compiler.cjs`.
- Pins: "fix b2 pin" + matrix rule (4).

### b3 — the shim's request cap was inert at the integration call site

- Evidence: the shim honors `options.budget.{measure, requestByteBudget}`, but the `planning-view.cjs` call site never passed them, so the compiler settled against an invented infinite serialized-request cap while the legacy chain enforces both caps (`contextBudget.fits`). The compiler's admission receipt therefore overstated deliverability.
- Fix (three parts, all CC1-side):
  1. the call site passes the live `contextBudget` measure and request ceiling into the shim;
  2. the degradation ledger no longer rides inside the measured payload — it grows with every settlement step, so measuring it fed a loop (more degradation → larger measured request → more degradation) and it never rides the integrated serialized request (planning-view attaches it to `context.manifest`); the ledger now travels on the compiler result and the manifest only;
  3. the live measure is wrapped with a payload+envelope fallback for payload-shape invariants the governed-only shim payload cannot satisfy (image-bearing sources are delivered by the legacy background admission until layer parity, so the serializer's image validation throws mid-settlement); the authoritative serialized check remains `finish()` on the real payload.
- Pins: "fix b3 pin" (compiled payload respects the serialized-request ceiling) plus the previously failing envelope suites (`assistant-request-budget`, `assistant-vision-repair-budget`) which exercise tightened-cap rebuilds and image repair end to end.

One existing test needed re-aiming, not a behavior revert: `tests/context-cc1-compiler.test.cjs` "the selectPlanningContext shim compiles against the legacy dependency shape" asserted on the *first non-current admission*, which under b1 is now the small incoming message correctly delivered verbatim (previously mis-delivered at the declarations tier, which made the assertion pass by accident). The test now targets the actual oversized declaration source and additionally checks tight-budget degradation with the declaration still reaching the payload.

## 4. Category (a)/(c) — by-design differences (content parity holds)

- **(a) Background admission never silently drops** (B4, §3.1): under S1 the legacy chain evicted 5 of 14 QQ messages outright (disclosed only via `deferredContext.qqSourceCount`), while CC1 delivered all 16 sources verbatim. Under S4 (6000 B budget) the legacy chain kept only 2 sources and evicted the rest, while CC1 delivered all 8 — the oversized private source degraded to a ranged excerpt with two recorded, handle-carrying degradation steps. Harness rule (5) pins that everything legacy delivers stays addressable (delivered or explicit marker) in CC1.
- **(a) MQA material framing** (B5, §3.2): in S2 both chains deliver the declaration sentence (content parity, harness rule 2), and CC1 additionally emits `materialRequirements` outcomes (`declared_arrangement:delivered`, `availability_state:delivered`) plus the `arrangementHandling` consumption contract. In S3 CC1 honestly reports `missing` where the legacy chain simply delivers nothing — no false content either way.
- **(c) Surface naming**: legacy exposes explicit-lookup delivery via `payload.evidenceDelivery` (source-delivery manifest); CC1 exposes the same facts via per-view `delivery.status` and `materialRequirements.retrievedMaterials`. Same information, different field names — recorded, no action.
- **(c) Ledger vocabulary**: legacy step names (`ranged_excerpt`, `deterministic_digest`) vs CC1's result-named `degraded_to_<tier>` steps; the entry shape `{step, appliedTo, recoveredBytes, remainingNeed, lookupHandle}` is shared and every individual-source step carries a copy-ready handle (harness rule 6).

## 5. Observed matrix (abridged from the `DSH_PARITY_REPORT=1` export)

| Scenario | legacy delivered | CC1 delivered | degradation steps (legacy/cc1) | declaration parity | gap keys beyond always-on set |
| --- | --- | --- | --- | --- | --- |
| S1_rich_snapshot | 11 verbatim | 16 verbatim | 0 / 0 | n/a | — |
| S2_declaration_invitation | 3 verbatim | 3 verbatim | 0 / 0 | 1 = 1 ✓ | — |
| S3_no_declaration | 3 verbatim | 3 verbatim | 0 / 0 | 0 = 0 ✓ | — |
| S4_overbudget | 2 verbatim | 7 verbatim + 1 ranged | 0 / 2 | both empty ✓ | — |
| S5_topic_relationship | 4 verbatim | 4 verbatim | 0 / 0 | n/a | relationshipClaims, relationshipActivities, topicActive, topicRetained, coreMemory |
| S6_lookup_feedback | 12 (incl. feedback source) | 12 (same set) | 0 / 0 | in-view both ✓ | feedbackTargets, privateCandidates, evidenceDelivery |
| S7_discovery_methods | 7 verbatim | 7 verbatim | 0 / 0 | n/a | coreMemory, methodCards, memoryDiscoveryDirectory, retrievedMemory |

Always-on gap keys observed in every scenario: `privateConversation`, `taskContext`, `work`, `materialView`, `goal`, `deferredContext`. (`work`/`materialView`/`goal` are built before the selection seam; they are listed for completeness of the retirement inventory.)

## 6. Retirement gaps (explicit recorded differences)

Each key is pinned by the harness; the cited design section defines the CC1-side target behavior that must exist before the legacy owner can be removed.

| Gap | Legacy owner today | Design target |
| --- | --- | --- |
| privateConversation | selection.cjs group builder | §3.1 step 3 candidate gatherer |
| relationshipClaims / relationshipEvents / relationshipActivities | selection.cjs `includeGrounded` projections + entailment labels | §3.4 identity-entailed rendering |
| topicActive / topicRetained | selection.cjs task/topic views | §3.1 step 3 direct references; §3.2 closed_topic negative control |
| coreMemory / memoryIndex / retrievedMemory / memoryDiscoveryDirectory | selection.cjs + discovery module | §2.3 retrieval service |
| methodCards | selection.cjs `runtimeCard` delivery | §3.5 contract-generated fragments |
| feedbackTargets (structured records) | selection.cjs evaluation-target projection | §2.5 feedback binding |
| preferences / privateRestrictions | selection.cjs note projections | §2.1 preference ontology |
| privateCandidates | selection.cjs candidate pool | §3.1 step 3 |
| evidenceDelivery | selection.cjs source-delivery manifest | §3.1 step 6 extraction contracts |
| taskContext | selection.cjs refresh() | §3.1 step 3 task frame |
| deferredContext | selection.cjs omission counters | §3.1 manifest vocabulary |
| work / materialView / goal | planning-view seed projections (pre-selection) | carried over verbatim at retirement; listed for inventory completeness |

## 7. Conclusion — can the optional layers be retired?

**Not yet.** The governed core (current-interaction floor, MQA-mandatory materials, explicit lookups, ladder settlement, degradation manifest) reached verified parity after fixes b1–b3, and the harness pins that parity deterministically — this is the reproducible regression net for the retirement work. The optional layers themselves are still delivered exclusively by the legacy engine: CC1 has no counterpart for any of the §6 gaps.

Recommended retirement path:

1. Port the §6 gaps in design-aligned workstreams (retrieval/discovery §2.3; methods §3.5; relationship projection §3.4; task frame + private-conversation grouping §3.1; feedback records §2.5; preference/restriction controls §2.1), extending the harness scenario matrix with each port and shrinking the gap list to empty.
2. Keep the harness as the acceptance gate: a layer may be removed from `selection.cjs` only when its gap entry disappears from the matrix and the governed-core rules stay green.
3. After retirement, keep rules (0)–(7) as the permanent no-regression contract for the compiler chain.

This report records structural parity only. Per the project contract, conversational-quality claims still require the frozen-replay + independent blinded-review process; nothing here substitutes for it.
