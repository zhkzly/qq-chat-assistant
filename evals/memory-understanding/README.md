# Supplemental memory-understanding observations

These four visible fictional cases freeze raw QQ/private observations, clocks, goals and external user pauses. They are supplemental to the unchanged 38-case/81-step assistant dataset. They do not prescribe memory record shapes or provide expected profiles to the system under test.

`reviewer_only` is excluded from all SUT/model input. Only raw events, source updates, goal and request are introduced. An adapter must use actual product ingestion, normal background consolidation and public memory/answer views. Pauses represent the user waiting; they do not authorize forcing a supplied memory or treating incomplete maintenance as complete. Record native provider timing, virtual event clock, unfinished work and all HTTP attempts.

Visible memory observations must come from the actual public product view before/after the user question, with no semantic repair by the adapter. Product-specific fields/imports stay in the replaceable adapter. The same observation protocol and selected model apply to baseline and candidate. Each comparison remains capped at 16 HTTP per arm and 32 combined, including maintenance and repair.

Status: input and external review criteria only. This file does not mean the observer is implemented, any paid replay ran, the memory is accurate, or the Goal is complete. Actual memory artifacts and subsequent assistant outputs require independent blinded review. Scripted migration fixtures are separate from architecture-independent behavior cases.

Before-request pauses occur after the last introduced event and finish at the frozen request timestamp; they must not move the request past its authored `at`. After-request idle observations may advance the observation clock by the declared interval and must record it separately. Source recalls carry their own external timestamp. A timeout records unfinished work, not a successful memory observation.

## Revision 3 operational correction

Before any live semantic comparison, independent architecture review found that the original ten-second quiet interval did not make the default ten-minute scheduler idle eligible. Revision 3 moves all eight authored request timestamps fifteen minutes later on the same world dates and declares 600000ms virtual quiet windows. All original event timestamps, eight request texts, filler messages, source recalls, goals and external criteria remain unchanged. Revision 2 bytes and synthetic-only evidence are retained. No request is replaced with a memory-tab action to reduce cost.

The supplemental condition is explicit scheduled-idle observation, not frozen H identity or a desktop timing claim. Ordinary ingress and foreground actions must not preawait background work. Only the declared quiet windows give normally scheduled work a bounded native completion opportunity (65000ms); no forced maintenance API, expected profile, hidden no-op or direct model-only answer is allowed. Preserve virtual/native timing, model HTTP counts, cancellations and pending/error state. Pending at the deadline is an incomplete memory checkpoint; read the real public view and continue the fixed user request when the model cap permits, letting the product own cancellation. Core state, notes, preferences, experience and the actual person-view branch must be captured mechanically as applicable; hidden source mappings are attribution only. Public API projection is not automatically a rendered-page or native-desktop observation.

The separately frozen condition profile declares a 300000ms foreground observation safety bound, sufficient for the unchanged four-request/native-60s product limits plus overhead. This is distinct from the 65000ms idle-work observation deadline and does not change provider deadlines or quotas. Record both limits and actual elapsed time; never relabel an observer timeout as a semantic product failure.


V4 input correction (2026-10-31): runtime goals express ordinary conversation purposes only. Diagnostic goals that named tested distinctions were removed before V4 execution. All original observations, eight requests, timestamps, idle windows, and reviewer-only criteria are unchanged. V3 model runs are retained as operational debugging evidence and do not support semantic-quality claims. The V3 cases remain in the frozen 022 candidate.
