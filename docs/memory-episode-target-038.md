# Explicit navigation episode identity (038)

Candidate 038 is isolated in `.worktrees/memory-episode-target-038`, based on
`cb892328fd479a72a7dc1b5741534c462a08a457`. Its held backend hash is
`3f32757ba4318c3bd35dc58d7f9dcb7984e0ffdef609cd1af5abecb0e21f6658`.

The preserved main032 M3 trace offered an existing navigation episode and its
complete original evidence. The producer repeated that episode using only an old
`c#` original and omitted its offered `m#` identity. Store correctly interpreted
the result as new creation, rejected the old-only creation, and retained atomic
batch/journal progress. Adding only the existing canonical episode ID made the
same captured proposal admissible in the coordinator's zero-HTTP Store probe.
The former prompt taught `{id?}`, and the native schema omitted the creation
rule. This candidate aligns that producer/decoder contract with existing admission.

## Product behavior

Every native episode selects `id: "NEW"` or an offered writable episode `m#`.
The request-specific result schema advertises those exact choices in the initial
request and its existing single correction. If no creation or update is available,
the episode array has `maxItems: 0`. `episodes: []` remains genuine no-change.

The decoder restores a selected same-kind alias to its captured canonical ID.
It removes only the explicit NEW marker to represent actual creation. Creation
requires a nondeleted source in the reviewed current batch; old context originals
alone cannot create navigation. Semantic recovery rereads cannot create a new
navigation episode. Missing native identity, ineligible creation and read-only
targets are actionable field errors inside the existing correction allowance.
No ID is inferred from text, paraphrases, source overlap or apparent uniqueness.
The model may choose the existing target or omit the proposal; the program does
not attach an unrelated current question or discard a bad episode to commit the
rest of an otherwise rejected batch.

Complete legacy items/episodes/retire results retain their existing optional-ID
creation compatibility, with the same eligible-current-evidence requirement.
Explicit IDs remain same-kind offered targets; typed relationship records retain
their separate expectedVersion/transition semantics and old-original allowance.
The legacy field lists and typed records are not conflated. Native items remain
unadvertised. The existing captured transition test's scripted producer explicitly
marks its eligible navigation creations NEW; its preserved capture JSON is unchanged.

Only `src/memory-engine.cjs` and `src/model-response-format.cjs` change product
behavior. Store, controller, scheduler and evidence guards are unchanged. The
memory prompt/wire version is now `evidence-backed-understanding-2026-11-01.1` and
participates in the existing batch fingerprint; no unrelated cache was bumped.

## Executed evidence

The new fixture is derived from the complete fictional main032 M3 trace. It binds
the source run SHA256 and preserves initial and rejected wire responses, canonical
batches, source IDs, original times, revisions and Store receipts. The test rebuilds
the original initial batch/receipt and rejected batch exactly before exercising
the new decoder. It does not contain behavioral ratings or prepared understanding.

| Check | Actual result |
| --- | --- |
| Pre-change identity regression | 6 failed / 7 passed; RED retained |
| Expanded episode contracts | 16/16 passed, exit 0 |
| Focused memory and related functional checks | 16 files, 218/218 passed, exit 0 |
| Application JavaScript syntax | Passed, exit 0 |
| Dataset check | Original 18 cases/34 steps valid, exit 0 |
| Diff/protected-path checks | Passed, exit 0 |

Tests cover initial/correction schema equality, explicit target decoding,
current creation, legacy creation, old-only rejection, one bounded repair,
unchanged atomic progress after repeated invalid proposals, no-change, actual
semantic-recovery no-decision, and explicit negative/correction provenance.
Wrong kind, unoffered and read-only targets, missing originals, changed revision,
changed body, foreign scope and withdrawal remain rejected. Existing typed
transition, CAS, retirement, migration, preference and evidence-offer checks pass.

A file-backed database rebuilt from the actual baseline failure was closed and
reopened. Its pending journal and diagnostic error did not suppress the new request;
selecting the offered target then succeeded, retained one episode, cleared the
error, and preserved raw source IDs/times/revisions. Withdrawal was checked as a
separate atomic-admission countercase. The persisted error is diagnostic only;
controller failure counts and retry cooldown are process-local. This does not
prove automatic retry in an already running old process. Existing scheduling and
per-task call limits remain applicable.

Initial fixture-clock/lifecycle mistakes and an initial focused failure from two
old scripted native episode producers are retained in `.goal-runs/engineering-038/`.
Their corrections changed test plumbing or explicit producer markers, not raw
captures, Store guards or frozen criteria. Final checks are recorded separately.

## Limits and handoff

Selector validity does not establish semantic identity, novelty, entailment or
relevance. An arbitrary current citation is still only structural membership;
the program cannot prove it supports the episode. A model may still choose the
wrong target or produce false facts. The candidate adds no semantic critic,
automatic identity fill, new model calls or scheduler retry loop.

The complete 38-case/81-step conversation dataset remains unchanged, with hash
`d7890b62c8c92e7e496d631ca8f2c255bd6871380d779e194fbb85125a0e7aa0`.
The public memory observer and its frozen V4 cases are unchanged. These are
source/functional and scripted integration checks; there are no live/provider
calls, semantic ratings, desktop QQ tests, commits or activation from this task.
The coordinator owns full checks, public memory observations and independent
actual-output evaluation. Contract checks alone do not establish Goal completion.

Complete files, hashes and logs are in `.goal-runs/engineering-038/`; product
source is held for coordinator review and execution.
