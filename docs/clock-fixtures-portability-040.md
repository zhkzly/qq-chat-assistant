# Portable historical fixtures (C040 supplement)

This packaging change leaves product backend
`6a0201f4d76ce6bc9aa2a952c2ef0d432b3a35f66f308d880faeaf87582b2aa1`
unchanged. It replaces the two historical worktree imports in test helpers with
wholly fictional logical SQLite snapshots, using the existing pre-review fixture
format. Default tests no longer execute historical product code.

The snapshots were generated once under `/tmp` by the verified historical
implementations, before any current Store constructor read the databases:

| Fixture | Historical revision | Actual historical state |
| --- | --- | --- |
| `activity-gap-038-snapshot.json` | `98738f964ab25a2fc3f5f2c77490f09fc92deea1` | Recalled cancellation evidence removed dependent records; one opaque gap; no pending journal rows. |
| `clock-pending-039-snapshot.json` | `2c9dd77aa5c6f7fd8cf7ee2a7f82b07e357eb12b` | Captured matching QQ echoes rejected in two scripted attempts; three pending journal rows and the original error. |

Each fixture records its historical backend and Store hashes, generation method,
input hash, generator hash, source SQLite file hash and logical snapshot hash.
The checked-in JSON includes actual schema, rows, rowids, sequences and SQLite
user version. Restoration pins the fixture bytes, verifies the exact logical
database and decisive old state through raw SQLite, closes it, and only then lets
the test open the current Store. It does not build the old database with current
Store APIs. SQLite file bytes need not match after logical restoration.

The 038 migration test still compares original IDs, text, times, revisions,
permissions, feedback and the unchanged gap record after upgrade. The 039 test
still checks that the corrected protocol fingerprint retries the preserved pending
work, admits the captured rich proposal in one scripted request and preserves raw
sources. The actual historical `RELATIONSHIP_PROTOCOL` export is separately frozen
as a hash-pinned text fixture. These are mechanical migration checks, not model
quality ratings or desktop integration evidence.

Generation used no provider calls. The one-off generator, original fictional
SQLite files and generation log remain local evidence under `/tmp`; their hashes
and the focused portability checks are recorded in the separate packaging handoff
under `.goal-runs/engineering-040/test-packaging/`. The original implementation
handoff and earlier RED/green evidence are preserved.
