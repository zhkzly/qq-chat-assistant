# Assistant development dataset

This is a reusable, project-local **fictional development/regression dataset**.
It is not a prompt library, an unseen benchmark, a product memory store, or an
automatically graded quality report. Case goals vary: relationship, friendship,
support, work and learning. No real conversations or credentials are included.

- `conversation.jsonl`: starting and continuing conversations, self-sharing,
  explicit invitations versus exploring interest, and non-romantic help.
- `context-memory.jsonl`: private corrections, authored actual sends, dated
  understandings, changed facts, scoped preferences, quotations and uncertainty.
- `rubric.json`: shared review dimensions, rating meanings and hard failures.
- `FORMAT.md`: the data format and chronology/source rules.

Each line is one case; a case may contain several incremental steps. Each step
has its own current request, new observations and behavioral acceptance criteria.
Criteria permit multiple useful answers rather than one exact gold sentence.
The `contrast_group` joins scenarios whose context or goal changes the appropriate
help. All cases have been visible to their authors and reviewers.

## Commands

Run from the repository root:

```bash
npm run eval:check
npm run eval:list
npm run --silent eval:case -- --id conv-reconnect-known-anchor --step s1 --view model
npm run --silent eval:case -- --id conv-reconnect-known-anchor --step s1 --view review
```

The silent flag keeps npm's banner out of machine-readable exports. The equivalent
entry point is `node scripts/eval-dataset.cjs check|list|show`. `show` accepts
`--id`, optional `--step`, and `--view model|review`; `--dir` selects another
directory with JSONL shards and a rubric. There is no inference or `--live` mode.

`check` validates fields, IDs, calendar times, replay order, original evidence
references, and the shared rubric. It produces a content hash and explicitly
reports `semantic_evaluation: not_run`. It does not decide whether wording is
natural or the goal has been advanced.

`model` exports only the supplied goal, available messages, private context,
notes and current request at that step. It omits case IDs, tags, contrast labels,
expected behavior and rubric. Private context is planning context, not automatic
permission to put its contents into an outbound message.

`review` includes the same input, step criteria and rubric, plus an **ungraded**
review form. Bind it to the actual assistant response, trace and implementation
version before completing ratings. A rubric rating is not an observed result.

## Reuse during development

1. Validate the dataset and record its hash plus the rubric version.
2. Select the cases affected by the proposed behavior change. Keep meaningful
   counterexamples, including legitimate direct invitations and other goals.
3. Run baseline and candidate under the same declared model and time conditions
   using a separately authorized runtime runner. Preserve what was actually
   loaded, the responses, failures and implementation versions.
4. Give a separate reviewer the full situation, real outputs and criteria.
   Keep case-specific criteria out of the assistant's own input. Record concrete
   evidence and disagreements rather than relying on a total score.
5. Compare usefulness, facts, current meaning and continuity. Recheck the broader
   set when the affected behavior expands. Never relabel data validation as a
   quality improvement or discard failures merely because they are inconvenient.

The inspection exporter remains separate from actual agent evaluation. Use the
independent checkpoint replay in [REPLAY.md](REPLAY.md) to drive the product via
its replaceable adapter. `eval:case --view model` is not the replay execution
path. The older `goal-help-quality-check.cjs` uses different fixed-goal JS fixtures
and is not the runner for this dataset.

## Evidence limits and maintenance

A fixed outgoing message or contact continuation is an authored test condition.
It need not equal a generated candidate and is not proof that the user adopted
it, that a real contact replied, or that a relationship improved. The exported
later steps include authored updates and prior user requests; they do not
fabricate unseen generated assistant turns or prove runtime memory persisted.
The checkpoint runner retains its actual outputs and state within each episode.

Add new failures as fictional cases with the same causal structure. Keep original
IDs stable, preserve source dates and review boundaries, and rerun the checker.
Changing case content changes the dataset hash. Record why a criterion changes;
compare old and new implementations against the same corrected data rather than
silently improving a score by relaxing the test. Create separate independently
authored final-acceptance cases later; none are called held-out here.
