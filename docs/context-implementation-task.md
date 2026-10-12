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
