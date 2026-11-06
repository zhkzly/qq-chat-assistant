# Replay observer correction

Goal: distinguish an optional compaction rejection from failure of its owning foreground request.
Invariant: retain the original adapter rejection and provider trace.
Invariant: await compaction and continue to surface terminal foreground and memory failures.
Invariant: preserve all prior runs; corrected observations receive a new runtime identity.
Out of scope: product behavior, dataset changes, retrospective replacement of actual outputs.
Evidence: baseline-stream-challenges/stream-discussion-explicit-recall.run.json terminal trace 334 records compaction rejection; trace 363 records HTTP 200 and a complete published answer.

## Decisions

The controller catches optional compaction errors and explicitly continues with deterministic context. The replay wrapper must delegate terminal outcome to the controller while retaining the nested rejection. A synthetic actual-transport regression will exercise this path; genuine foreground failure remains a negative control. Mutation checks are unnecessary for this reversible observer correction under the user's current preference.
