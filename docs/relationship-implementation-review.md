# Skeptical implementation review

The reviewed design is a starting hypothesis, not a mandate to add every proposed table. Preserve the user's romantic goal through concrete help: initiating/continuing, shared activities, expressing interest and interpreting actual reciprocal development.

Risks to falsify: (1) stale short-term claims treated as stable traits; (2) compressed summaries reinforcing model guesses; (3) feedback duplicates counting as independent or recurring evidence; (4) a good reply mislabeled as a successful intervention; (5) context filled with irrelevant indexed memories and complete historical versions; (6) logical calls hiding retries/background cost; (7) broad migrations erasing records or creating competing sources of truth.

Evidence anchors: https://arxiv.org/abs/2307.03172 and https://www.trychroma.com/research/context-rot show task- and position-dependent long-input degradation; they do not establish a universal safe token size. Prior local research verifies LongMemEval information-loss trade-offs, ExpeL reflection regressions and ACE unreliable-feedback regressions. More maintenance/longer prompts are not success criteria.

Implementation decisions and executed evidence will be appended below. No relationship-effectiveness claim follows from synthetic tests.

## Implemented decisions and falsified defects

The actual implementation reuses existing memory records/dependencies for typed claims and activities, plus one scoped experience-object table. It preserves the original QQ message table and manually sent workflow. There is no extra router, embedding dependency or automatic global skill evolution.

Independent review and execution found and fixed:
- Feedback had two apparent authority sources. Migration now canonicalizes aliases and keeps generated evaluation targets separate from factual sources.
- Fallback QQ context could lose self/contact identity. The actual serialized payload now derives it from message direction.
- Corrections within one assistant task could relabel stale proposals with newer source revisions. Applied semantic actions clear prior proposals.
- An obsolete early return could leave a task running; a late rejected pre-resume attempt could overwrite completed usage. Both now preserve terminal ownership.
- Automatic maintenance could exceed a rolling request cap via retry. It now budgets the remaining actual HTTP attempts.
- A recorded live-model feedback review exposed a real storage failure: state CAS writes serialized hydrated display-only feedback, normalization changed the revision, and final save failed. All companion writes now share canonical serialization; the recorded synthetic-conversation response reproduces the failure and passes after the fix.
- A source start time alone does not prove continuing applicability. Claims without an explicit end remain unspecified instead of receiving an indefinitely current label; relative dates require original-time interpretation.
- Legacy two-field browser scope could misbind draft events or preserve a forgotten duplicate. New event routes validate all four identities, drafts migrate only after confirmed same-scope recovery, and the old duplicate is then removed.

Ordinary functional tests, real browser execution with synthetic records, recorded model-response replay, live-model scenarios, isolated migration of a private real database copy, and native helper refresh are recorded separately in the release evidence. No test is a romantic-effectiveness score. The original unavailable-provider attempts and the pre-fix live failure remain recorded rather than being silently replaced by successful retries.

Release review also distinguishes a corrected source from a forgotten one: user-edited drafts may remain for explicit review, retaining their origin lineage, while source deletion must clear derived text even after such review. Deleting a feedback display row must delete its canonical source; deleting an assistant response must invalidate its exact artifacts and dependents without deleting shared original QQ evidence. These are consumer-level regression requirements, not additional relationship-stage gates.

Migration compatibility limit: future-version rejection is enforced by the new Store. A historical binary cannot retroactively learn this guard; deployment therefore stops the uniquely identified old child before opening the migrated database. Running an old writer concurrently is unsupported, and downgrade uses the pre-upgrade private backup rather than opening the new schema with old code.

A new-ID re-extraction could also recreate a withdrawn interpretation from the same evidence after retirement changed its signature. Retirement now retains prior semantic signatures; replaying the exact prior interpretation (including changed search tags) is a no-op, while new evidence remains admissible. This deterministic identity gate does not claim to detect every semantic paraphrase. The red-to-green regression also checks that new actual evidence can still support a new understanding.

The final compatibility regression covers pre-upgrade assistant turns without artifact references. They now receive a durable response/candidate/option family with incomplete-generation provenance and stale status; only recorded historical source revisions are retained. Existing legacy drafts bind to that lineage, require review, and remain reachable by later correction/deletion. An explicit missing artifact version is not reconstructed from display text.

Native integration caught a budget failure not exercised by the earlier live synthetic samples: a valid 48,000-byte payload became a 65,281-byte complete foreground request after instructions and nested JSON escaping, exceeding the configured 64,000-byte cap before transport. Context selection must use the same serialized envelope measurement as transport, preserving whole required evidence and trimming optional units. A separate quoted-text synthetic case reproduced the same mechanism in memory batches; smaller source batches must be rebound with their original cursor and receipt contract.
