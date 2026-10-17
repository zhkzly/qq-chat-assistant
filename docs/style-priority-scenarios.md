# Current meaning and expression priority: predeclared continuous cases

These three fictional trajectories reuse `runHarness({continuousCases})` from
`scripts/goal-help-quality-check.cjs`. No new runtime judge, model output schema,
style menu or native QQ action is introduced. The exact inputs and positive and
negative judgements live in `scripts/style-priority-cases.cjs`.

The aim is to distinguish content choice, the user's current communication
action and repeatable expression defaults. A gentler version of the wrong
invitation is still the wrong action. Conversely, a confirmed direct invitation
must not be replaced by interest probing merely to sound less direct.

## Frozen scenario scope

| Case | Continuous evidence | Positive judgement | Counterexample / failure to retain |
| --- | --- | --- | --- |
| S1 work, not an old activity | A prior puzzle invitation idea; a new first-workday share; a local work-only correction; a human-written actual QQ reply; her new colleague/lunch detail | Stay with the actual current story, carry the local correction, update after actual sending and add concrete content on the next incoming message | A softer old puzzle invitation, repetition of the sent line, invented matching job experience, automatic loss of the correction or an interview merely to keep messages flowing |
| S2 invitation now | Previous interest-only restraint; current explicit invitation with the user's Saturday-afternoon availability and voice activity | Give the legitimate invitation with current facts and her choice intact | Indefinite probing, erasing the invitation, repeated availability questions, or fabricated acceptance |
| S3 one-off expression | A real explicit save request; current complete-thought/emoji permission; a new closing with a quoted third-party habit | Apply only this request's override, leave the durable default unchanged, and do not promote the quote to the user's preference | Conflicting old controls still delivered, treating permission as a mandatory emoji, saving a one-off requirement or turning the contact's quotation into user authority |

S3 does not pretend that a prior private turn is a saved preference. Its first
step must produce an applied existing `set_preference` receipt; subsequent
planning inputs must contain that saved note. If the model fails to save it,
retain that result and mark the durable-conflict portion as not exercised or
failed. Do not repair the fixture silently or repeat the batch until it saves.

Before any live sampling, S3's current request uses the already observed probe
wording `这次不要用短句，可以加点表情，解释完整一点。` rather than relying on
parsing an additional synonym for brevity. This still tests the same current
choice versus the actually saved old defaults; no model result informed that
wording choice.

The actually sent S1 message is a fixed fictional human action, not an assertion
that the user copied the generated text. It need not equal the preceding model
output. Scripted incoming messages are test conditions, not evidence that a
real person would reply or become closer.

## Execution and review boundary

- Seven generating tasks normally use fourteen planning/wording requests;
  the fixed batch limit is **18 total HTTP attempts**, within the existing
  four-attempt task limit. The observe step makes no model request. Repairs
  consume the same cap; retain incomplete work if the cap is reached.
- Before any live call, the root reviewer must read and freeze these definitions
  and the production source identity. Use the same declared definitions, one
  bounded batch, and retain all outputs and failures. No case selection or
  repeated sampling to find a preferred sentence.
- Criteria, case IDs and synthetic example wording are report/test material.
  They must stay outside model prompts. The existing report retains the exact
  case declarations, source hashes, planning inputs, restricted wording inputs
  and visible results for independent review.
- Review useful content and natural interaction from the complete trajectory.
  Do not score by question count, emoji presence, invitation avoidance or a
  character threshold. Respect a current explicit closing; it does not become
  a permanent contact ban.
- The deterministic check uses the real Store/Controller/context pipeline and
  a local structured responder. It proves legal preference admission,
  continuity, source/control delivery and isolation, not the model's ability to
  interpret vague feedback or produce natural conversation.
- A deliberately wrong old-topic draft is included only as a negative test of
  the evidence boundary: transport success must still require semantic review.
  The runner is not expected to mechanically classify that sentence as bad.

The author has worked on earlier project components; this is not an external
relationship-expert study or a wholly unseen generalization set. No real chats,
credentials or screenshots are used. Live evidence, if authorized and run by
the root, and real worker activation must be reported separately.

## Verification status

The focused command
`node --test --test-isolation=none tests/style-priority-continuity.test.cjs`
passed 5/5 checks in the shared candidate worktree. The initial
continuity probe reached a real conflicting-control assertion; before live
sampling its wording was aligned with the existing explicit probe quoted above.
Production changes were still being prepared concurrently, so this is not a
same-input causal before/after comparison or a final frozen-source release check.
The final full suite passed 655 checks in 96 files. Syntax and diff checks passed.

The frozen definitions ran once through the actual configured model: 15 HTTP
attempts for seven generating steps, unchanged source/settings, no transport
failure. The independent reviewer found the seven candidate texts usable.
However, S3's first preference save stayed pending; its durable-save/restore
criterion was **not exercised**, despite mechanically completed requests.
The result is retained rather than silently confirming the proposal or changing
the fixture. A separate two-request Store-seeded handoff probe verified the
local override under an existing known default; it does not replace S3 or prove
model-driven saving/restoration. No native desktop action was taken. See
expression-priority-review_CN.md and expression-priority-evidence/.
