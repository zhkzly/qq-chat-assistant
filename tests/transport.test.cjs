'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { QQTransport, createReadAdapter, READ_ROUTES, upgradeTransport } = require('../plugin/ipc-transport.cjs');
// Transport fixture derives from actual, redacted desktop execution headers:
// RM_IPCFROM_RENDERER3, request/ntApi -> RM_IPCFROM_MAIN3, response/full.
function native(transport, wc, name, payload) {
  transport.response({ type: 'request', eventName: 'ntApi-emit' }, { cmdName: `fixture/${name}`, payload }, wc);
}
function login(transport, wc, uid = 'u_owner', uin = '1111111111') {
  native(transport, wc, 'onQRCodeLoginSucceed', { result: { uid, uin } });
  native(transport, wc, 'onSessionInitComplete', { uid, result: 0 });
}
function contents(id) {
  const wc = new EventEmitter(); wc.id = id; wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed; wc.send = () => {}; return wc;
}
function capture(ipc, wc, id = `original-${wc.id}`, payload = {}) {
  const event = { sender: wc }, header = { type: 'request', eventName: 'ntApi', peerId: wc.id, callbackId: id };
  ipc.emit('RM_IPCFROM_RENDERER3', event, header, payload); return { event, header };
}
function setup(t) {
  const ipc = new EventEmitter(), transport = new QQTransport(ipc), main = contents(3);
  transport.observe({ webContents: main }); login(transport, main); capture(ipc, main);
  t.after(() => { for (const task of transport.pending.values()) { clearTimeout(task.timer); task.resolve({}); } transport.pending.clear(); });
  return { ipc, transport, main };
}
function reply(wc, callbackId, value = { result: 0, msgList: [] }) {
  wc.send('RM_IPCFROM_MAIN3', { type: 'response', callbackId, promiseStatue: 'full' }, value);
}
test('QQ native transport preserves original messages and allows only read routes', async () => {
  const ipc = new EventEmitter(), transport = new QQTransport(ipc);
  const originalCalls = [];
  const wc = { isDestroyed: () => false, send(...args) { originalCalls.push(args); } };
  transport.observe({ webContents: wc });
  login(transport, wc);
  ipc.on('RM_IPCFROM_RENDERER3', (_, header, payload) => {
    if (header.callbackId.startsWith('qq-chat-assistant-')) wc.send('RM_IPCFROM_MAIN3', {
      type: 'response', callbackId: header.callbackId, promiseStatue: 'full' }, { result: 0, msgList: [] });
  });
  ipc.emit('RM_IPCFROM_RENDERER3', { sender: wc }, { type: 'request', eventName: 'ntApi', peerId: 3, callbackId: 'original' },
    { cmdName: 'onSessionInitComplete', cmdType: 'invoke', payload: [] });
  const result = await transport.call('nodeIKernelMsgService/getMsgs', [{ peer: { chatType: 1, peerUid: 'u_friend' } }]);
  assert.equal(result.result, 0); assert.equal(originalCalls.length, 1);
  for (const route of ['nodeIKernelMsgService/sendMsg', 'send_private_msg', 'nodeIKernelMsgService/recallMsg'])
    await assert.rejects(transport.call(route, []), /Read-only/);
  assert.equal(READ_ROUTES.some(r => /sendMsg|recall|forward/.test(r)), false);
});
test('transport propagates native failures and carries both real event callbacks', async () => {
  const ipc = new EventEmitter(), transport = new QQTransport(ipc);
  const wc = { isDestroyed: () => false, send() {} }; transport.observe({ webContents: wc });
  login(transport, wc);
  ipc.on('RM_IPCFROM_RENDERER3', (_, header) => {
    if (header.callbackId.startsWith('qq-chat-assistant-')) wc.send('RM_IPCFROM_MAIN3', {
      type: 'response', callbackId: header.callbackId, promiseStatue: 'rejected' }, { errMsg: 'native-error-91' });
  });
  ipc.emit('RM_IPCFROM_RENDERER3', { sender: wc }, { type: 'request', eventName: 'ntApi', callbackId: 'original' }, {});
  await assert.rejects(transport.call('nodeIKernelMsgService/getMsgs', []), /native-error-91/);
  const adapter = createReadAdapter(transport), calls = [];
  adapter.getMsgService().addKernelMsgListener({ onRecvMsg: value => calls.push(value), onMsgInfoListUpdate: value => calls.push(value) });
  wc.send('RM_IPCFROM_MAIN3', { type: 'request', eventName: 'ntApi-emit' }, { cmdName: 'nodeIKernelMsgListener/onRecvMsg', payload: ['incoming'] });
  wc.send('RM_IPCFROM_MAIN3', { type: 'request', eventName: 'ntApi-emit' }, { cmdName: 'nodeIKernelMsgListener/onMsgInfoListUpdate', payload: ['actually-sent'] });
  assert.deepEqual(calls, [['incoming'], ['actually-sent']]);
});
test('current QQ active-msg payload and older-page direction match executed native contracts',async()=>{
 const ipc=new EventEmitter(),transport=new QQTransport(ipc),adapter=createReadAdapter(transport);let received;
 adapter.getMsgService().addKernelMsgListener({onMsgInfoListUpdate:value=>{received=value}});
 transport.response({type:'request',eventName:'ntApi-emit'},{cmdName:'nodeIKernelMsgListener/onRecvActiveMsg',payload:{msgList:[{msgId:'72057594037927937'}]}});
 assert.equal(received[0].msgId,'72057594037927937');
 let params;transport.call=async(route,payload)=>{params=payload[0];return {msgList:params.cnt===10&&params.queryOrder===true?[{msgId:'older'}]:[]}};
 const result=await adapter.getMsgService().getMsgsIncludeSelf({chatType:1,peerUid:'u_friend'},'cursor',10,false);
 assert.equal(result.msgList.length,1);assert.equal(params.count,undefined);
});
test('login identity cache follows authenticated account and ignores duplicate session initialization',()=>{
 const transport=new QQTransport(new EventEmitter());let ready=0;transport.on('account-ready',()=>ready++);
 const emit=(cmdName,payload)=>transport.response({type:'request',eventName:'ntApi-emit'},{cmdName,payload});
 emit('nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_owner',uin:'1111111111'}});
 emit('nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_owner',result:0});
 emit('nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_owner',result:0});assert.equal(ready,1);
 emit('nodeIKernelMsgListener/onKickedOffLine',{});assert.equal(transport.identities.size,0);assert.equal(transport.account,null);
});

