# Independent checkpoint replay

Cases freeze an observed conversational prefix, a cutoff, an ordinary user goal,
and subsequent external inputs. They do not define the assistant's memory schema,
retrieval implementation, prompts, tool count or expected internal call sequence.
Each implementation reconstructs its own state from the same raw prefix. Never
copy a previous implementation's derived memory into a candidate evaluation.

## Boundaries

- `eval-replay-plan.cjs` compiles observable inputs and keeps expected understanding
  and behavioral criteria in a reviewer-only section.
- `eval-replay.cjs` runs the portable adapter protocol. It imports no product code.
- `eval-replay-cli.cjs` binds case, policy, rubric, harness and adapter identities
  and saves outputs. It requires an explicit adapter and never assigns ratings.
- `eval-qq-adapter.cjs` and `eval-runtime-session.cjs` are the replaceable boundary
  for the current product. They alone know its APIs, storage and module layout.

A new architecture needs its own adapter, not a rewritten behavioral dataset.
Internal traces are optional attribution evidence. A tool call or memory record
count is not a behavioral success criterion.

## Adapter protocol v1

An adapter factory exports `createAdapterFactory(options)` and returns an object
with `create()` for a new isolated episode. An episode exposes:

| Method | Meaning |
| --- | --- |
| `open(initial, {goal})` | Prepare this implementation from the observed raw prefix; do not regenerate archived assistant messages. |
| `advanceTo(iso)` | Advance scenario time and finish work due before that point. |
| `observe(events)` | Receive externally authored QQ messages, including actual human sends. |
| `observePrivate(events)` | Process additional user inputs; return any actual intermediate assistant outputs. Never insert authored new assistant answers. |
| `respond(request)` | Return the actual answer; an optional `reference.reply_id` binds an actually observed earlier answer. |
| `configure({automatic?, goal?})` | Optional explicit user controls, including a changed long-term purpose. |
| `withdrawSources(events)` | Apply observed source deletion, exclusion or QQ recall, without executing any real QQ message action. |
| `drainOutputs()` | Return newly generated observable outputs, including automatic advice preceding a manual request. |
| `currentOutput()` | Return the currently displayed candidate, or null. |
| `diagnostics()` | Optional versioned internal evidence; errors do not determine conversational quality. |
| `close()` | Release episode resources. |

Set `protocol_version: 1`. Output shape is `{reply_id?, text, suggestions:[{text}],
disposition, options?:[{label}], notices?:[{text}], references?:[{label,text}]}` where disposition is draft, discussion, clarification, wait or
unavailable. Implement automatic observation methods when evaluating automatic
behavior. Optional diagnostics cannot substitute for observable outputs.

## Running

```bash
npm run eval:check
npm run eval:replay:list
# Synthetic transport: actual product integration, no semantic evidence.
npm run eval:replay -- --id conv-reconnect-known-anchor --out /tmp/qq-replay-example
# Explicit real selected model; global cap includes preparation, repairs and maintenance.
npm run eval:replay -- --id conv-reconnect-known-anchor --live --max-http 12 --out /tmp/qq-replay-live
```

Use a new output directory. The CLI defaults to inventory without case selection.
Use `--source-root` for a different product checkout, or invoke the independent
CLI with `--adapter /path/to/another-adapter.cjs`. Compare the same case/policy/
rubric under declared model and resource conditions. No automatic optimization
or Codex Goal is started.

The current product adapter uses isolated SQLite, actual bind/history/live
normalization, actual localhost API routes, actual model adapters and persistent
per-episode state. Only the QQ native boundary is fictional. Prefix preparation
uses controlled memory-maintenance checkpoints to build this implementation's
derived records; this is not proof of automatic maintenance scheduling. Later
events exercise normal scheduling. Preparation calls count toward the HTTP cap.
Historical private context is explicitly archived; live assistant replies are
never replaced. No real QQ process, user database or settings is modified.

Use `--continue-on-case-error` explicitly to retain an independent case failure and continue a batch. The default stops; the global HTTP cap is always respected. Missing steps and cases remain recorded, and a batch with any execution failure stays incomplete.

## Evidence and review

`*.run.json` contains actual external inputs, outputs, optional internal traces
and failure details. `*.review.json` contains observable results and criteria,
without the internal diagnostics. `transport.json` preserves actual requests and
responses, and `manifest.json` binds identities and unfinished cases. All review
forms start ungraded. An execution result is not a quality verdict.

The original 18 cases remain unchanged. `replay/legacy-adaptations.json` explicitly
records corrected ordinary goals and independent instructions for authored
feedback that would otherwise assume a particular generated answer. Original
texts remain available to the reviewer. Never silently adapt a case to help a
particular implementation. Unbound response-dependent feedback is not delivered
and is reported as not replayed. The coverage supplements add emotional disclosure, warmth, repair, low reciprocation, source withdrawal, goal changes, actual-answer feedback and long private histories; see [coverage](COVERAGE_CN.md).

The frozen prefix is the evidence available at the checkpoint, not simply all
current database rows with old message timestamps. Current data may have later
edits, recalls, exclusions or deletions. Without a preserved version, a historical
state cannot be reconstructed with certainty. Store the authorized raw snapshot
separately; keep real records out of Git. Existing fixtures are fictional.

Fixed contact continuations are external test conditions. They do not establish
adoption of a generated message, causal responses or improved relationships.
This is synthetic-boundary product integration, never desktop QQ integration.

Rebuilding memory after a rewrite is separate from migrating a user's existing
production database. No cross-version memory cache is implemented here; any
future cache must bind raw-prefix identity, implementation, model/configuration,
time policy and preparation conditions.

## Policy v2 fidelity and calibration

The reader accepts frozen v1 fixtures; new observable capabilities require policy
`observed-history-replay-v2`. Authored notes retain `note_kind`, `declared_use`,
`evidence_source_ids`, original ID and time. Derived understanding stays reviewer-only.
`feedback.mode: observed_output` binds `target_step_id` to that step's actual
returned reply. Optional `target_output` selects output, observed_outputs or
intermediate_outputs with an explicit index for list channels. An unavailable
target is unreplayed rather than replaced by an authored answer. New assistant
turns cannot appear in step inputs.

`source_updates` carry original source IDs, event times, channel and delete,
exclude or recall operations. QQ recall is an observed external event, never a
request to operate real QQ. Withdrawn evidence cannot support later authored notes.
Controls, goals and references are public conversational actions, not a memory
schema or prescribed tool sequence.

The current adapter exports substantive answer content: explanation/body, labeled
wording, choices, recovery notices and expandable method/source claims. It does not
verify desktop layout, buttons or every source-catalog display. Prefix memory
progress follows committed receipts and segment cursors, not a falling source count.
Historical source restoration is distinct from normal current-time note creation.

Reviewer calibration is offline and independent of the product. `eval:judge:check`
validates anchors; `eval:judge:export` gives blinded material; `eval:judge:compare`
compares real supplied judgments with version-bound provisional references. No
command invokes a judge. See [calibration](calibration/README.md); AI references,
style disagreements and ungraded items remain explicit.
