# Context overflow repair
Goal: Keep private discussion usable and faithful to the current relationship purpose when history grows.
Invariant: Preserve current user input, exact intent controls, source revisions and original local history; QQ remains manual-send only.
Invariant: Enforce actual serialized request budgets and scope; no silent loss of current instructions or fabricated memory.
Scope: Diagnose and repair necessary-context growth using the smallest evidenced assembly or continuation change.
Acceptance basis: main9b5641c, user screenshot and actual zero-call preflight failure “最近完整私下讨论与当前必要内容超过上下文预算”.

## Decisions
- Ordinary red-to-green tests and private-copy compatibility checks; no mechanical mutation gate.
- Real chat, secrets and source-rich private captures remain outside Git/research archives.
- User asked whether Jev-like compaction is necessary. Verified upstream README: output compacts tool calls/results while preserving user/assistant text; it is not a direct fix for long private text. No Jev service is contacted and no new destination receives chat.
- Live source material changed during investigation; the latest isolated copy no longer reproduces the screenshot. Preserve the actual zero-HTTP failure metadata and use source-shaped boundary regressions, not an invented exact replay claim.
- Cross-review found incidental feedback objects are selected before the latest private group and cannot be evicted at that first failure gate. Move nonselected feedback behind recent discussion; protect current exact-target feedback.
- Prefer no-loss model projection of duplicate bookkeeping to automatic semantic summaries for this bounded fix; actual compression remains limited and must not be claimed as summarization.
