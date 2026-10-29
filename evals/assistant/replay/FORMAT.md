# Observed-history replay fixtures

Contract: compile existing fictional cases into implementation-independent observed histories and incremental inputs. Preserve every available raw event and original string ID. Keep derived understandings and judging criteria reviewer-only. Never call a model, import product code, regenerate archived replies or manufacture actual assistant turns. The existing `conversation.jsonl` and `context-memory.jsonl` are the legacy source artifacts; their meanings and evidence limits remain applicable.

Acceptance checks: preserve prefix/step chronology and source identity; reject future events; retain archived assistant context as archived; keep reviewer criteria out of runtime observations; preserve the ordinary goal unless a checked per-case adaptation declares a change; guard response-dependent feedback; retain complete long fixtures; support observe-only events and the user's automatic setting; load every legacy/native plan; report malformed rows and duplicate identities.

These are synthetic development fixtures, not recorded real chats or unseen tests. No model execution or conversational quality review has been performed by the compiler tests.

## API

`scripts/eval-replay-plan.cjs` exports:

- `buildReplayPlan(case, {goalOverride, requestOverrides})`: compile one legacy case without flattening its steps. No adaptation is implicit in this function.
- `validateReplayPlan(plan)`: return structural/chronology errors, or `[]`.
- `loadReplayPlans({datasetDir, replayDir, includeLegacy=true, applyLegacyAdaptations=true})`: return `{plans, datasetHash, policyVersion, files}`. The loader explicitly applies the versioned `legacy-adaptations.json` map when enabled; it never rewrites the original shards.
- `REPLAY_POLICY_VERSION`: the compiler policy version.

Each JSONL row in this directory is a complete native plan with `schema_version:1`, `policy_version`, `id`, `source_kind:"event_fixture"`, `goal_type`, `runtime_goal`, `initial`, `steps`, `adaptations`, `reviewer_only` and `limitations`.

`initial.as_of` is the observation cutoff. All `initial.qq_events` and `initial.private_events` are available at or before this time, in chronological order within each channel. This is the complete supplied prefix, not a prompt assembled for one implementation. Preserve all events: the compiler does not truncate histories to a recent window. Each implementation starts afresh from this same observed prefix and produces its own state. A previous implementation's stored memory is not an input.

QQ events contain `{id, at, speaker:"self"|"contact", text, provenance:"authored_external_qq"}`. Private events contain `{id, at, role:"user"|"assistant", text, provenance:"archived_context"|"authored_user_note"}`. Archived assistant messages are historical observations supplied once, never answers expected from the new run and never regenerated. Legacy material/preference notes become authored user notes with their declared `discussion`/`draft` use retained; derived understanding notes remain under `reviewer_only.excluded_understandings`.

Each step contains `{id, as_of, qq_events, private_events, request, feedback}` and optional `user_controls:{automatic:boolean}`. `request` is either `{id, at, text}`, dated at the step time, or `null` for an observe-only step. Only new external observations appear in each step. Actual assistant responses and prior executed requests stay in the session; they are never copied from fixtures or re-injected by the compiler. No plan field specifies a controller, memory representation, prompt, retrieval action, tool call or model-call count.

The optional automatic control records a user-visible setting. Observe-only incoming and actually-sent messages allow a system adapter to expose its own resulting visible state. They do not prescribe an internal callback or force a particular generation schedule. The runner must record whether it actually observed outputs and which external event they followed.

## Fixed continuations and feedback

Fixed future QQ messages are new authored external observations. A `self` event records a scripted human-send condition, independent of the assistant's real candidate. A contact event is not a simulated person's reaction to a new candidate. Preserve the real assistant output even when it differs from the scripted self message. Evaluate how the assistant handles the supplied history; do not infer adoption, causal reply quality or real relationship progress from these continuations.

`feedback.mode:"requires_observed_output"` marks response-relative instructions. A runner must bind them to an actually observed assistant output before applying them; otherwise report them as not replayed. The conservative text detector is a guard, not a semantic quality judge. Stable, per-case adaptations may replace relative criticism with an independently valid current instruction; each records `version`, matching `original_text`, `replacement_text` and `reason` under `adaptations`. The original source text remains available for review. Adaptations cannot vary by implementation or be silently chosen after seeing a candidate's answer.

`legacy-adaptations.json` also removes diagnostic language from selected goals while preserving their ordinary purpose. There is no goal-type-wide replacement and no default romantic purpose. Exact source-text matching makes stale adaptations an error. Reviewers receive original goals, case criteria and excluded understandings; the system adapter receives only observable history, current goal, current inputs and user controls. Diagnostics may be collected separately and do not determine conversational quality.

## Frozen native episodes

- `replay-mixed-history-reciprocity`: a long, mixed everyday history, an open continuation request, independent local correction and external send/response updates. Positive criteria include truthful reciprocal sharing and responsiveness rather than merely asking another factual question.
- `replay-job-change-later-recall`: raw old/new job evidence, intervening conversation and a later request. No prepared understanding or expected internal memory is supplied.
- `replay-incoming-then-human-send`: an explicit automatic setting, incoming observation, independent human send and subsequent manual request. Review visible freshness and usefulness; do not count model calls as a quality score.

## Decisions

The observer cutoff is explicit and checked against every prefix event. Native fixtures use the same portable observations as legacy plans. Archived assistant context is retained because it was already observed; new assistant outputs remain solely runtime evidence. Ordinary tests cover these boundaries; no mutation check or paid model run is necessary for this data compiler.
