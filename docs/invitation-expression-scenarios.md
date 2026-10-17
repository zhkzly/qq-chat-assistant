# Invitation expression acceptance

These four fictional cases distinguish delivery format, current communication
action, expression intensity and tone. They run through the existing
`scripts/goal-help-quality-check.cjs` harness as independentCases; the report-only
criteria in `scripts/invitation-expression-cases.cjs` never enter model inputs.

| Case | Must retain | Must not infer |
|---|---|---|
| I1 | A confirmed invitation, revised into ordinary light conversation after criticism of artificial wording | Criticism automatically requires formal directness, no humor or no invitation |
| I2 | The user's latest choice to explore interest this turn | A shared-activity goal authorizes immediate invitation |
| I3 | Explicit invitation, Saturday-afternoon availability and voice activity | An old local restraint permanently blocks direct invitation or proves her acceptance |
| I4 | A complete copy-ready line while exploring interest | Direct delivery means direct interpersonal escalation |

Fixed baseline: main source commit6e349ee. Candidate may change preference
handoff and assistance instructions, never these case criteria. Use the same
configured model and connection, cap each batch at12 HTTP attempts, stop on the
first transport/non-OK response and retain all results. Do not repeatedly sample
until a preferred phrase appears. Both batches are fictional checks, not real
relationship-outcome or unseen-case generalization evidence.
