'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store.cjs');
const { Controller } = require('../src/controller.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

function sources(store) {
  const user = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'I want to understand what I mean first.' });
  const note = store.saveNote(scope, { text: 'I visited an exhibition.', use: 'discussion' });
  const message = normalize(raw(), scope); store.add(scope, [message]);
  return { user, note, message, ids: [`private:${user.id}`, `note:${note.id}`, `qq:${message.messageId}`] };
}
function derive(store, ids) {
  const baseRevision = store.getCompanion(scope).revision;
  const result = store.applyState(scope, { focus: 'Find a natural topic', items: [{ text: 'A real observation', sourceIds: ids }], openThreads: [{ text: 'A pending question', sourceIds: ids, status: 'open' }], unknowns: ['Whether this is a good time'] }, { baseRevision, sourceIds: ids, coverage: { complete: true, sourceIds: ids } });
  assert.equal(result.applied, true);
  store.saveRun(scope, { requestId: 'request-1', payload: { text: 'derived private material' }, sourceIds: ids });
  store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: 'Derived private material', sourceIds: ids });
}

test('private streams persist and are isolated by all four scope fields; exports remain actual-only', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-companion-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.sqlite'); let store = new Store(file);
  const initial = store.getCompanion(scope); assert.equal(initial.goal.version, 0);
  assert.deepEqual(initial.turns, []); store.setGoal(scope, 'Develop mutual understanding');
  const { ids } = sources(store); derive(store, ids);
  const revision = store.getCompanion(scope).revision;
  store.addFeedback(scope, { requestId: 'request-1', text: 'Too formal', kind: 'local' });
  assert.ok(store.getCompanion(scope).revision >= revision);
  const exported = JSON.parse(store.export(scope, 'json').data);
  assert.equal(exported.messages.length, 1); assert.equal(exported.messages[0].kind, 'actual');
  assert.equal(JSON.stringify(exported).includes('Derived private material'), false);
  for (const key of ['accountUid', 'accountUin', 'peerUid', 'peerUin']) {
    const other = { ...scope, [key]: `${scope[key]}-different` };
    assert.equal(store.getCompanion(other).goal.version, 0);
    assert.deepEqual(store.getCompanion(other).notes, []);
  }
  store.close(); store = new Store(file); t.after(() => store.close());
  assert.equal(store.getCompanion(scope).goal.text, 'Develop mutual understanding');
  assert.equal(store.getCompanion(scope).turns.filter(t=>t.kind!=='feedback_ref').length, 2);
  assert.equal(store.getCompanion(scope).turns.filter(t=>t.kind==='feedback_ref').length, 1);
  assert.equal(store.getCompanion(scope).feedback[0].text, 'Too formal');
});

test('scope and source provenance cannot be supplied by incomplete or cross-contact objects', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const key of ['accountUid', 'accountUin', 'peerUid', 'peerUin']) {
    const missing = { ...scope }; delete missing[key];
    assert.throws(() => store.getCompanion(missing), /scope/i);
    assert.throws(() => store.saveNote({ ...scope, [key]: 123 }, { text: 'bad', use: 'discussion' }), /scope/i);
  }
  const assistant = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: 'Maybe she likes hiking' });
  const note = store.saveNote({ ...scope, peerUid: 'another-contact' }, { text: 'foreign', use: 'draft' });
  for (const id of [`private:${assistant.id}`, `note:${note.id}`, 'qq:123']) {
    assert.equal(store.applyState(scope, { items: [{ text: 'False fact', sourceIds: [id] }] }, { baseRevision: store.getCompanion(scope).revision, sourceIds: [id], coverage: { complete: true, sourceIds: [id] } }).applied, false);
  }
});

test('CAS and patch allowlist preserve user authority; reviewed no-change advances complete coverage', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const { ids } = sources(store);
  const baseRevision = store.getCompanion(scope).revision;
  const options = { baseRevision, sourceIds: ids, coverage: { complete: true, sourceIds: ids } };
  for (const patch of [{ goal: { text: 'Override' } }, { authorization: true }, { items: [{ text: 'Invented', sourceIds: ['qq:unknown'] }] }, { items: [{ text: 'Uncited', sourceIds: [] }] }, { openThreads: [{ text: 'Override', sourceIds: ids, shared: true }] }]) {
    assert.equal(store.applyState(scope, patch, options).applied, false);
  }
  assert.equal(store.applyState(scope, {}, options).applied, true);
  assert.equal(store.getCompanion(scope).state.possiblyStale, false);
  assert.deepEqual(store.getCompanion(scope).state.coverage.sourceIds, ids);
  assert.equal(store.getCompanion(scope).revision, baseRevision);
  assert.equal(store.applyState(scope, {}, { ...options, baseStateVersion: 0 }).reason, 'stale_state_version');
  assert.equal(store.getCompanion(scope).state.version, 1);
  store.setGoal(scope, 'A changed user goal');
  assert.equal(store.applyState(scope, { focus: 'Old task' }, options).reason, 'stale_revision');
  assert.equal(store.getCompanion(scope).goal.text, 'A changed user goal');
  assert.throws(() => store.saveRun(scope, { requestId: 'late-result', baseRevision, payload: 'outdated material' }), /Stale run revision/);
});

