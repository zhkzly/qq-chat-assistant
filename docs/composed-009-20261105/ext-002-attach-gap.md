# ext-memory-context-002/002b attach-gap note (2026-11-06)

The candidate replay attach for ext-002/002b could not be completed: the recorded
implementation hash (fbeda344, the iter13-lineage source snapshot) refers to a /tmp
snapshot directory that was removed by system /tmp cleanup before the attach ran. The
canonical restore at /tmp/qq-composed-009-frozen now carries the LATEST validated
candidate (012d2329, commit e943e5b lineage), which differs from the run's recorded
snapshot by the later repair-guidance clause — byte-exact reconstruction of fbeda344 is
not possible post-cleanup.

The round decision (inconclusive, 7/12 clean under the final package vs 3/12 in ext-001)
stands on the PRESERVED evidence in this directory: transport.json (all 42+ requests with
models and receipts), per-case run.json/diagnostics (failure table verified), and the
per-case review files. The unattached state is itself recorded here rather than silently
omitted.

For future runs: the canonical source root is /tmp/qq-composed-009-frozen (012d2329) —
recreate it from git (git archive e943e5b src tests docs) if lost again, and always
commit the candidate line to the repo BEFORE relying on /tmp snapshots.
