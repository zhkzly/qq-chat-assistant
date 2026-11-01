'use strict';
// M4 optional stages (RT1): the embedding provider interface and the JEV
// decision adapter, both DISABLED BY DEFAULT. Tests prove the resource-doc
// adoption rules with isolated, deterministic local providers only - no real
// network call is ever made: synonym recall with a retained same-input
// lexical baseline, legal-set-only semantic admission, revision-keyed vector
// stale-drop, api-key hygiene (environment-only, redacted everywhere), and
// batched hash-cached JEV decisions that reorder but never drop items or
// demote corrections.
const test = require('node:test'), assert = require('node:assert/strict');
const { createRetrievalService } = require('../src/memory/retrieval-service.cjs');
const { createLocalTestEmbeddingProvider, createDoubaoEmbeddingProvider, cosineSimilarity } = require('../src/memory/embedding-provider.cjs');
const { createJevDecisionProvider, createLocalTestJevProvider } = require('../src/memory/jev-decisions.cjs');
const { buildFixtureStore, scope, asOf } = require('./fixtures/retrieval.cjs');

function countingProvider(provider) {
  const state = { embedCalls: 0, batches: [] };
  return { state, wrapped: { ...provider, embed: async texts => { state.embedCalls++; state.batches.push(texts.length); return provider.embed(texts); } } };
}

test('semantic stage is disabled by default and the manifest records why', async () => {
  const { store } = buildFixtureStore();
  const service = createRetrievalService({ store, embedding: createDoubaoEmbeddingProvider() });
  const { items, manifest } = await service.retrieve({ scope, query: '加班', asOf });
  assert.ok(items.length >= 1);
  assert.deepEqual(manifest.stages.semantic, { enabled: false, reason: 'disabled_by_default', provider: { name: 'doubao-embedding-vision', model: 'doubao-embedding-vision' } });
  assert.equal(manifest.baseline.thisRunIsBaseline, true);
  store.close();
});

test('synonym recall through the semantic layer while the same-input lexical baseline miss is retained', async () => {
  const { store } = buildFixtureStore();
  const local = createLocalTestEmbeddingProvider({ dims: 128, synonymSets: [['加班', '工作到很晚']] });
  const { state, wrapped } = countingProvider(local);
  const service = createRetrievalService({ store, embedding: wrapped });
  const comparison = await service.compareBaseline({ scope, query: '工作到很晚', asOf, limit: 10 });
  // Lexical bigrams cannot bridge the synonym pair: the baseline run misses.
  assert.deepEqual(comparison.baseline.itemIds, []);
  const added = comparison.diff.addedIds;
  assert.ok(added.includes('qq:1003'), 'semantic gap candidate recalled');
  assert.ok(added.some(id => id.startsWith('private:')), 'private consultation turn recalled semantically');
  assert.deepEqual(comparison.diff.removedIds, []);
  assert.equal(comparison.enhanced.manifest.stages.semantic.enabled, true);
  assert.equal(comparison.enhanced.manifest.stages.semantic.neverAdmittedOutsideLegalSet, true);
  assert.deepEqual(comparison.providers.embedding, { name: 'local-test-embedding', model: 'local-hash-bigram', enabled: true });
  // One batch embeds all missing legal rows plus the query; a second call
  // only re-embeds the query (revision-keyed vector cache).
  assert.equal(state.embedCalls, 1);
  assert.equal(state.batches[0] > 5, true, 'single batch: legal rows plus query');
  const repeat = await service.retrieve({ scope, query: '工作到很晚', asOf, limit: 10 });
  assert.deepEqual(repeat.items.map(item => item.id), comparison.enhanced.itemIds, 'cached vectors give identical results');
  assert.equal(state.embedCalls, 2);
  assert.deepEqual(state.batches[1], 1);
  store.close();
});

test('a vector hit can never admit a hard-filtered source', async () => {
  const { store } = buildFixtureStore();
  const local = createLocalTestEmbeddingProvider({ dims: 128 });
  const service = createRetrievalService({ store, embedding: local });
  // T0-only tier filter removes the semantically strongest private candidate.
  const tiered = await service.retrieve({ scope, query: '加班', asOf, tiers: ['T0'] });
  assert.equal(tiered.manifest.stages.semantic.enabled, true);
  assert.ok(tiered.items.every(item => item.kind === 'qq'));
  assert.equal(tiered.items.some(item => item.id.startsWith('private:')), false);
  // A recalled message is never embedded, never scored and never returned,
  // even when the query is its own withdrawn text.
  const withdrawnQuery = await service.retrieve({ scope, query: '这条被撤回的消息提到加班', asOf, limit: 50 });
  assert.equal(withdrawnQuery.items.some(item => item.id === 'qq:1004'), false);
  assert.equal(withdrawnQuery.manifest.tombstones.some(item => item.id === 'qq:1004'), true);
  store.close();
});

test('stale vector rows are dropped on revision change and re-embedded once', async () => {
  const { store, liveTurn } = buildFixtureStore();
  const local = createLocalTestEmbeddingProvider({ dims: 128 });
  const { state, wrapped } = countingProvider(local);
  const service = createRetrievalService({ store, embedding: wrapped });
  const first = await service.retrieve({ scope, query: '加班', asOf });
  const vectorsAfterFirst = service.indexStatus(scope).vectorRows;
  store.updateTurn(scope, liveTurn.id, '这周加班改成了正常下班节奏');
  const second = await service.retrieve({ scope, query: '加班', asOf });
  assert.ok(second.manifest.stages.semantic.staleDropped.includes(`private:${liveTurn.id}`));
  assert.equal(service.indexStatus(scope).vectorRows, vectorsAfterFirst, 'stale row dropped, new revision re-embedded');
  assert.ok(second.items.some(item => item.id === `private:${liveTurn.id}`));
  assert.equal(state.batches.at(-1), 2, 'batch contains query plus exactly the changed row');
  store.close();
});

