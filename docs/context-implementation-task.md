# Relationship context implementation

Goal: Support the user's long-term relationship goal through persistent private discussion, truthful cross-day context and optional drafts in the existing QQ companion.
Invariant: Only actual QQ observations count as sent; no sending or auto-reply capability is added.
Invariant: Account/contact, source validity and model consent bind every request and persistent result.
Invariant: Private discussion and outgoing draft inputs are separate; user-authored goals and material permissions cannot be changed by model state patches.
Scope: Implement the minimal five-part design; no embedding/Jev requirement, automatic Skill evolution, QQ installation changes or real-chat processing during verification.
Acceptance basis: Existing normalized QQ fixtures and controller/server consumers, plus the approved context design's mixed-request, cancellation, copy-only, deletion and stale-result cases.

## Decisions

- 2026-10-12: Established formal main baseline d45e629 from reviewed source files only; created feature/relationship-context from main. Research snapshot histories are not merged. Existing model profiles and reply-focus functionality remain part of the baseline.
- 2026-10-12: User authorized implementation after design delivery. Functional, source-shaped integration and synthetic browser checks are used; mutation checks are optional and not necessary for this change.

- 2026-10-12: Implemented and exercised persistent private conversation, per-contact goal/materials, constrained working-state updates, purpose-specific model input, actual manifests and bound feedback. Optional models were not added.
- 2026-10-12: Review found and fixed late history resurrecting recalled QQ content, missing the preceding complete message burst, and dropping all prior state on each new request. Historical evidence with uncovered later changes is now explicitly historical-only.
- 2026-10-12: Functional suite passes 100 checks. Synthetic UI suites cover 16 legacy and 10 assistant checks. Configured gpt-6.1-sol passed 4 bounded synthetic cases in 6 requests. These are not real-chat or relationship-effectiveness evidence.
- 2026-10-12: Mixed private/public source selection still depends on model semantics; exact substring/source checks do not establish semantic disclosure permission. Keep this explicit in user documentation. Main/runtime integration is a separate handoff after candidate review.

## Scope correction — full goal-driven completion

The user explicitly rejected MVP/staged delivery on 2026-10-12. This supersedes the earlier minimal-scope and handoff-only boundary. Complete the operational relationship-support system: unified entry points; searchable long-term QQ/private/notes history; incremental evidence-backed memory and state maintenance; natural-language user-owned goals/materials/preferences/corrections; sustained discussion-to-expression without recopying context; method applicability/evidence; bounded costs, deletion and uncertainty; end-to-end, live-model and desktop integration evidence. Integrate into formal main after review and validation while preserving user data and other work. Do not add automatic QQ sending or promise the other person's feelings.

Gold flows: the user's current conversation and original design scenarios, including old private context after many later turns, changed/cancelled plans, private versus shareable statements, and old quick-reply bypass. Existing consumer and fixture contracts remain the source-shaped structural baseline; held-out live-model multi-session tasks must cover semantic behavior.

## Verification

The complete source-shaped suite and both browser flows pass. The live model exercised nine multi-session scenario categories; inaccurate evaluator conditions were corrected and four affected/changed cases were rerun with their original records retained. Independent review checked actual output helpfulness, privacy projections and relevance/cost. Desktop refresh follows this candidate commit.
