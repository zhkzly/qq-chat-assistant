# Acceptance checklist

- [x] An unavailable helper requests a visible, actionable error from desktop startup (synthetic fake-dialog consumer check; installed zenity verified).
- [x] The error contains no private launch token, model keys or chat text (error projection checks).
- [x] Activation has a bounded wait; a stale helper URL cannot hang startup indefinitely (real local HTTP timeout fixture).
- [x] Activation succeeds against an existing loopback service without changing scope (synthetic local HTTP service).
- [x] Starting the local runtime explicitly requests the assistant window after readiness (shell consumer and delayed-worker tests).
- [x] Ordinary QQ is never killed or restarted by the launcher (negative consumer check and source review).
- [x] Existing runtime startup without the explicit open flag keeps its prior behavior (plugin fixture).
- [x] Functional tests and syntax checks pass; successful real desktop reopening remains pending safe exit from ordinary QQ.
