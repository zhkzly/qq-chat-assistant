'use strict';
// M4 retrieval service tests (RT1 acceptance, design \u00a74.3): filter
// correctness (withdrawn / excluded / disabled / undetermined never returned),
// CJK-bigram lexical ranking with time decay, anchor and reply neighborhoods,
// tier filtering, manifest explainability, adapter parity with the current
// store projection, index lifecycle, and the appendix-B9 batched
// program-side range interface. All data is synthetic (fictional fixtures).
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/store.cjs');
const { createRetrievalService, createStoreObservationProvider } = require('../src/memory/retrieval-service.cjs');
const { buildFixtureStore, scope, otherScope, asOf } = require('./fixtures/retrieval.cjs');

test('hard filters: withdrawn, user-excluded, disabled and control-excluded sources are never returned, with reasons', async () => {
  const { store } = buildFixtureStore(); const service = createRetrievalService({ store });
  const { items, manifest } = await service.retrieve({ scope, query: '加班 爬山 展览 正式', asOf });
  const ids = items.map(item => item.id);
  assert.equal(ids.includes('qq:1004'), false, 'recalled qq message must never be returned');
  assert.equal(ids.includes('qq:1005'), false, 'user-excluded qq message must never be returned');
  assert.equal(ids.includes('note:note-off'), false, 'disabled note must never be returned');
  const tombstones = new Map(manifest.tombstones.map(item => [item.id, item.reason]));
  assert.equal(tombstones.get('qq:1004'), 'withdrawn_recall');
  assert.equal(tombstones.get('qq:1005'), 'user_excluded');
  assert.equal(tombstones.get('note:note-off'), 'use_disabled');
  const controlTombstone = [...tombstones.entries()].find(([id]) => id.startsWith('private:') && tombstones.get(id) === 'turn_excluded');
  assert.ok(controlTombstone, 'memory-excluded private turn is a tombstone');
  assert.ok(manifest.tombstones.every(item => item.explanation), 'every tombstone carries an explanation');
  store.close();
});

test('speaker filters never default an undetermined speaker to either party', async () => {
  const db = new DatabaseSync(':memory:');
  const stub = {
    name: 'stub', adapterVersion: 'test', observationLog: false,
    universe: () => ({ sources: [
      { id: 'qq:x1', type: 'qq', text: '无方向来源也说休息', at: asOf, revision: 'r1' },
      { id: 'qq:x2', type: 'qq', text: '对方说休息', at: asOf, revision: 'r2', direction: 'incoming', role: 'contact' },
      { id: 'qq:x3', type: 'qq', text: '我说休息', at: asOf, revision: 'r3', direction: 'outgoing', role: 'user' }
    ], tombstones: [] })
  };
  const service = createRetrievalService({ provider: stub, db });
  for (const speakers of [['account_owner'], ['contact'], ['account_owner', 'contact']]) {
    const { items, manifest } = await service.retrieve({ scope, query: '休息', asOf, filters: { speakers } });
    assert.equal(items.some(item => item.id === 'qq:x1'), false, `undetermined must not match ${speakers.join('|')}`);
    assert.equal(manifest.stages.hardFilter.rejectedCounts.speaker_undetermined_no_default, 1);
    assert.equal(items.some(item => speakers.includes('contact') && item.id === 'qq:x2' || speakers.includes('account_owner') && item.id === 'qq:x3'), true);
  }
  // Only an explicit undetermined request returns it, labeled as such.
  const explicit = await service.retrieve({ scope, query: '休息', asOf, filters: { speakers: ['undetermined'] } });
  assert.deepEqual(explicit.items.map(item => item.id), ['qq:x1']);
  assert.equal(explicit.items[0].speaker, 'undetermined');
  db.close();
});

test('kind and tier allow-lists filter precisely and cross-scope data never leaks', async () => {
  const { store } = buildFixtureStore(); const service = createRetrievalService({ store });
  const qqOnly = await service.retrieve({ scope, query: '展览 加班 休息 正式', asOf, filters: { kinds: ['qq'] } });
  assert.ok(qqOnly.items.every(item => item.kind === 'qq'));
  assert.equal(qqOnly.manifest.stages.hardFilter.rejectedCounts.kind_not_allowed >= 3, true);
  const publicOnly = await service.retrieve({ scope, query: '展览 加班 休息 正式', asOf, tiers: ['T0'] });
  assert.ok(publicOnly.items.every(item => item.tier === 'T0'));
  assert.ok(publicOnly.items.every(item => item.kind === 'qq'), 'only qq sources are T0 in the shim');
  assert.equal(publicOnly.manifest.stages.hardFilter.rejectedCounts.tier_not_allowed >= 3, true);
  const every = await service.retrieve({ scope, query: '展览 加班 休息 正式 开心', asOf, limit: 50 });
  assert.equal(every.items.some(item => item.id.includes('9999') || item.id === 'qq:9001'), false, 'other-scope message never returned');
  assert.equal(every.items.some(item => item.kind === 'note' && item.id === 'note:note-draft'), true, 'draft-use note retrievable');
  store.close();
});