test('native events from a previous account window cannot enter the new account',()=>{
 const transport=new QQTransport(new EventEmitter());const first={send(){},isDestroyed:()=>false};const second={send(){},isDestroyed:()=>false};
 const emit=(wc,cmdName,payload)=>transport.response({type:'request',eventName:'ntApi-emit'},{cmdName,payload},wc);
 transport.observe({webContents:first});emit(first,'nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_first',uin:'1111111111'}});
 emit(first,'nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_first',result:0});
 transport.observe({webContents:second});emit(second,'nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_second',uin:'2222222222'}});
 emit(second,'nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_second',result:0});
 let received=0;transport.on('native-event',()=>received++);
 emit(first,'nodeIKernelMsgListener/onRecvActiveMsg',{msgList:['old-account']});assert.equal(received,0);
 emit(second,'nodeIKernelMsgListener/onRecvActiveMsg',{msgList:['new-account']});assert.equal(received,1);
});

test('old-account renderer requests cannot replace a current-account native read context',async()=>{
 const ipc=new EventEmitter(),transport=new QQTransport(ipc);
 const wc=()=>({send(){},isDestroyed:()=>false});const first=wc(),second=wc();
 const native=(window,cmdName,payload)=>transport.response({type:'request',eventName:'ntApi-emit'},{cmdName,payload},window);
 transport.observe({webContents:first});native(first,'nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_first',uin:'1111111111'}});native(first,'nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_first',result:0});
 transport.observe({webContents:second});native(second,'nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_second',uin:'2222222222'}});native(second,'nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_second',result:0});
 const request=(sender,id)=>ipc.emit('RM_IPCFROM_RENDERER3',{sender},{type:'request',eventName:'ntApi',callbackId:id},{cmdName:'onSessionInitComplete',payload:[]});
 request(second,'new');request(first,'old');assert.equal(transport.context.event.sender,second);
 ipc.on('RM_IPCFROM_RENDERER3',(event,header)=>{if(header.callbackId?.startsWith('qq-chat-assistant-'))event.sender.send('RM_IPCFROM_MAIN3',{type:'response',callbackId:header.callbackId,promiseStatue:'full'},{msgList:[]})});
 first.destroyed=true;request(first,'late-old');assert.equal(transport.context.event.sender,second);
 assert.deepEqual((await transport.call('nodeIKernelMsgService/getMsgs',[])).msgList,[]);
});

