# Implementation decisions

- Goal: assist actual reciprocal relationship development through useful private discussion and truthful continuity; memory/cost metrics do not replace that goal.
- Baseline: formal main d45e629, independently reviewed source only; feature worktree starts at that commit. Existing model profile and reply-focus changes are preserved.
- Storage: one local SQLite companion record per authenticated four-field scope; raw sources separated from generated output. Source edits conservatively invalidate derived state and generated copies.
- Runtime: ordinary discussion is one model request; drafting first selects an expression then uses a restricted second input. No required Jev, embedding, multi-agent runtime or skill evolution.
- Validation: source-shaped functional checks, two isolated synthetic browser suites and four actual-model synthetic scenarios. Mutation checks were not needed.
- Remaining limits: semantic disclosure interpretation, provider token budget, live QQ deployment, and actual relationship outcomes remain distinct from implemented behavior.
- Integration: main is unchanged after baseline; merge-back remains pending user review, including preservation of existing untracked workflow files and coordination with any running helper server. No QQ restart or installation change occurred.
