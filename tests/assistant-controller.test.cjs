'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const {withoutCurrentControl}=require('./fixtures/wording-lanes.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Controller } = require('./fixtures/whole-answer-fidelity.cjs');
const { Store } = require('../src/store.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

// Native fixture fields come from the same source-shaped records used by the
// existing integration tests. All relationship content and models are synthetic.
const tick = () => new Promise(resolve => setImmediate(resolve));
const goal = '逐渐了解彼此，建立自然、双向关心的关系';
function setup(assistantModel, filename = ':memory:') {
  const store = new Store(filename);
  let selected = scope;
  const settings = {
    auto: false, apiKey: 'synthetic-only', model: 'synthetic-assistant', baseUrl: 'http://fixture.invalid/v1',
    realChatConsent: { accountUid: scope.accountUid, peerUin: scope.peerUin, model: 'synthetic-assistant', baseUrl: 'http://fixture.invalid/v1' }
  };
  const fidelityCalls=[];
  const controller = new Controller({ store, settings, assistantModel:async(...args)=>{
    if(args[1].payload.purpose==='fidelity_check'){fidelityCalls.push(structuredClone(args[1].payload));return {checkRef:args[1].payload.checkRef,factual:factualReview(args[1].payload,{}),verdict:'allow',issues:[]};}
    return assistantModel(...args);
  },
    read: async (command, args) => {
      if (command === 'bind') {
        selected = args.uin === scope.peerUin ? scope : { ...scope, peerUid: 'u_other', peerUin: String(args.uin) };
        return selected;
      }
      return { source: 'synthetic', messages: [] };
    },
    model: async () => { throw new Error('Legacy draft generation is not the private discussion path'); }
  });
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  return { controller, store, fidelityCalls, async bind() { await controller.bind(scope.peerUin); },
    close() { controller.close(); store.close(); } };
}
function companion(app) { return app.controller.snapshot().companion; }
function assistantTexts(app, selected = scope) {
  return app.store.getCompanion(selected).turns.filter(turn => turn.role === 'assistant').map(turn => turn.text);
}
async function waitFor(testFn) {
  for (let index = 0; index < 20; index++) { if (testFn()) return; await tick(); }
  assert.fail('Synthetic model call did not start');
}

test('private discussion works without QQ history, continues across restart, and stays contact-scoped', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assistant-thread-test-'));
  const filename = path.join(directory, 'synthetic.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let firstContext;
  const first = setup(async (_, context) => {
    firstContext = context;
    return { kind: 'discussion', text: '先说说你想让她了解实验的哪一部分。' };
  }, filename);
  try {
    await first.bind();
    await first.controller.setGoal(goal);
    await first.controller.assist({ text: '实验终于成功了，但我还没想清楚怎么分享。', purpose: 'discussion' });
    assert.equal(first.controller.snapshot().total, 0);
    assert.equal(companion(first).turns.length, 2);
    assert.equal(companion(first).goal.text, goal);
    assert.equal(firstContext.payload.purpose, 'discussion');
    assert.match(JSON.stringify(firstContext.payload), /实验终于成功了/);
    assert.equal(JSON.parse(first.store.export(scope, 'json').data).messages.length, 0);
  } finally { first.close(); }
  let followupContext;
  const second = setup(async (_, context) => {
    followupContext = context;
    return { kind: 'options', text: '可以先分享成功的开心，技术细节等她有兴趣再说。' };
  }, filename);
  try {
    await second.bind();
    assert.equal(companion(second).turns.length, 2);
    await second.controller.assist({ text: '我主要想分享终于松了口气。', purpose: 'discussion' });
    const text = JSON.stringify(followupContext.payload);
    assert.match(text, /实验终于成功了/);
    assert.match(text, /先说说你想让她了解/);
    assert.equal(companion(second).goal.text, goal);
    await second.controller.bind('2222222222');
    assert.equal(companion(second).turns.length, 0);
    assert.equal(JSON.stringify(companion(second)).includes('实验终于成功了'), false);
    await second.bind();
    assert.equal(companion(second).turns.length, 4);
  } finally { second.close(); }
});

test('provider failure preserves private input without creating an answer or completed state coverage', async t => {
  const app = setup(async () => { throw new Error('synthetic-provider-unavailable'); });
  t.after(() => app.close());
  await app.bind();
  await assert.rejects(app.controller.assist({ text: '今天没有新消息，也可以帮我想想吗？', purpose: 'discussion' }), /synthetic-provider-unavailable/);
  const state = app.controller.snapshot();
  assert.equal(state.companion.turns.filter(turn => turn.role === 'user').length, 1);
  assert.equal(state.companion.turns[0].text, '今天没有新消息，也可以帮我想想吗？');
  assert.equal(state.companion.turns.filter(turn => turn.role === 'assistant').length, 0);
  assert.equal(state.companion.state.coverage.complete, false);
  assert.equal(state.assistantBusy, false);
  assert.match(state.assistantError, /synthetic-provider-unavailable/);
});

test('explicit local help and feedback do not rewrite the user-owned long-term goal', async t => {
  const app = setup(async () => ({ kind: 'discussion', text: '这次可以先想清楚，不急着决定说法。' }));
  t.after(() => app.close());
  await app.bind();
  await app.controller.setGoal(goal);
  const version = companion(app).goal.version;
  await app.controller.assist({ text: '这次先想清楚，暂时不用草稿。', purpose: 'discussion' });
  const reply = companion(app).turns.find(turn => turn.role === 'assistant');
  assert.ok(reply.requestId);
  await app.controller.addFeedback({ requestId: reply.requestId, text: '这次说得有点正式。' });
  assert.equal(companion(app).goal.text, goal);
  assert.equal(companion(app).goal.version, version);
  assert.equal(companion(app).feedback[0].requestId, reply.requestId);
  await app.controller.setGoal('先作为普通朋友相处');
  assert.equal(companion(app).goal.text, '先作为普通朋友相处');
  assert.ok(companion(app).goal.version > version);
});

test('mixed current private meaning is control-only while outward material stays independently approved', async t => {
  const contexts = [];
  const privateFear = 'PRIVATE_FEAR_我怕她嫌我烦';
  const privateNote = 'PRIVATE_NOTE_这周很担心她不喜欢我';
  const shareable = '实验终于成功了';
  const app = setup(async (_, context) => {
    contexts.push(structuredClone(context));
    if (context.payload.purpose === 'draft_prepare') {
      const material = context.payload.sources.find(source => source.type === 'note' && source.text === '今天去爬山了');
      assert.ok(material, 'selected draft material must reach preparation');
      return { kind: 'discussion', text: '只分享本次获准的真实近况。', draftPlan: withCurrentDraftControls({ style: 'short', quotes: [
        { sourceId: context.payload.userRequest.sourceId, text: shareable,authorization:{permission:{sourceId:context.payload.userRequest.sourceId,text:context.payload.userRequest.text},referent:{sourceId:context.payload.userRequest.sourceId,text:shareable}} },
        { sourceId: material.id, text: material.text }
      ] },context.payload),answer:{privateExplanation:'可以这样分享：',suggestions:[{style:'简短',text:'实验终于成功啦，今天还出去爬了山，挺开心的。'}]} };
    }
    assert.fail(`Unexpected primary purpose: ${context.payload.purpose}`);
  });
  t.after(() => app.close());
  await app.bind();
  await app.controller.setGoal(goal);
  await app.controller.saveNote({ text: privateNote, use: 'discussion' });
  await app.controller.saveNote({ text: '今天去爬山了', use: 'draft' });
  const selected = companion(app).notes.find(note => note.text === '今天去爬山了');
  await app.controller.assist({ text: `${privateFear}，但想告诉她${shareable}，帮我写一句。`, purpose: 'draft', materialIds: [selected.id] });
  assert.equal(contexts.length, 1);
  assert.equal(app.fidelityCalls.length,1);
  const admitted=app.controller.assistantContext().run.payload;
  assert.equal(admitted.purpose,'answer_admission');
  assert.match(JSON.stringify(contexts[0].payload), /PRIVATE_FEAR_/);
  const outgoing = JSON.stringify(withoutCurrentControl(admitted,`${privateFear}，但想告诉她${shareable}，帮我写一句。`));
  assert.equal(admitted.currentHumanControl.sourceId,contexts[0].payload.intentAuthority.sourceId);
  assert.deepEqual(admitted.outboundQuotes.map(quote=>({sourceId:quote.sourceId,text:quote.text})),[
    {sourceId:`note:${selected.id}`,text:selected.text},{sourceId:contexts[0].payload.userRequest.sourceId,text:shareable}
  ]);
  for (const excluded of [privateFear, privateNote, goal, '我怕她嫌我烦']) assert.equal(outgoing.includes(excluded), false, excluded);
  assert.equal(admitted.userRequest, undefined);
  assert.equal(admitted.goal, undefined);
  assert.match(outgoing, /实验终于成功了/);
  assert.match(outgoing, /今天去爬山了/);
  assert.equal(companion(app).turns.at(-1).suggestions.length, 1);
  for(const excluded of [privateFear,privateNote,goal,'我怕她嫌我烦'])assert.equal(JSON.stringify(companion(app).turns.at(-1).suggestions).includes(excluded),false,excluded);
  assert.equal(app.controller.snapshot().total, 0, 'generating a draft is not an actual send');
});

test('invalid draft references cannot authorize discussion-only or unselected notes', async t => {
  let calls = 0;
  let forbiddenId;
  const app = setup(async (_, context) => {
    calls++;
    assert.equal(context.payload.purpose, 'draft_prepare');
    return { kind: 'discussion', text: 'This unauthorized note must be rejected.', draftPlan: withCurrentDraftControls({ style: 'natural', quotes: [{ sourceId: `note:${forbiddenId}`, text: '不想告诉她的担忧' }] },context.payload),answer:{suggestions:[{style:'自然',text:'不想告诉她的担忧'}]} };
  });
  t.after(() => app.close());
  await app.bind();
  await app.controller.saveNote({ text: '不想告诉她的担忧', use: 'discussion' });
  forbiddenId = companion(app).notes[0].id;
  await assert.rejects(app.controller.assist({ text: '帮我分享实验成功了。', purpose: 'draft', materialIds: [] }),error=>error.code==='primary_authority_reference_missing'&&error.issues?.some(item=>item.path==='materials[0].authorityRef'));
  assert.equal(calls, 1, 'a readable discussion-only note has no outward authority and cannot reach checking');
  assert.equal(app.fidelityCalls.length, 0);
  assert.equal(assistantTexts(app).length, 0);
});

test('source and selection changes discard both a late answer and its state patch', async t => {
  const cases = [
    ['contact switch', async app => app.controller.bind('2222222222')],
    ['goal edit', async app => app.controller.setGoal('普通朋友相处即可')],
    ['note deletion', async app => app.controller.deleteNote(companion(app).notes[0].id)],
    ['private input deletion', async app => app.controller.deleteTurn(companion(app).turns.find(turn => turn.role === 'user').id)],
    ['model and permission change', async app => { app.controller.settings.realChatConsent = null; app.controller.modelChanged(); }],
    ['new actual QQ event', async app => app.controller.live({ scope, messages: [raw()] })]
  ];
  for (const [label, invalidate] of cases) await t.test(label, async subtest => {
    let finish, context;
    const app = setup(async (_, received) => {
      context = received;
      return new Promise(resolve => { finish = resolve; });
    });
    subtest.after(() => app.close());
    await app.bind();
    await app.controller.saveNote({ text: '一次尚未决定的邀请', use: 'discussion' });
    const pending = app.controller.assist({ text: '先一起想想下一步。', purpose: 'discussion' });
    await waitFor(() => finish);
    await invalidate(app);
    finish({ kind: 'discussion', text: 'STALE_RESPONSE_MUST_NOT_SURVIVE', statePatch: {
      focus: 'STALE_FOCUS_MUST_NOT_SURVIVE', items: [{ text: 'STALE_FACT_MUST_NOT_SURVIVE', sourceIds: [context.payload.userRequest.sourceId] }]
    } });
    await pending;
    const all = JSON.stringify(app.store.getCompanion(scope));
    assert.equal(all.includes('STALE_RESPONSE_MUST_NOT_SURVIVE'), false);
    assert.equal(all.includes('STALE_FOCUS_MUST_NOT_SURVIVE'), false);
    assert.equal(all.includes('STALE_FACT_MUST_NOT_SURVIVE'), false);
    assert.equal(app.controller.snapshot().assistantBusy, false);
  });
});

test('newer private request wins when model responses arrive out of order', async t => {
  const pendingCalls = [];
  const app = setup(async (_, context) => new Promise(resolve => pendingCalls.push({ context, resolve })));
  t.after(() => app.close());
  await app.bind();
  const old = app.controller.assist({ text: '先想个开场。', purpose: 'discussion' });
  await waitFor(() => pendingCalls.length === 1);
  const current = app.controller.assist({ text: '等等，先帮我理清想表达什么。', purpose: 'discussion' });
  await waitFor(() => pendingCalls.length === 2);
  pendingCalls[1].resolve({ kind: 'question', text: '你更想分享事情本身，还是当时的心情？' });
  await current;
  pendingCalls[0].resolve({ kind: 'discussion', text: 'OLD_REQUEST_RESULT', statePatch: { focus: 'OLD_REQUEST_FOCUS' } });
  await old;
  assert.deepEqual(assistantTexts(app), ['你更想分享事情本身，还是当时的心情？']);
  assert.equal(JSON.stringify(companion(app).state).includes('OLD_REQUEST_FOCUS'), false);
  assert.equal(companion(app).turns.filter(turn => turn.role === 'user').length, 2);
});

test('incoming burst resumes the same explicit question with new evidence without duplicating user input', async t => {
  const calls=[];
  const app=setup(async(_,context)=>new Promise(resolve=>calls.push({context,resolve})));
  t.after(()=>app.close());await app.bind();
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=app.controller.assist({text:'先帮我理解她这次说的意思。',purpose:'discussion'});
  await waitFor(()=>calls.length===1);
  app.controller.live({scope,messages:[raw('72057594037928090',false,{elements:[{textElement:{content:'报告交完了'}}]})]});
  app.controller.live({scope,messages:[raw('72057594037928091',false,{elements:[{textElement:{content:'今晚很累，先不聊了'}}]})]});
  calls[0].resolve({kind:'discussion',text:'obsolete'});await pending;
  t.mock.timers.tick(1801);await waitFor(()=>calls.length===2);
  assert.equal(calls[1].context.payload.userRequest.text,'先帮我理解她这次说的意思。');
  assert.ok(calls[1].context.payload.sources.some(s=>s.text==='今晚很累，先不聊了'));
  calls[1].resolve({kind:'discussion',text:'她明确说今晚先休息，可以自然收尾。'});
  await waitFor(()=>assistantTexts(app).length===1);
  assert.equal(companion(app).turns.filter(turn=>turn.role==='user').length,1);
  assert.equal(assistantTexts(app)[0],'她明确说今晚先休息，可以自然收尾。');
  t.mock.timers.reset();
});

test('successful memory batches reset consecutive failure count even when the next batch fails',async t=>{
  const app=setup(async()=>({kind:'discussion',text:'ok'}));t.after(()=>app.close());await app.bind();
  for(let n=0;n<80;n++)app.store.appendTurn(scope,{role:'user',kind:'discussion',text:`合成来源 ${n}`});
  let calls=0;app.controller.memoryModel=async(_settings,batch)=>{
    calls++;if(calls%2===0)throw new Error('synthetic-transient-500');
    return {reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[]};
  };
  const first=await app.controller.maintainMemory({maxBatches:2});
  assert.equal(first.batches,1);assert.equal(app.controller.memoryFailures,1);
  const second=await app.controller.maintainMemory({maxBatches:2});
  assert.equal(second.batches,1);assert.equal(app.controller.memoryFailures,1,'intervening progress breaks a consecutive-failure streak');
  assert.ok(second.processed>first.processed);
  await app.controller.maintainMemory({maxBatches:2});assert.equal(app.controller.memoryFailures,0);
  assert.equal(app.store.memoryStatus(scope).pending,0);
});

test('a queued automatic suggestion cannot replace the user explicit private request',async t=>{
  let calls=0,finish;
  const app=setup(async()=>{calls++;return new Promise(resolve=>{finish=resolve})});t.after(()=>app.close());await app.bind();
  t.mock.timers.enable({apis:['setTimeout']});app.controller.auto=true;app.controller.schedule();
  const requested=app.controller.assist({text:'先陪我想清楚，不要替我生成回复。'});await waitFor(()=>!!finish);
  app.controller.schedule();t.mock.timers.tick(2000);await tick();assert.equal(calls,1);
  finish({kind:'discussion',text:'我们先理清你想表达的意思。'});await requested;
  assert.equal(assistantTexts(app).at(-1),'我们先理清你想表达的意思。');t.mock.timers.reset();
});

test('revoked actual evidence is absent from future private context and invalidates its derived state', async t => {
  const contexts = [];
  const app = setup(async (_, context) => {
    contexts.push(context);
    if (contexts.length === 1) return { kind: 'discussion', text: '她说周末想看电影。', statePatch: {
      items: [{ text: '她周末想看电影', sourceIds: [`qq:${raw().msgId}`] }]
    } };
    return { kind: 'discussion', text: '这条消息已撤回，目前无法据此确定周末安排。' };
  });
  t.after(() => app.close());
  await app.bind();
  app.controller.live({ scope, messages: [raw(undefined, false, { elements: [{ textElement: { content: '周末想看电影_RECALLED_SOURCE' } }] })] });
  await app.controller.assist({ text: '接下来可以聊什么？', purpose: 'discussion' });
  assert.match(JSON.stringify(companion(app).state), /她周末想看电影/);
  app.controller.live({ scope, messages: [raw(undefined, false, { recallTime: '1' })] });
  assert.equal(JSON.stringify(companion(app).state).includes('她周末想看电影'), false);
  await app.controller.assist({ text: '现在还有什么确定的信息？', purpose: 'discussion' });
  assert.equal(JSON.stringify(contexts.at(-1).payload).includes('RECALLED_SOURCE'), false);
  assert.equal(app.store.messages(scope)[0].messageId, raw().msgId);
});
