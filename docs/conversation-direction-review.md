# Conversation direction review

Baseline: main `0d2423c`. Implementation is isolated in `feature/conversation-direction-20261012`.

The reported failure was traced to the first causal handoff: a private correction reached preparation but not the restricted final draft. This release keeps bounded current-topic state and separately projects source-bound expression controls; it does not expose the complete private discussion to the drafting model.

## Cross-review decisions

- Storage and model reviewers separated user purpose from observed progress. Actual QQ can update progress but cannot rewrite user intent or reopen a closed topic.
- The live synthetic replay found a parser/store mismatch: private stage and unknown fields could be accepted then fail at commit without explicit observation IDs. Private task state now binds verified current user evidence; actual progress still needs observation evidence. Clear operations require a current verified actor.
- A one-turn request to discuss before drafting must not become a permanent topic constraint. A later draft request records a proposed review stage without implying that anything was sent.
- Preparation, repair and draft share source revisions and controls. Required recent complete private turns and topic grounding take priority over optional old summaries; over-budget required content fails explicitly.
- An active effective topic cannot silently fall back to a legacy draftPlan without necessary guidance. Missing controls trigger the existing single format repair. Explicitly removed controls and closed topics do not impose revoked intent. An independent reviewer checked the three new guard tests and the resume branch.
- Feedback continuation targets the exact artifact and canonical feedback, is scope-bound and idempotent, and preserves independent unsent input. Recording feedback alone still makes no model call.

## Evidence limits

Ordinary red-to-green functional tests and actual isolated browser execution verify contracts. Real model calls use synthetic material and record loaded source hashes; first failures remain recorded. Independent semantic review supports only those replayed cases. Existing native helper refresh is recorded separately and never implies romantic effectiveness or QQ message sending. Credentials and actual chat records remain outside Git.
