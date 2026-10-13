'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { NativeDriver } = require('./native-driver.cjs');
const { QQTransport, createReadAdapter } = require('./ipc-transport.cjs');
const {fillQQDraft,inspectQQDraft}=require('./draft.cjs');
const { activeContact } = require('./contact.cjs');
function currentDraftTools() {
  if(process.env.CHAT_ASSISTANT_PROBE==='1') {
    for(const name of ['./draft.cjs','./contact.cjs']) delete require.cache[require.resolve(name)];
  }
  return {...require('./draft.cjs'),...require('./contact.cjs')};
}
const root = path.resolve(__dirname, '..');
const privateDir = path.join(root, 'data');
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const driver = new NativeDriver(), transport = new QQTransport(ipcMain);
driver.capture(createReadAdapter(transport));
let worker, endpoint, helper, starting, lastGuiPeer, helperSourceId;
let guiEpoch = 0, guiSequence = 0;
const peerVersions = new Map();
const windowPeers = new Map(), preloadSessions = new WeakSet(), hookedWindows = new WeakSet();
function recordStatus(status) {
  fs.writeFileSync(path.join(privateDir, 'integration-status.json'), JSON.stringify({
    time: new Date().toISOString(), qqVersion: app.getVersion(), phase: status.phase,
    nativeReadReady: status.nativeReadReady === true,
    readAdapterAttached: !!driver.session, authenticated: !!status.account,
    listenerAttached: !!driver.listenerSession, workerRunning: !!worker, helperOpen: !!helper
  }, null, 2), { mode: 0o600 });
}
function recordError(error) {
  fs.appendFileSync(path.join(privateDir, 'integration-errors.log'), `${new Date().toISOString()} ${error.message}\n`, { mode: 0o600 });
}
driver.on('status', status => { recordStatus(status); worker?.send({ type: 'status', status }); });
driver.on('messages', event => worker?.send({ type: 'messages', ...event }));
driver.on('read-stat', event => fs.appendFileSync(path.join(privateDir, 'native-read-stat.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }));
transport.on('account-reset', () => { guiEpoch++; windowPeers.clear(); peerVersions.clear(); lastGuiPeer=null; helperSourceId=null; driver.offline(); });
transport.on('account-ready', account => driver.login(account.uid, account.uin).then(startWorker).catch(error => {
  driver.phase = 'integration_error'; recordStatus(driver.status()); recordError(error);
}));
function startWorker() {
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const executable = process.env.CHAT_ASSISTANT_NODE || path.join(process.env.HOME, '.local/bin/node');
    const log = fs.openSync(path.join(privateDir, 'assistant-server.log'), 'a', 0o600);
    worker = spawn(executable, [path.join(root, 'src/server.cjs')], {
      cwd: root, env: { ...process.env, CHAT_ASSISTANT_ROOT: root }, stdio: ['ignore', log, log, 'ipc']
    });
    fs.closeSync(log);
    worker.on('message', async message => {
      if(message.type==='ready') worker.send({type:'features',features:{qqDraftFill:true}});
      if (message.type === 'ready') { endpoint = message.url; worker.send({ type: 'status', status: driver.status() }); resolve(); }
      if (message.type === 'read') {
        try { worker.send({ type: 'reply', id: message.id, result: await driver.command(message.command, message.args) }); }
        catch (error) { worker.send({ type: 'reply', id: message.id, error: error.message }); }
      }
      if(['fill-draft','inspect-draft'].includes(message.type)) {
        try {
          driver.assertScope(message.args.scope);
          const args={windows:BrowserWindow.getAllWindows(),bindings:windowPeers,windowAccounts:transport.windowAccounts,
            account:driver.account,scope:message.args.scope,preferredWindowId:helperSourceId,
            assertScope:()=>driver.assertScope(message.args.scope),text:message.args.text,replace:message.args.replace===true};
          const tools=currentDraftTools();
          const result=message.type==='inspect-draft'?await tools.inspectQQDraft(args):await tools.fillQQDraft(args);
          worker.send({type:'reply',id:message.id,result});
        } catch(error) {worker.send({type:'reply',id:message.id,error:error.message});}
      }
      if (message.type === 'open-helper') openHelper().catch(recordError);
    });
    worker.on('error', reject);
    worker.on('exit', code => { endpoint = null; worker = null; starting = null;
      recordStatus(driver.status()); if (code) reject(new Error(`Assistant worker exited: ${code}`)); });
  });
  return starting;
}
async function openHelper(sender, uin) {
  await startWorker();
  if(sender?.getURL().startsWith('app://'))helperSourceId=sender.id;
  let peer = uin ? { uin: String(uin) } : null;
  if (!peer && sender?.getURL().startsWith('app://')) {
    try { const current = await currentDraftTools().activeContact(sender);
      if (current) peer = { uin: await driver.toUin(current.peerUid) }; } catch (error) { recordError(error); }
  }
  const cachedPeer = windowPeers.get(sender?.id);
  if(cachedPeer?.accountUid===driver.account?.uid)peer ||= cachedPeer;
  if(!peer && sender && BrowserWindow.getAllWindows().filter(w=>w.isVisible() && w.webContents.getURL().startsWith('app://') && w.webContents.getURL().includes('index.html')).length===1) peer=lastGuiPeer?.accountUid===driver.account?.uid?lastGuiPeer:null;
  worker.send({ type: 'visibility', visible: true });
  worker.send({ type: 'open-contact', uin: peer?.uin || null });
  if (helper && !helper.isDestroyed()) { helper.show(); helper.focus(); return; }
  helper = new BrowserWindow({ title: 'QQ 聊天助手', width: 480, height: 890, minWidth: 370, minHeight: 560,
    backgroundColor: '#10151e', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  helper.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  helper.webContents.on('will-navigate', (event, url) => {
    if (!endpoint || new URL(url).origin !== new URL(endpoint).origin) event.preventDefault();
  });
  helper.on('closed', () => { helper = null; worker?.send({ type: 'visibility', visible: false }); recordStatus(driver.status()); });
  await helper.loadURL(endpoint);
  recordStatus(driver.status());
}
ipcMain.handle('qq-chat-assistant:open', (event, uin) => openHelper(event.sender, uin));
ipcMain.handle('qq-chat-assistant:status', () => ({ ...driver.status(), selected: null }));
function findPeer(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  if (Number(value.chatType) === 1 && typeof value.peerUid === 'string') return value;
  for (const child of Object.values(value)) { const found = findPeer(child, depth + 1); if (found) return found; }
  return null;
}
transport.on('request', async ({ sender, payload }) => {
  if (!payload?.cmdName?.includes('getAioFirstViewLatestMsgs') || !driver.account) return;
  const peer = findPeer(payload.payload); if (!peer) return;
  const ownerUid = driver.account.uid, epoch = guiEpoch, revision = ++guiSequence;
  const focused = BrowserWindow.getFocusedWindow();
  const receivers = [sender];
  if(focused?.webContents.getURL().startsWith('app://')) receivers.push(focused.webContents);
  for(const receiver of receivers) { peerVersions.set(receiver.id,revision);windowPeers.delete(receiver.id); }
  lastGuiPeer = null;
  try {
    const uin = await driver.toUin(peer.peerUid);
    if(epoch!==guiEpoch || ownerUid!==driver.account?.uid) return;
    const resolved = { uin, accountUid:ownerUid, peerUid:peer.peerUid };
    for(const receiver of receivers) {
      if(peerVersions.get(receiver.id)===revision && !receiver.isDestroyed()) windowPeers.set(receiver.id,resolved);
    }
    if(revision===guiSequence) lastGuiPeer=resolved;
  } catch { /* Explicit selection stays available when identity lookup is not ready. */ }
});

exports.onBrowserWindowCreated = window => {
  if (hookedWindows.has(window)) return; hookedWindows.add(window); transport.observe(window);
  const session = window.webContents.session;
  if (!preloadSessions.has(session) && typeof session.registerPreloadScript === 'function') {
    session.registerPreloadScript({ type: 'frame', id: 'qq-chat-assistant-preload', filePath: path.join(__dirname, 'preload.cjs') });
    preloadSessions.add(session);
  }
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'a') {
      event.preventDefault(); openHelper(window.webContents).catch(recordError);
    }
  });
  window.webContents.on('did-finish-load', () => {
    if (window.webContents.getURL().includes('newLogin') && !driver.account) {
      driver.phase = 'waiting_login'; worker?.send({ type: 'status', status: driver.status() }); recordStatus(driver.status());
    }
  });
  window.on('closed', () => { windowPeers.delete(window.webContents.id);peerVersions.delete(window.webContents.id); });
  recordStatus(driver.status());
};
app.on('browser-window-created', (_event, window) => exports.onBrowserWindowCreated(window));
app.on('before-quit', () => worker?.kill('SIGTERM'));
app.whenReady().then(startWorker).catch(recordError);
recordStatus(driver.status());
// Bounded integration probes run only when explicitly enabled by a developer.
if (process.env.CHAT_ASSISTANT_PROBE === '1') require('./probe.cjs');
