# New-primary settings in the existing round workflow

`scripts/goal-round.cjs` remains the single coordinator CLI. It dispatches stages
with `dataset_setting: stream` or `component` to `goal-round-settings.cjs`;
legacy checkpoint/regression stages retain their native implementation.
Neither branch runs a provider or assigns a conversational grade.

The new Goal is separate from `goals/assistant-improvement`. Its stage declares
`dataset_file`, `target_cases` and `guardrail_cases`. Complete contrast families
are selected by default. A prepare freezes the exact data, runtime/model input,
review rubric/semantic contract, roles and HTTP condition before implementation.

## Assessment before a change

```bash
node scripts/goal-round.cjs prepare \
  --goal-dir goals/context-memory-evaluation-20261105/versions/initial-primary \
  --id new-stream-assessment --stage new_stream --assessment --unlimited-http \
  --hypothesis 'Assess current actual behavior before selecting a causal change.' \
  --out .goal-runs/context-memory-20261105/rounds/new-stream-assessment
node scripts/goal-round.cjs attach --round <round> --variant baseline \
  --replay <actual-stream-replay> --adapter ./scripts/eval-qq-adapter.cjs
node scripts/goal-round.cjs packet --round <round>
```

Assessment freezes a baseline-only condition. It can establish acceptable current
behavior without forcing an unnecessary rewrite. Comparison is the default:
both arms, a declared change, actual non-regression and a target improvement are
required. Product acceptance still belongs to the coordinator and whole Goal,
not to the integrity checker.

When a smaller whole-family assessment reuses an already executed larger batch,
prepare with `--reuse-compatible-baseline`. The dataset and all selected inputs
must match. Each shard records the full source-batch HTTP accounting as
`full_reused_source_batch_not_per_review_shard`; do not sum reused transport
receipts as new provider requests.

## Native evidence and blinded review

Stream attachment verifies empty opening, exact outer event identity/type/time,
actual raw event inputs/order, actual feedback references and completed-event
coverage. Component attachment verifies the complete controlled model input,
semantic contract and actual adapter identity. Both retain full actual run,
transport, error and preparation artifacts, checking their hashes thereafter.

The reviewer sees opaque system/case IDs and complete actual cases. Component
provisional axis expectations, source-seed metadata, implementation paths and the
coordinator's hypothesis are omitted. The common component task and semantic
contract occur once. A component reviewer binds to the inline component rubric,
not a falsely asserted installed project agent profile.

Stream events reference the one frozen external event list. Public memory is a
mechanical projection of UI-consumed text, labels, conditions, source
descriptions, time and status; hidden record histories/revision hashes are not
included. Identical projected snapshots are shared by explicit reference. This
projection is not DOM or desktop evidence. Each user request needs its own
`step_ratings`, and source evidence for that grade must precede that request in
the authored event order. Case-wide public-memory errors remain reviewable.

Reviewers receive the complete `review-packet/bundle.json` inline. They fill only
the supplied template and bind literal output/public-memory/execution evidence.
Missing execution remains insufficient or failed; a successful transport or
syntactically valid decision is not semantic acceptance.

## Relative old-data regression

Only a stage explicitly declaring `acceptance_mode: no_new_regressions` opts in.
It requires actual paired reviews and retains pre-existing bad, uncertain or
missing outcomes in `regression_findings`. New hard failures, newly missing
answers and downgraded usability block acceptance. Still-bad equivalent outcomes
are not called fixed; no target improvement is required for this guard-only
setting. The old Goal stages lack that declaration and preserve their existing
strict behavior. Missing judgments, inconclusive comparisons, changed evidence
or invalid identities still block either mode.

## Variant-specific UI source consumption

New stream packets read the relationship renderer from each attached variant's
actual `source_root/ui/app.js`. A backend-only baseline may use the explicitly
recorded main-UI fallback; that fallback must match the declared baseline Git
revision. The source bytes are copied once into the round's engineering-only
`projection-sources/<variant>.ui-app.js`. Origin path, SHA-256, fallback status,
Git verification and parsed consumer identity remain outside the blind packet.
Later checking uses the immutable copy, not a mutable origin or live main UI.

The source-derived contract captures nonempty group headings, label mappings,
the actual applicability consumer, and the first/last-evidence-date consumer.
The reported-understanding candidate shows applicability in a separate line and
renders `firstEvidenceAt` plus display-distinct `lastEvidenceAt`; the baseline
does not. Those fields appear only when supported by that variant's source.
The observer never changes claim wording, classification or applicability.
Unrecognized supported-surface shapes fail explicitly rather than adding a
semantic repair. Existing frozen packets/reviews are not reprojected.

`tests/fixtures/reported-understanding-ui-renderer.js` is a source-text excerpt
copied from the isolated candidate, with its full-UI source hash recorded. It is
parsed, never executed. Focused tests cover actual candidate headings/lines,
equal/invalid evidence clocks, source-shape refusal, origin removal after
snapshot, frozen-copy tampering and the baseline fallback.

## Offline verification

```bash
node --test tests/goal-round.test.cjs tests/goal-round-settings.test.cjs tests/eval-http-budget.test.cjs
```

These tests use real producer-shaped protocol fixtures and deliberately mock
reviewer/live declarations only to verify accounting. They do not supply any
actual semantic quality result. They cover changed raw input/event time, false
complete tails, blind isolation, per-request future-evidence rejection,
synthetic-evidence rejection, immutable reviews and explicit relative regression.
