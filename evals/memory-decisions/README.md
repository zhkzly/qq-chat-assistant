# Controlled memory-evidence relation diagnostics

This is a **component setting**, `raw-evidence-relations-v1`. It conditions a decision adapter on fixed old/new raw statements and source-availability updates. It does not execute QQ Assistant ingestion, retrieval, memory maintenance, context selection or a conversation response. It does not seed an end-to-end run with reference memories.

The initial visible development set contains **8 contrast families / 16 cases**. Every case derives from project-local fictional raw observations, with source-file SHA-256, source case/event IDs and declared adaptations. Some variants introduce newly authored counterfactual observations; they are not represented as quotations from the seed. No public benchmark has been imported in this batch. Public HaluMem, LongMemEval or other data can later supply new raw-history seeds under separately recorded versions and licenses.

## What the controlled input contains

- `as_of`: the observation cutoff, with timezone.
- `prior_evidence` and `new_evidence`: chronological original statements with IDs, statement times, channels and utterance speakers.
- `availability_updates`: already observed recall/exclusion/deletion events. They change present evidence availability, not world-event truth.
- A common task and a fixed output contract. Original IDs become opaque `s#` / `u#` aliases so family names and diagnostic IDs do not hint at the relation.

No derived memory record, expected relationship, family label, seed transformation or reviewer criterion reaches the evaluated adapter. Historical evidence bodies are explicitly controlled component input, including when an availability event later withdraws their use. That retrospective component condition must not be copied into an end-to-end prompt after source withdrawal.

The output has independent axes for proposition subject, occurrence/validity scope, nonexclusive content relationships and evidence sufficiency. `output.schema.json` owns the value vocabulary. A brief explanation and delivered evidence aliases permit inspection; optional confidence is only a model-reported hint. The diagnostic does not instruct the product to write/delete/merge a particular internal record.

All references are `provisional_ai_reference`, never human gold. Expectations may list multiple defensible values. Content labels are nonexclusive, and the CLI does **not** assign automatic semantic scores. A label such as `change_over_time` must concern described circumstances, not merely later message arrival. Before using reference labels to compare JEV and Luna, independently calibrate them against known good/bad outputs and review disputed cases.

The current references are `provisional-ai-v2`. A blind raw-data review clarified that `same_subject` compares proposition holders rather than speakers, and `time_scope` compares described events/windows rather than arrival clocks. A newly supplied date for the explicitly same event can be `same`; a withdrawal-only operation or unrelated calendar assertion can make the content axes `not_applicable`. Evidence sufficiency concerns support for characterizing the relation, **not** support for selecting which world claim is true. Two explicit incompatible reports can suffice to recognize a conflict while leaving the winner unknown.

`reference-revisions/provisional-ai-v1.json` preserves the original ungraded annotations, public contract and all raw runtime hashes. The v2 correction did not change any raw runtime stimuli and was made without inspecting live outputs. Shared explanatory contract text was explicitly revised (`content-comparison-20261105-v2`) and therefore has a new input/contract identity. Earlier frozen live runs remain attached to their original bytes; they are not silently rescored or rerun. `md-conflict-or-time` remains a disclosed composite contrast (date plus omission of an uncertainty sentence), not a pure date-only experiment.

## Offline inspection

```bash
node scripts/eval-memory-decisions.cjs --check
node scripts/eval-memory-decisions.cjs --list
node scripts/eval-memory-decisions.cjs --id md-temporary-or-stable-temporary --view model
node scripts/eval-memory-decisions.cjs --id md-temporary-or-stable-temporary --view review
```

With no case selection, the CLI only lists inventory. Check/list/export never imports even a supplied adapter. Model export is an inspection artifact, not a scored run.

## Portable adapter execution

An adapter module exports:

```js
exports.createDecisionAdapter = async ({live, maxCalls, timeoutMs, signal, setting}) => ({
  identity: {mode: 'synthetic', model: 'declared-model', provider: 'none', version: '1'},
  async decide(input, {signal}) { /* Return the actual complete decision. */ },
  async summary() { /* Optional counts/transport evidence, without secrets. */ },
  async close() {}
});
```

Run the supplied explicitly synthetic fixture into a new directory:

```bash
node scripts/eval-memory-decisions.cjs \
  --adapter ./evals/memory-decisions/synthetic-adapter.cjs \
  --id md-temporary-or-stable-temporary,md-withdrawal-or-cancel-withdrawal \
  --out /tmp/qq-component-example
```

