# QQ statement clock contract (C040)

Candidate 040 is isolated in `.worktrees/qq-statement-clock-040`, based on
`2c9dd77aa5c6f7fd8cf7ee2a7f82b07e357eb12b`. Held backend hash:
`6a0201f4d76ce6bc9aa2a952c2ef0d432b3a35f66f308d880faeaf87582b2aa1`.

The actual 039 M4 sequence 2 output supplied correct QQ statement clocks and
matching source/quote echoes. The advertised schema allowed those optional fields,
but the decoder rejected any field besides basis as a non-QQ clock. The preserved
zero-provider diagnostic showed that removing only those nine redundant fields
made the same output decode. This is a mechanical contract mismatch, not evidence
of a model meaning error.

## Change

`qq_statement` accepts its minimal `{basis:"qq_statement"}` form and optional
verified at/sourceId/quote echoes. Equivalent timezone representations of the
same instant match. Echoed source must be the bound statement source even when
another message has the same timestamp. An echoed quote must be an exact unique
span of that original. Echoes are normalized away: canonical occurrence time and
its evidence always come from the actual bound QQ statement original.

Conflicts produce precise at/sourceId/quote paths, expected/actual feedback and
the legal minimal form through the existing all-issues/single-correction path.
QQ source type and speech-act kind remain a separate guard. Matching echoes cannot
turn a private report/question or physical occurrence into a QQ speech-act clock.
Unknown remains basis-only with no asserted date or unused witness fields. Explicit
reported occurrence still requires at/sourceId/quote and the actual original time
witness. PlannedFor and its sourceIds membership rule are unchanged.

The time schema retains its outer object/properties for result-tool normalization,
with discriminated anyOf alternatives declaring each basis's actual shape. No
extra metadata becomes mandatory for QQ clocks. Initial and correction envelopes
share the same schema and original input. Provider acceptance of anyOf remains a
real-run obligation; offline shape checks do not prove provider compatibility.

Only activity-evidence, model-response-format and the matching memory instruction
change product behavior. Memory wire version is
`evidence-backed-understanding-2026-11-01.3`, so new requests consume the corrected
contract fingerprint. Stored activity proof protocol, Store, SQL/processor versions,
identity/gap/current-state semantics, UI, settings and correction allowance remain
unchanged. The captured old opaque batchId is preserved in the fixture; scripted
producer comparisons explicitly rebind only batchId to the new request version.

## Executed evidence

- Pre-change RED: 12 tests, 10 failed and 2 existing guards passed; log retained.
- Expanded exact-capture/negative/reopen checks: 18/18 passed, exit 0.
- Focused existing and new checks: 15 files, 267/267 passed, exit 0.
- Application syntax, diff and protected-path comparisons: exit 0.
- Complete captured initial/correction inputs: 23426/28708 bytes under 48000;
  all three original source bodies, revisions, scopes and actor/citation fields retained.

Tests cover rich/minimal canonical equality, zoned instants and independent echo
subsets, conflicting leaves, same-clock different-source rejection, private/physical
guards, unknown/explicit shapes, planned citation membership and legacy-envelope
validation. Store body/RV/scope/withdrawal/CAS rejections remain atomic. A fictional
database created with frozen 039 code retains its three echo-failed pending sources;
reopening with 040 consumes the new fingerprint, admits the same captured rich
proposal in one scripted request, clears the error and preserves raw IDs/body/time/RV.
The scripted initial activity projection is cancelled. This is not a fresh model
run, semantic rating or claimed conversational gain.

The initial handoff used local frozen worktrees for cross-version proof. The
subsequent [fixture packaging supplement](clock-fixtures-portability-040.md)
replaces both helpers with old-generated logical database snapshots and a frozen
protocol string. The initial handoff and its original check evidence remain intact.

Artifacts, raw captured fixture provenance, errors, complete files and hashes are
under `.goal-runs/engineering-040/`. The coordinator owns actual model replay,
independent evaluation, merge and Goal acceptance. No provider call, commit, QQ
activation or source change to held 039 was performed by this task. Statement
membership still does not prove semantic entailment or truth; 039's model-judgment
limits remain. Date-only planned values keep their existing normalization behavior;
this fix does not establish an otherwise unknown planned clock.
