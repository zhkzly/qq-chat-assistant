# Session verification record — 2026-11-06 (13 live iterations)

Canonical analysis record for the context-memory-evaluation-20261105 composed candidate
(/tmp/qq-composed-009 line, frozen sources under /tmp/qq-composed-009-frozen*). The
goal-round CLI owns goals/context-memory-evaluation-20261105/state.json; this document
carries the session's measurement record that does not fit the CLI schema.

## Blinded round decisions (all evidence in .goal-runs/context-memory-20261105/)
- authored-note-source-008d: inconclusive — iter11b 4/4 executed; candidate 0 hard
  failures; baseline invented_or_misattributed_fact HF on excluded; 2 step-level
  minor_edit gaps.
- authored-note-source-008f: inconclusive — iter13b 4/4 executed; candidate 3 usable +
  1 minor_edit, zero HF; baseline rewrite + invented_or_misattributed_fact HF; quality
  preference to candidate on both material cases. Gate refused solely on the excluded
  r2 minor_edit (honest zero-history draft).
- authored-note-source-008g: inconclusive — symmetric Luna hallucination on the
  excluded case contained by BOTH systems this run; other three cases tied.
- ext-memory-context-001: rejected (execution evidence) — 3/12 clean on the extended
  long-source/recall/disclosure shapes.
- legacy-regression-composed-002: rejected (REGRESSION) — composed 23/43 clean vs
  baseline 35/43; current_fact_span_invalid x6 (new lane absent in baseline product),
  audit containment blocks x8, repair exhaustion x2, timeout x1.
- component-relation-semantics-005b: accepted — 16/16 mechanical binding, candidate-side
  15/16 usable vs baseline-side 12/16.

## First-cause attribution (29 failures, qq_diagnostician pass)
- C1 (34%): sparse auditor flags the draft's OWN proposals/questions/reassurances as
  unsupported_fact — instruction-RESISTANT (the duty card already teaches the exact
  rules; verified verbatim in transport). Auditor-side classification reliability.
- C2 (28%): exact-span citation discipline (paraphrase/derived-summary selection/trims).
- C3 (17%): audit output flakiness (issues-array omission; D10 rebuild mitigates).
- C4 (7%): materials authority/permissionQuote binding slips. C5 (3%): timeout.

## Complete fix package landed (D9-D13, all gate-neutral)
D9 legacy-complete delivery convention; zero-epistemics exclusion strategy; D10 sparse
audit one-bounded-representation-rebuild (stage-separated); alias-aware duplicate
collapse + attribution diagnostic; audit lane gpt-6.1-terra (bench 4/4 on the exact
failing payloads; Luna 2/4); handle-based currentFact citation; array-omission wording
fix; exclusion-completeness principle in the packet instructions (goal-round-settings).

## Verified live results
- iter13b (full package): 4/4 cases executed clean, zero terminal errors; audit lane
  gpt-6.1-terra confirmed in transport; blinded 3 usable + 1 minor_edit, zero HF;
  quality-preferred on both material cases vs the hallucinating baseline.
- Both material cases (retained + excluded) passed in the same run for the first time.
- Baseline hallucination (invented_or_misattributed_fact) reproduced in 3 of 4 reviewed
  rounds — never published by the candidate.

## Open boundary (honest)
- The excluded-case r2 step ceiling is minor_edit under the honest zero-history posture
  (architecture adjudication: USABLE-WITH-CAUTION, structurally sufficient help). The
  frozen letter-gate (all target steps usable) is unsatisfiable on that step without
  fabrication — unreconciled pending owner decision.
- Legacy old-43 regression stands (23/43 vs 35/43) — merging would ship refusals on
  legacy-shaped conversations; NOT merged. Handle-based redesign for the legacy family
  or a model change is the future arc.
- C1 residual: same-family auditor instruction-resistance; a cross-family auditor
  (claude/gemini lane) is the tested alternative (bench 3/4 with one no-tool-call flake).

## Merge status
NOT MERGED. Main repo src/ui clean at HEAD 196cca3a. The composed candidate line lives
in /tmp/qq-composed-009 with 10 frozen sources. Merge requires: excluded-shape usable
criterion adjudication (owner) + legacy regression resolution + explicit owner
authorization.
