'use strict';
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const READ_ROUTES = Object.freeze(['nodeIKernelMsgService/getAioFirstViewLatestMsgsAndAddActiveChat', 'nodeIKernelMsgService/getMsgs']);
const LIFECYCLE_VERSION = 'qq-ipc-lifecycle-2026-10-13.1';
class QQTransport extends EventEmitter {
  constructor(ipcMain) {
    super(); this.ipcMain = ipcMain; this.pending = new Map();
    this.windowAccounts = new WeakMap(); this.windows = new WeakSet(); this.identities = new Map(); this.loginCandidate = null; this.account = null;
    this.initializeLifecycle(); this.installHook(false);
  }
  get context() { return this._currentContext || null; }
  set context(value) { if (!this._suppressLegacyCapture) this._currentContext = value; }
  emit(name, ...args) {
    if (name === 'request' && this._suppressLegacyCapture) return false;
    return super.emit(name, ...args);
  }
  initializeLifecycle() {
    this.lifecycleVersion = LIFECYCLE_VERSION; this.sessionEpoch = 0; this.contexts = new Map();
    this._currentContext = null; this._senderVersions = new WeakMap(); this._lifecycleWindows = new WeakSet();
    this._suppressLegacyCapture = 0; this._lastReadiness = null;
  }
  installHook(legacy) {
    const ipcMain = this.ipcMain;
    const originalEmit = ipcMain.emit, self = this;
    ipcMain.emit = function(channel, event, header, payload, ...args) {
      self.captureRequest(channel, event, header, payload);
      // The old live hook still closes over this instance. Suppress only its
      // duplicate capture, while forwarding the original IPC arguments intact.
      if (legacy) self._suppressLegacyCapture++;
      try { return Reflect.apply(originalEmit, this, [channel, event, header, payload, ...args]); }
      finally { if (legacy) self._suppressLegacyCapture--; }
    };
  }
  live(context) {
    try {
      return !!context?.event?.sender && !context.event.sender.isDestroyed() &&
        !(typeof context.event.senderFrame?.isDestroyed === 'function' && context.event.senderFrame.isDestroyed());
    } catch { return false; }
  }
  validContext(context) {
    const sender = context?.event?.sender;
    return !!this.account && context?.epoch === this.sessionEpoch && context.accountUid === this.account.uid &&
      this.windowAccounts.get(sender) === this.account.uid && this.windows.has(sender) &&
      this.contexts.get(sender) === context &&
      context.senderVersion === (this._senderVersions.get(sender) || 0) && this.live(context);
  }
  selectContext() {
    if (this.validContext(this._currentContext)) return this._currentContext;
    this._currentContext = [...this.contexts.values()].reverse().find(context => this.validContext(context)) || null;
    return this._currentContext;
  }
  readiness() {
    const context = this.selectContext();
    return { nativeReadReady: !!context, reason: context ? 'ready' : this.account ? 'native_context_unavailable' : 'account_not_authenticated',
      epoch: this.sessionEpoch, hasContext: !!context, contextCount: this.contexts.size, pendingCount: this.pending.size,
      ...(context?.event.sender.id !== undefined ? { senderId: context.event.sender.id } : {}) };
  }
  publishReadiness() {
    const state = this.readiness(), key = JSON.stringify([state.nativeReadReady, state.epoch, state.senderId]);
    if (key !== this._lastReadiness) { this._lastReadiness = key; this.emit('readiness', state); }
  }
  rememberContext(channel, event, header) {
    const sender = event.sender, context = { channel, event, header, epoch: this.sessionEpoch,
      senderVersion: this._senderVersions.get(sender) || 0, accountUid: this.windowAccounts.get(sender) || null };
    this.contexts.delete(sender); this.contexts.set(sender, context); this._currentContext = context;
    this.publishReadiness(); return context;
  }
  captureRequest(channel, event, header, payload) {
    if (!String(channel).startsWith('RM_IPCFROM_RENDERER') || header?.eventName !== 'ntApi' || header.type !== 'request' ||
      typeof header.callbackId === 'string' && header.callbackId.startsWith('qq-chat-assistant-') || !this.windows.has(event?.sender) ||
      !this.live({ event })) return;
    const owner = this.windowAccounts.get(event.sender);
    if (this.account ? owner !== this.account.uid : this.loginCandidate && owner && owner !== this.loginCandidate.uid) return;
    this.rememberContext(channel, event, header);
    // Bypass legacy suppression only for this single validated capture.
    super.emit('request', { sender: event.sender, payload });
  }
  finishPending(id, error, result) {
    const task = this.pending.get(id); if (!task) return;
    this.pending.delete(id); clearTimeout(task.timer); error ? task.reject(error) : task.resolve(result);
  }
  invalidateSender(sender) {
    this._senderVersions.set(sender, (this._senderVersions.get(sender) || 0) + 1); this.contexts.delete(sender);
    if (this._currentContext?.event.sender === sender) this._currentContext = null;
    for (const [id, task] of this.pending) if (task.sender === sender) this.finishPending(id, new Error('QQ native read sender became unavailable'));
    this.publishReadiness();
  }
  resetSession() {
    this.sessionEpoch++; this.account = null; this.contexts.clear(); this._currentContext = null; this.identities.clear();
    for (const id of this.pending.keys()) this.finishPending(id, new Error('QQ session/account changed during native read'));
    this.publishReadiness(); this.emit('account-reset');
  }
  observe(window, { existing = false } = {}) {
    const wc = window.webContents;
    if (!this.windows.has(wc)) {
      this.windows.add(wc); if (this.account && !existing) this.windowAccounts.set(wc, this.account.uid);
      const send = wc.send, self = this;
      wc.send = function(channel, ...args) {
        if (String(channel).startsWith('RM_IPCFROM_MAIN')) self.response(args[0],args[1],wc);
        return Reflect.apply(send, this, [channel, ...args]);
      };
    }
    if (!this._lifecycleWindows.has(wc)) {
      this._lifecycleWindows.add(wc);
      wc.on?.('destroyed', () => this.invalidateSender(wc));
      wc.on?.('render-process-gone', () => this.invalidateSender(wc));
      wc.on?.('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (!isInPlace && isMainFrame !== false) this.invalidateSender(wc); });
    }
  }
  response(header, result, wc) {
    if (header?.type === 'response' && this.pending.has(header.callbackId)) {
      const task = this.pending.get(header.callbackId);
      if (wc !== task.sender) return;
      if (task.epoch !== this.sessionEpoch || task.accountUid !== this.account?.uid ||
        task.senderVersion !== (this._senderVersions.get(wc) || 0) || !this.live(task.context))
        this.finishPending(header.callbackId, new Error('QQ session/account or sender changed during native read'));
      else if (header.promiseStatue !== 'full') this.finishPending(header.callbackId, new Error(`QQ read rejected (${header.promiseStatue || 'unknown'}): ${String(result?.message || result?.errMsg || result?.code || '')}`));
      else this.finishPending(header.callbackId, null, result);
      return;
    }
    if (header?.type === 'request' && ['ntApi-emit','NodeStoreApi-emit'].includes(header.eventName) && result?.cmdName) {
      const name = result.cmdName.split('/').at(-1), data = result.payload;
      if (name === 'onQRCodeLoginSucceed' && data?.result?.uid && data.result.uin) {
        if (String(data.result.uid) !== this.loginCandidate?.uid || String(data.result.uin) !== this.loginCandidate?.uin) this.resetSession();
        this.loginCandidate = {uid:String(data.result.uid),uin:String(data.result.uin)};
        this.identities.set(this.loginCandidate.uid,this.loginCandidate.uin);
      }
      if(name==='onSessionInitComplete' && data?.uid===this.loginCandidate?.uid && data.result === 0 && wc) {
        this.windowAccounts.set(wc,String(data.uid));
        const context = this.contexts.get(wc);
        if (context?.epoch === this.sessionEpoch && context.accountUid === null) context.accountUid = String(data.uid);
      }
      if(wc && this.account && this.windowAccounts.get(wc)!==this.account.uid && !['onQRCodeLoginSucceed','onSessionInitComplete'].includes(name)) return;
      if (name === 'onBuddyListChange' || name === 'onProfileSimpleChanged') {
        for (const profile of Object.values(data?.userSimpleInfos || data?.profiles || {})) {
          if (profile.uid && /^\d{5,12}$/.test(String(profile.uin))) this.identities.set(String(profile.uid),String(profile.uin));
        }
      }
      if (name === 'onKickedOffLine') { this.resetSession(); this.loginCandidate=null; }
      if (name === 'onSessionInitComplete' && data?.uid === this.loginCandidate?.uid && data.result === 0 && this.account?.uid !== this.loginCandidate.uid) {
        this.account = this.loginCandidate; this.emit('account-ready', this.account);
      }
      this.publishReadiness();
      this.emit('native-event', result);
    }
  }
  call(route, payload) {
    if (!READ_ROUTES.includes(route)) return Promise.reject(new Error('Read-only QQ IPC route rejected'));
    const context = this.selectContext(); this.publishReadiness();
    if (!context) return Promise.reject(new Error('QQ IPC is not ready'));
    const { channel, event, header } = context;
    const callbackId = `qq-chat-assistant-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finishPending(callbackId, new Error(`QQ read timeout: ${route}`)), 8000);
      this.pending.set(callbackId, { resolve, reject, timer, context, sender: event.sender, epoch: this.sessionEpoch,
        senderVersion: context.senderVersion, accountUid: this.account.uid });
      try { this.ipcMain.emit(channel, event, { ...header, callbackId }, { cmdName: route, cmdType: 'invoke', payload }); }
      catch (error) { this.finishPending(callbackId, error); }
    });
  }
}
function upgradeTransport(instance, { observedWindows = [] } = {}) {
  if (!(instance instanceof EventEmitter) || !instance.ipcMain || !(instance.pending instanceof Map) || !(instance.windowAccounts instanceof WeakMap))
    throw new Error('Invalid existing QQ native transport');
  const legacy = instance.lifecycleVersion !== LIFECYCLE_VERSION, seed = legacy && instance.context;
  if (legacy) {
    for (const task of instance.pending.values()) { clearTimeout(task.timer); task.reject(new Error('QQ native transport upgraded; retry this read')); }
    instance.pending.clear();
    // Remove the legacy own field so its closure uses the suppression accessor.
    delete instance.context;
  }
  Object.setPrototypeOf(instance, QQTransport.prototype);
  if (legacy) { instance.initializeLifecycle(); instance.installHook(true); }
  for (const window of observedWindows) instance.observe(window, { existing: true });
  if (seed && instance.account && instance.windowAccounts.get(seed.event?.sender) === instance.account.uid && instance.windows.has(seed.event.sender) && instance.live(seed))
    instance.rememberContext(seed.channel, seed.event, seed.header);
  instance.publishReadiness(); return instance;
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
    getReadiness: () => transport.readiness().nativeReadReady,
    onReadinessChange: listener => {
      const forward = status => listener(status.nativeReadReady); transport.on('readiness', forward);
      return () => transport.off('readiness', forward);
    },
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
module.exports = { QQTransport, createReadAdapter, READ_ROUTES, upgradeTransport };
