'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { Controller } = require('../src/controller.cjs');
const { parseAssistant } = require('../src/assistant-model.cjs');
const { buildContext } = require('../src/assistant-context.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const explanation = '她正在分享自己的游戏习惯；先接住吐槽，暂时不直接问游戏名，也不马上邀请一起玩。';
const summary = '先接住她的吐槽';
const wording = '哈哈，PVP确实有时候越打越上头';
function setup(t, { composerRecovery = false } = {}) {
  const store = new Store(':memory:');
  const message = normalize(raw('72057594037927937', false, { elements: [{ textElement: { content: '我不怎么玩PVP，玩点回合制PVE的' } }] }), scope);
  store.add(scope, [message]); store.setGoal(scope, '与她发展双方愿意的恋爱关系');
  const inputs = [], settings = { model: 'synthetic-explanation', baseUrl: 'http://synthetic.invalid/v1', anonymous: true, auto: false,
    realChatConsent: { ...scope, model: 'synthetic-explanation', baseUrl: 'http://synthetic.invalid/v1' } };
  const controller = new Controller({ store, settings, read: async () => ({ messages: [], source: 'synthetic' }), assistantModel: async (_, input) => {
    inputs.push(structuredClone(input.payload));
    if (input.payload.purpose === 'draft') {
      if (composerRecovery) input.manifest.responseRecovery = { kind: 'restricted_draft', reasonCode: 'structured_output_invalid', metadataApplied: false, intentSourceIds: [] };
      return { kind: 'draft', text: summary, suggestions: [{ style: '自然', text: wording }] };
    }
    const sourceId = input.payload.intentAuthority?.sourceId || input.payload.userRequest.sourceId;
    return { kind: 'discussion', text: explanation, draftPlan: { intent: 'reply', quotes: [], guidance: {
      objective: { text: '回应她真实分享的游戏习惯', sourceIds: [sourceId] },
      allowedApproach: { text: '先接住PVP吐槽，再自然接话', sourceIds: [sourceId] },
      avoidances: [{ text: '暂时不直接问游戏名，不马上邀请', sourceIds: [sourceId] }] } } };
  } });
  controller.visible = false; controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } }); controller.scope = { ...scope };
  t.after(() => { controller.close(); store.close(); });
  return { store, controller, inputs, message };
}
test('readable planning and lookup steps retain their explanation while legacy pure envelopes remain accepted', () => {
  const payload = { sources: [], methodSelection: { candidates: [], maxApplied: 2 }, topicContext: { active: null } };
  for (const operation of [{ draftPlan: { intent: 'reply', quotes: [] } }, { lookup: { query: 'later actual reply' } }]) {
    const readable = parseAssistant({ kind: 'discussion', text: explanation, ...operation }, 'discussion', payload);
    assert.equal(readable.kind, 'discussion'); assert.equal(readable.text, explanation);
    const legacy = parseAssistant(operation, 'discussion', payload);
    assert.equal(legacy.kind, undefined); assert.equal(legacy.text, undefined);
  }
});
for (const composerRecovery of [false, true]) test(`private explanation survives composer${composerRecovery ? ' recovery' : ''} without entering outgoing material`, async t => {
  const { store, controller, inputs } = setup(t, { composerRecovery });
  const reply = await controller.assist({ text: '先接吐槽，暂时不直接问游戏名；给我一句，也解释为什么这样接', purpose: 'discussion' });
  assert.deepEqual(inputs.map(input => input.purpose), ['discussion', 'draft']);
  assert.deepEqual(reply.discussionExplanation, { kind: 'discussion', text: explanation });
  assert.equal(reply.text, summary); assert.equal(reply.suggestions[0].text, wording);
  assert.ok(!JSON.stringify(inputs[1]).includes(explanation), 'private rationale is user-visible generated help, never drafting input or outbound authorization');
  assert.ok(!JSON.stringify(inputs[1].outboundQuotes).includes(explanation));
  const saved = store.getCompanion(scope).turns.find(turn => turn.id === reply.id);
  assert.deepEqual(saved.discussionExplanation, reply.discussionExplanation);
  assert.equal(store.experiences.artifact(scope, reply.artifactRef).body, `${explanation}\n\n${summary}`);
  assert.equal(store.experiences.artifact(scope, reply.suggestions[0].artifactRef).body, wording);
  assert.equal(store.messages(scope).length, 1, 'assistant explanation and wording create no actual QQ messages');
});
test('whole-response feedback evaluates the displayed explanation, while draft feedback evaluates wording alone', async t => {
  const { store, controller } = setup(t), reply = await controller.assist({ text: '解释依据，也给一句接话', purpose: 'discussion' });
  const responseFeedback = store.experiences.addFeedback(scope, { text: '这段依据有帮助', targetRef: { kind: 'artifact', artifactRef: reply.artifactRef }, clientEventId: 'synthetic-response-explanation-feedback' });
  const draftFeedback = store.experiences.addFeedback(scope, { text: '这句表达自然', targetRef: { kind: 'artifact', artifactRef: reply.suggestions[0].artifactRef }, clientEventId: 'synthetic-draft-wording-feedback' });
  assert.equal(store.experiences.hydrateFeedback(scope, responseFeedback.id).target.body, `${explanation}\n\n${summary}`);
  assert.equal(store.experiences.hydrateFeedback(scope, draftFeedback.id).target.body, wording);
});
test('a later private discussion can retrieve the explanation as generated help, never as an original factual source', async t => {
  const { store, controller } = setup(t), reply = await controller.assist({ text: '解释依据，也给一句接话', purpose: 'discussion' });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '刚才为什么这样接？再讨论一下' });
  const context = buildContext({ scope, records: store.messages(scope), companion: store.getCompanion(scope), turn, requestId: 'synthetic-explanation-recall',
    availableSources: store.memorySources(scope), retrievedDiscussion: [reply], coverage: { status: 'partial' } });
  const recent = context.payload.privateConversation.find(item => item.id === reply.id);
  assert.equal(recent.discussionExplanation.text, explanation); assert.match(recent.authority, /assistant/);
  assert.equal(context.payload.retrievedDiscussion.find(item => item.id === reply.id).discussionExplanation.text, explanation);
  assert.ok(!context.payload.sources.some(source => source.id === `private:${reply.id}`));
});
test('a clarification retains its private explanation separately without starting the composer', async t => {
  const { store, controller, inputs } = setup(t);
  controller.assistantModel = async (_, input) => { inputs.push(input.payload); return { kind: 'discussion', text: explanation, draftPlan: { clarification: '你这次希望只接住吐槽，还是也愿意邀请？' } }; };
  const reply = await controller.assist({ text: '我还不确定怎么表达', purpose: 'discussion' });
  assert.equal(inputs.length, 1); assert.equal(reply.kind, 'question'); assert.deepEqual(reply.discussionExplanation, { kind: 'discussion', text: explanation });
  assert.equal(reply.text, '你这次希望只接住吐槽，还是也愿意邀请？'); assert.equal(reply.suggestions, undefined);
  assert.equal(store.experiences.artifact(scope, reply.artifactRef).body, `${explanation}\n\n${reply.text}`);
});
test('QQ reply advice exposes the same full help text while only wording remains adoptable', async t => {
  const { store, controller } = setup(t);
  const reply = await controller.assist({ text: '接住吐槽，暂时不邀请；解释依据，也给一句接话', purpose: 'reply' });
  assert.equal(controller.advice.analysis, `${explanation}\n\n${summary}`);
  assert.equal(controller.advice.suggestions[0].text, wording);
  await controller.suggest();
  assert.equal(controller.advice.analysis, `${explanation}\n\n${summary}`);
  assert.equal(controller.advice.suggestions[0].text, wording);
  assert.equal(store.messages(scope).length, 1);
});
test('deletion and source withdrawal remove private explanation bodies and their feedback lineage', async t => {
  for (const operation of ['delete_output', 'forget_source']) {
    const { store, controller, message } = setup(t), reply = await controller.assist({ text: '解释依据，也给一句接话', purpose: 'discussion' });
    assert.equal(reply.discussionExplanation.text, explanation);
    const feedback = store.experiences.addFeedback(scope, { text: '依据太笼统', targetRef: { kind: 'artifact', artifactRef: reply.artifactRef }, clientEventId: `synthetic-${operation}-feedback` });
    if (operation === 'delete_output') store.deleteTurn(scope, reply.id); else store.forgetSource(scope, `qq:${message.messageId}`);
    assert.ok(!store.getCompanion(scope).turns.some(turn => turn.id === reply.id));
    assert.equal(store.experiences.artifact(scope, reply.artifactRef).availability, 'redacted');
    assert.equal(store.experiences.artifact(scope, reply.artifactRef).body, '');
    assert.equal(store.experiences.hydrateFeedback(scope, feedback.id), null);
    assert.ok(!JSON.stringify(store.getCompanion(scope)).includes(explanation));
  }
});
test('store accepts only bounded assistant explanation metadata and deduplicates identical visible text', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const discussionExplanation of [{ kind: 'draft', text: explanation }, { kind: 'discussion', text: '' }, { kind: 'discussion', text: 'x'.repeat(6001) }, { kind: 'discussion', text: explanation, suggestions: [] }])
    assert.throws(() => store.appendTurn(scope, { role: 'assistant', kind: 'draft', text: summary, discussionExplanation }), /explanation/i);
  assert.throws(() => store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '合成用户请求', discussionExplanation: { kind: 'discussion', text: explanation } }), /explanation/i);
  const saved = store.appendTurn(scope, { role: 'assistant', kind: 'draft', text: summary, discussionExplanation: { kind: 'discussion', text: summary } });
  assert.equal(store.experiences.artifact(scope, saved.artifactRef).body, summary);
});
