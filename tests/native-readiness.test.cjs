'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeDriver } = require('../plugin/native-driver.cjs');
const { Controller } = require('./fixtures/assistant-protocol.cjs');
const { Store } = require('../src/store.cjs');
const { scope } = require('./fixtures/native.cjs');
function adapter(initial = true) {
  let ready = initial, subscribed, unsubscribed = 0, listenerCount = 0;
  const session = {
    getReadiness: () => ready,
    onReadinessChange(listener) { subscribed = listener; return () => { unsubscribed++; }; },
    getMsgService: () => ({ addKernelMsgListener() { listenerCount++; }, getAioFirstViewLatestMsgs: async () => ({ msgList: [] }) }),
    getUixConvertService: () => ({ getUid: async () => ({ uidInfo: new Map([[scope.peerUin, scope.peerUid]]) }) })
  };
  return { session, set(value) { ready = value; subscribed?.(value); }, callback: () => subscribed,
    counts: () => ({ unsubscribed, listenerCount }) };
}
test('native read readiness changes preserve authenticated scope and do not attach another listener', async () => {
  const source = adapter(), driver = new NativeDriver();
  driver.capture(source.session); await driver.login(scope.accountUid, scope.accountUin);
  await driver.command('bind', { accountUid: scope.accountUid, uin: scope.peerUin });
  const before = driver.status(), epoch = driver.epoch, events = [];
  driver.on('status', status => events.push(status));
  source.set(false);
  assert.equal(driver.status().nativeReadReady, false);
  assert.equal(driver.phase, 'ready'); assert.equal(driver.epoch, epoch);
  assert.equal(driver.account, before.account); assert.equal(driver.selected, before.selected);
  assert.deepEqual(driver.scope(), scope); driver.assertScope(scope);
  source.set(true);
  assert.equal(driver.status().nativeReadReady, true);
  assert.deepEqual(events.map(status => status.nativeReadReady), [false, true]);
  assert.equal(source.counts().listenerCount, 1);
});
test('replacing a captured adapter unsubscribes readiness and ignores a queued old callback', () => {
  const first = adapter(), second = adapter(false), driver = new NativeDriver();
  driver.capture(first.session); const staleCallback = first.callback();
  driver.capture(second.session); const events = [];
  driver.on('status', status => events.push(status)); staleCallback(true);
  assert.equal(first.counts().unsubscribed, 1); assert.equal(events.length, 0);
  assert.equal(driver.status().nativeReadReady, false);
  second.set(true); assert.equal(events.length, 1); assert.equal(events[0].nativeReadReady, true);
});
test('legacy native adapters retain the existing status shape', async () => {
  const source = adapter(); delete source.session.getReadiness; delete source.session.onReadinessChange;
  const driver = new NativeDriver(); driver.capture(source.session); await driver.login(scope.accountUid, scope.accountUin);
  assert.deepEqual(driver.status(), { phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin }, selected: null });
});
test('controller keeps selection, local goal and unsent private input across read-channel status changes', () => {
  const store = new Store(':memory:'), controller = new Controller({ store, settings: {}, read: async () => {} });
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin }, nativeReadReady: true });
  controller.scope = scope; store.setGoal(scope, 'Synthetic local direction');
  store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Synthetic unsent private question' });
  const before = store.getCompanion(scope), epoch = controller.epoch;
  controller.updateStatus({ ...controller.status, nativeReadReady: false });
  assert.equal(controller.scope, scope); assert.equal(controller.epoch, epoch);
  assert.deepEqual(store.getCompanion(scope), before); assert.equal(controller.snapshot().status.nativeReadReady, false);
  controller.updateStatus({ ...controller.status, nativeReadReady: true });
  assert.equal(controller.scope, scope); assert.deepEqual(store.getCompanion(scope), before);
  controller.close(); store.close();
});
