'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Store } = require('../src/store.cjs');
const { Controller } = require('./fixtures/whole-answer-fidelity.cjs');
const { createServer } = require('../src/server.cjs');
const { scope } = require('./fixtures/native.cjs');
test('private HTTP routes enforce scope and local auth, expose actual request, and keep raw QQ export separate', async t => {
  const store = new Store(':memory:');
  const settings = { auto: false, apiKey: 'synthetic', model: 'synthetic', baseUrl: 'http://fixture.invalid/v1',
    realChatConsent: { accountUid: scope.accountUid, peerUin: scope.peerUin, model: 'synthetic', baseUrl: 'http://fixture.invalid/v1' } };
  const controller = new Controller({ store, settings, read: async command => command === 'bind' ? scope : { source: 'synthetic', messages: [] },
    assistantModel: async (_,input) => input.payload.purpose==='fidelity_check' ? {checkRef:input.payload.checkRef,verdict:'allow',issues:[]} : ({ kind: 'discussion', text: '先从自己的真实近况想起。', stateReview:'no_change' }) });
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  await controller.bind(scope.peerUin);
  const server = createServer({ controller, token: 'synthetic-token', uiDir: path.resolve(__dirname, '../ui') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { controller.close(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, args) => fetch(base + route, { method: 'POST', headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const bound = { accountUid: scope.accountUid, peerUid: scope.peerUid };
  assert.equal((await fetch(base + '/api/assistant-context')).status, 401);
  for (const route of ['/api/assistant', '/api/goal', '/api/note', '/api/note-delete', '/api/turn-delete', '/api/feedback']) {
    const response = await post(route, { ...bound, peerUid: 'wrong', text: 'wrong scope' });
    assert.equal(response.status, 400, route);
    assert.match((await response.json()).error, /会话已改变/);
  }
  assert.equal(store.getCompanion(scope).turns.length, 0);
  assert.equal((await post('/api/goal', { ...bound, text: '希望交流自然，逐渐了解彼此' })).status, 200);
  const response = await post('/api/assistant', { ...bound, text: '想分享今天的小事', purpose: 'discussion' });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.companion.turns.length, 2);
  assert.equal(snapshot.total, 0);
  const inspect = await fetch(base + '/api/assistant-context', { headers: { Authorization: 'Bearer synthetic-token' } });
  const captured = await inspect.json();
  assert.equal(captured.run.payload.userRequest.text, '想分享今天的小事');
  assert.equal(captured.run.manifest.requestId, snapshot.companion.turns[1].requestId);
  assert.equal(captured.run.maintenance, 'reviewed_no_change');
  controller.configure({ instruction: '后来改变的旧快速回复指示' });
  assert.equal(controller.assistantContext().run.payload.userRequest.text, '想分享今天的小事', 'inspector does not recompute input');
  assert.deepEqual(JSON.parse(store.export(scope, 'json').data).messages, []);
});
