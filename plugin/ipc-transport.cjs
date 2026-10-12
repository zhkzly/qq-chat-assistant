'use strict';
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const READ_ROUTES = Object.freeze(['nodeIKernelMsgService/getAioFirstViewLatestMsgsAndAddActiveChat', 'nodeIKernelMsgService/getMsgs']);
class QQTransport extends EventEmitter {
  constructor(ipcMain) {
    super(); this.ipcMain = ipcMain; this.context = null; this.pending = new Map();
    this.windowAccounts = new WeakMap(); this.windows = new WeakSet(); this.identities = new Map(); this.loginCandidate = null; this.account = null;
    const originalEmit = ipcMain.emit, self = this;
    ipcMain.emit = function(channel, event, header, payload, ...args) {
      if (String(channel).startsWith('RM_IPCFROM_RENDERER') && header?.eventName === 'ntApi' &&
          header.type === 'request' && !header.callbackId?.startsWith('qq-chat-assistant-') && event?.sender) {
        if(!self.account || self.windowAccounts.get(event.sender)===self.account.uid) {
          self.context = { channel, event, header };
          self.emit('request', { sender: event.sender, payload });
        }
      }
      return Reflect.apply(originalEmit, this, [channel, event, header, payload, ...args]);
    };
  }
  observe(window) {
    const wc = window.webContents;
    if (this.windows.has(wc)) return; this.windows.add(wc); if(this.account) this.windowAccounts.set(wc,this.account.uid);
    const send = wc.send, self = this;
    wc.send = function(channel, ...args) {
      if (String(channel).startsWith('RM_IPCFROM_MAIN')) self.response(args[0],args[1],wc);
      return Reflect.apply(send, this, [channel, ...args]);
    };
  }
  response(header, result, wc) {
    if (header?.type === 'response' && this.pending.has(header.callbackId)) {
      const task = this.pending.get(header.callbackId); this.pending.delete(header.callbackId); clearTimeout(task.timer);
      if (task.accountUid && task.accountUid!==this.account?.uid) task.reject(new Error('QQ account changed during native read'));
      else if (header.promiseStatue !== 'full') task.reject(new Error(`QQ read rejected (${header.promiseStatue || 'unknown'}): ${String(result?.message || result?.errMsg || result?.code || '')}`));
      else task.resolve(result);
    }
    if (header?.type === 'request' && ['ntApi-emit','NodeStoreApi-emit'].includes(header.eventName) && result?.cmdName) {
      const name = result.cmdName.split('/').at(-1), data = result.payload;
      if (name === 'onQRCodeLoginSucceed' && data?.result?.uid && data.result.uin) {
        if (data.result.uid !== this.loginCandidate?.uid) { this.identities.clear(); this.account=null; this.emit('account-reset'); }
        this.loginCandidate = {uid:String(data.result.uid),uin:String(data.result.uin)};
        this.identities.set(this.loginCandidate.uid,this.loginCandidate.uin);
      }
      if(name==='onSessionInitComplete' && data?.uid===this.loginCandidate?.uid && wc) this.windowAccounts.set(wc,String(data.uid));
      if(wc && this.account && this.windowAccounts.get(wc)!==this.account.uid && !['onQRCodeLoginSucceed','onSessionInitComplete'].includes(name)) return;
      if (name === 'onBuddyListChange' || name === 'onProfileSimpleChanged') {
        for (const profile of Object.values(data?.userSimpleInfos || data?.profiles || {})) {
          if (profile.uid && /^\d{5,12}$/.test(String(profile.uin))) this.identities.set(String(profile.uid),String(profile.uin));
        }
      }
      if (name === 'onKickedOffLine') { this.account=null;this.loginCandidate=null;this.identities.clear(); }
      if (name === 'onSessionInitComplete' && data?.uid === this.loginCandidate?.uid && data.result === 0 && this.account?.uid !== this.loginCandidate.uid) {
        this.account = this.loginCandidate; this.emit('account-ready', this.account);
      }
      this.emit('native-event', result);
    }
  }
  call(route, payload) {
    if (!READ_ROUTES.includes(route)) return Promise.reject(new Error('Read-only QQ IPC route rejected'));
    if (!this.context || this.context.event.sender.isDestroyed()) return Promise.reject(new Error('QQ IPC is not ready'));
    if(this.account && this.windowAccounts.get(this.context.event.sender)!==this.account.uid) return Promise.reject(new Error('QQ native read context belongs to a different account'));
    const { channel, event, header } = this.context;
    const callbackId = `qq-chat-assistant-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(callbackId); reject(new Error(`QQ read timeout: ${route}`)); }, 8000);
      this.pending.set(callbackId, { resolve, reject, timer, accountUid:this.account?.uid });
      this.ipcMain.emit(channel, event, { ...header, callbackId }, { cmdName: route, cmdType: 'invoke', payload });
    });
  }
}
function createReadAdapter(transport) {
  const listeners = [];
  transport.on('native-event', event => {
    const name = event.cmdName.split('/').at(-1);
    if (name === 'onRecvActiveMsg') { for (const listener of listeners) listener.onMsgInfoListUpdate(event.payload?.msgList || []); return; }
    if (['onRecvMsg', 'onAddSendMsg', 'onMsgInfoListUpdate', 'onKickedOffLine'].includes(name))
      for (const listener of listeners) listener[name](event.payload?.msgList || event.payload);
  });
  return {
    getMsgService: () => ({
      addKernelMsgListener: listener => { listeners.push(listener); return 0; },
      getAioFirstViewLatestMsgs: (peer, count) => transport.call(
        'nodeIKernelMsgService/getAioFirstViewLatestMsgsAndAddActiveChat', [{ peer, cnt: count }, undefined]),
      getMsgsIncludeSelf: (peer, msgId, count, queryOrder) => transport.call(
        'nodeIKernelMsgService/getMsgs', [{ peer, msgId, cnt: count, queryOrder: !queryOrder }, undefined])
    }),
    getUixConvertService: () => ({
      getUin: async ids => {
        const map=new Map(); for(const uid of ids) { const uin=transport.identities.get(uid); if(!uin) throw new Error('QQ account/contact identity not yet available');map.set(uid,uin); } return {uinInfo:map};
      },
      getUid: async ids => {
        const map=new Map();for(const uin of ids) { const match=[...transport.identities.entries()].find(([,value])=>value===uin);if(!match) throw new Error('该 QQ 号尚未进入好友缓存，请在 QQ 打开该私聊后重试');map.set(uin,match[0]); } return {uidInfo:map};
      }
    })
  };
}
module.exports = { QQTransport, createReadAdapter, READ_ROUTES };
