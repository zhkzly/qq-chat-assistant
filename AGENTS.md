# Project instructions

This is a personal Ubuntu QQ conversation assistant. The user chats normally in QQ; the assistant provides suggestions for manual copying and sending.

- Keep the primary workflow inside normal desktop QQ plus a separate assistant window.
- Automatically load accessible history and observe both incoming and actually sent messages for the selected private conversation. Never require export/import as the main workflow.
- Do not implement or expose message sending, forwarding, automatic replies, or simulated key presses to send QQ messages.
- Bind data and model requests to the authenticated account and selected contact. Discard stale results after contact changes.
- Preserve original QQ message IDs as strings. AI drafts and clipboard actions are not actual sent messages.
- Keep credentials, real chat records and exports out of Git and out of research archives.
- Do not modify the existing QQ installation during research. Prepare and verify a concrete compatibility candidate before requesting any necessary installation approval.
- Do not re-enable the previous AstrBot/NapCat automatic-reply deployment for this project.
- Comments and general project documentation are English. Language-specific `_CN.md` documents and Chinese UI strings are permitted.
- Record whether evidence is source-only, a synthetic prototype, or an actual desktop integration test. Never claim desktop integration from mockups or API documentation alone.
- Mutation-license checks are optional, not a mandatory gate. The user's latest instruction permits them only when useful; explain the purpose and use an isolated copy. Prefer ordinary functional and UI tests.
