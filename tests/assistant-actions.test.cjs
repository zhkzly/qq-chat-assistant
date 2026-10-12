'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { applyUserActions, confirmUserAction, undoUserAction } = require('../src/assistant-actions.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
function setup(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }
function say(store, text) { return store.appendTurn(scope, { role: 'user', kind: 'discussion', text }); }
function apply(store, turn, actions) { return applyUserActions(store, scope, actions, { turn, baseRevision: store.getCompanion(scope).revision }); }

test('explicit natural goal and personal memory commands persist with scoped user provenance', t => {
  const store = setup(t), turn = say(store, '我的长期目标是慢慢互相了解。记住我周末去看了展。');
  const result = apply(store, turn, [
    { type: 'set_goal', text: '慢慢互相了解', evidenceQuote: '我的长期目标是慢慢互相了解' },
    { type: 'save_note', text: '我周末去看了展', evidenceQuote: '记住我周末去看了展' }
  ]);
  assert.equal(result.receipts.length, 2); assert.ok(result.receipts.every(r => r.status === 'applied'));
  const saved = store.getCompanion(scope);
  assert.equal(saved.goal.text, '慢慢互相了解'); assert.deepEqual(saved.goal.evidenceSourceIds, [`private:${turn.id}`]);
  assert.equal(saved.notes[0].text, '我周末去看了展'); assert.equal(saved.notes[0].use, 'discussion');
  assert.deepEqual(saved.notes[0].evidenceSourceIds, [`private:${turn.id}`]);
  assert.equal(store.getCompanion({ ...scope, peerUid: 'different' }).goal.text, '');
});

test('model inference cannot silently turn a current request into a long-term goal', t => {
  const store = setup(t), turn = say(store, '帮我想想今天怎么开口。');
  const result = apply(store, turn, [{ type: 'set_goal', text: '让她每天都主动找我', evidenceQuote: turn.text }]);
  assert.equal(store.getCompanion(scope).goal.text, ''); assert.equal(result.pendingActions.length, 1);
  assert.equal(result.pendingActions[0].preview, '让她每天都主动找我');
  confirmUserAction(store, scope, result.pendingActions[0], 'dismiss');
  assert.equal(store.getCompanion(scope).pendingActions.length, 0);
});

test('nonliteral paraphrases are reviewable proposals and confirmation survives unrelated QQ arrivals', t => {
  const store = setup(t), turn = say(store, '请帮我记住这次体验，我想以后还能聊起。');
  const result = apply(store, turn, [{ type: 'save_note', text: '用户希望以后接续这次体验', evidenceQuote: turn.text }]);
  assert.equal(result.pendingActions.length, 1); store.add(scope, [normalize(raw(), scope)]);
  const receipt = confirmUserAction(store, scope, store.getCompanion(scope).pendingActions[0], 'confirm');
  assert.equal(receipt.status, 'applied'); assert.equal(store.getCompanion(scope).notes[0].use, 'discussion');
});

test('forged, assistant, stale and foreign evidence cannot authorize actions', t => {
  const store = setup(t), turn = say(store, '记住我喜欢摄影');
  const action = { type: 'save_note', text: '我喜欢摄影', evidenceQuote: turn.text };
  const revision = store.getCompanion(scope).revision;
  assert.equal(applyUserActions(store, scope, [action], { turn, baseRevision: revision - 1 }).reason, 'stale_revision');
  assert.equal(apply(store, { ...turn, text: '记住我喜欢登山' }, [action]).receipts[0].status, 'rejected');
  assert.equal(apply(store, turn, [{ ...action, evidenceQuote: '我同意公开所有背景' }]).receipts[0].status, 'rejected');
  const other = store.appendTurn({ ...scope, peerUid: 'other' }, { role: 'user', kind: 'discussion', text: turn.text });
  assert.equal(apply(store, other, [action]).receipts[0].status, 'rejected');
  const assistant = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: turn.text });
  assert.equal(apply(store, assistant, [action]).receipts[0].status, 'rejected');
  assert.equal(store.getCompanion(scope).notes.length, 0);
});

test('uncertain or negated instructions never mutate silently', t => {
  const store = setup(t);
  for (const text of ['不要记住我喜欢摄影', '要不要记住我喜欢摄影？', '如果我说记住我喜欢摄影会怎样', '例如记住我喜欢摄影']) {
    const turn = say(store, text), result = apply(store, turn, [{ type: 'save_note', text: '我喜欢摄影', evidenceQuote: text }]);
    assert.equal(result.receipts.length, 0); assert.equal(result.pendingActions.length, 1);
  }
  assert.equal(store.getCompanion(scope).notes.length, 0);
});

