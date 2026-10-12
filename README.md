# QQ Chat Assistant

A local Ubuntu desktop companion for normal QQ conversations. It reads the selected private chat, loads accessible history, and provides a persistent private assistant conversation for thinking through what to do, responding, sharing personal material and reviewing actual interaction. Optional drafts can be copied or filled into an unsent QQ input for the human to review and send.

**Status:** the complete relationship-context pipeline is merged into main and running in the existing QQ helper: all assistance entry points share scoped context, searchable long-term QQ/private history, durable incremental memory, natural-language user actions, source-backed current state, evidence-linked methods and feedback. Release and desktop verification are recorded in [the evidence record](docs/context-implementation-evidence.json).

Users can discuss goals and recent experiences naturally, continue a previous idea into a draft without copying it again, correct or forget context, and inspect what was used. Explicit user intent controls lasting goals and disclosure; uncertain operations show a concrete proposal. The assistant never sends QQ messages. See [context behavior and limits](docs/context-management_CN.md).

The window opens directly into a private discussion with a fixed composer. QQ history and relationship memory have separate tabs; API configuration lives in Settings, and adopting an expression opens an editable draft dialog. The [interface verification record](docs/ui-clarity-evidence.json) includes 40 synthetic browser checks and an actual desktop layout/reload check.

## Use

Start `bash scripts/launch.sh`, log in normally if QQ asks, and open **✦ AI 建议** in a private chat or press **Ctrl+Shift+A** in QQ. The same helper window is reused. Enter a friend's QQ number if the current window cannot be identified. History loads automatically; export is optional. See [Chinese usage guide](docs/usage_CN.md).

The installed QQ binaries were copied into a private reversible runtime; `/opt/QQ` was not patched. The original profile is shared with normal QQ and was backed up before integration. The installed base is 3.2.31-51102; the tested auto-updated code is 3.2.33-52892 on Electron 40. QQ updates may require rechecking its internal read contracts.

## Verify

```sh
npm test
npm run test:ui
npm run test:assistant-ui
npm run test:goal-replay
npm run check
npm run diagnose
```

Tests use synthetic messages. Browser screenshots are labeled synthetic. Real history and credentials are under ignored, private `data/`; do not share that directory. The documentation archive excludes it.

Mutation checks are optional when useful, not a normal prerequisite. Both browser checks use isolated temporary Chrome profiles; their results do not prove native integration or relationship outcomes.

## Architecture

`plugin/` integrates the QQ UI and enforces a two-route read-only QQ IPC allowlist. `src/` contains the scoped SQLite store, model projection, consent gate and loopback server. `ui/` is the companion window. The native adapter observes emitted message updates; outgoing records are accepted only after successful sending by QQ. Copying and draft filling never create a sent record. Draft filling checks the live private peer and account, preserves existing text, and exposes no send operation.

An explicit consent record binds model access to the selected QQ account/contact, model and API base URL. Closing the helper pauses automatic model generation. No arbitrary QQ dispatch or send API is exposed.
