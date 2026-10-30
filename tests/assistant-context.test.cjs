'use strict';
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext, buildDraftContext } = require('../src/assistant-context.cjs');
const { assistModel } = require('./fixtures/assistant-protocol.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const {withoutCurrentControl}=require('./fixtures/wording-lanes.cjs');

function message(id, outgoing, text) {
  return normalize(raw(String(id), outgoing, { elements: [{ textElement: { content: text } }] }), scope);
}
function contextFixture(t, { text = '接下来怎样聊？', records = [], notes = [], budget = 48000, purpose = 'discussion', prior = [] } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  if (records.length) store.add(scope, records);
  store.setGoal(scope, 'PRIVATE_GOAL_希望她更主动关心我');
  for (const note of notes) store.saveNote(scope, note);
  for (const turn of prior) store.appendTurn(scope, turn);
  const turn = store.appendTurn(scope, { role: 'user', kind: purpose, text });
  const companion = store.getCompanion(scope);
  const args = { scope, records: store.messages(scope), companion, turn, purpose,
    coverage: { status: 'partial', pages: 1 }, requestId: 'synthetic-context-request', byteBudget: budget };
  return { store, turn, companion, args };
}
function essentialOrExplicitOverflow(build, required) {
  let context;
  try { context = build(); } catch (error) {
    assert.match(error.message, /预算/);
    assert.match(error.message, /没有静默截断|未被截断/);
    return;
  }
  for (const record of required) {
    const actual = context.payload.sources.find(source => source.id === `qq:${record.messageId}`);
    assert.ok(actual, `essential message ${record.messageId} must not be silently omitted`);
    assert.equal(actual.text, record.text, 'essential messages must not be truncated');
  }
}

test('latest outgoing burst retains the preceding incoming boundary before optional notes', t => {
  const records = [message(101, false, `${'背景'.repeat(400)}，今晚不想聊。`),
    ...[102, 103, 104].map(id => message(id, true, `我刚才补充的事情 ${id}`))];
  const { args } = contextFixture(t, { records, budget: 4000, notes: [{ text: 'N'.repeat(1700), use: 'discussion' }] });
  essentialOrExplicitOverflow(() => buildContext(args), records);
});

test('latest incoming burst retains the full preceding outgoing burst rather than only its last bubble', t => {
  const records = [message(201, true, `${'安排'.repeat(300)}，之前的邀请先取消吧。`), message(202, true, '我今晚还在处理事情。'),
    message(203, true, '等双方都方便的时候再说。'), message(204, false, '好，我也正想早点休息。'), message(205, false, '那下次再聊。')];
  const { args } = contextFixture(t, { records, budget: 4000, notes: [{ text: 'N'.repeat(1700), use: 'discussion' }] });
  essentialOrExplicitOverflow(() => buildContext(args), records);
});

test('genuinely oversized current request or essential exchange is rejected rather than silently sliced', t => {
  const hugeRequest = contextFixture(t, { text: '当前请求'.repeat(2000), budget: 4000 });
  assert.throws(() => buildContext(hugeRequest.args), /上下文预算.*没有静默截断/);
  const hugeExchange = contextFixture(t, { records: [message(301, true, '刚才那个安排呢？'),
    message(302, false, `${'她完整的解释'.repeat(2000)}最后决定今晚不见面。`)], budget: 4000 });
  assert.throws(() => buildContext(hugeExchange.args), /上下文预算.*没有静默截断/);
});

test('new user input retains source-backed facts and archives legacy threads without current task authority', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const records = Array.from({ length: 70 }, (_, index) => message(500 + index, index % 2 === 1,
    index === 0 ? '周末一起去看电影吧，时间还没定。' : `后来的普通消息 ${index}`));
  store.add(scope, records);
  const before = store.getCompanion(scope);
  const receipt = store.applyState(scope, {
    items: [{ text: '她提过周末看电影', sourceIds: ['qq:500'] }],
    openThreads: [{ text: '周末电影暂未定具体时间', sourceIds: ['qq:500'], status: 'open' }],
    unknowns: ['双方具体哪天有空']
  }, { baseRevision: before.revision, sourceIds: ['qq:500'], coverage: { complete: false, sourceIds: ['qq:500'] } });
  assert.equal(receipt.applied, true);
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '继续上次的话题。' });
  const companion = store.getCompanion(scope);
  const context = buildContext({ scope, records, companion, turn, requestId: 'synthetic-state-navigation',
    coverage: { status: 'accessible_end', pages: 2 } });
  assert.equal(context.payload.workingState.possiblyStale, true);
  assert.equal(context.payload.workingState.authority, 'previous_summary_needs_review');
  assert.equal(context.payload.workingState.items[0].text, '她提过周末看电影');
  assert.equal(context.payload.workingState.focus, undefined);
  assert.equal(context.payload.workingState.openThreads, undefined);
  assert.equal(context.payload.workingState.unknowns, undefined);
  assert.equal(context.payload.workingState.legacyTaskReviews, undefined, 'historical controls must not enter the model as current state');
  assert.equal(context.payload.topicContext.active, null, 'vague continuation cannot create a current task from archived threads');
  assert.equal(context.payload.sources.find(source => source.id === 'qq:500').text, records[0].text);
  const archived = companion.state.legacyTaskReviews.at(-1);
  assert.equal(archived.status, 'needs_review');
  assert.deepEqual(archived.sourceIds, ['qq:500']);
  assert.equal(archived.sourceRevisions['qq:500'], store.memorySources(scope).find(source => source.id === 'qq:500').revision);
  assert.equal(archived.openThreads[0].text, '周末电影暂未定具体时间');
  assert.equal(archived.openThreads[0].status, 'open', 'archive preserves the original thread status as historical data');
  assert.deepEqual(archived.openThreads[0].sourceIds, ['qq:500']);
  assert.deepEqual(archived.unknowns, ['双方具体哪天有空']);
  assert.deepEqual(store.getCompanion(scope).state, companion.state, 'context projection must not rewrite persisted facts or historical controls');
});

