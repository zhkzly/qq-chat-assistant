'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { normalize, compare, qqSourceMetadata } = require('../src/messages.cjs');
const { Store } = require('../src/store.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

// Synthetic values in the maintained ReplyElement contract. Native spellings:
// replayMsgId, replayMsgSeq, sourceMsgIdInRecords, senderUin, senderUidStr.
// Receive-side sourceMsgIdInRecords addresses msg.records, not raw.msgId.
const targetId = '720575940379279391';
function quoted(reply = {}, overrides = {}) {
  return raw('720575940379279392', false, { elements: [
    { replyElement: { replayMsgId: targetId, replayMsgSeq: '90071992547409931', senderUin: scope.accountUin,
      senderUidStr: scope.accountUid, ...reply } },
    { textElement: { content: 'Synthetic reply' } }
  ], ...overrides });
}
function storeFixture(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }

test('native replies retain original target ID, sequence and scoped author without copying quote previews', () => {
  const message = normalize(quoted({ sourceMsgIdInRecords: targetId, sourceMsgText: 'PRIVATE_QUOTE_PREVIEW',
    sourceMsgTextElems: [{ textElemContent: 'PRIVATE_QUOTE_BODY' }] }), scope);
  assert.deepEqual(message.replyTo, { messageId: targetId, sequence: '90071992547409931',
    senderUid: scope.accountUid, senderUin: scope.accountUin, direction: 'outgoing' });
  assert.equal(message.senderUid, scope.peerUid);
  assert.equal(message.text, '[引用消息]Synthetic reply');
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE_QUOTE/);
  assert.deepEqual(qqSourceMetadata(message), { sequence: message.sequence, senderUid: scope.peerUid,
    senderUin: scope.peerUin, replyTo: message.replyTo });
});

test('zero native reply IDs preserve a sequence-plus-author reference without inventing an ID', () => {
  const message = normalize(quoted({ replayMsgId: '0', sourceMsgIdInRecords: '0' }), scope);
  assert.deepEqual(message.replyTo, { sequence: '90071992547409931', senderUid: scope.accountUid,
    senderUin: scope.accountUin, direction: 'outgoing' });
  assert.equal(message.replyTo.messageId, undefined);
  const recordsId = normalize(quoted({ replayMsgId: '0', sourceMsgIdInRecords: targetId }), scope);
  assert.equal(recordsId.replyTo.messageId, undefined, 'embedded record IDs are not canonical QQ message IDs');
  assert.equal(recordsId.replyTo.sequence, '90071992547409931');
  const uinOnly = normalize(quoted({ replayMsgId: '0', senderUidStr: undefined }), scope);
  assert.equal(uinOnly.replyTo.senderUid, scope.accountUid);
  assert.equal(uinOnly.replyTo.senderUin, scope.accountUin);
});
test('canonical replay IDs remain authoritative when the embedded records reference uses a different namespace', () => {
  const message = normalize(quoted({ sourceMsgIdInRecords: '99999999999999991' }), scope);
  assert.equal(message.replyTo.messageId, targetId);
  assert.equal(message.replyTo.sequence, '90071992547409931');
  assert.equal(message.replyTo.sourceMsgIdInRecords, undefined);
  assert.equal(qqSourceMetadata(message).replyTo.messageId, targetId);
});
test('received UID-only sequence pointers preserve validated Unix reply time in normalized sources', () => {
  const seconds = String(Number(raw().msgTime) - 1), timestamp = Number(seconds) * 1000;
  for (const replayMsgId of [targetId, '0']) {
    // Derived from the bounded native metadata shape: senderUidStr present,
    // senderUin absent, embedded record reference not a canonical cache ID.
    const message = normalize(quoted({ replayMsgId, sourceMsgIdInRecords: '99999999999999991',
      senderUin: undefined, replyMsgTime: seconds }), scope);
    assert.equal(message.replyTo.timestamp, timestamp);
    assert.equal(message.replyTo.senderUid, scope.accountUid);
    assert.equal(message.replyTo.senderUin, scope.accountUin);
    assert.equal(message.replyTo.messageId, replayMsgId === '0' ? undefined : targetId);
    assert.deepEqual(qqSourceMetadata(message).replyTo, message.replyTo);
  }
  for (const replyMsgTime of [undefined, '', '0', '-1', '1.5', 1791726000, '9007199254740993'])
    assert.equal(normalize(quoted({ replyMsgTime }), scope).replyTo.timestamp, undefined, 'unknown or invalid time is not an invented anchor');
});