test('destroyed temporary sender falls back to the whole live original context without transplanting headers', async t => {
  const { ipc, transport, main } = setup(t), original = capture(ipc, main, 'live-main');
  const temporary = contents(41); transport.observe({ webContents: temporary }); capture(ipc, temporary, 'pool');
  temporary.destroyed = true; temporary.emit('destroyed');
  let invoked;
  ipc.on('RM_IPCFROM_RENDERER3', (event, header) => {
    if (header.callbackId.startsWith('qq-chat-assistant-')) { invoked = { event, header }; reply(event.sender, header.callbackId); }
  });
  assert.equal((await transport.call(READ_ROUTES[0], [{ peer: { chatType: 1, peerUid: 'u_friend' } }])).result, 0);
  assert.equal(invoked.event, original.event); assert.equal(invoked.event.sender, main); assert.equal(invoked.header.peerId, original.header.peerId);
  assert.equal(original.header.callbackId, 'live-main'); assert.equal(transport.pending.size, 0);
});

test('renderer loss and main-frame navigation invalidate their own contexts and publish truthful readiness', t => {
  const { ipc, transport, main } = setup(t), adapter = createReadAdapter(transport), changes = [];
  assert.equal(adapter.getReadiness(), true); const unsubscribe = adapter.onReadinessChange(value => changes.push(value));
  main.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(adapter.getReadiness(), false); assert.equal(transport.account.uid, 'u_owner');
  capture(ipc, main, 'reloaded'); assert.equal(adapter.getReadiness(), true);
  main.emit('did-start-navigation', {}, 'app://index.html', false, false); assert.equal(adapter.getReadiness(), true, 'subframes do not invalidate the main channel');
  main.emit('did-start-navigation', {}, 'app://index.html', false, true); assert.equal(adapter.getReadiness(), false);
  capture(ipc, main, 'after-navigation'); assert.equal(adapter.getReadiness(), true);
  unsubscribe(); const count = changes.length; main.destroyed = true; main.emit('destroyed'); assert.equal(changes.length, count);
  assert.ok(changes.includes(false)); assert.ok(changes.includes(true)); assert.equal(transport.readiness().nativeReadReady, false);
});

test('a wrong callback sender cannot consume the pending read before the original sender responds', async t => {
  const { ipc, transport, main } = setup(t), other = contents(4); transport.observe({ webContents: other });
  let callbackId; ipc.on('RM_IPCFROM_RENDERER3', (_event, header) => { if (header.callbackId.startsWith('qq-chat-assistant-')) callbackId = header.callbackId; });
  const pending = transport.call(READ_ROUTES[1], []); pending.catch(() => {});
  reply(other, callbackId, { result: 0, msgList: ['wrong-window'] }); assert.equal(transport.pending.size, 1);
  reply(main, callbackId, { result: 0, msgList: ['original-window'] }); assert.deepEqual((await pending).msgList, ['original-window']);
  assert.equal(transport.pending.size, 0);
});

