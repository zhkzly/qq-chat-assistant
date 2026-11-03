'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { NativeDriver } = require('../plugin/native-driver.cjs');

const ROOT = path.resolve(__dirname, '..');
const owner = { uid: 'u_owner', uin: '1111111111' };
const friend = { uid: 'u_friend', uin: '3307428370' };
const replyScope = { accountUid: owner.uid, accountUin: owner.uin, peerUid: friend.uid, peerUin: friend.uin };
// Short driver-level hang timeout for focused tests; each suite run is its
// own process, so no restore is needed.
process.env.CHAT_ASSISTANT_NATIVE_READ_TIMEOUT_MS = '120';

function raw(msgId, own = false) {
  return { chatType: 1, peerUid: friend.uid, peerUin: friend.uin,
    senderUid: own ? owner.uid : friend.uid, senderUin: own ? owner.uin : friend.uin,
    msgId, msgSeq: '9007199254740993', msgTime: '1791726000', sendStatus: 2,
    elements: [{ elementType: 1, textElement: { content: 'Synthetic read-bridge fixture' } }] };
}
const hang = () => new Promise(() => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fake transport msg service; same shape as the ipc-transport read adapter.
async function ready(overrides = {}) {
  const driver = new NativeDriver();
  const calls = { latest: 0, anchored: 0, lastGetMsgs: null };
  const service = {
    listener: null,
    addKernelMsgListener(listener) { this.listener = listener; return 0; },
    async getAioFirstViewLatestMsgs() { calls.latest++; return { result: 0, msgList: [raw('100'), raw('101', true)] }; },
    async getMsgsIncludeSelf(peer, anchor, count, queryOrder) {
      calls.anchored++; calls.lastGetMsgs = { peer: { ...peer }, anchor, count, queryOrder };
      return { result: 0, msgList: [raw('90')] };
    },
    sendMsg() { throw new Error('Sending must be unreachable'); },
    ...overrides
  };
  driver.capture({ getMsgService: () => service, getUixConvertService: () => ({
    getUin: async () => ({ uinInfo: new Map([[owner.uid, owner.uin]]) }),
    getUid: async () => ({ uidInfo: new Map([[friend.uin, friend.uid]]) }) }) });
  await driver.login(owner.uid);
  const scope = await driver.command('bind', { accountUid: owner.uid, uin: friend.uin });
  return { driver, service, scope, calls };
}

test('a hung latest read falls back once to the newest cached msgId and returns fallback messages', async () => {
  const { driver, service, scope, calls } = await ready();
  const first = await driver.command('latest', { scope });
  assert.equal(first.source, 'desktop-qq-native');
  assert.equal(calls.latest, 1);
  service.getAioFirstViewLatestMsgs = () => { calls.latest++; return hang(); };
  service.getMsgsIncludeSelf = (peer, anchor, count, queryOrder) => {
    calls.anchored++; calls.lastGetMsgs = { peer: { ...peer }, anchor, count, queryOrder };
    return { result: 0, msgList: [raw('140'), raw('141', true)] };
  };
  const second = await driver.command('latest', { scope });
  // Anchored at the newest msgId already cached for the scope ('101'),
  // reading the newer side of that anchor.
  assert.deepEqual(calls.lastGetMsgs, {
    peer: { chatType: 1, peerUid: scope.peerUid, guildId: '' }, anchor: '101', count: 50, queryOrder: true });
  assert.equal(second.source, 'desktop-qq-native-fallback');
  assert.equal(second.scope, scope);
  assert.deepEqual(second.messages.map(m => m.msgId), ['140', '141']);
  assert.equal(second.messages[0].senderUin, friend.uin);
  assert.equal(second.messages[1].senderUin, owner.uin);
});

test('a hung latest read with no cached anchor returns an empty fallback page promptly', async () => {
  const { driver, service, scope, calls } = await ready({ getAioFirstViewLatestMsgs: () => hang() });
  const started = Date.now();
  const result = await driver.command('latest', { scope });
  assert.deepEqual(result, { scope, messages: [], source: 'desktop-qq-native-fallback' });
  assert.equal(calls.anchored, 0);
  assert.ok(Date.now() - started < 5000);
});

test('a persistently hanging read surfaces the native timeout after exactly one fallback attempt', async () => {
  const { driver, service, scope, calls } = await ready();
  await driver.command('latest', { scope });
  service.getAioFirstViewLatestMsgs = () => hang();
  service.getMsgsIncludeSelf = () => { calls.anchored++; return hang(); };
  await assert.rejects(driver.command('latest', { scope }), error => {
    assert.match(error.message, /^QQ native read timed out after 120ms: latest-fallback$/);
    return true;
  });
  assert.equal(calls.anchored, 1);
});

test('real native failures keep their error and never trigger the fallback read', async () => {
  const { driver, service, scope, calls } = await ready();
  service.getAioFirstViewLatestMsgs = async () => ({ result: 91, errMsg: 'fixture failure', msgList: [] });
  await assert.rejects(driver.command('latest', { scope }), /QQ history failed \(91\): fixture failure/);
  assert.equal(calls.anchored, 0);
});

test('the fallback path still enforces scope and epoch assertions', async () => {
  const { driver, service, scope } = await ready();
  await driver.command('latest', { scope });
  service.getAioFirstViewLatestMsgs = () => hang();
  service.getMsgsIncludeSelf = () => { driver.offline(); return { result: 0, msgList: [raw('140')] }; };
  await assert.rejects(driver.command('latest', { scope }), /QQ account or contact changed/);
});

test('a hung older read times out without issuing a fallback latest read', async () => {
  const { driver, service, scope, calls } = await ready();
  service.getMsgsIncludeSelf = (peer, anchor, count, queryOrder) => {
    calls.anchored++; calls.lastGetMsgs = { peer: { ...peer }, anchor, count, queryOrder };
    return hang();
  };
  await assert.rejects(driver.command('older', { scope, cursor: '95' }),
    /QQ native read timed out after 120ms: older/);
  assert.deepEqual(calls.lastGetMsgs, {
    peer: { chatType: 1, peerUid: scope.peerUid, guildId: '' }, anchor: '95', count: 50, queryOrder: false });
  assert.equal(calls.anchored, 1);
});

test('read-only command filtering still rejects non-read commands', async () => {
  const { driver } = await ready();
  for (const command of ['send', 'forward', 'recall', 'sendMsg'])
    await assert.rejects(driver.command(command, {}), /Read-only/);
});

// --- server.cjs read() retry behaviour, against the real worker process ---

async function startBridge(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-read-bridge-'));
  const child = fork(path.join(ROOT, 'src', 'server.cjs'), [], {
    cwd: ROOT,
    env: { ...process.env, CHAT_ASSISTANT_ROOT: dataRoot, CHAT_ASSISTANT_PORT: '0',
      // Small retry timings; attempts stay at the production default (2).
      CHAT_ASSISTANT_READ_TIMEOUT_MS: '120', CHAT_ASSISTANT_READ_RETRY_GAP_MS: '40' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const state = { readRequests: [], stderr: [] };
  child.stderr.on('data', chunk => state.stderr.push(String(chunk)));
  const readyMessage = await new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message.type === 'read') state.readRequests.push(message);
      if (message.type === 'ready') { child.off('message', onMessage); resolve(message); }
    };
    child.on('message', onMessage);
    child.on('error', reject);
  });
  const port = Number(new URL(readyMessage.url).port);
  const token = fs.readFileSync(path.join(dataRoot, 'data', 'web-token.txt'), 'utf8');
  child.send({ type: 'status', status: { phase: 'ready', account: { uid: owner.uid, uin: owner.uin } } });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.on('exit', resolve)), delay(3000)]);
  });
  return { child, port, token, readRequests: state.readRequests, stderr: state.stderr };
}

