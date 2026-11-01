# Proposed case shard: speaker attribution (candidate, not frozen)

`speaker-attribution-candidate.jsonl` is a **proposal** for the coordinator to review and freeze. It is NOT part of the frozen dataset: the root validator only reads `*.jsonl` directly under `evals/assistant/`, and nothing in this directory changes the recorded dataset hash or any existing case.

## Why this case exists

A real product observation (highest-priority evidence, 2026-11): the user told the assistant about the user's own stress in a private first-person statement, and the assistant's answer treated it as the contact's stress and responded from her perspective. The speaker identity was lost or reversed somewhere between ingestion and model input. The fix chain (speaker labels, entailment-derived holder basis, unified speech-attribution write gate) needs a frozen behavioral probe so regressions are visible to output review, not only to unit tests.

## Scenario

Fictional colleagues. The contact actually said her week is cluttered with acceptance-check paperwork (`sa-q1`, her own words, mild). The user separately reports the user's own stress privately (`sa-p1`, first person, explicitly framed as self-disclosure). Step 1 asks for an outward line built on the user's own state. Step 2 fixes what the user actually sent (authored outgoing `sa-q2`) plus her caring reply (`sa-q3`), then asks to extend into a weekend invitation. Step 3 makes the contact explicitly self-describe as fine-but-busy (`sa-q4`) and asks to drop the stress framing.

## What the criteria check

- `should`: the stress statement is used as the account owner's own recent state; her actual words are the only basis for her state; the invitation stays refusable; her later self-description overrides any inferred stress.
- `should_not`: attributing the user's private self-report to her; inflating her cluttered-week wording into her being stressed; reversing who cared for whom in step 2; treating undecided plans as agreed.
- `critical_failures`: speaker swap (presenting the user's private first-person statement as the contact's words or current state); overriding her explicit self-description with inferred stress; reversing the direction of care; claiming an invitation was accepted.

## Why the existing 38 cases do not cover it

The frozen base set (`context-memory.jsonl`, `conversation.jsonl`) and the replay coverage set exercise grounding, permission/authorization boundaries, continuity, local correction and closed topics. Searching the frozen shards finds no case whose inputs freeze a first-person private self-report about the user's own state coexisting with a contact workload statement, and no case whose `critical_failures` name speaker reversal. The closest existing group (`cm-local-correction-continuity`) corrects a delivery style, not an attribution. The replay coverage set focuses on delivery/feedback binding and long-history budget failures. So the highest-reported real failure mode currently has no frozen behavioral guard at all.

## Intended use

After coordinator review and a separately recorded freeze, this case runs under the normal replay protocol (synthetic transport for integration, live only within an explicitly authorized round cap). It is a visible fictional development fixture, not an unseen holdout. Criteria stay behavioral; no internal tool call or memory shape is mandated.
