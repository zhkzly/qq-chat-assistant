'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, normalizeMetadataReviewPending } = require('../src/store.cjs');
const { scope } = require('./fixtures/native.cjs');
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Synthetic current intent' });
  const source = store.memorySources(scope).find(s => s.id === `private:${turn.id}`);
  const marker = { reasonCode: 'auxiliary_metadata_rejected', sourceIds: [source.id], sourceRevisions: { [source.id]: source.revision } };
  return { store, turn, source, marker };
}
test('auxiliary rejection markers persist as bound assistant program metadata, not factual sources', t => {
  const { store, source, marker } = fixture(t);
  const answer = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: 'Readable truthful advice',
    sourceIds: [source.id], metadataReviewPending: marker });
  assert.deepEqual(answer.metadataReviewPending, marker);
  assert.equal(answer.responseRecovery, undefined);
  assert.equal(answer.privateReviewReceipt, undefined);
  assert.equal(store.memorySources(scope).some(s => s.id === `private:${answer.id}`), false);
  assert.deepEqual(store.getCompanion(scope).turns.find(t => t.id === answer.id).metadataReviewPending, marker);
});
test('pending markers reject unbound, stale, forged, multiple or apparently reviewed intent', t => {
  const { store, source, marker } = fixture(t);
  const base = { role: 'assistant', kind: 'discussion', text: 'Synthetic advice', sourceIds: [source.id] };
  for (const value of [
    { ...marker, reasonCode: 'made_up' }, { ...marker, sourceIds: [] },
    { ...marker, sourceIds: [source.id, 'private:other'] },
    { ...marker, sourceIds: ['qq:900'], sourceRevisions: { 'qq:900': 'fake' } },
    { ...marker, sourceRevisions: {} }, { ...marker, sourceRevisions: { [source.id]: 'old-revision' } }
  ]) assert.throws(() => store.appendTurn(scope, { ...base, metadataReviewPending: value }), /metadata|source|revision/i);
  assert.throws(() => store.appendTurn(scope, { ...base, sourceIds: [], metadataReviewPending: marker }), /source/i);
  assert.throws(() => store.appendTurn(scope, { ...base, metadataReviewPending: marker,
    privateReviewReceipt: { applied: true, sourceIds: [source.id] } }), /pending|review/i);
  assert.throws(() => store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Synthetic text', metadataReviewPending: marker }), /assistant|metadata/i);
  store.updateTurn(scope, source.id.slice('private:'.length), 'Corrected synthetic current intent');
  assert.throws(() => store.appendTurn(scope, { ...base, metadataReviewPending: marker }), /source|revision/i);
});
test('marker normalizer requires an exact single revision binding and has no unrelated authority fields', t => {
  const { marker } = fixture(t);
  assert.deepEqual(normalizeMetadataReviewPending(marker), marker);
  assert.throws(() => normalizeMetadataReviewPending({ ...marker, metadataApplied: true }), /metadata/i);
  assert.throws(() => normalizeMetadataReviewPending({ ...marker, sourceRevisions: { ...marker.sourceRevisions, 'private:foreign': 'fake' } }), /metadata|source/i);
});
test('canonical local feedback can bind a pending review while actual action receipts remain independently recorded', t => {
  const { store, source } = fixture(t);
  const original = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: 'Synthetic evaluated answer', sourceIds: [source.id] });
  const feedback = store.addFeedback(scope, { text: 'Synthetic local correction', targetRef: { kind: 'artifact', artifactRef: original.artifactRef } });
  const current = store.memorySources(scope).find(s => s.id === feedback.sourceId);
  const marker = { reasonCode: 'auxiliary_metadata_rejected', sourceIds: [current.id], sourceRevisions: { [current.id]: current.revision } };
  const receipts = [{ id: 'synthetic-action-receipt', status: 'applied', type: 'save_note' }];
  const answer = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: 'Synthetic corrected help',
    sourceIds: [current.id], metadataReviewPending: marker, actionReceipts: receipts });
  assert.deepEqual(answer.metadataReviewPending, marker);
  assert.deepEqual(answer.actionReceipts, receipts);
  assert.equal(store.getCompanion(scope).notes.length, 0, 'a pending marker does not apply the action described by a receipt');
});
