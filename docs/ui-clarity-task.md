# Conversation-first interface

Goal: Make the relationship assistant's everyday discussion and optional expression flow clear in the actual narrow desktop window.
Invariant: Preserve scoped context, model consent, history, private inputs and draft provenance.
Invariant: Manual QQ sending only; no model or QQ writes for synthetic verification.
Invariant: Keep every existing capability accessible through purpose-specific surfaces.
Scope: Reorganize the UI, navigation and tests; do not change the relationship/memory pipeline.
Acceptance basis: Current ui/index.html/app.js consumers, the running helper, and the existing 31 synthetic browser checks.

## Acceptance

- [x] The default 370px and 480px views expose a private composer without page scrolling.
- [x] Contact identity is always visible; connection/model configuration does not crowd daily conversation.
- [x] QQ history and relationship memory have dedicated, keyboard-accessible navigation.
- [x] Reply adoption opens an editable draft; closing it returns to the conversation without losing edits.
- [x] Notes, source search, confirmations, feedback, model settings and reply focus remain accessible.
- [x] Switching contacts clears stale scoped UI and never mixes inputs or drafts.
- [x] Actual pointer-based browser checks and visual inspection verify the new flow.
- [x] Verified changes are integrated and loaded in the desktop helper with user data and unsent inputs preserved.

## Decisions

- Use three workspace tabs (discussion, QQ history, relationship memory), a separate draft dialog and one settings dialog. The conversational input remains the primary entry; optional help actions do not impose a fixed workflow.
- Existing backend contracts and source-shaped fixtures remain unchanged. Ordinary functional and browser tests provide relevant evidence; mutation checks are unnecessary for this layout change.

- Independent review found hidden settings errors and memory-result actions overwriting unsent private text. Settings errors are now shown inside the modal, and selected background is appended to the existing thought. Dialogs have accessible names; the main composer exposes one compact QQ excerpt.
- The sandbox disallows loopback test servers (listen EPERM). The same functional suite passed outside that network sandbox: 155/155, no real model calls.

- Pointer testing reproduced a material selector overlaying the input at 370x560. Its positioning container is now the entire composer, keeping the open selector above the input. The compact QQ excerpt uses the fresh state snapshot rather than the older history export cache.
- The native UI-only reload helper now captures a scoped temporary recovery snapshot, refuses pending settings/contact/request states, and verifies restoration before deleting it. Synthetic browser verification is required before using it on the desktop.

- Final candidate verification: all 155 functional tests and 40 pointer-based synthetic browser checks pass. Reload tests include unchanged configuration, exact scope and unsaved input hashes after a further poll. Screenshots at 370x560 and 480x900 were visually inspected.

- Integrated source commit 4259564 into main and refreshed the actual Electron helper without restarting QQ or its service. At 482x891 the composer is fully visible, only the discussion panel is visible and the page does not overflow. All 747 QQ records, current goal/contact and unsent input hashes remain unchanged. The first refresh attempt correctly waited for an existing request to finish.