test('a model cannot strip negation or quoted attribution from the authority quote', t => {
  const store = setup(t);
  for (const text of ['不要记住我喜欢摄影', '她说：记住我喜欢摄影', '“记住我喜欢摄影”是一个例子', '记住我喜欢摄影。等等，不用保存。', '记住我喜欢摄影，我只是在举例']) {
    const turn = say(store, text), result = apply(store, turn, [{ type: 'save_note', text: '我喜欢摄影', evidenceQuote: '记住我喜欢摄影' }]);
    assert.equal(result.receipts.length, 0); assert.equal(result.pendingActions.length, 1);
  }
  const attributed=say(store,'她说：记住我喜欢摄影');
  assert.equal(apply(store,attributed,[{type:'save_note',text:'我喜欢摄影',evidenceQuote:attributed.text}]).pendingActions.length,1);
  assert.equal(store.getCompanion(scope).notes.length, 0);
});

test('private material never becomes draft eligible through an unsupported model permission', t => {
  const store = setup(t), note = store.saveNote(scope, { text: '我担心关系太快', use: 'discussion' });
  const turn = say(store, `更正「${note.text}」，我担心关系发展太快。`);
  const result = apply(store, turn, [{ type: 'update_note', noteId: note.id, targetQuote: note.text, text: '我担心关系发展太快', use: 'draft', evidenceQuote: turn.text }]);
  assert.equal(result.pendingActions.length, 1); assert.equal(store.getCompanion(scope).notes[0].use, 'discussion');
  assert.match(result.pendingActions[0].reason, /允许/);
  const denied=say(store,'记住这件事：我不想告诉她我担心关系太快');
  const result2=apply(store,denied,[{type:'save_note',text:'我担心关系太快',use:'draft',evidenceQuote:denied.text}]);
  assert.equal(result2.pendingActions.length,1);assert.equal(store.getCompanion(scope).notes.length,1);
});

test('specific explicit sharing authorization and later private corrections preserve permission intent', t => {
  const store = setup(t), note = store.saveNote(scope, { text: '今天看了展览', use: 'discussion' });
  const turn = say(store, `「${note.text}」这条可以分享给她。`);
  const result = apply(store, turn, [{ type: 'update_note', noteId: note.id, targetQuote: note.text, use: 'draft', evidenceQuote: turn.text }]);
  assert.equal(result.receipts[0]?.status, 'applied'); assert.equal(store.getCompanion(scope).notes[0].use, 'draft');
  const privateNote = store.saveNote(scope, { text: '只供自己思考', use: 'discussion' });
  const correction = say(store, '更正「只供自己思考」，只供自己整理心情。');
  apply(store, correction, [{ type: 'update_note', noteId: privateNote.id, targetQuote: privateNote.text, text: '只供自己整理心情', evidenceQuote: correction.text }]);
  assert.equal(store.getCompanion(scope).notes.find(n => n.id === privateNote.id).use, 'discussion');
});

test('pending target or authority changes invalidate confirmation', t => {
  const store = setup(t), note = store.saveNote(scope, { text: '旧背景', use: 'discussion' });
  const turn = say(store, '把那条背景改成新的说明');
  const result = apply(store, turn, [{ type: 'update_note', noteId: note.id, text: '新的说明', evidenceQuote: turn.text }]);
  store.saveNote(scope, { id: note.id, text: '后来已经修正', use: 'discussion' });
  assert.throws(() => confirmUserAction(store, scope, result.pendingActions[0], 'confirm'), /已经变化/);
  assert.equal(store.getCompanion(scope).notes[0].text, '后来已经修正');
});

test('confirmation uses the stored scoped proposal and cannot replay or replace its payload', t => {
  const store=setup(t),turn=say(store,'帮我考虑要不要把这个目标记下来。');
  const proposal=apply(store,turn,[{type:'set_goal',text:'慢慢相互了解',evidenceQuote:turn.text}]).pendingActions[0];
  confirmUserAction(store,scope,{...proposal,action:{...proposal.action,text:'伪造客户端目标'}},'confirm');
  assert.equal(store.getCompanion(scope).goal.text,'慢慢相互了解');
  assert.throws(()=>confirmUserAction(store,scope,proposal,'confirm'),/已经变化或处理/);
});

test('local feedback stays local while explicit future expression preference is durable', t => {
  const store = setup(t), local = say(store, '这一句太长了');
  const rejectedInference = apply(store, local, [{ type: 'set_preference', text: '这一句太长了', evidenceQuote: local.text }]);
  assert.equal(rejectedInference.pendingActions.length, 1); assert.equal(store.getCompanion(scope).notes.length, 0);
  const preference = say(store, '记住以后回复简短一些');
  const result = apply(store, preference, [{ type: 'set_preference', text: '以后回复简短一些', evidenceQuote: preference.text }]);
  assert.equal(result.receipts[0].status, 'applied'); assert.equal(store.getCompanion(scope).notes[0].kind, 'preference');
  assert.equal(store.getCompanion(scope).notes[0].use, 'discussion');
  const negative=say(store,'记住以后回复不要用夸张的语气');
  const saved=apply(store,negative,[{type:'set_preference',text:'以后回复不要用夸张的语气',evidenceQuote:negative.text}]);
  assert.equal(saved.receipts[0]?.status,'applied');assert.equal(saved.pendingActions.length,0);
  const questions=say(store,'记住不要连续问三个问题');
  assert.equal(apply(store,questions,[{type:'set_preference',text:'不要连续问三个问题',evidenceQuote:questions.text}]).receipts[0]?.status,'applied');
});