test('retrieved old invitation remains historical until its omitted later chronology is looked up', t => {
  const records = Array.from({ length: 100 }, (_, index) => message(600 + index, index % 2 === 1,
    index === 0 ? '周末一起去看电影吧' : index === 20 ? '取消吧，后来我改主意了。' : `普通消息编号 ${index}`));
  const { args } = contextFixture(t, { records, text: '周末看电影的事还能接着聊吗？' });
  const context = buildContext(args);
  assert.ok(context.payload.sources.some(source => source.id === 'qq:600'), 'the old invitation must actually be retrieved');
  assert.equal(context.payload.sources.some(source => source.id === 'qq:620'), false, 'a past match does not load the entire later conversation');
  assert.equal(context.payload.sources.find(source => source.id === 'qq:600').historicalOnly, true);
  assert.ok(context.payload.deferredContext.qqSourceCount>0);
});

test('old invitation cannot silently appear current when a later cancellation does not fit', t => {
  const records = Array.from({ length: 100 }, (_, index) => message(800 + index, index % 2 === 1,
    index === 0 ? '周末一起去看电影吧' : index === 20 ? `${'X'.repeat(50000)}取消吧，后来我改主意了。` : `普通消息编号 ${index}`));
  const { args } = contextFixture(t, { records, text: '周末看电影的事还能接着聊吗？' });
  const context = buildContext(args);
  const invitation = context.payload.sources.find(source => source.id === 'qq:800');
  assert.ok(invitation, 'the fixture must retrieve the old invitation');
  assert.equal(context.payload.sources.some(source => source.id === 'qq:820'), false, 'oversized intervening evidence cannot fit this fixture');
  assert.equal(invitation.historicalOnly, true);
  assert.equal(invitation.continuationCoverage, 'later_messages_omitted');
  assert.match(context.payload.evidenceRule, /不可据此断言当前约定有效/);
  assert.ok(context.manifest.omittedSourceCount > 0);
});

test('draft preparation rejects unauthorized private sources and respects already granted note permission', t => {
  const fixture = contextFixture(t, { purpose: 'draft_prepare', text: '想告诉她实验终于成功了。',
    notes: [{ text: 'PRIVATE_NOTE_实验期间暂时不想分享的烦恼', use: 'discussion' }, { text: 'UNSELECTED_NOTE_实验成功后准备周末旅行', use: 'draft' }],
    prior: [{ role: 'user', kind: 'discussion', text: 'OLDER_PRIVATE_我对她有好感' }] });
  const prepared = buildContext(fixture.args);
  const forbidden = prepared.payload.sources.filter(source => source.id !== prepared.payload.userRequest.sourceId && source.type !== 'qq' && source.use !== 'draft');
  assert.equal(forbidden.length, 2, 'the preparation fixture must contain the old private turn and the restricted note');
  for (const source of forbidden) assert.throws(() => buildDraftContext(prepared, {
    style: 'natural', quotes: [{ sourceId: source.id, text: source.text }]
  }, fixture.args), /本次明确请求|已选分享素材/);
  const allowed=prepared.payload.sources.find(source=>source.type==='note'&&source.use==='draft');
  const withoutRepeatedCheckbox=buildDraftContext(prepared,withCurrentDraftControls({style:'natural',quotes:[{sourceId:allowed.id,text:allowed.text}]},prepared.payload),fixture.args);
  assert.equal(withoutRepeatedCheckbox.payload.outboundQuotes[0].text,allowed.text);
  assert.throws(() => buildDraftContext(prepared, { style: 'natural', quotes: [
    { sourceId: prepared.payload.userRequest.sourceId, text: '模型编造了一个新经历' }
  ] }, fixture.args), /本次明确请求|已选分享素材/);
});

