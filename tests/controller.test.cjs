'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('./fixtures/assistant-protocol.cjs');
const { Store } = require('../src/store.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(assistantModel) {
  const store = new Store(':memory:'); let selected = scope, calls = [];
  const controller = new Controller({ store, settings: { apiKey: 'fixture', model: 'fixture', baseUrl:'http://fixture.invalid/v1', realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,baseUrl:'http://fixture.invalid/v1',model:'fixture'} }, assistantModel,
    read: async (command, args) => {
      calls.push({ command, args });
      if (command === 'bind') { selected = { ...scope, peerUin: args.uin, peerUid: args.uin === scope.peerUin ? scope.peerUid : 'u_second' }; return selected; }
      if (command === 'latest') return { source: 'fixture', messages: [{ ...raw(), peerUin: selected.peerUin, peerUid: selected.peerUid,
        senderUin: selected.peerUin, senderUid: selected.peerUid }] };
      return { source: 'fixture', messages: [] };
    } });
  controller.auto = false; controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  return { store, controller, calls, close() { controller.close(); store.close(); } };
}
test('binding auto-loads history and reaches an explicit accessible boundary', async () => {
  const app = setup(); await app.controller.bind(scope.peerUin); await tick();
  assert.equal(app.controller.snapshot().total, 1); assert.ok(app.calls.some(c => c.command === 'older'));
  assert.equal(app.controller.snapshot().coverage.status, 'accessible_end'); app.close();
});
test('incoming and manually sent events update selected context; unrelated and failed messages do not', async () => {
  const app = setup(); await app.controller.bind(scope.peerUin); await tick();
  app.controller.live({ scope, messages: [raw('72057594037927939'), raw('72057594037927940', true)] });
  assert.equal(app.controller.snapshot().total, 3);
  app.controller.live({ scope: { ...scope, peerUid: 'u_other' }, messages: [raw('72057594037927941')] });
  app.controller.live({ scope, messages: [raw('72057594037927942', true, { sendStatus: 0 })] });
  assert.equal(app.controller.snapshot().total, 3); app.close();
});
test('deferred model result from prior contact is discarded after switching', async () => {
  let resolve; const app = setup(() => new Promise(r => { resolve = r; }));
  await app.controller.bind(scope.peerUin); await tick(); const generating = app.controller.suggest(); await tick();
  assert.equal(typeof resolve, 'function', 'the request must reach the deferred model before switching');
  await app.controller.bind('2222222222'); await tick();
  resolve({ kind: 'discussion', text: 'old' }); await generating;
  assert.equal(app.controller.advice, null); assert.equal(app.controller.scope.peerUin, '2222222222'); app.close();
});
test('model results must match latest message revision and current user instruction', async () => {
  let resolve; const app = setup(() => new Promise(r => { resolve = r; }));
  await app.controller.bind(scope.peerUin); await tick(); const first = app.controller.suggest(); await tick();
  assert.equal(typeof resolve, 'function');
  app.controller.live({ scope, messages: [raw('72057594037927940')] });
  resolve({ kind: 'discussion', text: 'stale' }); await first; assert.equal(app.controller.advice, null);
  resolve = undefined; const second = app.controller.suggest(); await tick(); assert.equal(typeof resolve, 'function'); app.controller.configure({ instruction: '更简短' });
  resolve({ kind: 'discussion', text: 'wrong instruction' }); await second; assert.equal(app.controller.advice, null); app.close();
});
test('history errors preserve partial records and surface an error, never claim EOF', async () => {
  const app = setup(); await app.controller.bind(scope.peerUin); await tick();
  app.controller.read = async () => { throw new Error('native-error-91'); };
  await app.controller.loadOlder();
  assert.equal(app.controller.snapshot().total, 1); assert.equal(app.controller.snapshot().coverage.status, 'read_error');
  assert.match(app.controller.error, /native-error-91/); app.close();
});
test('cached history begins pagination at newest returned page to fill offline gaps', async () => {
  const app = setup(); app.store.add(scope, [require('../src/messages.cjs').normalize(raw('72057594037927000'), scope)]);
  await app.controller.bind(scope.peerUin); await tick();
  const older = app.calls.find(c => c.command === 'older');
  assert.equal(older.args.cursor, '72057594037927937'); app.close();
});

test('closed helper retains context but never schedules background model calls',async(t)=>{
 let calls=0;const app=setup(async()=>{calls++;return {kind:'discussion',text:'fixture'}});
 await app.controller.bind(scope.peerUin);await tick();
 t.mock.timers.enable({apis:['setTimeout']});app.controller.auto=true;app.controller.setVisible(false);
 app.controller.schedule();t.mock.timers.tick(2500);await tick();assert.equal(calls,0);assert.equal(app.controller.snapshot().total,1);
 t.mock.timers.reset();app.close();
});

test('model cannot receive real context until destination and selected-account/contact consent matches',async()=>{
 let calls=0;const app=setup(async()=>{calls++;return {kind:'discussion',text:'fixture'}});await app.controller.bind(scope.peerUin);await tick();
 delete app.controller.settings.realChatConsent;await assert.rejects(app.controller.suggest(),/允许/);assert.equal(calls,0);
 app.controller.settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,baseUrl:'http://other.invalid/v1',model:'fixture'};
 await assert.rejects(app.controller.suggest(),/允许/);assert.equal(calls,0);app.close();
});

test('viewing the same context keeps usable suggestions, but changing instructions discards them',async()=>{const a=setup(async()=>({kind:'discussion',text:'fixture',replyDisposition:'wait'}));await a.controller.bind(scope.peerUin);await tick();await a.controller.suggest();const result=a.controller.advice;a.controller.configure({instruction:a.controller.instruction,images:[]});assert.equal(a.controller.advice,result);a.controller.configure({instruction:'Different'});assert.equal(a.controller.advice,null);a.close()});