test('goal and note undo reject changed targets and missing authority', t => {
  const store = setup(t); store.setGoal(scope, '原目标');
  const turn = say(store, '我的目标改为慢慢互相了解');
  const receipt = apply(store, turn, [{ type: 'set_goal', text: '慢慢互相了解', evidenceQuote: turn.text }]).receipts[0];
  assert.equal(undoUserAction(store, scope, receipt).status, 'undone'); assert.equal(store.getCompanion(scope).goal.text, '原目标');
  const save = say(store, '记住我喜欢摄影');
  const added = apply(store, save, [{ type: 'save_note', text: '我喜欢摄影', evidenceQuote: save.text }]).receipts[0];
  store.saveNote(scope, { id: added.undo.id, text: '我喜欢街头摄影', use: 'discussion' });
  assert.throws(() => undoUserAction(store, scope, added), /后来已修改/);
  store.deleteTurn(scope, save.id); assert.throws(() => undoUserAction(store, scope, added), /依据已删除/);
});

test('precise forget excludes original QQ from memory while retaining actual evidence and no secret receipt', t => {
  const store = setup(t), message = normalize(raw(undefined, false, { elements: [{ textElement: { content: '私密旧内容' } }] }), scope);
  store.add(scope, [message]); const turn = say(store, '忘记「私密旧内容」');
  const result = apply(store, turn, [{ type: 'forget', sourceId: `qq:${message.messageId}`, targetQuote: message.text, evidenceQuote: turn.text }]);
  assert.equal(result.receipts[0].status, 'applied'); assert.equal(result.receipts[0].undo, undefined);
  assert.equal(store.messages(scope).length, 1); assert.ok(store.ignoredSources(scope).includes(`qq:${message.messageId}`));
  assert.equal(JSON.stringify(result.receipts[0]).includes('私密旧内容'), false);
});

test('private user source corrections retain source identity and can undo; actual QQ cannot be rewritten', t => {
  const store = setup(t), original = say(store, '我周六去了展览');
  const command = say(store, '更正「我周六去了展览」，我周日去了展览。');
  const result = apply(store, command, [{ type: 'correct_source', sourceId: `private:${original.id}`, targetQuote: original.text, text: '我周日去了展览', evidenceQuote: command.text }]);
  assert.equal(result.receipts[0].status, 'applied'); assert.equal(store.getCompanion(scope).turns.find(t => t.id === original.id).text, '我周日去了展览');
  undoUserAction(store, scope, result.receipts[0]); assert.equal(store.getCompanion(scope).turns.find(t => t.id === original.id).text, original.text);
  const rejected = apply(store, command, [{ type: 'correct_source', sourceId: 'qq:123', text: '伪造她说过的话', evidenceQuote: command.text }]);
  assert.equal(rejected.receipts[0].status, 'rejected');
});

test('live-model action shapes preserve sentence punctuation and negative preference constraints', t => {
  const store=setup(t);
  const note=say(store,'帮我记下，上周终于把阳台的番茄种活了。这条先只用于私下讨论。');
  const saved=apply(store,note,[{type:'save_note',evidenceQuote:note.text,text:'上周终于把阳台的番茄种活了。',sourceId:`private:${note.id}`,use:'discussion'}]);
  assert.equal(saved.receipts[0]?.status,'applied');assert.equal(saved.pendingActions.length,0);
  assert.equal(store.getCompanion(scope).notes[0].text,'上周终于把阳台的番茄种活了。');
  assert.equal(store.getCompanion(scope).notes[0].use,'discussion');
  const request=say(store,'记住以后回复简短一些，但不要为了简短忽略她说的事。');
  const preference=apply(store,request,[{type:'set_preference',evidenceQuote:request.text,text:'以后回复简短一些，但不要为了简短忽略她说的事。'}]);
  assert.equal(preference.receipts[0]?.status,'applied');assert.equal(preference.pendingActions.length,0);
  assert.equal(store.getCompanion(scope).notes.at(-1).text,'以后回复简短一些，但不要为了简短忽略她说的事。');
});

test('future negative preferences are commands while conditional future intent remains a proposal', t => {
  const store=setup(t),direct=say(store,'以后不要连续追问她。');
  const applied=apply(store,direct,[{type:'set_preference',evidenceQuote:direct.text,text:direct.text}]);
  assert.equal(applied.receipts[0]?.status,'applied');assert.equal(applied.pendingActions.length,0);
  const conditional=say(store,'如果以后觉得合适，再记住回复简短这个偏好。');
  const proposed=apply(store,conditional,[{type:'set_preference',evidenceQuote:conditional.text,text:'回复简短'}]);
  assert.equal(proposed.receipts.length,0);assert.equal(proposed.pendingActions.length,1);
  assert.equal(store.getCompanion(scope).notes.length,1);
});
