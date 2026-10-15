# Startup repair contract

Goal: opening QQ Chat Assistant either displays its window or gives an actionable visible error.
Preserve the existing QQ process, unsent inputs, settings and message records.
Use the current verified local runtime without modifying the installed QQ application.
Never send messages, disclose private launch tokens or silently restart ordinary QQ.
Scope: launcher failure visibility and explicitly requested assistant startup; no model or context changes.
Gold evidence: the installed desktop entry uses Terminal=false; live ordinary /opt/QQ/qq has no assistant environment; loopback helper currently refuses connections.

## Append-only decisions

- Repair the launcher in a worktree based on main 621ce5d. The working main contains unrelated untracked user files; leave them untouched.
- Ordinary QQ must be closed by the user or after explicit approval. Reusing stale launcher metadata cannot attach the assistant to that process.
- Use functional tests; mutation checks are unnecessary for this bounded failure path.
- Native inspection confirmed the running executable is /opt/QQ/qq with no assistant launch environment; the saved loopback helper endpoint refuses connections. Do not reinterpret the historical integration-status.json as current health.
- Full functional regression: 483 passed, zero failed. JavaScript syntax checks, bash -n and git diff --check passed. The tests use synthetic fixtures; no successful real desktop reopening is claimed.
- Independent review checked QQ preservation, bounded activation, strict loopback and redirect rejection. The machine has /usr/bin/zenity; a missing dialog utility on another machine remains outside this deployment evidence.
- Work notes are stored under docs/assistant-startup-*.md to avoid colliding with the user's existing untracked root task.md/checklist.md/DECISIONS.md.
