# Manual review delivery 031

This candidate changes the authority of semantic review in the manual-copy QQ
assistant. It does not change raw history, evaluation criteria, the selected
model, the initial context compiler, the request budget, or the QQ send boundary.

## Observed problem

The selected-model 030 runs included useful primary suggestions rejected by a
fallible semantic reviewer. A long-case initial request was already within the
64,000-byte limit; the later audit-triggered regeneration wrapper exceeded that
limit. The first request compiler was not the cause. Candidate 031 removes that
consumer: semantic review no longer automatically vetoes or regenerates help.
It does not add another classifier or model to decide which criticisms are true.

## Execution and authority

1. The selected model produces a complete primary answer.
2. Program-owned material references, account/contact, excluded/withdrawn
   sources, source revisions, artifacts and cancellation remain hard checks.
3. The existing sparse semantic reviewer reads the candidate and supplied
   originals. Its normalized findings are retained as a second opinion.
4. The original candidate is delivered with private review findings beside the
   affected reference. A user can request a revision through ordinary feedback.
5. Source and artifact checks run again at atomic publication. Semantic feedback
   never buys a new provider request or substitutes a new candidate.

This removes automatic semantic-regeneration calls. It does not disable primary
structural repair or turn incomplete source/material admission into permission.
A warning does not make fabricated or inappropriate primary text good: actual
outputs still need independent behavioral evaluation.

## Public review representation

The existing `semanticReview` metadata retains its frame hashes and
`exhaustive:false`. It adds a `findings` list:

```
{
  status: "reviewed" | "incomplete",
  candidateHash,
  bindingHash,
  exhaustive: false,
  findings: [{
    kind: "reported_defect" | "concern",
    path,
    quote?,
    code,
    reason,
    evidence?: [{ sourceId, quote, revision }]
  }]
}
```

`reviewed` means a review was received, not that the answer is verified or
correct. The UI shows `核对提示（模型意见，可能有误）`, a disputed candidate quote and
reason, plus optional original witnesses under `核对引用的原话`. Findings are
private UI content outside the suggestion text. Adoption and clipboard actions
use only the original editable message. They never become actual QQ sends.

An unavailable or incomplete review uses the distinct notice:
`建议已生成；本次内容核对未完成，采用前请确认具体事实和私下信息。`

Public finding projection is best effort. It normalizes bounded strings before
Store consumption, trims before truncating, isolates unusable optional metadata
and preserves valid neighboring findings. Invalid metadata marks the review
incomplete rather than preventing help. This isolation does not wrap or suppress
source-version, candidate binding, account/contact, artifact or cancellation
failures. Store still validates scoped source witnesses atomically.

## Private copies and lifecycle

Review quotes and evidence are private content with dependencies. Witness IDs
join the generated turn's source dependencies. Source changes clear related
retained finding copies. Source forgetting also invalidates generated artifacts
and adopted drafts through the existing lifecycle. Direct leaf withdrawal clears
its finding copies while leaving original human records and independent sibling
artifacts intact. Public projections additionally require still-visible matching
candidate fields and current original witnesses. Review metadata is not a new
long-term factual memory or a successful action receipt.

## Missing personal material

One short fictional format example replaces redundant prose in the shared
real-material rule. It demonstrates an evidence-based QQ response plus a single
private question when the user wants to share themselves but has not supplied a
real detail. It contains no case IDs or plant facts, and explicitly is not a
factual source. Known material should be used without asking again. The prompt's
existing length guard still passes.

## Known limits and evidence

- Primary output and semantic review can both be wrong. There is no zero-leak,
  relationship-outcome, naturalness or factual-certification guarantee.
- Mechanical material admission validates declared selections; it does not prove
  every generated word comes only from those selections. Warnings are for human
  judgment, and bad primary text remains a behavioral failure.
- Preparing the audit frame can still fail with `fidelity_context_budget` when
  required originals plus candidate exceed the audit request limit. That happens
  before the optional review invocation and is not covered by its incomplete
  fallback. It was not the observed initial compiler defect in the retained
  030 long-case run. Further context-capacity work remains outside this change.
- Earlier census decoding and restoration helpers remain explicit historical
  compatibility tests. The native controller no longer invokes semantic
  candidate regeneration.
- Functional, mock-transport and synthetic browser/replay results do not prove
  conversational quality or desktop QQ integration. Selected-model actual
  replay and independent review belong to the coordinator.

Held backend identity:
`eff43e25724070a653bd90e1ace4642193b2f82d07ef1cd95c14777b91223ff3`.
The source-only first hold `445c7431e16470b92a8815907072b3623d549001e5ed4aa2fa34c27a3b960da2`
was superseded before any candidate SUT call. An independent source review found
optional advisory codes/reasons that could pass into Store as blank strings.
Native wire red probes reproduced the class; total best-effort projection and
normalization fixed it before the held source was replayed.

Final engineering results:

- Full functional collector: 179 files, 1,629 assertions, all passed with no
  skips/cancellations; all source/UI/scripts/fixture hashes unchanged during the
  complete run. Report: `.implementation-checks/manual-review-delivery-031/full-functional-final/summary.json`.
- Native Controller/Store/assistModel probes: 22/22, including intentionally
  wrong criticism, genuinely bad primary output, unavailable review, malformed
  advisory metadata, source/account/contact/cancellation boundaries, actual
  source forgetting/editing and leaf withdrawal, adopted draft cleanup.
- Full synthetic replay: 38 cases / 81 steps, 259 fixture HTTP calls, exit 0,
  at `/tmp/qq-031-full-synthetic-final`; zero paid/provider/real QQ calls.
- `npm run check` and `git diff --check`: exit 0.
- Prompt/schema checks: 9/9. Frozen replay inventory remains 38 cases / 81 steps,
  dataset hash `d7890b62c8c92e7e496d631ca8f2c255bd6871380d779e194fbb85125a0e7aa0`.

The initial complete collector retained obsolete automatic-veto contract
failures; they were updated to the explicitly authorized manual-review policy.
Raw cases, criteria, rubric and independent reviewer references were unchanged.
No model call, semantic self-grade, production DB write, commit, merge, QQ
restart or activation was performed by this implementation task.

## Coordinator actual-run limitation reported after source hold

The coordinator reported that actual comparison 070 did not reach the foreground
answer for the first long-private-consultation step: its existing compaction
adapter rejected a `quoteRefs.text` value because it was not a continuous literal
span. The second step therefore remained unexecuted. Both closed-topic steps
were delivered. This is a separate pre-existing compaction-proof fragility,
not the 031 semantic-review producer, pre-frame audit budget or removed
regeneration wrapper. The failed raw case and missing continuation remain
retained; this note does not grade outputs or accept the round or Goal.