test('lexical stage: CJK bigram recall, time-decay ordering, and no-overlap queries return nothing', async () => {
  const { store } = buildFixtureStore(); const service = createRetrievalService({ store });
  const { items, manifest } = await service.retrieve({ scope, query: '忙完', asOf });
  assert.deepEqual(items.map(item => item.id), ['qq:2001', 'qq:1001'], 'identical text: newer source ranks first via decay');
  assert.ok(items[0].decay > items[1].decay);
  assert.ok(items[0].lexicalScore > 0 && items[1].lexicalScore > 0);
  assert.deepEqual(items[0].matchedStages, ['hard_filter', 'lexical']);
  assert.deepEqual(items[1].reasons, ['legal:passed_hard_filters', 'lexical:bm25_match']);
  const none = await service.retrieve({ scope, query: '量子纠缠', asOf });
  assert.deepEqual(none.items, []);
  assert.equal(none.manifest.stages.lexical.matched, 0);
  // Single Han characters cannot match a bigram index token (same boundary as
  // the legacy rank()); the manifest keeps the miss explainable.
  const single = await service.retrieve({ scope, query: '忙', asOf });
  assert.deepEqual(single.items, []);
  assert.deepEqual(single.manifest.queryTerms, ['忙']);
  store.close();
});

test('anchors admit their neighborhoods and reply edges, but never bypass hard filters', async () => {
  const { store } = buildFixtureStore(); const service = createRetrievalService({ store });
  const anchored = await service.retrieve({ scope, query: '', asOf, anchors: [{ sourceId: 'qq:1003', reason: 'reply_focus' }] });
  const byId = new Map(anchored.items.map(item => [item.id, item]));
  assert.ok(byId.get('qq:1003'), 'anchor itself admitted');
  assert.equal(byId.get('qq:1003').matchedStages.includes('anchor'), true);
  assert.equal(byId.get('qq:1003').anchorReasons.includes('reply_focus'), true);
  for (const neighbor of ['qq:1001', 'qq:1002', 'qq:1006'])
    assert.ok(byId.get(neighbor), `${neighbor} is time-adjacent to the anchor`);
  assert.equal(byId.get('qq:1006').matchedStages.includes('reply_target'), true, 'message replying to the anchor is admitted');
  assert.equal(byId.get('qq:1006').matchedStages.includes('anchor_neighborhood'), true);
  assert.equal(anchored.manifest.stages.neighborhoods.replyTargetHits >= 1, true);
  // A recalled anchor stays out: hard filters are never bypassed by anchors.
  const withdrawn = await service.retrieve({ scope, query: '', asOf, anchors: [{ sourceId: 'qq:1004', reason: 'reply_focus' }] });
  assert.deepEqual(withdrawn.items, []);
  assert.deepEqual(withdrawn.manifest.stages.neighborhoods.anchorRejections, [{ sourceId: 'qq:1004', reason: 'anchor_not_in_legal_set' }]);
  store.close();
});

test('time window filter rejects outside observations with a counted reason', async () => {
  const { store } = buildFixtureStore(); const service = createRetrievalService({ store });
  const since = new Date(1791726000000 + 86400 * 29 * 1000).toISOString();
  const { items, manifest } = await service.retrieve({ scope, query: '忙完', asOf, filters: { since } });
  assert.deepEqual(items.map(item => item.id), ['qq:2001']);
  assert.ok(manifest.stages.hardFilter.rejectedCounts.outside_time_window >= 1);
  await assert.rejects(() => service.retrieve({ scope, asOf, filters: { since: asOf, until: new Date(1791726000000).toISOString() } }), /since is after until/);
  store.close();
});

test('manifest explainability: every item is fully staged and every rejected candidate has exactly one primary reason', async () => {
  const { store } = buildFixtureStore(); const service = createRetrievalService({ store });
  const { items, manifest } = await service.retrieve({ scope, query: '加班 展览', asOf, limit: 50 });
  assert.ok(items.length >= 3);
  for (const item of items) {
    assert.deepEqual(item.matchedStages[0], 'hard_filter');
    assert.ok(item.reasons.includes('legal:passed_hard_filters'));
    assert.ok(typeof item.score === 'number' && Number.isFinite(item.score));
    assert.ok(['account_owner', 'contact', 'undetermined'].includes(item.speaker));
    assert.ok(['qq', 'private', 'note', 'feedback'].includes(item.kind));
    assert.match(item.tier, /^T[0-4]$/);
    assert.ok(item.revision && item.at && item.totalChars >= 0);
  }
  const { rejected, rejectedCounts, rejectedTotal } = manifest.stages.hardFilter;
  assert.equal(rejected.length <= 500, true);
  assert.equal(Object.values(rejectedCounts).reduce((a, b) => a + b, 0), rejectedTotal);
  assert.equal(manifest.counts.universe, manifest.counts.legal + rejectedTotal);
  assert.ok(manifest.counts.tombstones >= 3);
  assert.equal(manifest.baseline.thisRunIsBaseline, true, 'no optional providers configured: this run is the same-input baseline');
  store.close();
});

