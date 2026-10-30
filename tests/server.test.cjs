'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer } = require('../src/server.cjs');
const { Store } = require('../src/store.cjs');
const { Controller } = require('./fixtures/assistant-protocol.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
test('loopback server gates records by token/origin and exposes no native send/dispatch API', async () => {
  const store = new Store(':memory:');
  const controller = new Controller({ store, read: async () => { throw new Error('Unexpected native call'); },
    settings: { apiKey: 'fixture-secret', model: 'fixture',baseUrl:'http://fixture.invalid/v1' } });
  controller.scope = scope; store.add(scope, [require('../src/messages.cjs').normalize(raw(), scope)]);
  const server = createServer({ controller, token: 'fixture-token', uiDir: path.resolve(__dirname, '../ui'),saveSettings(){},inspectDraft:async()=>({matchingWindows:1,windows:[{composers:1}]}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const headers = { Authorization: 'Bearer fixture-token' };
    const response = await fetch(`${base}/api/state`, { headers }); const state = await response.json();
    assert.equal(response.status, 200); assert.equal(state.total, 1);
    assert.equal(JSON.stringify(state).includes('fixture-secret'), false);
    assert.equal((await fetch(`${base}/api/state`, { headers: { ...headers, Origin: 'https://example.org' } })).status, 403);
    for (const route of ['/api/send', '/api/send_private_msg', '/api/invoke', '/api/forward', '/api/dispatch'])
      assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers, body: '{}' })).status, 404);
    const consent={allow:true,accountUid:scope.accountUid,peerUin:scope.peerUin,baseUrl:'http://fixture.invalid/v1',model:'fixture'};
    for(const wrong of [{accountUid:'u_other'},{peerUin:'2222222222'},{baseUrl:'http://other.invalid/v1'},{model:'other'}]) {
      const stale=await fetch(`${base}/api/consent`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({...consent,...wrong})});
      assert.notEqual(stale.status,200);assert.equal(controller.settings.realChatConsent,undefined);
    }
    const accepted=await fetch(`${base}/api/consent`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(consent)});
    assert.equal(accepted.status,200);assert.equal(controller.settings.realChatConsent.peerUin,scope.peerUin);
    const desktop=await(await fetch(`${base}/api/desktop`,{headers})).json();assert.equal(desktop.matchingWindows,1);
    const exported = await (await fetch(`${base}/api/export?format=json`, { headers })).json();
    assert.equal(exported.messages[0].messageId, '72057594037927937');
    const html = await fetch(base); assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally { controller.close(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
