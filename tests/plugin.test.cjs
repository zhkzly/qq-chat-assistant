'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
test('native helper reuses its window, isolates Node and refuses worker send commands', async () => {
  const app = new EventEmitter(); app.getVersion = () => 'synthetic-QQ'; app.whenReady = () => new Promise(() => {});
  const ipc = new EventEmitter(), handlers = new Map(); ipc.handle = (name, handler) => handlers.set(name, handler);
  const windows = []; let child;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; windows.push(this);
      this.webContents = new EventEmitter(); Object.assign(this.webContents, { id: windows.length, session: { registerPreloadScript() {} },
        send() {}, getURL: () => '', isDestroyed: () => false, setWindowOpenHandler() {} });
      app.emit('browser-window-created', {}, this); }
    isDestroyed() { return false; } show() {} focus() {} async loadURL(url) { this.url = url; }
  }
  const mockFs = { mkdirSync() {}, writeFileSync() {}, appendFileSync() {}, openSync: () => 1, closeSync() {} };
  const exports = {};
  const context = { exports, module: { exports }, __dirname: path.resolve(__dirname, '../plugin'),
    process: { env: { HOME: '/synthetic', CHAT_ASSISTANT_NODE: '/synthetic/node' } }, console, Buffer,
    setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:path') return path; if (name === 'node:fs') return mockFs;
      if (name === 'electron') return { app, ipcMain: ipc, BrowserWindow: Window };
      if (name === 'node:child_process') return { spawn() { child = new EventEmitter(); child.sent = [];
        child.send = value => child.sent.push(value); child.kill = () => {};
        queueMicrotask(() => child.emit('message', { type: 'ready', url: 'http://127.0.0.1:17860/#synthetic-token' })); return child; } };
      if (name.startsWith('./')) return require(path.resolve(__dirname, '../plugin', name));
      throw new Error(`Unexpected import ${name}`);
    } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../plugin/main.cjs'), 'utf8'), context);
  await handlers.get('qq-chat-assistant:open')({ sender: null });
  await handlers.get('qq-chat-assistant:open')({ sender: null });
  assert.equal(windows.length, 1); assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  child.emit('message', { type: 'read', id: 12, command: 'send_private_msg', args: { message: 'must not send' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(child.sent.find(m => m.type === 'reply' && m.id === 12).error, /Read-only/);
  windows[0].emit('closed'); assert.ok(child.sent.some(m => m.type === 'visibility' && m.visible === false));
});
test('QQ preload exposes only opening/status; no message sender or generic IPC dispatch', () => {
  let publicApi;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../plugin/preload.cjs'), 'utf8'), {
    require() { return { contextBridge: { exposeInMainWorld(name, api) { publicApi = api; }, executeInMainWorld() {} },
      ipcRenderer: { invoke() {} } }; }
  });
  assert.deepEqual(Object.keys(publicApi), ['open', 'status']);
});