test('failed session initialization cannot authenticate a context or rebind an old window', async t => {
  const { ipc, transport, main } = setup(t), second = contents(5); transport.observe({ webContents: second });
  native(transport, second, 'onQRCodeLoginSucceed', { result: { uid: 'u_second', uin: '2222222222' } });
  native(transport, main, 'onSessionInitComplete', { uid: 'u_second', result: 91 });
  assert.equal(transport.windowAccounts.get(main), 'u_owner'); assert.equal(transport.account, null);
  capture(ipc, main, 'old-after-failed-init'); assert.equal(transport.readiness().nativeReadReady, false);
  await assert.rejects(transport.call(READ_ROUTES[1], []), /not ready/);
  native(transport, second, 'onSessionInitComplete', { uid: 'u_second', result: 0 }); capture(ipc, second, 'new-session');
  assert.equal(transport.readiness().nativeReadReady, true); capture(ipc, main, 'old-after-new-init'); assert.equal(transport.context.event.sender, second);
});

test('duplicate login success is harmless while an actual same-account logout and relogin retires old reads', async t => {
  const { ipc, transport, main } = setup(t); let callbackId;
  ipc.on('RM_IPCFROM_RENDERER3', (_event, header) => { if (header.callbackId.startsWith('qq-chat-assistant-')) callbackId = header.callbackId; });
  const pending = transport.call(READ_ROUTES[1], []); pending.catch(() => {});
  const epoch = transport.readiness().epoch;
  native(transport, main, 'onQRCodeLoginSucceed', { result: { uid: 'u_owner', uin: '1111111111' } });
  native(transport, main, 'onSessionInitComplete', { uid: 'u_owner', result: 0 });
  assert.equal(transport.readiness().epoch, epoch); assert.equal(transport.pending.size, 1); assert.equal(transport.readiness().nativeReadReady, true);
  native(transport, main, 'onKickedOffLine', {});
  assert.equal(transport.pending.size, 0); await assert.rejects(pending, /session|account/i);
  assert.ok(transport.readiness().epoch > epoch); assert.equal(transport.readiness().nativeReadReady, false);
  reply(main, callbackId, { result: 0, msgList: ['stale'] });
  native(transport, main, 'onQRCodeLoginSucceed', { result: { uid: 'u_owner', uin: '1111111111' } });
  native(transport, main, 'onSessionInitComplete', { uid: 'u_owner', result: 0 }); assert.equal(transport.readiness().nativeReadReady, false);
  capture(ipc, main, 'fresh-session'); assert.equal(transport.readiness().nativeReadReady, true);
});

test('sender destruction and synchronous native dispatch errors clean pending timers immediately', async t => {
  const { ipc, transport, main } = setup(t);
  const pending = transport.call(READ_ROUTES[1], []); pending.catch(() => {});
  main.destroyed = true; main.emit('destroyed'); assert.equal(transport.pending.size, 0); await assert.rejects(pending, /sender|unavailable|destroy/i);
  main.destroyed = false; capture(ipc, main, 'synthetic-new-main');
  ipc.on('RM_IPCFROM_RENDERER3', (_event, header) => { if (header.callbackId.startsWith('qq-chat-assistant-')) throw new Error('synthetic-dispatch-failure'); });
  await assert.rejects(transport.call(READ_ROUTES[1], []), /synthetic-dispatch-failure/); assert.equal(transport.pending.size, 0);
});

