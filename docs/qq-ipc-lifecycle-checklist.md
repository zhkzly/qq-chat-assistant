# Acceptance
- [x] Live readiness/cause distinguishes logged-in account from available read context without exposing private content.
- [x] A destroyed/renderer-replaced recent sender can fall back only to a still-live authenticated original captured context.
- [x] All-stale or unauthenticated contexts remain unavailable; no synthetic sender/header substitution.
- [x] Pending callbacks are sender/account/session bound; wrong sender ignored, session reset/destroy/failure cleans promptly.
- [x] Same-account duplicate notifications preserve valid reads while genuine logout/relogin invalidates old sessions.
- [x] Account/contact/UID string and two-read-route boundaries remain enforced.
- [x] Readiness loss/restoration is observable without clearing selected contact, goals or unsent input.
- [x] Source-shaped tests and actual native latest/older history succeed, with original records preserved and no QQ sending/restart.
- [x] Candidate is reviewed and installed only in the owned plugin/runtime, with rollback and evidence.
