# Empty-start streaming replay

This is a distinct evaluation setting, not a replacement for the existing checkpoint replay or memory-understanding observer. Each episode opens an empty isolated implementation and introduces all source events chronologically. The system builds its own state through its normal ingestion, foreground and scheduled-maintenance paths.

The initial pilot has four visible fictional cases in two contrast families, adapted from existing project raw histories:

- `stream-temporary-state-unchanged` / `stream-temporary-state-updated`: temporary fatigue and running interest, with versus without later evidence of changed circumstances.
- `stream-material-retained` / `stream-material-excluded`: an authored shareable note, with versus without its subsequent exclusion.

Each case records its seed and adaptation. These are authored development cases with provisional reviewer criteria, not human-gold labels or unseen holdouts. Filler is omitted from the first family to keep this an adapter pilot, so it is not evidence about long-context scale.

### Post-pilot provenance refinement

The exact original dataset is retained at `versions/v1/cases.jsonl`, SHA-256 `541b7176a1ca2c725123a335300de3caafc622326e815e0250039c266e45d8ab`. Its pilot/source-bundle identities remain immutable.

The current default adds only `seed.source_sha256`; no raw event, request, goal or reviewer criterion changed. Provenance revision `local-seed-source-sha256-v2-2026-11-05` verifies source-file bytes, the cited case ID and declared original source IDs. It does not certify that a semantic adaptation is correct. `provenance-v2.json` records the old/new dataset identities and unchanged runtime-input hashes. This metadata-only refinement was not given a new paid replay.

Frozen legacy data without the SHA remains loadable with `seed_provenance.status: contains_legacy_unattested`; the loader does not invent a historical source digest. Current attested data rejects source hash drift or missing cited IDs during `--check` and before replay. Local seed verification is limited to JSONL files under the evaluation tree.

## Commands

From the project root:

```bash
node scripts/eval-stream-replay.cjs --check
node scripts/eval-stream-replay.cjs --list
node scripts/eval-stream-replay.cjs --adapter ./scripts/eval-qq-adapter.cjs \
  --id stream-material-excluded --max-http 16 --out /tmp/qq-stream-synthetic-new
```

Check and list do not instantiate an adapter or call a model. Replay without `--live` uses the adapter's synthetic transport and proves integration only.

An actual selected-model replay requires `--live`, an explicit `--settings-file`, an explicit global `--max-http`, and a new output directory. The runner passes those arguments unchanged to the replaceable adapter and does not edit provider settings. Preparation, maintenance, foreground requests, retries and repairs share the adapter's global cap. No live run was executed while creating this pilot.

## Data contract

Top-level fields are `schema_version`, `policy_version`, `id`, `family_id`, `start_at`, `runtime_goal`, `seed`, `events`, `reviewer_only` and `limitations`. The seed includes `kind`, `source`, `case_id`, optional `raw_ids`/`adaptation`, and current `source_sha256`. A case has no `initial` data slot: raw or derived memories, prepared context and archived assistant messages cannot be supplied at opening.

The runtime opening is always:

```json
{"as_of":"<start_at>","qq_events":[],"private_events":[]}
```

Every event has a distinct string `id`, timezone-aware `at`, and `kind`. Additional fields are:

| Kind | Fields | Runtime operation |
| --- | --- | --- |
| `qq` | `speaker: self/contact`, `text` | `observe` of an actual external QQ observation |
| `user_request` | `text`, optional `reply_to_event_id` | `respond`; a feedback reference resolves only to an actual earlier runtime reply |
| `note` | `text`, optional `declared_use: discussion/draft`, `note_kind: material/preference`, `evidence_source_ids` | `observePrivate` of a user-authored note, never a derived profile |
| `control` | `controls` containing `goal` and/or `automatic` | `configure` |
| `source_update` | `source_id`, `channel: qq/private/note`, `operation: delete/exclude/recall` | `withdrawSources` of an already observed source action |
| `idle` | `wall_timeout_ms: 1..65000` | `idleUntil(at)`; no pre-advance of that quiet interval |

Sources must be introduced before their use. A note cannot cite already withdrawn evidence. All source times and fixed requests survive runtime projection. Unknown fields, authored assistant events, context seeds, invalid calendar times and forward feedback references are rejected before the adapter opens.

`runtimeCase()` removes seed metadata, family labels, limitations and reviewer criteria from the adapter-facing input. Reviewer instructions, expected facts and gold memories do not enter adapter calls.

## Adapter and time boundaries

The portable runner imports no product modules. `--adapter` is the replaceable boundary. The current QQ adapter is opened with the explicitly declared `scheduled_idle_public_memory_observation_v1` condition, which uses foreground-only waits for ordinary operations. The condition name identifies this implementation's runtime mode rather than a universal memory architecture.

The event clock is virtual; model/provider deadlines and time spent on network calls stay native. Explicit idle events provide a bounded native opportunity for normally scheduled work. The runner records incomplete checkpoints and still delivers the fixed subsequent request; it does not force maintenance, manufacture a memory or relabel a timeout as semantic failure. The foreground event wall bound defaults to 300000 ms. Adapter setup and cleanup are bounded separately.

The runner is sequential: it awaits one foreground request before introducing the next event. It does **not** test QQ/source/contact changes during an in-flight model call, desktop UI behavior, disk persistence after restart, or actual human adoption of model wording. Those need separate integration settings.

## Artifacts

- `manifest.json`: settings, hashes, selected/unfinished episodes and failures.
- `<id>.run.json`: actual raw inputs, outputs, per-event clocks, idle receipts, optional public-memory views, diagnostics, failed events and cleanup state.
- `<id>.review.json`: complete visible episode and provisional external criteria; no internal diagnostics and no assigned ratings.
- `<id>.preparation.json`: the adapter's preparation receipt, when supplied. The runner does not rewrite it as an empty-start claim.
- `transport.json`: the adapter's actual request/response summary and global call accounting.

`setting_receipt` separately declares the empty opening, zero archived assistant turns, no runner-injected derived memory and whether every event completed. `entire_history_reexecuted` describes event execution only, not memory correctness or semantic quality. The original adapter preparation receipt may still say `scheduled_prefix`; both identities are retained instead of silently conflated.

All new assistant outputs are returned by the running implementation. Authored self/contact continuations remain external conditions, not evidence that a generated draft was actually sent or caused the contact's response.