test('partial coverage cannot claim all sources were consumed; new messages mark state stale', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const { ids } = sources(store);
  const baseRevision = store.getCompanion(scope).revision;
  assert.equal(store.applyState(scope, {}, { baseRevision, sourceIds: ids.slice(0, 1), coverage: { complete: true, sourceIds: ids.slice(0, 1) } }).applied, true);
  assert.equal(store.getCompanion(scope).state.possiblyStale, true);
  assert.equal(store.getCompanion(scope).state.coverage.complete, false);
  derive(store, ids); const before = store.getCompanion(scope);
  store.add(scope, [normalize(raw('72057594037927939'), scope)]);
  const after = store.getCompanion(scope); assert.equal(after.revision, before.revision + 1);
  assert.equal(after.state.possiblyStale, true); assert.equal(after.turns.length, before.turns.length);
});

test('material edit, permission shrink, and deletion scrub derived copies without deleting actual chat', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const data = sources(store);
  for (const change of [() => store.saveNote(scope, { id: data.note.id, text: 'Corrected exhibition', use: 'discussion' }), () => store.saveNote(scope, { id: data.note.id, text: 'Corrected exhibition', use: 'disabled' }), () => store.deleteNote(scope, data.note.id)]) {
    const note = store.getCompanion(scope).notes.find(n => n.id === data.note.id);
    const ids = note?.use !== 'disabled' ? data.ids : data.ids.filter(id => !id.startsWith('note:'));
    derive(store, ids); change(); const current = store.getCompanion(scope);
    assert.deepEqual(current.state.items, []); assert.deepEqual(current.state.openThreads, []);
    assert.deepEqual(current.runs, []); assert.equal(current.turns.length, 1);
    assert.equal(current.turns[0].role, 'user'); assert.equal(store.messages(scope).length, 1);
  }
  assert.equal(store.getCompanion(scope).notes.length, 0);
});

test('deleting a private user source invalidates derived copies and retains unrelated sources', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const { user, ids } = sources(store); derive(store, ids);
  assert.equal(store.deleteTurn(scope, user.id), true);
  const current = store.getCompanion(scope); assert.deepEqual(current.turns, []); assert.deepEqual(current.runs, []);
  assert.equal(current.notes.length, 1); assert.equal(store.messages(scope).length, 1);
  const revision = current.revision; assert.equal(store.deleteTurn(scope, user.id), false);
  assert.equal(store.getCompanion(scope).revision, revision);
});

test('QQ correction and recall invalidate state and cached advice, and recalled text cannot support facts', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const { message, ids } = sources(store); derive(store, ids);
  store.add(scope, [{ ...message, text: 'Corrected actual observation' }]);
  let current = store.getCompanion(scope); assert.deepEqual(current.runs, []); assert.deepEqual(current.state.items, []);
  derive(store, ids); store.add(scope, [{ ...message, text: '[已撤回]', recalled: true, media: [] }]);
  current = store.getCompanion(scope); assert.deepEqual(current.runs, []); assert.equal(current.turns.length, 1);
  assert.equal(store.applyState(scope, { items: [{ text: 'Recalled fact', sourceIds: [ids[2]] }] }, { baseRevision: current.revision, sourceIds: [ids[2]], coverage: { complete: true, sourceIds: [ids[2]] } }).applied, false);
  assert.equal(store.messages(scope)[0].messageId, message.messageId);
});

test('failed QQ batches roll back companion revision and message mutations together', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const { message, ids } = sources(store); derive(store, ids);
  const before = store.getCompanion(scope);
  assert.throws(() => store.add(scope, [{ ...message, text: 'Never committed' }, { ...message, messageId: 'other', kind: 'draft' }]), /provenance/);
  assert.deepEqual(store.getCompanion(scope), before);
  assert.equal(store.messages(scope)[0].text, message.text);
});

