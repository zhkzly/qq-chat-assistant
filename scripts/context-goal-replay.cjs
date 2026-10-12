'use strict';
// All events are synthetic. The application controller/store/context are real.
// --live is opt-in and never receives production chat data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Controller } = require('../src/controller.cjs');
const { Store } = require('../src/store.cjs');
const { assistModel } = require('../src/assistant-model.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('../tests/fixtures/native.cjs');

const GOAL = '慢慢互相了解，建立自然、双向关心的关系';
const PRIVATE = '私下担忧_我害怕自己不够有趣';
const SHARE = '上周终于把阳台的番茄种活了';
const SECOND_SHARE = '周末学会了弹一小段吉他';
const OLD = '她以前跟我提起，家里的狸花猫叫洛可，一听到鼓掌就躲起来。';
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const live = flag('--live');
const reportFile = option('--out') || path.join(os.tmpdir(), `qq-context-goal-replay-${live ? 'live' : 'synthetic'}.json`);
const onlyCases = option('--cases')?.split(',');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-goal-replay-'));
const report = { evidence: live ? 'live_model_with_synthetic_application_events' : 'synthetic_model_with_real_application_pipeline',
  startedAt: new Date().toISOString(), relationshipOutcomeVerified: false, desktopIntegrationVerified: false,
  notes: ['Model fixtures test plumbing, not model comprehension.', 'Passing these known cases is regression evidence, not unseen-case generalization.'], cases: [] };
let config;
if (live) {
  if (!option('--settings')) throw new Error('--live requires an explicitly selected --settings file');
  const rawSettings = JSON.parse(fs.readFileSync(path.resolve(option('--settings')), 'utf8'));
  const active = rawSettings.modelProfiles?.find(p => p.id === rawSettings.activeModelProfileId);
  const selected = active || rawSettings;
  config = { baseUrl: selected.baseUrl, model: selected.model, apiKey: selected.apiKey,
    anonymous: selected.anonymous === true, assistantContextBytes: 48000, auto: false };
  if (!config.baseUrl || !config.model || !(config.apiKey || config.anonymous)) throw new Error('Selected model configuration is incomplete');
  report.model = config.model;
} else config = { baseUrl: 'http://synthetic.invalid/v1', model: 'synthetic-goal-replay', apiKey: 'synthetic-only', auto: false };

function textOf(context) { return JSON.stringify(context.payload); }
function latest(record) { return record.turns.filter(t => t.role === 'assistant').at(-1); }
const sentenceContent = value => value.trim().replace(/[。.]$/, '');
function event(id, text, seconds, own = false) {
  return raw(id, own, { msgTime: String(seconds), elements: [{ elementType: 1, textElement: { content: text } }] });
}
const ordinaryResponse = { kind: 'discussion', text: '先沿着实际了解和这次想表达的事情讨论，暂不判断对方心意。', methodIds: ['choose_next_step'] };
function responseFor(stage, context) {
  const input = context.payload.userRequest?.text || '';
  if (context.payload.purpose === 'draft') return { kind: 'draft', text: '可修改的参考表达',
    suggestions: [{ style: '自然', text: (context.payload.outboundQuotes || []).map(q => q.text).join('，') || '今天怎么样？' }], methodIds: ['compose'] };
  if (stage === 'goal') return { kind: 'acknowledgment', text: '目标修改已交由程序核对。', methodIds: ['correction'],
    actions: [{ type: 'set_goal', evidenceQuote: input, text: GOAL }] };
  if (stage === 'note') return { kind: 'acknowledgment', text: '背景已交由程序核对。', methodIds: ['correction'],
    actions: [{ type: 'save_note', evidenceQuote: input, text: SHARE, use: 'discussion' }] };
  if (stage === 'preference') return { kind: 'acknowledgment', text: '长期表达偏好已交由程序核对。', methodIds: ['correction'],
    actions: [{ type: 'set_preference', evidenceQuote: input, text: '以后回复简短一些，但不要为了简短忽略她说的事' }] };
  if (stage === 'discussion-option') return { kind: 'options', text: '可以分享种番茄的进展，担忧留在这里讨论。', methodIds: ['choose_next_step'],
    expressionOptions: [{ label: '分享种番茄的小进展', quotes: [{ sourceId: context.payload.userRequest.sourceId, text: SHARE }], style: 'natural' }] };
  if (stage === 'two-options') return { kind: 'options', text: '可以聊种番茄的小进展，也可以分享学吉他的经历。这次还没选定。', methodIds: ['choose_next_step'],
    expressionOptions: [{ label: '种番茄', quotes: [{ sourceId: context.payload.userRequest.sourceId, text: SHARE }], style: 'natural' },
      { label: '学吉他', quotes: [{ sourceId: context.payload.userRequest.sourceId, text: SECOND_SHARE }], style: 'natural' }] };
  if (stage === 'ambiguous-followup') return { draftPlan: { clarification: '你指分享番茄的小进展，还是学吉他的经历？' } };
  if (stage === 'followup-draft' || stage === 'restricted-draft') {
    const candidate = context.payload.sources?.find(s => s.text.includes(SHARE));
    assert.ok(candidate, 'model fixture cannot draft without actual shareable evidence in input');
    return { draftPlan: { style: 'natural', authorizationQuote: input, quotes: [{ sourceId: candidate.id, text: SHARE }] } };
  }
  if (stage === 'quick') {
    const qq = context.payload.sources?.filter(s => s.type === 'qq').at(-1);
    assert.ok(qq, 'quick reply must carry actual QQ');
    return { draftPlan: { style: 'natural', quotes: [{ sourceId: qq.id, text: qq.text }] } };
  }
  return ordinaryResponse;
}

function application(testCase, filename = path.join(temp, `${testCase.id}.sqlite`)) {
  const store = new Store(filename), calls = [], settings = { ...config };
  let stage = 'ordinary';
  settings.realChatConsent = { accountUid: scope.accountUid, peerUin: scope.peerUin, model: settings.model, baseUrl: settings.baseUrl };
  const controller = new Controller({ store, settings,
    read: async (command, request) => command === 'bind' ? request.uin === scope.peerUin ? scope
      : { ...scope, peerUid: `u_synthetic_${request.uin}`, peerUin: String(request.uin) }
      : { source: 'synthetic-replay', messages: [] },
    // The legacy function must never be reachable through a current entry point.
    model: async () => { throw new Error('Legacy model path was called'); },
    assistantModel: async (receivedSettings, context, signal) => {
      const captured = { stage, context: structuredClone(context) }; calls.push(captured);
      captured.result = live ? await assistModel(receivedSettings, context, signal) : responseFor(stage, context);
      return captured.result;
    },
    memoryModel: async (receivedSettings, batch, signal) => {
      const captured = { stage: 'memory-maintenance', batch: structuredClone(batch) }; calls.push(captured);
      if (live) captured.result = await require('../src/memory-engine.cjs').consolidateMemory(receivedSettings, batch, signal);
      else {
        const source = batch.sources.find(s => s.text === OLD);
        captured.result = { reviewedSourceIds: batch.reviewedSourceIds, items: source ? [{ kind: 'fact', text: OLD,
          sourceIds: [source.id], topicKeys: ['宠物', '猫', '小动物', '胆小'], status: 'active', certainty: 'stated' }] : [], episodes: [], retire: [] };
      }
      return captured.result;
    }
  });
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  return { store, controller, calls, filename,
    async bind(uin = scope.peerUin) {
      await controller.bind(uin);
      settings.realChatConsent = { accountUid: scope.accountUid, peerUin: String(uin), model: settings.model, baseUrl: settings.baseUrl };
    },
    async ask(text, nextStage = 'ordinary', extra = {}) { stage = nextStage; return controller.assist({ text, purpose: 'discussion', ...extra }); },
    setStage(next) { stage = next; },
    record() { return store.getCompanion(controller.scope); },
    capture() { testCase.calls = [...(testCase.calls || []), ...calls]; },
    close() { controller.close(); store.close(); }
  };
}
function checked(testCase, title, fn) {
  try { fn(); testCase.checks.push({ title, status: 'pass' }); }
  catch (error) { testCase.checks.push({ title, status: 'fail', error: error.message }); throw error; }
}
async function runCase(id, title, fn) {
  if (onlyCases && !onlyCases.includes(id)) return;
  const result = { id, title, checks: [], status: 'running', semanticReview: live ? 'requires_independent_human_review' : 'not_model_effectiveness_evidence' };
  report.cases.push(result);
  try { await fn(result); result.status = 'pass'; }
  catch (error) { result.status = 'fail'; result.error = error.message; }
  process.stdout.write(`${id}: ${result.status} (${result.checks.length} checks)\n`);
}

async function main() {
  await runCase('natural-persistence', 'Natural goal, material and preference persist across restart', async result => {
    const first = application(result);
    try {
      await first.bind();
      await first.ask(`我的长期目标是${GOAL}，记住这个目标。`, 'goal');
      checked(result, 'explicit goal is persisted verbatim', () => assert.equal(first.record().goal.text, GOAL));
      const noteCommand = `帮我记下，${SHARE}。这条先只用于私下讨论。`;
      await first.ask(noteCommand, 'note');
      checked(result, 'material saved with exact authorizing source and without disclosure escalation', () => {
        const record = first.record(), source = record.turns.find(t => t.role === 'user' && t.text === noteCommand);
        assert.ok(source);
        assert.ok(record.notes.some(n => sentenceContent(n.text) === SHARE && n.use === 'discussion' &&
          source.text.includes(n.text) && n.evidenceSourceIds?.includes(`private:${source.id}`)));
      });
      await first.ask('记住以后回复简短一些，但不要为了简短忽略她说的事。', 'preference');
      checked(result, 'explicit persistent preference distinguished from an ordinary note', () => assert.ok(first.record().notes.some(n => n.kind === 'preference' && n.text.includes('不要为了简短'))));
    } finally { first.capture(); first.close(); }
    const reopened = application(result);
    try {
      await reopened.bind(); await reopened.ask('上次我想怎样发展这段关系，最近有什么可以聊的？');
      const input = textOf(reopened.calls.filter(c => c.context).at(-1).context);
      checked(result, 'goal and earlier material reach model after restart', () => { assert.ok(input.includes(GOAL)); assert.ok(input.includes(SHARE)); });
      checked(result, 'private assistance never creates actual QQ history', () => assert.equal(reopened.store.messages(scope).length, 0));
    } finally { reopened.capture(); reopened.close(); }
  });

  await runCase('old-private', 'Old private evidence survives many unrelated discussions', async result => {
    const app = application(result);
    try {
      await app.bind();
      const old = app.store.appendTurn(scope, { role: 'user', kind: 'discussion', text: OLD });
      for (let index = 0; index < 80; index++) {
        app.store.appendTurn(scope, { role: 'user', kind: 'discussion', text: `今天研究设备编号 D${index} 的散热，进度正常。这与她没有关系。` });
        app.store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: `设备 D${index} 的记录可以保留供以后参考。` });
      }
      await app.controller.maintainMemory({ maxBatches: 4 });
      await app.ask('她家的那个胆小的小动物叫什么来着？我想起它了，但忘了名字。');
      const context = app.calls.filter(c => c.context).at(-1).context;
      checked(result, 'original old private evidence is recovered under paraphrased query', () => assert.ok(context.payload.sources.some(s => s.id === `private:${old.id}` && s.text === OLD)));
      checked(result, 'old material remains user report, not observed QQ', () => { assert.equal(context.payload.sources.find(s => s.id === `private:${old.id}`).type, 'private'); assert.equal(app.store.messages(scope).length, 0); });
    } finally { app.capture(); app.close(); }
  });

  await runCase('changed-plan', 'Later cancellation survives out-of-order historical backfill', async result => {
    const app = application(result);
    const oldId = '90071992547409931234', cancelId = '90071992547409931299';
    try {
      await app.bind();
      app.controller.live({ scope, messages: [event(cancelId, '周六一起看流星的安排取消吧，我要回家，下次再说。', 1791731000)] });
      const older = normalize(event(oldId, '周六一起看流星吧。', 1791721000, true), scope);
      assert.ok(older); app.store.add(scope, [older]);
      await app.ask('周六观星那件事后来怎么样了？', 'ordinary', { purpose: 'review' });
      const sources = app.calls.filter(c => c.context).at(-1).context.payload.sources;
      checked(result, 'both proposal and later cancellation reach the review', () => { assert.ok(sources.some(s => s.id === `qq:${oldId}`)); assert.ok(sources.some(s => s.id === `qq:${cancelId}`)); });
      checked(result, 'original IDs remain strings and observed time orders events', () => { const rows = app.store.messages(scope); assert.deepEqual(rows.map(m => m.messageId), [oldId, cancelId]); assert.ok(rows.every(m => typeof m.messageId === 'string')); });
    } finally { app.capture(); app.close(); }
  });

  await runCase('discussion-to-draft', 'A discussed expression can become a draft without retyping', async result => {
    const app = application(result);
    try {
      await app.bind();
      await app.ask(`${PRIVATE}，不过我愿意跟她分享的是：${SHARE}。先帮我想想怎么自然接上。`, 'discussion-option');
      const turn = latest(app.record());
      // Free-form discussion is permitted; structured options are an optional UI
      // affordance, not a prerequisite for resolving a later natural reference.
      result.observations = [{ title: 'structured expression options in initial discussion', count: turn.expressionOptions?.length || 0 }];
      await app.ask('就按刚才那个，帮我组织成一句话。', 'followup-draft', { purpose: 'draft' });
      const draft = app.calls.filter(c => c.context?.payload.purpose === 'draft').at(-1);
      checked(result, 'anaphoric request produces a draft without retyping the content', () => { assert.ok(draft); assert.ok(textOf(draft.context).includes(SHARE)); });
      checked(result, 'private motive is absent from the draft model input', () => { assert.equal(textOf(draft.context).includes(PRIVATE), false); assert.equal(draft.context.payload.privateConversation, undefined); });
      checked(result, 'draft generation is not evidence of sending', () => assert.equal(app.store.messages(scope).length, 0));
    } finally { app.capture(); app.close(); }
  });

  await runCase('scope-and-disclosure', 'Restricted background and contact isolation', async result => {
    const app = application(result);
    try {
      await app.bind(); await app.controller.setGoal(GOAL);
      await app.controller.saveNote({ text: PRIVATE, use: 'discussion' });
      await app.ask(`我想告诉她：${SHARE}。帮我写一句。`, 'restricted-draft', { purpose: 'draft' });
      const draft = app.calls.filter(c => c.context?.payload.purpose === 'draft').at(-1);
      checked(result, 'discussion-only note excluded from outbound context', () => { assert.ok(draft); assert.equal(textOf(draft.context).includes(PRIVATE), false); assert.equal(textOf(draft.context).includes(GOAL), false); });
      await app.bind('2222222222');
      await app.ask('帮我看看今天可以聊什么。');
      checked(result, 'another contact never receives previous relationship background', () => { const input = textOf(app.calls.filter(c => c.context).at(-1).context); for (const secret of [GOAL, PRIVATE, SHARE]) assert.equal(input.includes(secret), false); });
    } finally { app.capture(); app.close(); }
  });

  await runCase('feedback', 'Feedback influences later context at the intended scope', async result => {
    const app = application(result);
    try {
      await app.bind(); await app.controller.setGoal(GOAL);
      await app.ask('我想和她分享最近做饭的事。');
      const initial = latest(app.record()), goalVersion = app.record().goal.version;
      const feedback = await app.controller.addFeedback({ requestId: initial.requestId, text: '这一次的表达太正式了，像在写报告。' });
      checked(result, 'local feedback remains bound to the original request', () => assert.equal(feedback.requestId, initial.requestId));
      await app.ask('记住以后回复简短一些，但不要为了简短忽略她说的事。', 'preference');
      checked(result, 'future preference is persisted, not merely present in recent chat', () => assert.ok(app.record().notes.some(n => n.kind === 'preference' && n.text.includes('以后回复简短一些'))));
      await app.ask('那我继续说做饭这件事，怎么自然一点？');
      // The decision/preparation call needs feedback. The separate outbound
      // generator must not regain unrestricted private discussion as a side effect.
      const preparation = app.calls.filter(c => c.stage === 'ordinary' && c.context && c.context.payload.purpose !== 'draft').at(-1);
      const input = textOf(preparation.context);
      checked(result, 'applicable feedback and explicit preference reach later assistance', () => { assert.ok(input.includes('这一次的表达太正式')); assert.ok(input.includes('以后回复简短一些')); });
      const draft = app.calls.filter(c => c.context?.payload.purpose === 'draft').at(-1);
      if (draft) checked(result, 'private feedback is excluded from the outbound generation context', () => assert.equal(textOf(draft.context).includes('这一次的表达太正式'), false));
      checked(result, 'expression feedback does not rewrite the relationship goal', () => { assert.equal(app.record().goal.text, GOAL); assert.equal(app.record().goal.version, goalVersion); });
    } finally { app.capture(); app.close(); }
  });

  await runCase('unified-entry', 'Quick reply shares the same goal and history pipeline', async result => {
    const app = application(result);
    try {
      await app.bind(); await app.controller.setGoal(GOAL);
      await app.controller.saveNote({ text: '她最近在练陶笛，我想认真听她分享练习进展。', use: 'discussion' });
      app.controller.live({ scope, messages: [event('90071992547409939999', '今天终于吹顺那一小段了！', 1791741000)] });
      app.setStage('quick'); await app.controller.suggest();
      checked(result, 'quick reply actually uses the shared assistant pipeline', () => { assert.ok(app.calls.length); assert.equal(app.controller.snapshot().error, ''); });
      const preparation = app.calls.find(c => c.context && c.context.payload.purpose !== 'draft');
      checked(result, 'goal, material and actual incoming source reach quick reply', () => { assert.ok(preparation); const input = textOf(preparation.context); assert.ok(input.includes(GOAL)); assert.ok(input.includes('陶笛')); assert.ok(input.includes('今天终于吹顺那一小段了')); });
      checked(result, 'quick reply still cannot send', () => { assert.equal(app.store.messages(scope).length, 1); assert.equal(app.store.messages(scope)[0].direction, 'incoming'); });
    } finally { app.capture(); app.close(); }
  });

  await runCase('bounded-history', 'Accumulated unrelated memories cannot make a small current request unusable', async result => {
    const app = application(result);
    try {
      await app.bind();
      for (let index = 0; index < 60; index++) app.store.saveNote(scope, {
        text: `设备研究笔记 ${index}：${'一些与这次聊天无关的设备维修记录。'.repeat(50)}`, use: 'discussion' });
      await app.ask('今天想分享一件开心的小事，先陪我理清想说什么。');
      const call = app.calls.filter(c => c.context).at(-1);
      checked(result, 'small current request remains usable after many unrelated notes', () => assert.ok(call?.result));
      checked(result, 'serialized request stays within the actual context budget', () => assert.ok(call.context.manifest.inputBytes <= call.context.manifest.byteBudget));
      checked(result, 'budgeting preserves original private records and their restrictions', () => {
        assert.equal(app.record().notes.length, 60); assert.ok(app.record().notes.every(n => n.use === 'discussion'));
      });
    } finally { app.capture(); app.close(); }
  });

  await runCase('ambiguous-followup', 'Ambiguous reference does not silently choose what to share', async result => {
    const app = application(result);
    try {
      await app.bind();
      await app.ask(`我在两件事之间犹豫：${SHARE}；${SECOND_SHARE}。这两件都可以说，先给两个不同方向，不要替我选。`, 'two-options');
      await app.ask('就那个吧，帮我写。', 'ambiguous-followup', { purpose: 'draft' });
      checked(result, 'unresolved choice returns a concrete question', () => assert.equal(latest(app.record()).kind, 'question'));
      checked(result, 'ambiguous approval never reaches the outbound generator', () => assert.equal(app.calls.filter(c => c.context?.payload.purpose === 'draft').length, 0));
      checked(result, 'no actual send is inferred from vague approval', () => assert.equal(app.store.messages(scope).length, 0));
    } finally { app.capture(); app.close(); }
  });
  report.finishedAt = new Date().toISOString();
  report.summary = { total: report.cases.length, passed: report.cases.filter(c => c.status === 'pass').length,
    failed: report.cases.filter(c => c.status === 'fail').length, objectiveChecks: report.cases.reduce((sum, c) => sum + c.checks.length, 0),
    passedChecks: report.cases.flatMap(c => c.checks).filter(c => c.status === 'pass').length,
    failedChecks: report.cases.flatMap(c => c.checks).filter(c => c.status === 'fail').length,
    semanticVerdict: 'not_automatically_scored', relationshipVerdict: 'not_measured' };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Report: ${reportFile}\n`);
  if (report.summary.failed) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
