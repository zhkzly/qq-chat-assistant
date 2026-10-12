'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const app = new EventEmitter(); app.getVersion = () => 'synthetic-QQ'; app.whenReady = () => new Promise(() => {});
  const ipc = new EventEmitter(), handlers = new Map(); ipc.handle = (name, handler) => handlers.set(name, handler);
  const contents = id => ({ id, getURL: () => 'app://./renderer/index.html', isDestroyed: () => false });
  const a = { webContents: contents(4), isVisible: () => true }, b = { webContents: contents(6), isVisible: () => true };
  let focused = a, driver, transport, child, single = false; const lookups = new Map();
  class Driver extends EventEmitter {
    constructor() { super(); this.account = { uid: 'u_owner', uin: '1111111111' }; driver = this; }
    capture() {} status() { return { phase: 'ready', account: this.account }; }
    toUin(uid) { return lookups.get(uid); }
    offline() { this.account = null; }
  }
  class Transport extends EventEmitter { constructor() { super(); transport = this; } observe() {} }
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, {
      id: 9, session: { registerPreloadScript() {} }, send() {}, getURL: () => '', setWindowOpenHandler() {} }); }
    isDestroyed() { return false; } show() {} focus() {} async loadURL() {}
    static getAllWindows() { return single ? [a] : [a, b]; }
    static getFocusedWindow() { return focused; }
  }
  const exports = {}, context = { exports, module: { exports }, __dirname: path.resolve(__dirname, '../plugin'),
    process: { env: { HOME: '/synthetic', CHAT_ASSISTANT_NODE: '/synthetic/node' } }, console, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:fs') return { mkdirSync() {}, writeFileSync() {}, appendFileSync() {}, openSync: () => 1, closeSync() {} };
      if (name === 'electron') return { app, ipcMain: ipc, BrowserWindow: Window };
      if (name === 'node:child_process') return { spawn() { child = new EventEmitter(); child.sent = [];
        child.send = value => child.sent.push(value); child.kill = () => {};
        queueMicrotask(() => child.emit('message', { type: 'ready', url: 'http://127.0.0.1:17860/#synthetic-token' })); return child; } };
      if (name === './native-driver.cjs') return { NativeDriver: Driver };
      if (name === './ipc-transport.cjs') return { QQTransport: Transport, createReadAdapter: () => ({}) };
      if (name === './contact.cjs') return { activeContact: async () => null };
      if (name.startsWith('./')) return require(path.resolve(__dirname, '../plugin', name));
      throw new Error(`Unexpected import ${name}`);
    } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../plugin/main.cjs'), 'utf8'), context);
  return { a, b, driver, transport, lookups, setFocused(value) { focused = value; },
    setSingleWindow(value) { single=value; },
    request(uid) { transport.emit('request', { sender: contents(3), payload: {
      cmdName: 'nodeIKernelMsgService/getAioFirstViewLatestMsgsAndAddActiveChat',
      payload: [{ peer: { chatType: 1, peerUid: uid }, cnt: 50 }, undefined] } }); },
    async open(window) { await handlers.get('qq-chat-assistant:open')({ sender: window.webContents });
      return child.sent.filter(m => m.type === 'open-contact').at(-1)?.uin; } };
}
test('GUI peer belongs to the QQ window focused when the original read starts', async () => {
  const h = harness(); let resolveA;
  h.lookups.set('u_a', new Promise(r => { resolveA = r; }));
  h.lookups.set('u_b', Promise.resolve('2222222222'));
  h.request('u_a'); h.setFocused(h.b); h.request('u_b'); await tick();
  resolveA('3333333333'); await tick();
  assert.equal(await h.open(h.a), '3333333333');
  assert.equal(await h.open(h.b), '2222222222');
});
test('an older GUI lookup cannot overwrite a newer selection in the same window', async () => {
  const h = harness(); let resolveA;
  h.lookups.set('u_a', new Promise(r => { resolveA = r; })); h.lookups.set('u_b', Promise.resolve('2222222222'));
  h.request('u_a'); h.request('u_b'); await tick(); resolveA('3333333333'); await tick();
  assert.equal(await h.open(h.a), '2222222222');
});
test('old account GUI lookup is discarded after a new account logs in', async () => {
  const h = harness(); let resolve;
  h.lookups.set('u_a', new Promise(r => { resolve = r; })); h.request('u_a');
  h.transport.emit('account-reset'); h.driver.account = { uid: 'u_new', uin: '2222222222' };
  resolve('3333333333'); await tick();
  assert.equal(await h.open(h.a), null);
});

test('same-account relogin cannot restore a pre-logout lookup through the single-window fallback',async()=>{
 const h=harness();let resolve;h.setSingleWindow(true);h.lookups.set('u_a',new Promise(r=>{resolve=r}));h.request('u_a');
 h.transport.emit('account-reset');h.driver.account={uid:'u_owner',uin:'1111111111'};resolve('3333333333');await tick();
 assert.equal(await h.open(h.a),null);
});
test('cached GUI identity is invalid when the current account no longer matches it',async()=>{
 const h=harness();h.lookups.set('u_a',Promise.resolve('3333333333'));h.request('u_a');await tick();
 h.driver.account={uid:'u_new',uin:'2222222222'};
 assert.equal(await h.open(h.a),null);
});
