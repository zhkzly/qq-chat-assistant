'use strict';
const {extractMedia}=require('./media.cjs');
function sameScope(a, b) { return !!a && !!b && ['accountUid', 'accountUin', 'peerUid', 'peerUin'].every(k => a[k] === b[k]); }
const decimal = value => typeof value === 'string' && value.length <= 256 && /^\d+$/.test(value);
const pointer = value => decimal(value) && !/^0+$/.test(value) ? value : null;
function nativeReplyTimestamp(value) {
  const seconds = decimal(value) ? Number(value) : NaN;
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 8640000000000 ? seconds * 1000 : null;
}
function scopedAuthor(scope, uid, uin) {
  uid = uid === undefined || uid === null || uid === '' || uid === '0' ? null : uid;
  uin = uin === undefined || uin === null || uin === '' || uin === '0' ? null : uin;
  if (!uid && !uin) return null;
  const parties = [
    { senderUid: scope.accountUid, senderUin: scope.accountUin, direction: 'outgoing' },
    { senderUid: scope.peerUid, senderUin: scope.peerUin, direction: 'incoming' }
  ];
  return parties.find(party => (!uid || uid === party.senderUid) && (!uin || uin === party.senderUin)) || false;
}
function nativeReplyReference(reply, scope) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return { targetUnavailable: true };
  // Pinned receive/construct consumers: NapCatQQ 7471e3ecd648189a9e80530b00348a17a4528906,
  // packages/napcat-onebot/api/msg.ts. sourceMsgIdInRecords indexes embedded
  // msg.records, not canonical raw.msgId. A nonzero replayMsgId is authoritative;
  // otherwise preserve the scoped sequence and optional verified time anchor.
  // Embedded quote previews and record bodies never become original evidence.
  const messageId = pointer(reply.replayMsgId), sequence = pointer(reply.replayMsgSeq);
  const timestamp = nativeReplyTimestamp(reply.replyMsgTime);
  const author = scopedAuthor(scope, reply.senderUidStr, reply.senderUin);
  if (author === false || !messageId && !(sequence && author)) return { targetUnavailable: true };
  return { ...(messageId ? { messageId } : {}), ...(sequence ? { sequence } : {}), ...(timestamp ? { timestamp } : {}), ...(author || {}) };
}
function qqSourceMetadata(message) {
  const metadata = {};
  if (decimal(message.sequence)) metadata.sequence = message.sequence;
  const author = scopedAuthor(message, message.senderUid, message.senderUin);
  if (author && author.direction === message.direction) {
    metadata.senderUid = author.senderUid; metadata.senderUin = author.senderUin;
  }
  if (!message.recalled && message.replyTo) {
    const reply = message.replyTo;
    const timestamp = Number.isSafeInteger(reply.timestamp) && reply.timestamp > 0 && reply.timestamp <= 8640000000000000 && reply.timestamp % 1000 === 0 ? reply.timestamp : null;
    metadata.replyTo = reply.targetUnavailable === true ? { targetUnavailable: true } : nativeReplyReference({
      replayMsgId: reply.messageId, replayMsgSeq: reply.sequence, senderUidStr: reply.senderUid, senderUin: reply.senderUin,
      replyMsgTime: timestamp ? String(timestamp / 1000) : undefined
    }, message);
  }
  return metadata;
}
function normalize(raw, scope) {
  if (!scope || !raw || Number(raw.chatType) !== 1 || raw.peerUid !== scope.peerUid ||
      String(raw.peerUin) !== scope.peerUin) return null;
  const own = raw.senderUid === scope.accountUid && String(raw.senderUin) === scope.accountUin;
  const other = raw.senderUid === scope.peerUid && String(raw.senderUin) === scope.peerUin;
  if (!own && !other) return null;
  if (typeof raw.msgId !== 'string' || !/^\d+$/.test(raw.msgId) || raw.msgId === '0') return null;
  if (typeof raw.msgSeq !== 'string' || !/^\d+$/.test(raw.msgSeq)) return null;
  if (own && ((raw.sendStatus !== undefined && raw.sendStatus !== 2) || raw.msgSeq === '0')) return null;
  const seconds = Number(raw.msgTime);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 8640000000000) return null;
  const parts = [];
  for (const element of raw.elements || []) {
    if (element.textElement?.content) parts.push(String(element.textElement.content));
    else if (element.picElement) parts.push('[图片]');
    else if (element.pttElement) parts.push('[语音]');
    else if (element.videoElement) parts.push('[视频]');
    else if (element.fileElement) parts.push('[文件]');
    else if (element.faceElement) {const face=element.faceElement;const faces={14:'🙂',5:'😢',9:'😭',13:'😁',182:'😂',76:'👍',63:'🌹',0:'😲',6:'😳',21:'😊',32:'❓'};parts.push(faces[face.faceIndex] || `[QQ表情：${face.faceText || face.faceIndex}]`);}
    else if (element.replyElement) parts.push('[引用消息]');
    else if (element.arkElement) parts.push('[卡片]');
    else if (element.grayTipElement) parts.push('[系统提示]');
    else parts.push('[非文本消息]');
  }
  const recalled = !!raw.recallTime && raw.recallTime !== '0';
  const recallSeconds=Number(raw.recallTime),recalledAt=recalled&&Number.isSafeInteger(recallSeconds)&&recallSeconds>=seconds&&recallSeconds<=8640000000000?recallSeconds*1000:null;
  const references = recalled ? [] : (raw.elements || []).filter(element => element.replyElement)
    .map(element => nativeReplyReference(element.replyElement, scope));
  const distinct = [...new Map(references.map(reference => [JSON.stringify(reference), reference])).values()];
  const replyTo = distinct.length === 1 ? distinct[0] : distinct.length ? { targetUnavailable: true } : null;
  return { ...scope, messageId: raw.msgId, sequence: raw.msgSeq, timestamp: seconds * 1000,
    direction: own ? 'outgoing' : 'incoming', senderUid: raw.senderUid, senderUin: String(raw.senderUin),
    ...(replyTo ? { replyTo } : {}),
    text: recalled ? '[已撤回]' : parts.join(''), media:recalled?[]:extractMedia(raw.elements), recalled,...(recalledAt?{recalledAt}:{}), kind: 'actual', source: 'desktop-qq-native' };
}
function compare(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  const as = BigInt(a.sequence), bs = BigInt(b.sequence);
  if (as !== bs) return as < bs ? -1 : 1;
  const ai = BigInt(a.messageId), bi = BigInt(b.messageId);
  return ai === bi ? 0 : ai < bi ? -1 : 1;
}
module.exports = { normalize, sameScope, compare, qqSourceMetadata };
