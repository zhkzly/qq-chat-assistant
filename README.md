# QQ Chat Assistant

A local Ubuntu desktop companion for normal QQ conversations. It reads the selected private chat, loads accessible history, and provides a persistent private assistant conversation for thinking through what to do, responding, sharing personal material and reviewing actual interaction. Optional drafts can be copied or filled into an unsent QQ input for the human to review and send.

**Status:** the relationship-context implementation is verified with source-shaped functional tests and synthetic browser execution. This update has not been deployed into or tested against a live QQ session. Earlier desktop evidence for the existing bridge is recorded in historical verification documents and is not evidence for this new flow. No QQ messages are sent by the assistant.

The context flow keeps account/contact-scoped private turns, an explicit user goal, editable material permissions, one source-backed working state, actual request manifests and local feedback. Drafting gets a restricted input after selecting the intended expression. Interpreting mixed private/shareable language still depends on the model; review the draft before using it. See [context design and limits](docs/context-management_CN.md).

## Use

Start `bash scripts/launch.sh`, log in normally if QQ asks, and open **✦ AI 建议** in a private chat or press **Ctrl+Shift+A** in QQ. The same helper window is reused. Enter a friend's QQ number if the current window cannot be identified. History loads automatically; export is optional. See [Chinese usage guide](docs/usage_CN.md).

The installed QQ binaries were copied into a private reversible runtime; `/opt/QQ` was not patched. The original profile is shared with normal QQ and was backed up before integration. The installed base is 3.2.31-51102; the tested auto-updated code is 3.2.33-52892 on Electron 40. QQ updates may require rechecking its internal read contracts.

## Verify

```sh
npm test
npm run test:ui
npm run test:assistant-ui
npm run check
npm run diagnose
```

Tests use synthetic messages. Browser screenshots are labeled synthetic. Real history and credentials are under ignored, private `data/`; do not share that directory. The documentation archive excludes it.

Mutation checks are optional when useful, not a normal prerequisite. Both browser checks use isolated temporary Chrome profiles; their results do not prove native integration or relationship outcomes.

## Architecture

`plugin/` integrates the QQ UI and enforces a two-route read-only QQ IPC allowlist. `src/` contains the scoped SQLite store, model projection, consent gate and loopback server. `ui/` is the companion window. The native adapter observes emitted message updates; outgoing records are accepted only after successful sending by QQ. Copying and draft filling never create a sent record. Draft filling checks the live private peer and account, preserves existing text, and exposes no send operation.

An explicit consent record binds model access to the selected QQ account/contact, model and API base URL. Closing the helper pauses automatic model generation. No arbitrary QQ dispatch or send API is exposed.
