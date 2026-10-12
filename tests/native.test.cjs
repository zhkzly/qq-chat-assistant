'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeDriver, READ_COMMANDS } = require('../plugin/native-driver.cjs');
// This fixture derives from the frozen Peer, RawMessage and MsgService declarations.
const owner = { uid: 'u_owner', uin: '1111111111' };
const friend = { uid: 'u_friend', uin: '3307428370' };
function raw(own = false) { return { chatType: 1, peerUid: friend.uid, peerUin: friend.uin,
  senderUid: own ? owner.uid : friend.uid, senderUin: own ? owner.uin : friend.uin,
  msgId: '72057594037927937', msgSeq: '9007199254740993', msgTime: '1791726000',
  sendStatus: 2, elements: [{ elementType: 1, textElement: { content: 'Synthetic native fixture' } }] }; }
async function ready() {
  const driver = new NativeDriver();
  const service = { addKernelMsgListener(listener) { this.listener = listener; return 0; },
    async getAioFirstViewLatestMsgs() { return { result: 0, msgList: [raw(), raw(true)] }; },
    async getMsgsIncludeSelf() { return { result: 0, msgList: [raw()] }; },
    sendMsg() { throw new Error('Sending must be unreachable'); } };
  driver.capture({ getMsgService: () => service, getUixConvertService: () => ({
    getUin: async () => ({ uinInfo: new Map([[owner.uid, owner.uin]]) }),
    getUid: async () => ({ uidInfo: new Map([[friend.uin, friend.uid]]) }) }) });
  await driver.login(owner.uid);
  const scope = await driver.command('bind', { accountUid: owner.uid, uin: friend.uin });
  return { driver, service, scope };
}
test('driver only exposes four read commands and rejects all send variants', async () => {
  const { driver } = await ready();
  assert.deepEqual(READ_COMMANDS, ['status', 'bind', 'latest', 'older']);
  for (const command of ['send', 'send_private_msg', 'forward', 'recall', 'invoke', 'sendMsg'])
    await assert.rejects(driver.command(command), /Read-only/);
});
test('both real conversation directions preserve opaque IDs; other contacts/groups are ignored', async () => {
  const { driver, service, scope } = await ready();
  const events = [];
  driver.on('messages', e => events.push(e));
  service.listener.onRecvMsg([raw(), { ...raw(), chatType: 2 }, { ...raw(), peerUid: 'u_other' }]);
  service.listener.onMsgInfoListUpdate([raw(true)]);
  assert.equal(events.length, 2);
  assert.equal(events[1].messages[0].msgId, '72057594037927937');
  assert.equal(events[1].messages[0].senderUid, owner.uid);
  const history = await driver.command('latest', { scope });
  assert.equal(history.messages.length, 2);
});
test('cross-account and changed contact history scopes are rejected', async () => {
  const { driver, scope } = await ready();
  await assert.rejects(driver.command('latest', { scope: { ...scope, accountUid: 'u_other' } }), /changed/);
  await assert.rejects(driver.command('latest', { scope: { ...scope, peerUin: '2222222222' } }), /changed/);
  driver.offline();
  await assert.rejects(driver.command('latest', { scope }), /changed/);
});
test('history errors remain errors, and account change while awaiting rejects stale result', async () => {
  const { driver, service, scope } = await ready();
  service.getAioFirstViewLatestMsgs = async () => ({ result: 91, errMsg: 'fixture failure', msgList: [] });
  await assert.rejects(driver.command('latest', { scope }), /91.*fixture failure/);
  service.getAioFirstViewLatestMsgs = async () => { driver.offline(); return { msgList: [raw()] }; };
  await assert.rejects(driver.command('latest', { scope }), /changed/);
});
test('an older bind completion cannot overwrite a newer selection', async () => {
  const { driver } = await ready();
  let first; driver.toUid = uin => uin === '2222222222' ? new Promise(r => { first = r; }) : Promise.resolve('u_third');
  const pending = driver.command('bind', { accountUid: owner.uid, uin: '2222222222' });
  await driver.command('bind', { accountUid: owner.uid, uin: '3333333333' });
  first('u_second'); await assert.rejects(pending, /selection changed/);
  assert.equal(driver.selected.uin, '3333333333');
});
module.exports = { raw, ready };

test('native active updates may omit UINs; verified scoped UIDs complete them without accepting conflicts',async()=>{
 const {driver,service}=await ready();const events=[];driver.on('messages',e=>events.push(e));
 const message=raw();delete message.peerUin;delete message.senderUin;
 service.listener.onMsgInfoListUpdate([message,{...message,peerUin:'2222222222'},{...message,senderUid:'u_fake'}]);
 assert.equal(events.length,1);assert.equal(events[0].messages.length,1);assert.equal(events[0].messages[0].senderUin,friend.uin);
});
