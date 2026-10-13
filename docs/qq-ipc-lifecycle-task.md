# Recover native QQ IPC after renderer lifecycle changes
Goal: Restore live scoped QQ history/observation while preserving normal QQ, original records and unsent inputs.
Invariant: Exactly the existing two read-only QQ IPC routes; no sending, forwarding, simulated send keys or /opt changes.
Invariant: Context and callbacks belong to a live sender, authenticated account and current session; no transplanting a dead sender's header onto another window.
Invariant: Keep account/contact selection and drafts; distinguish account-login readiness from native read-channel liveness.
Scope: Native transport candidate lifecycle and pending cleanup, truthful readiness and reviewable in-place application.
Gold: Current live helper reports QQ IPC is not ready while account phase remains ready; hidden main sender2 exists, precreated empty chatPool sender41, no matching composer. Prior native parent continues running.

## Decisions
- The exact error branch is missing/destroyed saved transport context, not the model proxy or history database.
- Source-shaped synthetic probe reproduces temporary sender replacing the singleton and then closing despite another sender remaining live.
- Use ordinary focused/full tests and native read verification; mutation checks remain optional by user instruction.

Implementation and native recovery completed 2026-10-13; see qq-ipc-lifecycle-review.md for distinct functional, synthetic browser and actual desktop evidence.
