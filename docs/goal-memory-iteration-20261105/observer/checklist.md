- [x] A rejected optional compaction call does not invalidate a successfully published foreground response.
- [x] Original compaction rejection and request/response traces remain observable.
- [x] Genuine foreground failure is still rejected by the replay checkpoint.
- [x] Existing automatic memory failure checkpoints still reject.
- [x] New runs identify corrected observer bytes; old runs are preserved.

Validation: the new fallback check fails original v3 and passes v4; all42 runtime/stream/adapter checks pass. Logs: /tmp/qq-observer-before-20261105.log and /tmp/qq-observer-after-v2-20261105.log. The first post-change test run exposed a test-only call to a nonexistent public settle method; replaced it with a real subsequent /api/assistant call, retaining its failed log. Actual-model matched baselines are rerun in fresh directories; the earlier artifacts remain unchanged.
