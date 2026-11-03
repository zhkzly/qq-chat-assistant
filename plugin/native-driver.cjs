'use strict';
const { EventEmitter } = require('node:events');

const READ_COMMANDS = Object.freeze(['status', 'bind', 'latest', 'older']);
// A native read whose callback is lost must fail fast so the caller can fall
// back instead of hanging the whole read bridge until the worker times out.
const DEFAULT_NATIVE_READ_TIMEOUT_MS = 6000;
class NativeReadTimeout extends Error { }
function nativeReadTimeoutMs() {
  const parsed = Number(process.env.CHAT_ASSISTANT_NATIVE_READ_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NATIVE_READ_TIMEOUT_MS;
}
function opaque(value, field) {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error(`Invalid ${field}`);
  return value;
}
function noopListener(methods) {
  return new Proxy(methods, { get(target, key) { return key in target ? target[key] : () => {}; } });
}

class NativeDriver extends EventEmitter {
  constructor() {
    super();
    this.session = null;
    this.account = null;
    this.selected = null;
    this.phase = 'waiting_qq';
    this.epoch = 0;
    this.listenerSession = null;
    this.binding = 0;
    this.readinessUnsubscribe = null;
    // Newest cached msgId per scope, anchoring the fallback latest-read when
    // getAioFirstViewLatestMsgs hangs outside the active AIO view.
    this.newestMsgIdByScope = new Map();
  }
  capture(session) {
    this.readinessUnsubscribe?.();
    this.readinessUnsubscribe = null;
    this.session = session;
    this.offline('waiting_login');
    if (typeof session?.getReadiness === 'function' && typeof session.onReadinessChange === 'function') {
      this.readinessUnsubscribe = session.onReadinessChange(() => {
        // A renderer lifecycle change does not log the account out or change
        // the selected contact. Only the read-channel capability changes.
        if (this.session === session) this.emit('status', this.status());
      });
    }
  }
  async login(uid, uin) {
    this.epoch++;
    const epoch = this.epoch;
    this.account = null;
    this.selected = null;
    this.phase = 'initializing';
    this.emit('status', this.status());
    if (!this.session) throw new Error('QQ session not captured');
    const owner = uin || await this.toUin(uid);
    if (epoch !== this.epoch) return;
    if (!/^\d{5,12}$/.test(String(owner))) throw new Error('QQ account lookup failed');
    this.account = { uid: opaque(uid, 'account UID'), uin: String(owner) };
    if (this.listenerSession !== this.session) {
      const accept = raw => this.accept(Array.isArray(raw) ? raw : [raw]);
      this.session.getMsgService().addKernelMsgListener(noopListener({
        onRecvMsg: accept,
        onAddSendMsg: accept,
        onMsgInfoListUpdate: accept,
        onKickedOffLine: () => this.offline('offline')
      }));
      this.listenerSession = this.session;
    }
    this.phase = 'ready';
    this.emit('status', this.status());
  }
  offline(phase = 'waiting_login') {
    this.epoch++;
    this.phase = phase;
    this.account = null;
    this.selected = null;
    this.emit('status', this.status());
  }
  status() {
    const status = { phase: this.phase, account: this.account, selected: this.selected };
    if (typeof this.session?.getReadiness === 'function') status.nativeReadReady = this.session.getReadiness() === true;
    return status;
  }
  async toUin(uid) {
    const result = await this.session.getUixConvertService().getUin([opaque(uid, 'UID')]);
    return result.uinInfo.get(uid);
  }
  async toUid(uin) {
    const result = await this.session.getUixConvertService().getUid([uin]);
    return result.uidInfo.get(uin);
  }
  assertScope(scope) {
    if (this.phase !== 'ready' || !this.account || this.account.uid !== scope.accountUid ||
        this.account.uin !== scope.accountUin || !this.selected || this.selected.uid !== scope.peerUid ||
        this.selected.uin !== scope.peerUin) throw new Error('QQ account or contact changed');
  }
  withIdentity(message, scope) {
    if (!message || Number(message.chatType)!==1 || message.peerUid!==scope.peerUid || ![scope.accountUid,scope.peerUid].includes(message.senderUid)) return null;
    const sender=message.senderUid===scope.accountUid?scope.accountUin:scope.peerUin;
    if ((message.peerUin && message.peerUin!=='0' && String(message.peerUin)!==scope.peerUin) ||
      (message.senderUin && message.senderUin!=='0' && String(message.senderUin)!==sender)) return null;
    const elements=(message.elements||[]).map(element=>{const copy={...element};for(const key of ['picElement','fileElement']){if(copy[key]){copy[key]={...copy[key]};for(const field of ['thumbPath','picThumbPath'])if(copy[key][field] instanceof Map)copy[key][field]=Object.fromEntries(copy[key][field]);}}return copy;});
    return {...message,elements,peerUin:scope.peerUin,senderUin:sender};
  }
  accept(messages) {
    if (!this.account || !this.selected || this.phase !== 'ready') return;
    const scope = this.scope();
    const filtered = messages.map(m=>this.withIdentity(m,scope)).filter(Boolean);
    if (filtered.length) { this.trackNewestMsgId(scope, filtered); this.emit('messages', { scope, messages: filtered }); }
  }
  scope() {
    if (!this.account || !this.selected) throw new Error('Select a logged-in private conversation first');
    return { accountUid: this.account.uid, accountUin: this.account.uin,
      peerUid: this.selected.uid, peerUin: this.selected.uin };
  }
  scopeKey(scope) {
    return `${scope.accountUid}|${scope.peerUid}`;
  }
  trackNewestMsgId(scope, messages) {
    let newest = this.newestMsgIdByScope.get(this.scopeKey(scope));
    for (const message of messages || []) {
      const id = message?.msgId;
      if (typeof id !== 'string' || !/^\d+$/.test(id) || id === '0') continue;
      if (!newest || BigInt(id) > BigInt(newest)) newest = id;
    }
    if (newest) this.newestMsgIdByScope.set(this.scopeKey(scope), newest);
    return newest;
  }
  raceTimeout(promise, label) {
    const timeoutMs = nativeReadTimeoutMs();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new NativeReadTimeout(`QQ native read timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
      // Promise.resolve keeps non-promise service results working, and the
      // handlers stay attached after a timeout so a late native rejection
      // cannot become an unhandled rejection.
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); });
    });
  }
  finishRead(name, scope, epoch, result, source, cursor) {
    this.assertScope(scope);
    if (epoch !== this.epoch) throw new Error('QQ session changed during history read');
    if (result.result !== undefined && result.result !== 0) throw new Error(`QQ history failed (${result.result}): ${result.errMsg || ''}`);
    if (!Array.isArray(result.msgList)) throw new Error('QQ history response has no msgList');
    this.emit('read-stat', { command:name, rawCount:result.msgList.length, senderOwner:result.msgList.filter(m=>m.senderUid===scope.accountUid).length, senderPeer:result.msgList.filter(m=>m.senderUid===scope.peerUid).length, peerUIDMatches:result.msgList.filter(m=>m.peerUid===scope.peerUid).length, peerUINMatches:result.msgList.filter(m=>String(m.peerUin)===scope.peerUin).length, olderThanCursor:cursor?result.msgList.filter(m=>typeof m.msgId==='string'&&/^\d+$/.test(m.msgId)&&BigInt(m.msgId)<BigInt(cursor)).length:null });
    this.trackNewestMsgId(scope, result.msgList);
    const messages = result.msgList.map(m=>this.withIdentity(m,scope)).filter(Boolean);
    return { scope, messages, source };
  }
  async command(name, args = {}) {
    if (!READ_COMMANDS.includes(name)) throw new Error('Read-only command rejected');
    if (name === 'status') return this.status();
    if (name === 'bind') {
      if (this.phase !== 'ready' || !this.account) throw new Error('QQ is not logged in');
      const owner = this.account;
      const epoch = this.epoch;
      const binding = ++this.binding; this.selected = null;
      if (args.accountUid !== owner.uid) throw new Error('QQ account changed');
      const uin = String(args.uin || '');
      if (!/^\d{5,12}$/.test(uin) || uin === owner.uin) throw new Error('Enter another private QQ contact');
      const uid = await this.toUid(uin);
      if (epoch !== this.epoch || this.account !== owner || binding !== this.binding) throw new Error('QQ account or selection changed');
      this.selected = { uid: opaque(uid, 'contact UID'), uin, name: uin };
      return this.scope();
    }
    const scope = args.scope;
    if (!scope) throw new Error('Missing conversation scope');
    this.assertScope(scope);
    const epoch = this.epoch;
    const service = this.session.getMsgService();
    const peer = { chatType: 1, peerUid: scope.peerUid, guildId: '' };
    try {
      const result = name === 'latest' ? await this.raceTimeout(service.getAioFirstViewLatestMsgs(peer, 50), 'latest') :
        await this.raceTimeout(service.getMsgsIncludeSelf(peer, opaque(args.cursor, 'history cursor'), 50, false), 'older');
      return this.finishRead(name, scope, epoch, result, 'desktop-qq-native', name === 'older' ? args.cursor : null);
    } catch (error) {
      // Only a hung read falls back; real native failures keep their errors.
      if (name !== 'latest' || !(error instanceof NativeReadTimeout)) throw error;
      this.assertScope(scope);
      if (epoch !== this.epoch) throw new Error('QQ session changed during history read');
      const anchor = this.newestMsgIdByScope.get(this.scopeKey(scope));
      // No cached anchor yet: report an empty fallback page rather than
      // issuing another read that could hang the same way.
      if (!anchor) return { scope, messages: [], source: 'desktop-qq-native-fallback' };
      const fallback = await this.raceTimeout(service.getMsgsIncludeSelf(peer, anchor, 50, true), 'latest-fallback');
      return this.finishRead('latest-fallback', scope, epoch, fallback, 'desktop-qq-native-fallback', null);
    }
  }
}

module.exports = { NativeDriver, READ_COMMANDS };