test('unusable and conflicting native quote metadata stays explicitly unknown; recalled messages expose no quote', () => {
  const failures = [
    { replayMsgId: 720575940379279400, replayMsgSeq: '0', sourceMsgIdInRecords: '0' },
    { replayMsgId: '0', replayMsgSeq: '0', sourceMsgIdInRecords: '0' },
    { replayMsgId: '0', replayMsgSeq: '0', sourceMsgIdInRecords: targetId },
    { senderUidStr: 'u_foreign', senderUin: '1234567890' },
    { senderUidStr: scope.peerUid, senderUin: scope.accountUin },
    { replayMsgId: '0', senderUidStr: undefined, senderUin: '0' }
  ];
  for (const reply of failures) assert.deepEqual(normalize(quoted(reply), scope).replyTo, { targetUnavailable: true });
  const multiple = quoted({}, { elements: [{ replyElement: quoted().elements[0].replyElement },
    { replyElement: { ...quoted().elements[0].replyElement, replayMsgId: '720575940379279399' } }] });
  assert.deepEqual(normalize(multiple, scope).replyTo, { targetUnavailable: true });
  const recalled = normalize(quoted({}, { recallTime: '1' }), scope);
  assert.equal(recalled.replyTo, undefined);
  assert.equal(qqSourceMetadata(recalled).replyTo, undefined);
  assert.equal(recalled.text, '[已撤回]');
});

test('actual same-second order uses string sequence before message ID and survives Store projection', t => {
  const store = storeFixture(t);
  const first = normalize(raw('720575940379279399', true, { msgSeq: '90071992547409931' }), scope);
  const second = normalize(raw('720575940379279391', false, { msgSeq: '90071992547409932' }), scope);
  assert.ok(compare(first, second) < 0);
  store.add(scope, [second, first]);
  assert.deepEqual(store.messages(scope).map(m => m.messageId), [first.messageId, second.messageId]);
  assert.deepEqual(store.memorySources(scope).filter(s => s.type === 'qq').map(s => s.sequence), [first.sequence, second.sequence]);
});

test('ordering/author enrichment keeps legacy source revisions, derived memory and assistant artifacts intact', t => {
  const store = storeFixture(t), message = normalize(raw(targetId, true, { msgSeq: '90071992547409931' }), scope);
  const legacyMessage = { ...message }; delete legacyMessage.senderUid;
  store.add(scope, [legacyMessage]);
  const oldSource = { id: `qq:${targetId}`, type: 'qq', text: message.text, at: new Date(message.timestamp).toISOString(),
    role: 'user', direction: 'outgoing', use: 'discussion', messageId: targetId };
  const oldRevision = createHash('sha256').update(JSON.stringify(oldSource)).digest('hex');
  const beforeSource = store.memorySources(scope)[0];
  assert.equal(beforeSource.revision, oldRevision);
  const batch = store.memoryBatch(scope);
  assert.equal(store.applyMemoryBatch(scope, batch, { reviewedSourceIds: batch.reviewedSourceIds,
    items: [{ kind: 'fact', text: 'Synthetic sourced memory', sourceIds: [oldSource.id] }], episodes: [], retire: [] }).applied, true);
  store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Synthetic private request' });
  const answer = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: 'Synthetic preserved advice', sourceIds: [oldSource.id] });
  const companion = store.getCompanion(scope);
  assert.equal(store.applyState(scope, { focus: 'Synthetic focus', items: [{ text: 'Synthetic current state', sourceIds: [oldSource.id] }] },
    { baseRevision: companion.revision, sourceIds: [oldSource.id], coverage: { complete: false, sourceIds: [oldSource.id] } }).applied, true);
  const pending = store.memoryStatus(scope).pending;
  assert.equal(store.add(scope, [{ ...message, sequence: '90071992547409932' }]), 1);
  const after = store.memorySources(scope).find(s => s.id === oldSource.id);
  assert.equal(after.revision, oldRevision);
  assert.equal(after.sequence, '90071992547409932');
  assert.equal(after.senderUid, scope.accountUid);
  assert.equal(store.memoryStatus(scope).pending, pending);
  assert.equal(store._memoryRecords(scope).length, 1);
  assert.ok(store.getCompanion(scope).turns.some(t => t.id === answer.id));
  assert.equal(store.getCompanion(scope).state.focus, 'Synthetic focus');
  const persisted = JSON.parse(store.db.prepare('SELECT record FROM memory_sources WHERE scope_key=? AND source_id=?').get(store.scopeKey(scope), oldSource.id).record);
  assert.equal(persisted.sequence, after.sequence);
});

