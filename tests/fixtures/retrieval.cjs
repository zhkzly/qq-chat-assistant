'use strict';
// Deterministic fixture for the M4 retrieval-service tests (RT1). All data is
// synthetic; timestamps derive from a fixed base second so decay and window
// behavior stay deterministic. Field names follow the frozen native contract
// (see tests/fixtures/native.cjs).
const { Store } = require('../../src/store.cjs');
const { normalize } = require('../../src/messages.cjs');
const { scope, raw } = require('./native.cjs');

const BASE_SECONDS = 1791726000;
const asOf = new Date((BASE_SECONDS + 86400 * 31) * 1000).toISOString();
const at = offsetSeconds => new Date((BASE_SECONDS + offsetSeconds) * 1000).toISOString();
const otherScope = { ...scope, peerUid: 'u_other', peerUin: '9999999999' };

function qq(id, own, offsetSeconds, elements, overrides = {}) {
  return normalize(raw(String(id), own, { msgTime: String(BASE_SECONDS + offsetSeconds), elements, ...overrides }), scope);
}
const text = content => [{ elementType: 1, textElement: { content } }];
const reply = (id, seq) => [{ elementType: 1, replyElement: { replayMsgId: String(id), replayMsgSeq: String(seq) } }];

// Build a store whose universe exercises every hard filter and tombstone:
// qq messages (live, recalled, later-excluded), private turns (live,
// control-excluded), notes (discussion, draft-use, disabled) and feedback.
function buildFixtureStore() {
  const store = new Store(':memory:');
  store.add(scope, [
    qq(1001, false, 0, text('今天有点累，刚忙完')),
    qq(1002, true, 600, text('辛苦了，早点休息')),
    qq(1003, false, 1200, text('这周连续加班，项目要上线')),
    qq(1004, false, 1800, text('这条被撤回的消息提到加班'), { recallTime: String(BASE_SECONDS + 2400) }),
    qq(1005, true, 2400, text('周末去爬山怎么样')),
    qq(1006, false, 3000, reply(1003, 1003)),
    qq(2001, false, 86400 * 30, text('今天有点累，刚忙完'))
  ]);
  store.add(otherScope, [normalize(raw('9001', false, { peerUid: otherScope.peerUid, peerUin: otherScope.peerUin,
    senderUid: otherScope.peerUid, senderUin: otherScope.peerUin, msgTime: String(BASE_SECONDS + 60), elements: text('另一个联系人的消息') }), otherScope)]);
  const liveTurn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '这周连续加班，我想约她周末看展览' });
  const controlTurn = store.appendTurn(scope, { role: 'user', kind: 'user_control', text: '这次别把她的每句话拆成好几个问题' });
  store.markTurnControl(scope, controlTurn.id);
  store.saveNote(scope, { id: 'note-material', text: '她喜欢看展览，特别是当代艺术', use: 'discussion' });
  store.saveNote(scope, { id: 'note-draft', text: '可分享：上次爬山她很开心', use: 'draft' });
  store.saveNote(scope, { id: 'note-off', text: '这条笔记停用了', use: 'disabled' });
  const evaluatedReply = store.appendTurn(scope, { role: 'assistant', kind: 'reply', text: '辛苦了，注意休息', requestId: 'req-1' });
  // F1: explicit artifact binding with digest pinning
  store.addFeedback(scope, { text: '这条建议太正式了', targetRef: { kind: 'artifact', artifactRef: evaluatedReply.artifactRef }, expectedDigest: store.experiences.artifact(scope, evaluatedReply.artifactRef).bodyDigest });
  store.forgetSource(scope, 'qq:1005');
  return { store, liveTurn, controlTurn };
}

module.exports = { scope, otherScope, asOf, at, buildFixtureStore, qq, text, reply, BASE_SECONDS };
