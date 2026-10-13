# Model response failure diagnosis
Goal: Explain the reported missing answer and correct duplicate/stale model failure display, preserving the saved question and configured model.
Evidence: User screenshot and actual run show HTTP429 capacity before any answer; the saved question is present and the task failed. One minimal fictional request later returned200/OK on the same configured model.
Invariant: No QQ sending, profile/credential changes, private research export or hidden unbounded model retry.
Scope: Model errors stay in the assistant channel, copied old errors clear on a fresh attempt, UI never caches server errors as local faults; ordinary tests and safe helper activation.
No: Treating the separate explanation-with-plan parser defect as the demonstrated cause of this screenshot.

## Decisions
- Diagnose the actual 429 first. Keep the independently found explanation-suppression defect separate for a future scoped fix.
- Use ordinary functional and pointer tests; mutation checks remain optional.

- Functional tests and pointer tests prove failed request retention, one model-error banner, legacy-copy clearing, separate native read errors, preserved unsent fields and contact binding.
- The independently reproduced explanation-with-draftPlan suppression is a separate open issue; the supplied screenshot demonstrates a pre-answer HTTP429, so it was not treated as the reported cause or mixed into this fix.

- Actual helper updated without restarting QQ. The exact screenshot question was re-submitted once under current consent/current user-selected gpt-6-sol, completed with one draft candidate; both error channels clear, original nine UI input hashes and relationship goal preserved, previous game topic remains removed. No QQ messages sent. Private snapshots/results remain ignored local data.
