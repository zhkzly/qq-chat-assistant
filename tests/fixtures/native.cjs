'use strict';
// Synthetic values; field names and sendStatus values derive from the frozen
// QQ SDK RawMessage/SendStatusType/Peer contracts (research source S01).
const scope = { accountUid: 'u_owner', accountUin: '1111111111', peerUid: 'u_friend', peerUin: '3307428370' };
function raw(id = '72057594037927937', own = false, overrides = {}) {
  return { chatType: 1, peerUid: scope.peerUid, peerUin: scope.peerUin,
    senderUid: own ? scope.accountUid : scope.peerUid, senderUin: own ? scope.accountUin : scope.peerUin,
    msgId: id, msgSeq: id, msgTime: '1791726000', sendStatus: 2, recallTime: '0',
    elements: [{ elementType: 1, textElement: { content: own ? 'Synthetic actual outgoing' : '今天有点累，刚忙完' } }], ...overrides };
}
module.exports = { scope, raw };