test('SQLite state CAS rejects a second connection committing after the initial version read', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-companion-race-'));
  const file = path.join(dir, 'state.sqlite'); const first = new Store(file), second = new Store(file);
  t.after(() => { first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { ids } = sources(first);
  const options = { baseRevision: first.getCompanion(scope).revision, baseStateVersion: 0, sourceIds: ids, coverage: { complete: true, sourceIds: ids } };
  const readSources = first._sourceIds.bind(first);
  first._sourceIds = (...args) => {
    assert.equal(second.applyState(scope, { focus: 'Already committed' }, options).applied, true);
    return readSources(...args);
  };
  assert.equal(first.applyState(scope, { focus: 'Late overwrite' }, options).reason, 'stale_state_version');
  assert.equal(first.getCompanion(scope).state.focus, 'Already committed');
});

test('run completion replaces its pending record and retention removes only old derived runs', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const { user, message } = sources(store);
  const revision = store.getCompanion(scope).revision;
  const pending = store.saveRun(scope, { id: 'same-request', requestId: 'same-request', status: 'pending', payload: 'pending input' });
  const complete = store.saveRun(scope, { id: 'same-request', requestId: 'same-request', status: 'complete', payload: 'final input' });
  let current = store.getCompanion(scope);
  assert.equal(current.runs.length, 1); assert.equal(current.runs[0].status, 'complete');
  assert.equal(current.runs[0].payload, 'final input'); assert.equal(complete.createdAt, pending.createdAt);
  for (let n = 0; n < 15; n++) store.saveRun(scope, { id: `run-${n}`, payload: `bounded cache ${n}` });
  current = store.getCompanion(scope); assert.equal(current.runs.length, 12);
  assert.deepEqual(current.runs.map(run => run.id), Array.from({ length: 12 }, (_, n) => `run-${n + 3}`));
  store.saveRun(scope, { id: 'run-3', status: 'complete' });
  assert.equal(store.getCompanion(scope).runs.at(-1).id, 'run-3');
  assert.equal(store.getCompanion(scope).runs.length, 12);
  assert.equal(current.revision, revision); assert.equal(current.turns[0].id, user.id);
  assert.equal(store.messages(scope)[0].messageId, message.messageId);
});

test('feedback must reference a retained run or assistant response in this scope', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const other = { ...scope, peerUid: 'other-peer' };
  store.saveRun(other, { id: 'foreign-request' });
  store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'A user request', requestId: 'user-only' });
  for (const requestId of ['missing', 'foreign-request', 'user-only']) {
    assert.throws(() => store.addFeedback(scope, { requestId, text: 'Cannot bind' }), /feedback request/i);
  }
  store.saveRun(scope, { id: 'run-id', requestId: 'retained-request' });
  store.addFeedback(scope, { requestId: 'retained-request', text: 'Too formal' });
  store.addFeedback(scope, { requestId: 'run-id', text: 'Too long' });
  store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: 'A retained response', requestId: 'older-response' });
  store.addFeedback(scope, { requestId: 'older-response', text: 'This was useful' });
  assert.equal(store.getCompanion(scope).feedback.length, 3);
});

test('compact state rejects oversized fields without changing the previous state', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const { ids } = sources(store);
  const options = { baseRevision: store.getCompanion(scope).revision, sourceIds: ids, coverage: { complete: true, sourceIds: ids } };
  const item = { text: 'x'.repeat(1000), sourceIds: ids };
  const accepted = { focus: 'x'.repeat(1000), items: Array(16).fill(item), openThreads: Array(16).fill(item), unknowns: Array(12).fill('x'.repeat(1000)) };
  assert.equal(store.applyState(scope, accepted, options).applied, true);
  const before = store.getCompanion(scope).state;
  for (const patch of [{ items: Array(17).fill(item) }, { openThreads: Array(17).fill(item) }, { unknowns: Array(13).fill('unknown') }, { items: [{ ...item, text: 'x'.repeat(1001) }] }, { openThreads: [{ ...item, text: 'x'.repeat(1001) }] }, { unknowns: ['x'.repeat(1001)] }, { focus: 'x'.repeat(1001) }]) {
    const result = store.applyState(scope, patch, options);
    assert.equal(result.applied, false); assert.match(result.detail, /1000|16|12/);
    assert.deepEqual(store.getCompanion(scope).state, before);
  }
});

test('a late native history page cannot restore content after a live QQ recall', async t => {
  const store = new Store(':memory:'); let finishHistory;
  const controller = new Controller({ store, settings: {}, read: () => new Promise(resolve => { finishHistory = resolve; }) });
  t.after(() => { controller.close(); store.close(); }); controller.scope = scope;
  const { ids, message } = sources(store); derive(store, ids);
  const loading = controller.loadLatest();
  controller.live({ scope, messages: [{ ...raw(), recallTime: '1' }] });
  const recalledRevision = store.getCompanion(scope).revision;
  assert.equal(store.messages(scope)[0].recalled, true);
  finishHistory({ messages: [raw()], source: 'synthetic-delayed-native-history' }); await loading;
  const current = store.getCompanion(scope), record = store.messages(scope)[0];
  assert.equal(record.messageId, message.messageId); assert.equal(record.recalled, true);
  assert.equal(record.text, '[已撤回]'); assert.equal(current.revision, recalledRevision);
  assert.equal(store._sourceIds(scope).has(`qq:${message.messageId}`), false);
  assert.deepEqual(current.runs, []); assert.deepEqual(current.state.items, []);
  assert.equal(current.turns.every(turn => turn.role === 'user'), true);
  assert.equal(JSON.parse(store.export(scope, 'json').data).messages[0].text, '[已撤回]');
});
