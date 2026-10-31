# Usable delivery recovery 029

This candidate addresses runtime delivery failures captured by the selected real
model on fictional development inputs in rounds 052–055. It changes the existing
checker and recovery path, not the dataset, rubric, account/contact workflow,
model/provider, memory writer, storage, or manual QQ send boundary.

Base: `7eb6aeb6e05a33fa505bb6fe612c19a936a5c757` (028).
Backend identity (`src/**/*.cjs` via the existing replay adapter):
`aa46f85bc9d7b3e8855118c927fbc8871491248de8d3323c7e673b3e258a425e`.
The producer/checker fidelity contract is `whole-answer-fidelity-v7`.

## Captured cause and product behavior

- Checker parse failures previously bypassed the available structural repair.
  The checker can now correct its own result once, using the same candidate,
  complete original evidence, source revisions, account/contact, version and
  captured frame. It cannot rewrite the primary answer or fetch more evidence.
  Exact candidate quotations and recognized statement kinds remain mandatory.
  Unknown `kind=commitment` is not locally aliased to `intent`: the checker must
  distinguish a newly proposed action from an existing plan or past event.
- Checker-output correction uses the existing `delivery_repair` slot shared with
  primary structural repair and whole-candidate regeneration. It adds no task
  allowance. A prior repair, cancellation or frame drift prevents another one;
  checker transport failures receive no network retry. A corrected rejection
  cannot obtain a further primary repair after spending that shared slot.
- A model privacy finding based entirely on exactly program-authorized QQ or
  admitted material cannot invent another permission requirement. Separate
  unadmitted private material and newer human restrictions remain blocking;
  admitting one fragment does not authorize another fragment of its source.
- Model judgments about subject, positive focus, interaction, or invitation
  prohibitions remain private diagnostics. The primary must still follow the
  human request. Program material exclusion, disclosure admission, withdrawal,
  account/contact and source-version fences remain mandatory. Independent output
  evaluation still assesses whether the actual answer follows the request.
- Extra `basis`, `qualification`, or `related` metadata on an `unverifiable`
  assertion is isolated before optional source decoding. The exact assertion
  remains uncertain and cannot receive publication approval.
- The initial, structural-repair and factual-regeneration prompts share the same
  real-material rule: preserve an evidence-based QQ response and ask privately
  for one actually missing personal detail. Invented busy days, vague current
  life, not having chosen a story, promises to share later, and placeholders are
  not substitutes for real self material. A single clarification is appropriate
  only when honest progress on the whole request is blocked. Existing material
  should be used without asking again.

The existing `currentFacts` instructions now explicitly include private task
facts such as a requested handoff time and items. This does not grant blanket
use of the current human statement. The captured 055 work result declared no
admitted fragments: its false QQ privacy finding is removed, while four separate
unadmitted private factual assessments remain rejected. A native functional probe
shows that narrow date/item admission works through the existing product path;
actual model selection and classification require the coordinator's live replay.

## Preserved evidence and checks

`tests/fixtures/checker-delivery-028.json` contains eight exact fictional checker
packets extracted from the immutable 028 captures, including original candidate,
evidence, roles, revisions, raw checker response, and original run/transport
SHA-256 values. It contains no rubric, expected understanding, reviewer ratings,
credentials, or real chat records. The functional tests script any corrected
checker result explicitly; those scripts do not establish model judgment quality.

Before product edits, `node tests/checker-delivery-recovery.test.cjs` produced
11 failing probes and 3 passing guards. The retained log is
`/tmp/qq-029-red-checker.log`. The final checker suite has 16 passing probes,
including single-attempt network/HTTP failure during repair. Related focused
checks cover independent privacy restrictions, unsupported past facts, qualifier
loss, concrete question premises, same-field private conditions, shared-slot
exhaustion, and account/contact/QQ/source changes during repair.

- `npm run eval:check`, `eval:list`, and `eval:replay:list`: exit 0; the frozen
  38-case/81-step replay inventory remains unchanged.
- `npm run check`: exit 0 (`/tmp/qq-029-check.log`).
- `npm test`: exit 0, 176 files / 1,582 assertions / zero failures
  (`/tmp/qq-029-full-unit-final.log`). A final added work-admission probe was then
  checked with the complete lifecycle file: 22/22 pass
  (`/tmp/qq-029-green-lifecycle-final.log`).
- The initial sandboxed full suite stopped with loopback-listener `EPERM`; the
  authorized local run above supplied the full result. The first unrestricted
  run exposed two obsolete no-checker-repair assertions; their functional
  expectations now preserve failure after one bounded correction.
- Default synthetic replay in `/tmp/qq-029-focused-synthetic-local` consumed its
  global 16-request cap after three cases/five steps. Four cases are unexecuted,
  so its overall status remains incomplete. The earlier directory
  `/tmp/qq-029-focused-synthetic` preserves the sandbox `EPERM` failure.

These checks establish parser, authority and integration behavior only. No paid
model call, conversational rating, acceptance decision, desktop QQ integration,
commit, or production activation was performed by this implementation task.
The coordinator's prepared 056–059 normal-host comparisons remain the source of
actual conversational evidence for this candidate. In particular, remaining
model misclassification, over-abstention, and output usefulness are unresolved by
scripted functional checks.
