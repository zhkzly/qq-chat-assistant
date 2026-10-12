'use strict';
const {extractMedia}=require('./media.cjs');
function sameScope(a, b) { return !!a && !!b && ['accountUid', 'accountUin', 'peerUid', 'peerUin'].every(k => a[k] === b[k]); }
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
  return { ...scope, messageId: raw.msgId, sequence: raw.msgSeq, timestamp: seconds * 1000,
    direction: own ? 'outgoing' : 'incoming', senderUin: String(raw.senderUin),
    text: recalled ? '[已撤回]' : parts.join(''), media:recalled?[]:extractMedia(raw.elements), recalled, kind: 'actual', source: 'desktop-qq-native' };
}
function compare(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  const as = BigInt(a.sequence), bs = BigInt(b.sequence);
  if (as !== bs) return as < bs ? -1 : 1;
  const ai = BigInt(a.messageId), bi = BigInt(b.messageId);
  return ai === bi ? 0 : ai < bi ? -1 : 1;
}
module.exports = { normalize, sameScope, compare };