test('changing a quote target changes source evidence while a forgotten/recalled target remains unavailable separately', t => {
  const store = storeFixture(t), target = normalize(raw(targetId, true), scope), message = normalize(quoted(), scope);
  store.add(scope, [target, message]);
  const sourceId = `qq:${message.messageId}`, before = store.memorySources(scope).find(s => s.id === sourceId);
  assert.equal(before.replyTo.messageId, targetId);
  store.forgetSource(scope, `qq:${targetId}`);
  const availableReply = store.memorySources(scope).find(s => s.id === sourceId);
  assert.ok(availableReply);
  assert.equal(availableReply.replyTo.targetUnavailable, undefined, 'loaded-target availability is not stored as native pointer metadata');
  assert.equal(store.memorySources(scope).some(s => s.id === `qq:${targetId}`), false);
  store.add(scope, [normalize(quoted({ replayMsgId: '720575940379279399' }), scope)]);
  const changed = store.memorySources(scope).find(s => s.id === sourceId);
  assert.notEqual(changed.revision, before.revision);
  assert.equal(changed.replyTo.messageId, '720575940379279399');
  assert.doesNotMatch(JSON.stringify(changed), /Synthetic actual outgoing/);
  store.add(scope, [normalize(raw('720575940379279399', true, { recallTime: '1' }), scope)]);
  assert.equal(store.memorySources(scope).some(s => s.id === 'qq:720575940379279399'), false);
});
test('sequence-only quote target changes are semantic evidence rather than top-level ordering enrichment', t => {
  const store = storeFixture(t), message = normalize(quoted({ replayMsgId: '0' }), scope);
  store.add(scope, [message]);
  const sourceId = `qq:${message.messageId}`, before = store.memorySources(scope).find(s => s.id === sourceId);
  store.add(scope, [normalize(quoted({ replayMsgId: '0', replayMsgSeq: '90071992547409932' }), scope)]);
  const after = store.memorySources(scope).find(s => s.id === sourceId);
  assert.equal(after.replyTo.messageId, undefined);
  assert.equal(after.replyTo.sequence, '90071992547409932');
  assert.notEqual(after.revision, before.revision);
});
test('reply-time anchor changes revise quote evidence and survive Store source projection', t => {
  const store = storeFixture(t), seconds = String(Number(raw().msgTime) - 1);
  const message = normalize(quoted({ replayMsgId: '0', sourceMsgIdInRecords: '99999999999999991', replyMsgTime: seconds, senderUin: undefined }), scope);
  store.add(scope, [message]);
  const sourceId = `qq:${message.messageId}`, before = store.memorySources(scope).find(s => s.id === sourceId);
  assert.equal(before.replyTo.messageId, undefined); assert.equal(before.replyTo.timestamp, Number(seconds) * 1000);
  store.add(scope, [normalize(quoted({ replayMsgId: '0', replyMsgTime: String(Number(seconds) - 1), senderUin: undefined }), scope)]);
  const after = store.memorySources(scope).find(s => s.id === sourceId);
  assert.equal(after.replyTo.timestamp, (Number(seconds) - 1) * 1000); assert.notEqual(after.revision, before.revision);
});