test('actual serialized drafting request separates complete current controls from approved expression and QQ evidence', async t => {
  const privateFear = 'PRIVATE_FEAR_我怕她嫌我烦';
  const privateNote = 'PRIVATE_NOTE_最近特别患得患失';
  const shared = '实验终于成功了';
  const fixture = contextFixture(t, { purpose: 'draft_prepare', text: `${privateFear}，但想告诉她${shared}。`,
    records: [message(401, false, '最近你的实验怎么样？')],
    notes: [{ text: privateNote, use: 'discussion' }, { text: '今天去爬山了', use: 'draft' }],
    prior: [{ role: 'user', kind: 'discussion', text: 'OLDER_PRIVATE_我总是纠结怎么推进关系' },
      { role: 'assistant', kind: 'discussion', text: 'PRIVATE_SUMMARY_你比较担心被拒绝' }] });
  const selected = fixture.companion.notes.find(note => note.use === 'draft');
  const prepared = buildContext({ ...fixture.args, materialIds: [selected.id] });
  assert.ok(JSON.stringify(prepared.payload).includes(privateFear));
  const context = buildDraftContext(prepared, withCurrentDraftControls({ style: 'short', quotes: [
    { sourceId: prepared.payload.userRequest.sourceId, text: shared },
    { sourceId: `note:${selected.id}`, text: selected.text }
  ] },prepared.payload,{objective:'分享实验成功及登山近况',allowedApproach:'简短地分享真实近况'}), fixture.args);
  let captured;
  const result = await assistModel({ apiKey: 'synthetic-only', baseUrl: 'http://fixture.invalid/v1', model: 'synthetic' }, context, undefined,
    async (url, request) => {
      assert.equal(String(url), 'http://fixture.invalid/v1/chat/completions');
      captured = JSON.parse(request.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'draft', text: '简短分享：',
        suggestions: [{ style: '自然', text: '实验终于成功啦，今天还去爬了山。' }] }) } }] }) };
    });
  const actualSerialized=JSON.stringify(captured),payload=JSON.parse(captured.messages[1].content);
  const otherLanes=withoutCurrentControl(payload,fixture.turn.text);
  const assertionView={...captured,messages:captured.messages.map((message,index)=>index===1?{...message,content:JSON.stringify(otherLanes)}:message)};
  const serialized = JSON.stringify(assertionView);
  for (const excluded of [privateFear, privateNote, 'PRIVATE_GOAL_', 'OLDER_PRIVATE_', 'PRIVATE_SUMMARY_'])
    assert.equal(serialized.includes(excluded), false, excluded);
  assert.match(serialized, /实验终于成功了/);
  assert.match(serialized, /今天去爬山了/);
  assert.match(serialized, /最近你的实验怎么样/);
  const aliases=new Map(context.manifest.sourceHandles.bindings.map(binding=>[binding.handle,binding.sourceId]));
  assert.equal(aliases.get(payload.currentHumanControl.sourceId),prepared.payload.intentAuthority.sourceId);
  assert.deepEqual(payload.outboundQuotes.map(quote=>({sourceId:aliases.get(quote.sourceId),text:quote.text})),[
    {sourceId:prepared.payload.userRequest.sourceId,text:shared},{sourceId:`note:${selected.id}`,text:selected.text}
  ]);
  assert.equal(JSON.stringify(captured),actualSerialized,'the assertion projection cannot change the actual request');
  assert.equal(payload.userRequest, undefined);
  assert.equal(payload.privateConversation, undefined);
  assert.equal(payload.workingState, undefined);
  assert.equal(payload.goal, undefined);
  assert.equal(captured.tools, undefined);
  assert.equal(result.suggestions.length, 1);
  for(const excluded of [privateFear,privateNote,'PRIVATE_GOAL_','OLDER_PRIVATE_','PRIVATE_SUMMARY_'])assert.equal(JSON.stringify(result.suggestions).includes(excluded),false,excluded);
});
