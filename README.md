# QQ Chat Assistant

A local Ubuntu desktop companion for normal QQ conversations. It reads the selected private chat, loads accessible history, produces editable reply suggestions through the configured model, and supports copying or filling an unsent QQ draft for the human to review and send.

**Status:** installed personal MVP. The real QQ desktop bridge and history reads have executed successfully. The current chat has user-granted model consent; other account/contact/model/API combinations remain gated, and images require separate consent. Native source-window binding, draft insertion/cleanup and all 739 cached rows have been verified. Fresh live-message-to-suggestion confirmation remains open. 57 behavior, 55 mutation and 13 synthetic browser checks pass. No QQ messages are sent by the assistant.

## Use

Start `bash scripts/launch.sh`, log in normally if QQ asks, and open **✦ AI 建议** in a private chat or press **Ctrl+Shift+A** in QQ. The same helper window is reused. Enter a friend's QQ number if the current window cannot be identified. History loads automatically; export is optional. See [Chinese usage guide](docs/usage_CN.md).

The installed QQ binaries were copied into a private reversible runtime; `/opt/QQ` was not patched. The original profile is shared with normal QQ and was backed up before integration. The installed base is 3.2.31-51102; the tested auto-updated code is 3.2.33-52892 on Electron 40. QQ updates may require rechecking its internal read contracts.

## Verify

```sh
npm test
npm run test:ui
npm run check
npm run diagnose
python3 scripts/mutations.py
```

Tests use synthetic messages. Browser screenshots are labeled synthetic. Real history and credentials are under ignored, private `data/`; do not share that directory. The documentation archive excludes it.

## Architecture

`plugin/` integrates the QQ UI and enforces a two-route read-only QQ IPC allowlist. `src/` contains the scoped SQLite store, model projection, consent gate and loopback server. `ui/` is the companion window. The native adapter observes emitted message updates; outgoing records are accepted only after successful sending by QQ. Copying and draft filling never create a sent record. Draft filling checks the live private peer and account, preserves existing text, and exposes no send operation.

An explicit consent record binds model access to the selected QQ account/contact, model and API base URL. Closing the helper pauses automatic model generation. No arbitrary QQ dispatch or send API is exposed.
