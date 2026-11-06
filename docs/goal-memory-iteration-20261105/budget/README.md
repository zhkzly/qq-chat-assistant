# Explicit unlimited experiment HTTP accounting

The user's current authorization removes the aggregate HTTP-call quota for this
experiment. It does not change the provider, credentials, approval controls,
per-request product budget, timeout, retry or cancellation semantics.

Every real runner accepts `--unlimited-http`; JavaScript adapters accept
`unlimitedHttp: true`. A numeric `--max-http` and `--unlimited-http` cannot be
combined. Existing numeric caps and finite defaults remain supported.

The mode is serialized as `max_http: null` and `unlimited_http: true`. Component
adapters use their existing `http_cap: null` field with the same explicit flag.
No Infinity value or arbitrarily large numeric cap is used. Accounting continues
to retain every forwarded, blocked and failed request.

```bash
node scripts/eval-stream-replay.cjs --adapter ./scripts/eval-qq-adapter.cjs \
  --all --live --settings-file data/settings.json --unlimited-http \
  --out /tmp/new-stream-unlimited-run

node scripts/eval-memory-decisions.cjs \
  --adapter ./scripts/eval-memory-decisions-luna-adapter.cjs \
  --all --live --settings-file data/settings.json --unlimited-http \
  --out /tmp/new-component-unlimited-run
```

Unlimited component mode also removes the implicit sixteen-adapter-invocation
quota; the finite selected dataset still terminates naturally. An explicitly
supplied `--max-calls` remains a deliberate workset limit, independent of HTTP
accounting. Adapters must declare unlimited support rather than silently
accepting a flag while retaining a finite HTTP ceiling.

Unlimited QQ checkpoint preparation continues beyond sixteen maintenance
checkpoints only while committed progress continues. Nonprogress, provider
failure, cancellation and wall deadlines still produce visible incomplete
evidence.

## New Goal directory

The existing Goal is not modified. `prepareRound({goalDir})` and CLI
`goal-round prepare --goal-dir <directory>` select a separate Goal contract,
roles file and state. The absolute `goal_directory` is frozen in the round and
used for subsequent provenance checks; omitted options preserve legacy behavior.

An unlimited round requires `execution.unlimited_http_authorized: true`. A new
Goal can declare `max_http_per_round: null`; an explicit `--unlimited-http`
freezes `max_http: null`, `per_variant_http: null` and `unlimited_http: true`.
Both attached arms must match that mode. A numeric capped arm cannot be hidden
inside an unlimited comparison or vice versa. `http_remaining` is null for
unlimited rounds, while total usage remains numeric.

The old Goal and historical numeric-cap evidence stay intact. A separate worker
extends the same round workflow for new-primary stream/component datasets.

## Validation

`tests/eval-http-budget.test.cjs` covers explicit serialization, conflicting flags,
513 synthetic bridge requests, a 24-case unlimited component workset, the
seventeen-checkpoint loop, preserved provider failures, independent Goal
directories and authorization rejection. `tests/goal-round.test.cjs` adds an
otherwise-bound numeric/unlimited arm mismatch rejection. All provider responses
in these checks are synthetic; no live model or QQ action was run by this worker.