test('store adapter parity: live ids and revisions match the store projection exactly', async () => {
  const { store, liveTurn } = buildFixtureStore();
  const provider = createStoreObservationProvider(store);
  const canonical = store._rawMemorySources(scope);
  const universe = provider.universe(scope);
  const canonicalById = new Map(canonical.map(source => [source.id, source]));
  assert.deepEqual([...universe.sources.map(source => source.id)].sort(), [...canonicalById.keys()].sort());
  for (const source of universe.sources)
    assert.equal(source.revision, canonicalById.get(source.id).revision, `revision parity for ${source.id}`);
  assert.ok(universe.sources.some(source => source.id === `private:${liveTurn.id}`));
  store.close();
});

test('index lifecycle: incremental sync is a no-op when unchanged and drops rows for new tombstones', async () => {
  const { store } = buildFixtureStore(); const service = createRetrievalService({ store });
  const first = service.syncIndex(scope);
  assert.ok(first.updated >= 9 && first.dropped === 0);
  const second = service.syncIndex(scope);
  assert.deepEqual({ updated: second.updated, dropped: second.dropped }, { updated: 0, dropped: 0 }, 'unchanged universe: no index writes');
  // A new recall tombstones an indexed row; sync must drop it from the index.
  const { normalize } = require('../src/messages.cjs');
  const { raw } = require('./fixtures/native.cjs');
  const { BASE_SECONDS } = require('./fixtures/retrieval.cjs');
  store.add(scope, [normalize(raw('1003', false, { msgTime: String(BASE_SECONDS + 1200), recallTime: String(BASE_SECONDS + 1300),
    elements: [{ elementType: 1, textElement: { content: '这周连续加班，项目要上线' } }] }), scope)]);
  const third = service.syncIndex(scope);
  assert.equal(third.dropped, 1);
  const afterRecall = await service.retrieve({ scope, query: '加班', asOf });
  assert.equal(afterRecall.items.some(item => item.id === 'qq:1003'), false, 'recalled source no longer retrievable');
  assert.equal(afterRecall.manifest.tombstones.some(item => item.id === 'qq:1003' && item.reason === 'withdrawn_recall'), true);
  store.close();
});

test('index drift between the observation universe and the lexical index fails loudly', async () => {
  const { store } = buildFixtureStore(); const service = createRetrievalService({ store });
  await service.retrieve({ scope, query: '加班', asOf });
  store.db.prepare("UPDATE retrieval_lex_meta SET kind='feedback' WHERE source_id='qq:1001'").run();
  await assert.rejects(() => service.retrieve({ scope, query: '加班', asOf, filters: { kinds: ['qq'] } }), /index drift/);
  store.close();
});

test('appendix B9: one program-side call resolves many ranges with per-range status', async () => {
  const { store, liveTurn } = buildFixtureStore(); const service = createRetrievalService({ store });
  const currentRevision = store._rawMemorySources(scope).find(source => source.id === 'qq:1001').revision;
  const result = await service.retrieveRanges({ scope, asOf, query: '忙完', ranges: [
    { sourceId: 'qq:1001', maxChars: 6 },                                   // ok, query-focused offset
    { sourceId: 'qq:1001', offset: 0, maxChars: 6, revision: 'stale' },     // stale revision
    { sourceId: 'qq:1004', maxChars: 10 },                                  // tombstoned recall
    { sourceId: 'qq:424242', maxChars: 10 },                                // unknown
    { sourceId: 'note:note-draft', maxChars: 40 }                           // ok, tier T2 note
  ] });
  assert.equal(result.manifest.roundTrips, 1);
  const [ok, stale, tombstoned, unknown, note] = result.ranges;
  assert.equal(ok.resolved, true);
  assert.equal(ok.offset > 0, true, 'default offset uses query focus, not the head');
  assert.equal(ok.text.includes('忙完'), true, 'focused window contains the query terms');
  assert.equal(ok.deliveredChars, 6);
  assert.equal(stale.resolved, false);
  assert.equal(stale.reason, 'stale_revision');
  assert.equal(stale.currentRevision, currentRevision);
  assert.equal(tombstoned.reason, 'tombstoned:withdrawn_recall');
  assert.equal(unknown.reason, 'unknown_source');
  assert.equal(note.resolved, true);
  assert.equal(note.tier, 'T2');
  assert.equal(result.manifest.counts.resolved, 2);
  assert.equal(result.manifest.counts.refused, 3);
  // Budget cap is enforced across the batch with an explicit marker.
  const capped = await service.retrieveRanges({ scope, ranges: [
    { sourceId: 'note:note-material', maxChars: 10 }, { sourceId: 'note:note-draft', maxChars: 50 }], maxTotalChars: 14 });
  assert.equal(capped.ranges[1].budgetTruncated, true);
  assert.equal(capped.ranges[1].deliveredChars, 4);
  await assert.rejects(() => service.retrieveRanges({ scope, ranges: [{ sourceId: 'qq:1001', maxChars: 999999 }] }), /Invalid ranges/);
  store.close();
});
