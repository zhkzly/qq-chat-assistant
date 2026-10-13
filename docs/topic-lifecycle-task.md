# Direct topic lifecycle contract
Goal: End or remove the selected local discussion topic immediately without requiring a model call, while preserving the user's romantic goal and real communication.
Invariant: Four-field account/contact scope and exact topic version bind each explicit action; stale actions and late model results cannot alter or revive another topic.
Invariant: Keep QQ records, long-term goal, source-grounded relationship memories and unsent composer/draft/goal text intact.
Scope: Local lifecycle persistence, authenticated route, direct UI controls, meaningful functional/pointer tests, main integration and safe helper activation.
Evidence: User screenshot shows completed game topic still active with HTTP429; ui/app.js adjustTopic(true) merely appends a natural-language closure request to the composer.
No: QQ sending, cloud upload, model/provider changes, inferred automatic memory forgetting, or a wider context redesign.

## Decisions
- Use ordinary functional and UI regressions; mutation checks are optional under current AGENTS.md.

- Diagnosis: completion was a draft-composer helper rather than a state operation. A provider429 therefore prevented closure. The new explicit local API appends one current user_control source and updates/removes only the topic atomically.
- Closed active focus is omitted, factual state retained/stale, summaries for this scope discarded, and obsolete requests cancelled. No substring classifier or broad source-forget operation is used.