function serveReads(child, handler) {
  child.on('message', message => {
    if (message.type !== 'read') return;
    handler(message, payload => child.send({ type: 'reply', id: message.id, ...payload }));
  });
}

function getState(port, token) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/state',
      headers: { authorization: `Bearer ${token}` } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.setTimeout(1500, () => request.destroy(new Error('state request timed out')));
  });
}

async function waitFor(port, token, predicate, deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await getState(port, token); if (predicate(last)) return last; }
    catch (error) { last = error; }
    await delay(25);
  }
  throw new Error(`condition not met before deadline: ${JSON.stringify(last)?.slice(0, 300)}`);
}

test('a fast native read still completes on a single attempt', async t => {
  const bridge = await startBridge(t);
  const latestAttempts = [];
  serveReads(bridge.child, (message, respond) => {
    if (message.command === 'bind') respond({ result: replyScope });
    else if (message.command === 'latest') { latestAttempts.push(message.id);
      respond({ result: { scope: replyScope, messages: [raw('72057594037929901')], source: 'desktop-qq-native' } }); }
    else if (message.command === 'older') respond({ result: { scope: replyScope, messages: [], source: 'desktop-qq-native' } });
  });
  bridge.child.send({ type: 'open-contact', uin: friend.uin });
  const state = await waitFor(bridge.port, bridge.token,
    snapshot => snapshot.coverage?.status === 'partial' || snapshot.coverage?.status === 'accessible_end');
  assert.equal(latestAttempts.length, 1);
  assert.equal(state.error, '');
  assert.equal(state.coverage.source, 'desktop-qq-native');
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].messageId, '72057594037929901');
});

test('a persistently hanging read retries once then surfaces the stable timeout error', async t => {
  const bridge = await startBridge(t);
  const latestAttempts = [];
  serveReads(bridge.child, (message, respond) => {
    if (message.command === 'bind') respond({ result: replyScope });
    else if (message.command === 'latest') latestAttempts.push({ id: message.id, at: Date.now() }); // hang: no reply
  });
  bridge.child.send({ type: 'open-contact', uin: friend.uin });
  await waitFor(bridge.port, bridge.token, () => latestAttempts.length >= 2, 4000);
  // The second attempt starts only after the first per-attempt timeout plus the gap.
  assert.ok(latestAttempts[1].at - latestAttempts[0].at >= 120);
  const state = await waitFor(bridge.port, bridge.token,
    snapshot => typeof snapshot.error === 'string' && snapshot.error.includes('QQ 读取超时'), 4000);
  assert.equal(state.error, 'QQ 读取超时：latest');
  assert.equal(latestAttempts.length, 2);
  assert.equal(state.coverage.status, 'read_error');
});