`--all` runs the whole selected dataset; `--max-calls` bounds adapter invocations across cases. `--timeout-ms` bounds each factory/decision call and aborts the supplied signal. Failures are retained and stop the batch unless `--continue-on-case-error` is explicitly supplied. Invalid output structures retain the actual output with `output_contract_error`, not a semantic failure rating.

Live execution additionally requires `--live` and an adapter declaring `mode: live`, model and provider. The portable runner counts decision invocations, not hidden provider retries: a real adapter must separately enforce and report its global HTTP/usage cap, actual requests/responses, destination and config identity. Adapter identity is declared provenance, not proof of a network implementation. Loading a caller-supplied adapter executes that module; the protocol is not a sandbox.

### Explicit selected-settings Luna bridge

`scripts/eval-memory-decisions-luna-adapter.cjs` supplies a bounded Luna bridge. It reads the explicitly supplied settings file using the existing selected-profile resolver. It refuses a selected model whose name does not contain `luna`; it never rewrites a settings file, changes providers, selects a profile globally or accesses production conversations. The selected settings file is fingerprinted and checked for drift before each dispatch.

```bash
node scripts/eval-memory-decisions.cjs \
  --adapter ./scripts/eval-memory-decisions-luna-adapter.cjs \
  --id md-temporary-or-stable-temporary,md-withdrawal-or-cancel-withdrawal \
  --live --settings-file /absolute/path/to/explicit-luna-settings.json \
  --max-calls 2 --max-http 2 --timeout-ms 60000 \
  --out /tmp/qq-component-luna-example
```

This command performs real model requests. The bridge makes at most one HTTP attempt per decision, with no automatic retry or repair; failures consume the shared `--max-http` cap. It uses the selected plain-text / JSON-object / inert-result-tool transport mode and checks the selected complete-request byte cap. Complete provider request bodies, responses, finish reasons, usage and elapsed times are retained in `adapter-summary.json`, with API key values redacted. Invalid or truncated responses remain observable failures, not substitute answers.

The worker validated the bridge with injected fetch responses only; those adapters declare `synthetic` mode. Parent-run live pilots, if any, have separate output directories and evidence. No JEV live bridge is included or verified. A successful Luna transport proves execution, not the correctness of its judgments.

The runner writes `manifest.json`, each `*.run.json`, and a separate `*.review.json`. Inputs, actual outputs, failure codes, timings and data/contract/runner/adapter hashes are retained. Reviewer labels appear only in review artifacts; all ratings remain `null`. `adapter-summary.json` retains optional transport evidence. No automatic optimization is started.

The manifest is created before importing the adapter. Module-load errors, throwing/hanging factories and identity failures retain an incomplete first-case envelope with `input_delivery: not_dispatched`; all selected decisions remain unexecuted. A missing adapter identity is `null`. HTTP counts remain unknown (`null`) unless an adapter summary actually reports them; zero decision calls does not prove that arbitrary initialization code performed zero network requests. Partial adapters are closed under an independent bound. Initialization failures remain execution evidence, not quality failures.

## Coverage and splits

The pairs cover temporary availability versus changed preference, local versus context-limited recurring instruction, quotation holder versus utterance speaker, explicit correction versus change over time, compatible addition versus duplicate, same-time contradiction versus different dates, source withdrawal versus cancellation, and unknown versus newly reported occurrence time.

All cases are visible development material. Any later development/test split must keep complete families and shared source histories together. Sixteen labels are too few for performance or calibrated-probability claims, and a component result cannot establish useful downstream QQ assistance.

## Checks

```bash
node --test --test-isolation=none tests/eval-memory-decisions.test.cjs
```

The 19 checks cover input validity, annotation isolation, opaque evidence IDs, preservation of raw stimuli across blind reference correction, an actual nontrivial synthetic adapter invocation, output/failure retention, cancellation, CLI artifacts and live-selection mismatch. Luna bridge checks use injected fetch to cover selected settings, destination and model, request/response/usage capture, failed HTTP accounting, settings drift, inert result-tool transport and truncation. Real subprocess checks exercise both successful standalone entrypoint loading and module/factory/timeout/identity failures. These checks prove boundaries and integration, not memory quality.
