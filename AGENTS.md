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

## Conversation behavior evaluation

- When optimizing context selection, memory understanding, consultation continuity, or suggested wording, use the project-local development dataset in `evals/assistant/`. Start with `npm run eval:check` and select relevant cases with `npm run eval:list`.
- Use `npm run eval:replay:list` and `npm run eval:replay -- --id <case-id> --out <new-directory>` for persistent product replay. The default uses synthetic transport and proves integration only; `--live` uses the selected real model with a declared global HTTP cap.
- Cases and behavioral criteria are independent of product architecture: freeze the observed raw prefix, cutoff, goal and external inputs; each implementation rebuilds its own state. Keep product imports and memory formats inside the replaceable adapter. Never give derived expected understandings or case criteria to the assistant.
- `eval:case --view model` is an inspection export, not agent evaluation. Give the separate reviewer actual replay output and `*.review.json`, and retain `*.run.json` diagnostics for attribution. Do not require particular internal tool calls or memory shapes as behavioral passing criteria.
- Structural validation is not conversational quality evaluation. Record the dataset hash, rubric version, actual model inputs/outputs and implementation version before claiming a behavior improvement. Do not fill an unrun review with passing ratings.
- These are visible fictional development/regression cases, not unseen holdouts. Retain failures and meaningful counterexamples. Inspection, validation and default replay do not start paid model runs. Explicit `--live` replay invokes the selected model under its declared cap; no command starts automatic optimization.