// The legacy hook retains self in its closure, exactly the in-place boundary:
// replacing only the exported class cannot replace that live instance.
class LegacyTransport extends EventEmitter {
  constructor(ipc) {
    super(); this.ipcMain = ipc; this.context = null; this.pending = new Map(); this.windowAccounts = new WeakMap();
    this.windows = new WeakSet(); this.identities = new Map(); this.account = { uid: 'u_owner', uin: '1111111111' }; this.loginCandidate = this.account;
    const original = ipc.emit, self = this;
    ipc.emit = function(channel, event, header, payload, ...args) {
      if (String(channel).startsWith('RM_IPCFROM_RENDERER') && header?.eventName === 'ntApi' && header.type === 'request' &&
        !header.callbackId?.startsWith('qq-chat-assistant-') && event?.sender && (!self.account || self.windowAccounts.get(event.sender) === self.account.uid)) {
        self.context = { channel, event, header }; self.emit('request', { sender: event.sender, payload });
      }
      return Reflect.apply(original, this, [channel, event, header, payload, ...args]);
    };
  }
  observe(window) {
    const wc = window.webContents; this.windows.add(wc); this.windowAccounts.set(wc, this.account.uid);
    const send = wc.send, self = this;
    wc.send = function(channel, ...args) { if (String(channel).startsWith('RM_IPCFROM_MAIN')) self.response(args[0], args[1], wc); return Reflect.apply(send, this, [channel, ...args]); };
  }
  response() {}
}
test('in-place upgrade preserves instance and legacy send hooks without duplicate GUI requests or invalid capture', async () => {
  const ipc = new EventEmitter(), legacy = new LegacyTransport(ipc), main = contents(3), old = contents(4);
  legacy.observe({ webContents: main }); legacy.observe({ webContents: old }); capture(ipc, main, 'before-upgrade');
  legacy.windowAccounts.set(old, 'u_previous'); let requests = 0; legacy.on('request', () => requests++);
  let legacyError, lateTimer = false;
  legacy.pending.set('legacy-pending', { reject: error => { legacyError = error; }, resolve() {}, timer: setTimeout(() => { lateTimer = true; }, 0) });
  const identity = legacy.identities; assert.equal(upgradeTransport(legacy, { observedWindows: [{ webContents: main }, { webContents: old }] }), legacy);
  assert.match(legacyError.message, /upgraded/); assert.equal(legacy.pending.size, 0);
  assert.equal(legacy.identities, identity); assert.equal(legacy.readiness().nativeReadReady, true);
  capture(ipc, main, 'upgraded-current'); assert.equal(requests, 1);
  capture(ipc, old, 'previous-account'); assert.equal(requests, 1); assert.equal(legacy.context.event.sender, main);
  const dead = contents(9); legacy.observe({ webContents: dead }); dead.destroyed = true; capture(ipc, dead, 'dead-legacy');
  assert.equal(requests, 1); assert.equal(legacy.context.event.sender, main);
  upgradeTransport(legacy, { observedWindows: [{ webContents: main }] }); capture(ipc, main, 'second-upgrade'); assert.equal(requests, 2);
  ipc.on('RM_IPCFROM_RENDERER3', (event, header) => { if (header.callbackId.startsWith('qq-chat-assistant-')) reply(event.sender, header.callbackId); });
  assert.equal((await legacy.call(READ_ROUTES[1], [])).result, 0);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(lateTimer, false);
});
test('upgrade cannot infer unknown existing window ownership or retain a destroyed legacy seed', () => {
  const ipc = new EventEmitter(), legacy = new LegacyTransport(ipc), unknown = contents(7);
  legacy.windows.add(unknown); legacy.context = { channel: 'RM_IPCFROM_RENDERER3', event: { sender: unknown }, header: { type: 'request', eventName: 'ntApi', callbackId: 'legacy' } };
  upgradeTransport(legacy, { observedWindows: [{ webContents: unknown }] });
  assert.equal(legacy.windowAccounts.get(unknown), undefined); assert.equal(legacy.readiness().nativeReadReady, false);
  capture(ipc, unknown, 'still-unknown'); assert.equal(legacy.context, null);
});