test('doubao provider: disabled by default, environment-only keys, redacted errors, isolated hooks', async () => {
  const key = 'sk-test-SECRET-' + 'x'.repeat(20);
  process.env.ARK_API_KEY = key;
  try {
    const disabled = createDoubaoEmbeddingProvider();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.availability().reason, 'disabled_by_default');
    assert.equal(disabled.availability().hasApiKey, true);
    await assert.rejects(() => disabled.embed(['x']), /disabled by default/);
    // Even explicitly enabled, no real network without an injected hook.
    const noHook = createDoubaoEmbeddingProvider({ enabled: true });
    await assert.rejects(() => noHook.embed(['x']), /Real network disabled/);
    // Isolated hook path: key goes to the request only, never to errors.
    let seen = null;
    const hooked = createDoubaoEmbeddingProvider({ enabled: true, fetchImpl: async (url, options) => {
      seen = { url, authorization: options.headers.authorization, body: JSON.parse(options.body) };
      throw new Error(`upstream exploded with ${key}`);
    } });
    await assert.rejects(() => hooked.embed(['你好世界']), message => {
      assert.match(message.message, /upstream exploded/);
      assert.equal(message.message.includes(key), false, 'api key never leaks into errors');
      assert.equal(message.message.includes('SECRET'), false);
      return true;
    });
    assert.equal(seen.authorization, `Bearer ${key}`);
    assert.deepEqual(seen.body.input, ['你好世界']);
    const ok = createDoubaoEmbeddingProvider({ enabled: true, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) }) });
    const embedded = await ok.embed(['a']);
    assert.equal(Math.abs(cosineSimilarity(embedded.vectors[0], [0.1, 0.2, 0.3]) - 1) < 1e-9, true);
    assert.equal(ok.contractUnverified, true, 'endpoint contract stays marked unverified until an isolated trial confirms it');
  } finally { delete process.env.ARK_API_KEY; }
});

test('JEV decisions: batched, hash-cached, reorder-only, corrections protected, disabled by default', async () => {
  const { store } = buildFixtureStore();
  const correctionTurn = store.appendTurn(scope, { role: 'user', kind: 'correction', text: '更正：上次说的展览日期是下周' });
  const disabled = createJevDecisionProvider();
  assert.equal(disabled.availability().reason, 'disabled_by_default');
  const untouched = await createRetrievalService({ store }).retrieve({ scope, query: '加班', asOf });
  assert.equal(untouched.manifest.stages.jev, null);
  // The provider judges: demote qq:1003, demote the correction, boost the note.
  const judgments = { 'qq:1003': -0.9, [`private:${correctionTurn.id}`]: -0.9, 'note:note-material': 0.5 };
  const jev = createLocalTestJevProvider(judgments);
  const service = createRetrievalService({ store, jev });
  const query = '加班 展览 日期';
  const run2 = await service.retrieve({ scope, query, asOf, limit: 10 });
  assert.equal(jev.calls, 1, 'single batched decision call');
  assert.equal(run2.manifest.stages.jev.batched, true);
  assert.equal(run2.manifest.stages.jev.cached, false);
  const ids2 = run2.items.map(item => item.id);
  assert.ok(ids2.includes('qq:1003') && ids2.includes(`private:${correctionTurn.id}`), 'negative hints never drop items');
  assert.equal(run2.manifest.stages.jev.dropped, 0);
  assert.ok(run2.manifest.stages.jev.protectedIds.includes(`private:${correctionTurn.id}`), 'correction exempt from demotion');
  const demoted = run2.items.find(item => item.id === 'qq:1003');
  assert.equal(demoted.jevAdjustment < 0, true);
  assert.equal(demoted.matchedStages.includes('jev_adjusted'), true);
  const protectedItem = run2.items.find(item => item.id === `private:${correctionTurn.id}`);
  assert.equal(protectedItem.jevAdjustment, undefined);
  // Same input again: served from the hash cache, no new provider call.
  const run3 = await service.retrieve({ scope, query, asOf, limit: 10 });
  assert.equal(jev.calls, 1, 'unchanged input is change-triggered: cache hit');
  assert.equal(run3.manifest.stages.jev.cached, true);
  // Changed input triggers exactly one new batched call.
  await service.retrieve({ scope, query: query + ' 爬山', asOf, limit: 10 });
  assert.equal(jev.calls, 2);
  store.close();
});

test('JEV remote adapter redacts the environment key and refuses unverified network', async () => {
  const key = 'sk-or-test-SECRET-' + 'y'.repeat(20);
  process.env.OPENROUTER_API_KEY = key;
  try {
    const provider = createJevDecisionProvider({ enabled: true, fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${key}`);
      throw new Error(`decision endpoint failed ${key}`);
    } });
    await assert.rejects(() => provider.decide({ kind: 'candidate_relevance', question: 'q', candidates: [{ id: 'a', excerpt: 'e' }] }),
      message => { assert.equal(message.message.includes(key), false); assert.match(message.message, /decision endpoint failed/); return true; });
    const blocked = createJevDecisionProvider({ enabled: true });
    await assert.rejects(() => blocked.decide({ kind: 'candidate_relevance', question: 'q', candidates: [{ id: 'a', excerpt: 'e' }] }), /Real network disabled/);
    await assert.rejects(() => createJevDecisionProvider({ enabled: true }).decide({ kind: 'generate_reply', question: 'q', candidates: [{ id: 'a', excerpt: 'e' }] }), /narrow typed decisions/);
  } finally { delete process.env.OPENROUTER_API_KEY; }
});
