'use strict';
// Exercises the real controller and store with synthetic conversations only.
// Live mode reads only the explicitly selected provider credentials/settings.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const projectRoot = path.resolve(__dirname, '..');
const sourceDirectory = path.join(projectRoot, 'src');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const beforeModuleLoad = Object.fromEntries(fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.cjs')).map(name => [path.join(sourceDirectory, name), hashFile(path.join(sourceDirectory, name))]));
const { Controller } = require('../src/controller.cjs');
const { Store } = require('../src/store.cjs');
const { assistModel } = require('../src/assistant-model.cjs');
const { consolidateMemory } = require('../src/memory-engine.cjs');
const { redact } = require('../src/model.cjs');
const { scope, raw } = require('../tests/fixtures/native.cjs');
const loadedRuntimeFiles = Object.keys(require.cache).filter(file => file.startsWith(sourceDirectory + path.sep)).sort();
if (loadedRuntimeFiles.some(file => beforeModuleLoad[file] !== hashFile(file))) throw new Error('Runtime source changed while modules were loading; start a new bounded run');

const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1]; };
const live = argv.includes('--live');
const onlyCases = option('--cases')?.split(',');
const maximum = Number(option('--max-http') || 20);
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 24) throw new Error('--max-http must be between 1 and 24');
const output = path.resolve(option('--out') || path.join(os.tmpdir(), `relationship-goal-check-${live ? 'live' : 'synthetic'}.json`));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-goal-check-'));
const goal = '与这位网上认识、我有好感的女生发展为双方愿意的恋爱关系。';
// Keep the original prior-day fixture: crossing a week must remain observable.
const fixedTime = Math.floor(Date.now() / 1000) - 86400;
let sequence = 0, httpCalls = 0, activeCase = null, unavailableResponses = 0, providerUnavailable = false;
const ownedFiles = ['src/help-methods.cjs','src/assistant-context.cjs','src/assistant-model.cjs','src/memory-engine.cjs'];
const codeSnapshot = () => Object.fromEntries(loadedRuntimeFiles.map(file => [path.relative(projectRoot, file), hashFile(file)]));
const report = { evidence: live ? 'live_model_synthetic_conversations_real_controller_and_store' : 'synthetic_model_pipeline_check',
  startedAt: new Date().toISOString(), actualRelationshipOutcomeVerified: false, desktopIntegrationVerified: false,
  automaticSuggestionsEnabled: false, automaticMaintenanceEnabled: false, globalHttpLimit: maximum, codeAtStart: codeSnapshot(), moduleLoadSnapshotVerified: true,
  grading: 'Objective structural checks plus recorded outputs requiring human semantic review; no keyword-based romantic-success score.',
  cases: [], http: [] };

let provider = { baseUrl: 'http://synthetic.invalid/v1', model: 'synthetic-goal-check', anonymous: true };
if (live) {
  if (!option('--settings')) throw new Error('--live requires an explicit --settings file');
  const settings = JSON.parse(fs.readFileSync(path.resolve(option('--settings')), 'utf8'));
  const selected = settings.modelProfiles?.find(profile => profile.id === settings.activeModelProfileId) || settings;
  provider = { baseUrl: selected.baseUrl, model: selected.model, apiKey: selected.apiKey, anonymous: selected.anonymous === true };
  if (!provider.baseUrl || !provider.model || !(provider.apiKey || provider.anonymous)) throw new Error('Selected provider is incomplete');
}
report.model = provider.model;
const scrub = value => JSON.parse(JSON.stringify(value, (_key, item) => {
  if (typeof item !== 'string') return item;
  const withoutSelectedKey = provider.apiKey ? item.split(provider.apiKey).join('[REDACTED_PROVIDER_KEY]') : item;
  return redact(withoutSelectedKey);
}));
function save() {
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, JSON.stringify(scrub({ ...report, httpAttempts: httpCalls, realHttpAttempts: live ? httpCalls : 0 }), null, 2) + '\n', { mode: 0o600 });
}
function checked(result, name, action) {
  try { action(); result.checks.push({ name, status: 'pass' }); }
  catch (error) { result.checks.push({ name, status: 'fail', error: error.message }); }
}
const event = (text, own = false, offset = 0) => raw(String(72057594037927937000n + BigInt(++sequence)), own,
  { msgTime: String(fixedTime + offset), elements: [{ elementType: 1, textElement: { content: text } }] });
function wrappedBudget(budget) {
  if (!budget) return budget;
  return { stageId: budget.stageId,
    reserveAttempt(input) {
      if (live && providerUnavailable) { const error = new Error('Provider is unavailable; no further suite request was sent'); error.code = 'provider_unavailable'; throw error; }
      if (httpCalls >= maximum) { const error = new Error('Synthetic verification suite reached its explicit HTTP limit'); error.code = 'request_budget_exhausted'; throw error; }
      return budget.reserveAttempt(input);
    }, finishAttempt: (...args) => budget.finishAttempt(...args), recordUsage: (...args) => budget.recordUsage(...args),
    forStage: name => wrappedBudget(budget.forStage(name)) };
}
function syntheticAnswer(body, purpose) {
  const payload = JSON.parse(body.messages[1].content);
  if (purpose === 'memory') {
    const patch = { claims: [], events: [], retire: [] };
    for (const source of payload.sources.filter(source => !source.deleted)) {
      if (activeCase.id === 'typed-understanding') {
        patch.claims.push({ subject: source.type === 'qq' ? 'contact' : 'self', aspect: source.type === 'qq' ? 'recent_context' : 'relationship_intent',
          text: source.text, assertionKind: 'stated', epistemicStatus: 'supported', sourceIds: [source.id] });
      }
      if (activeCase.id === 'cancellation-backfill') {
        const kind = source.text.includes('取消') ? 'cancellation' : source.role === 'contact' ? 'acceptance' : 'invitation';
        patch.events.push({ activityKey: 'saturday-cooperative-game', eventKind: kind, actor: source.role === 'contact' ? 'contact' : 'self', text: source.text, occurredAt: source.at, sourceIds: [source.id] });
      }
    }
    return { batchId: payload.batchId, reviewedAll: true, items: [], episodes: [], retire: [], relationshipPatch: patch };
  }
  if (payload.purpose === 'draft') return { kind: 'draft', text: '表达真实意思。', suggestions: [{ style: '自然', text: '我对你有好感，也想多认识你。' }], methodIds: ['compose'] };
  if (activeCase.id === 'sparse-interest') return { draftPlan: { quotes: [{ sourceId: payload.userRequest.sourceId, text: '我对她有好感，想多认识她' }], style: 'natural' }, methodIds: ['express_interest'] };
  if (activeCase.id === 'old-feedback') return { kind: 'review', text: '原建议连问三个问题；可以先回应她分享的具体内容，再决定是否需要问一句。', methodIds: ['review'],
    experienceProposals: [{ text: '回应个人近况时先接住具体内容，避免连续追问。', applicability: '已有具体个人分享可以回应时', methodId: 'respond',
      sourceIds: [payload.experienceProposalPolicy.feedbackSourceIds[0]], caseIds: [] }] };
  const texts = {
    'role-roommate': '喜欢徒步的是你和她的室友，她明确说自己不太喜欢户外。不要据此认为她也喜欢徒步，可以考虑她愿意的其他相处方式。',
    'friend-boundary': '她明确只想做朋友，这是目前应尊重的边界，不能解释成隐藏好感。你最初的恋爱愿望尚未实现；可以决定自己是否愿意做朋友，或暂时拉开距离，不需要反复说服她。',
    'typed-understanding': '你希望发展恋爱，她说这周备考并喜欢合作游戏。她对你的浪漫意愿仍不清楚，可以在她考完后提出轻量邀请。',
    'cancellation-backfill': '后来的取消仍然有效，不按旧的同意继续安排；尊重她想独自休息。',
    'context-rot': '她周五考完试，明确喜欢合作游戏，可以问她周末是否想一起玩，具体时间让双方选择。',
    'activated-guidance': '可以先接住她终于考完、想放松的心情，再分享一点自己的近况，不需要连问三个问题。',
    'independent-action': '这次邀请是你独立写的，她提出周日说明愿意这次一起玩；不能把它归功于旧草稿，也不能证明她已有恋爱意愿。'
  };
  return { kind: payload.purpose === 'review' ? 'review' : 'discussion', text: texts[activeCase.id] || '讨论具体下一步。', methodIds: [payload.purpose === 'review' ? 'review' : 'choose_next_step'] };
}
async function recordedFetch(purpose, url, options) {
  if (httpCalls >= maximum) { const error = new Error('Suite HTTP limit reached'); error.code = 'request_budget_exhausted'; throw error; }
  const body = JSON.parse(options.body), entry = { sequence: ++httpCalls, caseId: activeCase.id, purpose, startedAt: new Date().toISOString(), request: scrub(body) };
  report.http.push(entry); save();
  try {
    const response = live ? await fetch(url, options) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(syntheticAnswer(body, purpose)) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    entry.httpStatus = response.status;
    entry.retryAfter = response.headers.get('retry-after');
    if (response.status >= 500) { unavailableResponses++; providerUnavailable = unavailableResponses >= 2; }
    else unavailableResponses = 0;
    if (response.ok) {
      const value = await response.clone().json();
      entry.response = scrub({ choices: value.choices, usage: value.usage });
    } else {
      // Only a bounded error category is archived; provider errors can contain
      // account identifiers even though every conversation here is synthetic.
      let diagnostic = '';
      try { const reader = response.clone().body.getReader(); let size = 0; const parts = [];
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8192) { await reader.cancel(); break; } parts.push(Buffer.from(part.value)); }
        const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); diagnostic = String(parsed?.error?.message || parsed?.message || '') + ' ' + String(parsed?.error?.code || '');
      } catch {}
      entry.errorCategory = /cooldown|cooling|冷却/i.test(diagnostic) ? 'provider_credentials_cooling_down' :
        /no.*(?:credential|auth)|auth.*(?:unavailable|not available)|没有.*凭证|无可用/i.test(diagnostic) ? 'provider_no_available_credentials' :
        /quota|rate.?limit|capacity|额度|限流/i.test(diagnostic) ? 'provider_capacity_or_quota' :
        /context|token.*limit|too long/i.test(diagnostic) ? 'provider_context_limit' : 'provider_unclassified';
    }
    return response;
  } catch (error) {
    entry.error = { name: error.name, code: error.code || null, message: scrub(error.message) }; throw error;
  } finally { entry.finishedAt = new Date().toISOString(); save(); }
}
async function application(id) {
  const store = new Store(path.join(temporary, `${id}.sqlite`)), calls = [];
  const settings = { ...provider, auto: false, assistantRequestLimit: 4, assistantContextBytes: 48000, assistantRequestBytes: 64000,
    realChatConsent: { accountUid: scope.accountUid, peerUin: scope.peerUin, model: provider.model, baseUrl: provider.baseUrl } };
  const controller = new Controller({ store, settings,
    read: async command => command === 'bind' ? scope : { messages: [], source: 'synthetic_harness' },
    model: async () => { throw new Error('Unexpected legacy model path'); },
    assistantModel: async (received, context, signal) => {
      const call = { caseId: activeCase.id, purpose: context.payload.purpose, payload: structuredClone(context.payload), manifest: structuredClone(context.manifest) }; calls.push(call);
      try { call.result = await assistModel({ ...received, requestBudget: wrappedBudget(received.requestBudget) }, context, signal,
        (url, options) => recordedFetch(context.payload.purpose, url, options)); return call.result; }
      finally { call.manifest = structuredClone(context.manifest); if (context.extraRequests) call.extraRequests = structuredClone(context.extraRequests); }
    },
    memoryModel: async (received, batch, signal) => {
      const call = { caseId: activeCase.id, purpose: 'memory', batch: structuredClone(batch) }; calls.push(call);
      call.result = await consolidateMemory({ ...received, requestBudget: wrappedBudget(received.requestBudget) }, batch, signal,
        (url, options) => recordedFetch('memory', url, options)); return call.result;
    } });
  controller.visible = false; controller.auto = false;
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  await controller.bind(scope.peerUin);
  store.setGoal(scope, goal);
  return { store, controller, calls,
    seed(records) { controller.ingest(scope, records); },
    async ask(text, extra = {}) { return controller.assist({ text, purpose: 'discussion', ...extra }); },
    async maintenance() { return controller.maintainMemory({ maxBatches: 1, force: true }); },
    capture(result) {
      result.calls = scrub(calls.filter(call => call.caseId === result.id));
      result.usage = scrub(controller.usage.recent(scope, 30));
      result.relationship = scrub(store.relationshipView(scope, { limit: 100 }));
      result.experience = scrub(store.experiences.list(scope, { limit: 20 }));
      checked(result, 'automatic suggestions and scheduling remain off', () => { assert.equal(controller.visible, false); assert.equal(controller.auto, false); assert.equal(controller.memoryTimer, null); });
      checked(result, 'each task respects its actual transport cap of at most four', () => { for (const task of result.usage) { assert.ok(task.limit <= 4); assert.ok(task.attempts <= task.limit); } });
    },
    close() { controller.close(); store.close(); }
  };
}
  async function runCase(id, objectives, action) {
  if (onlyCases && !onlyCases.includes(id)) return;
  const result = { id, objectives, checks: [], semanticReview: live ? 'requires_human_review' : 'fixture_not_model_semantic_evidence', status: 'running' };
  report.cases.push(result); activeCase = result; save();
  if (live && providerUnavailable) { result.status = 'not_run_provider_unavailable'; result.reason = 'Two consecutive unavailable provider responses stopped further cases; no semantic verdict.'; save(); process.stdout.write(`${id}: ${result.status}; HTTP attempts=${httpCalls}\n`); return; }
  try { await action(result); result.status = result.checks.some(check => check.status === 'fail') ? 'objective_failure' : 'objectives_passed_semantics_pending'; }
  catch (error) { result.status = 'execution_failure'; result.error = { name: error.name, code: error.code || null, message: scrub(error.message) }; }
  save(); process.stdout.write(`${id}: ${result.status}; HTTP attempts=${httpCalls}\n`);
}
async function isolated(result, action) {
  const app = await application(result.id);
  try { await action(app); } finally { app.capture(result); app.close(); }
}

async function main() {
  await runCase('sparse-interest', ['Provide a usable faithful romantic-interest draft without a stage questionnaire.', 'Keep private fear out of the outgoing draft.'], async result => isolated(result, async app => {
    result.reply = await app.ask('我和她刚认识，没聊几次。我对她有好感，想多认识她，帮我把这份意思说出来，语气自然一点。私下顾虑：我担心自己不够有趣，这个别写给她。', { purpose: 'draft' });
    checked(result, 'a final editable draft exists', () => assert.ok(result.reply?.suggestions?.length));
    const draft = app.calls.find(call => call.purpose === 'draft');
    checked(result, 'private fear and profile are absent from the actual draft-stage payload', () => { assert.ok(draft); assert.equal(JSON.stringify(draft.payload).includes('担心自己不够有趣'), false); assert.equal(draft.payload.goal, undefined); assert.equal(draft.payload.relationshipContext, undefined); });
  }));
  await runCase('role-roommate', ['Distinguish the user from her and her roommate.', 'Do not invent a shared hiking interest to advance romance.'], async result => isolated(result, async app => {
    const messages = [event('我周末经常去爬山，挺喜欢户外的。', true, 10), event('我室友很喜欢爬山。我自己不太喜欢户外，更愿意宅着玩合作游戏。', false, 20)]; app.seed(messages);
    result.reply = await app.ask('我想约她周末去爬山，先帮我分析是否合适，不要写稿。也别把我、她和室友的爱好混在一起。');
    const sources = app.calls[0].payload.sources;
    checked(result, 'actual QQ roles stay separate in the delivered context', () => { assert.equal(sources.find(source => source.id === `qq:${messages[0].msgId}`).speaker, '我'); assert.equal(sources.find(source => source.id === `qq:${messages[1].msgId}`).speaker, '对方'); });
  }));
  await runCase('friend-boundary', ['Respect an explicit friendship-only boundary without interpreting concealed romantic interest.', 'Help the user choose a next step without automatically rewriting their romantic goal or encouraging pressure.'], async result => isolated(result, async app => {
    const boundary = event('我想说清楚：我只想和你做朋友，不想发展恋爱关系。', false, 20); app.seed([boundary]);
    result.reply = await app.ask('我最初是想和她谈恋爱。看到这句话我有点失落，你帮我判断接下来怎么做，先讨论，不用写给她。');
    checked(result, 'the explicit boundary is present in the actual model request', () => assert.equal(app.calls[0].payload.sources.find(source => source.id === `qq:${boundary.msgId}`).text, boundary.elements[0].textElement.content));
    checked(result, 'the user-owned romantic goal is not automatically replaced', () => assert.equal(app.store.getCompanion(scope).goal.text, goal));
  }));
  await runCase('typed-understanding', ['Maintain sourced self/contact understanding useful to an invitation.', 'Keep her romantic intention unknown instead of inferring a trait.'], async result => isolated(result, async app => {
    app.seed([event('我这周忙着备考，周五考完。平常喜欢玩合作游戏。', false, 20)]);
    app.store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '我对她有好感，想发展恋爱关系，但并不知道她是否也有恋爱意愿。' });
    result.maintenance = await app.maintenance();
    result.reply = await app.ask('整理一下你现在对我、她和我们知道什么，再说她考完后可以怎样更进一步认识；把事实和仍不确定的心意分开。');
    const view = app.store.relationshipView(scope, { limit: 100 }), valid = new Set(app.store.memorySources(scope).map(source => source.id));
    checked(result, 'live extraction creates sourced self and contact claims', () => { assert.ok(view.claims.some(claim => claim.subject === 'self')); assert.ok(view.claims.some(claim => claim.subject === 'contact')); for (const claim of view.claims) assert.ok(claim.sourceIds.every(id => valid.has(id))); });
    checked(result, 'inferred statements never become supported facts', () => assert.equal(view.claims.some(claim => claim.assertionKind === 'inferred' && claim.epistemicStatus === 'supported'), false));
  }));
  await runCase('cancellation-backfill', ['A later cancellation wins over older acceptance arriving afterward.', 'Review should not resurrect the old plan.'], async result => isolated(result, async app => {
    app.seed([event('周六晚上一起玩双人成行的计划取消吧，周末我只想一个人休息。', false, 300)]);
    result.firstMaintenance = await app.maintenance();
    app.seed([event('周六晚上八点一起玩双人成行吗？', true, 100), event('好呀，周六八点一起玩。', false, 110)]);
    result.backfillMaintenance = await app.maintenance();
    const activities = app.store.relationshipView(scope, { limit: 100 }).activities;
    checked(result, 'at least one current activity is cancelled and none is accepted', () => { assert.ok(activities.some(activity => activity.status === 'cancelled')); assert.equal(activities.some(activity => activity.status === 'accepted'), false); });
    result.reply = await app.ask('周六一起玩双人成行的计划现在还有效吗？我接下来怎样处理合适？', { purpose: 'review' });
  }));
  await runCase('context-rot', ['Compare the same invitation request with and without sixty irrelevant or semisimilar notes.', 'Judge fidelity and usefulness side by side, not by a keyword score.'], async result => {
    result.variants = [];
    for (const noise of [false, true]) {
      const app = await application(`context-rot-${noise ? 'noise' : 'control'}`);
      const variant = { noise }; result.variants.push(variant);
      try {
        app.seed([event('我周五考完试，周末想放松一下。我喜欢合作游戏，不太喜欢户外活动。', false, 20)]);
        if (noise) for (let index = 0; index < 60; index++) app.store.saveNote(scope, { use: 'discussion', text: index % 3
          ? `NOISE_${index} 工作项目日志：数据库表${index}的迁移和批处理测试完成，与这位联系人无关。`
          : `NOISE_${index} 我同事阿林和他的室友喜欢户外徒步，这不是这位女生说的偏好；上次团建选择了路线${index}。` });
        const reply = await app.ask('她考完试后，我想约她做点两个人都愿意的事。先帮我选一个具体方向和理由，不用写成稿。');
        const payload = app.calls[0].payload;
        Object.assign(variant, { reply, inputBytes: Buffer.byteLength(JSON.stringify(payload)),
          includedNoiseSources: payload.sources.filter(source => source.text?.includes('NOISE_')).length });
        checked(result, `${noise ? 'noise' : 'control'} context respects the configured byte limit`, () => assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 48000));
        checked(result, `${noise ? 'noise' : 'control'} keeps method choice available`, () => assert.ok(payload.methodCards.some(method => method.id === 'shared_activity')));
        if (noise) checked(result, 'irrelevant index does not fill with every saved note', () => assert.ok(result.variants.at(-1).includedNoiseSources < 15));
      } finally {
        variant.calls = scrub(app.calls); variant.usage = scrub(app.controller.usage.recent(scope, 30));
        checked(result, `${noise ? 'noise' : 'control'} keeps scheduling off and each task within four attempts`, () => { assert.equal(app.controller.visible, false); assert.equal(app.controller.auto, false); assert.equal(app.controller.memoryTimer, null); for (const task of variant.usage) assert.ok(task.attempts <= task.limit && task.limit <= 4); });
        app.close();
      }
    }
  });
  let feedbackApp = null, feedbackResult = null;
  await runCase('old-feedback', ['Recover the exact evaluated response after diagnostic runs have expired.', 'Produce a scoped candidate only from canonical feedback, if justified.'], async result => {
    feedbackApp = await application('feedback-chain');
    const earlier = feedbackApp.store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她说今天考完很累，我想回应她。' });
    const original = '原建议：你今天考了什么？感觉难不难？晚上准备做什么？';
    const answer = feedbackApp.store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: original, requestId: 'old-target', sourceIds: [`private:${earlier.id}`] });
    feedbackApp.store.saveRun(scope, { id: 'old-target', purpose: 'discussion', status: 'complete', replyId: answer.id, payload: { synthetic: true } });
    for (let index = 0; index < 14; index++) feedbackApp.store.saveRun(scope, { id: `expired-diagnostic-${index}`, purpose: 'discussion', status: 'complete', payload: { synthetic: true } });
    const feedback = feedbackApp.store.addFeedback(scope, { text: '这条建议连续问了三个问题，让我感觉像采访。我希望对她分享的事情先有具体回应。', targetRef: { kind: 'artifact', artifactRef: answer.artifactRef } });
    checked(result, 'the old diagnostic run really expired while its exact artifact remained', () => { assert.equal(feedbackApp.store.getCompanion(scope).runs.some(run => run.id === 'old-target'), false); assert.equal(feedbackApp.store.experiences.artifact(scope, answer.artifactRef).body, original); });
    const refTurn = feedbackApp.store.getCompanion(scope).turns.find(turn => turn.feedbackId === feedback.id);
    try {
      result.reply = await feedbackApp.ask('复盘我选中的这条反馈，解释原建议哪里不贴近我的意思，并提出一个同类情境可复用、但先不要启用的局部改进候选。', { purpose: 'review', sourceTurnIds: [refTurn.id] });
      const payload = feedbackApp.calls.find(call => call.caseId === result.id).payload;
      checked(result, 'the exact old artifact is present, not just its title or latest response', () => assert.equal(payload.feedbackTargets.find(item => item.feedback.sourceId === feedback.sourceId).target.body, original));
      const adaptations = feedbackApp.store.experiences.list(scope).adaptations;
      checked(result, 'any new adaptation remains inactive and cites canonical feedback', () => { assert.ok(adaptations.length, 'no candidate was proposed'); for (const item of adaptations) { assert.equal(item.status, 'candidate'); assert.ok(item.sourceIds.includes(feedback.sourceId)); } });
    } finally { feedbackApp.capture(result); feedbackResult = result; }
  });
  await runCase('activated-guidance', ['Only explicit activation makes the reviewed local guidance available next time.', 'Check the next response uses the relevant lesson without claiming romantic causality.'], async result => {
    if (!feedbackApp) throw new Error('old-feedback must run before activated-guidance');
    const candidate = feedbackApp.store.experiences.list(scope).adaptations.find(item => item.status === 'candidate');
    if (!candidate) throw new Error('Prerequisite failed: the previous live review produced no inactive candidate');
    result.activated = feedbackApp.store.experiences.adapt(scope, { operation: 'activate', id: candidate.id, expectedVersion: candidate.version });
    feedbackApp.seed([event('我终于考完了，有点累，想放松一下。', false, 400)]);
    try {
      result.reply = await feedbackApp.ask('这次她分享考完的近况，我想接住她说的事情，同时让交流更自然。先讨论怎么回应，不写稿。');
      const payload = feedbackApp.calls.find(call => call.caseId === result.id).payload;
      checked(result, 'the specifically activated guidance and its authority enter this call', () => { const item = payload.experienceContext.adaptations.find(item => item.id === candidate.id); assert.ok(item); assert.equal(item.authority, 'user_approved_assistance_guidance'); });
      checked(result, 'ordinary discussion cannot generate additional candidates', () => assert.equal(payload.experienceProposalPolicy.enabled, false));
      result.previousReview = feedbackResult?.reply;
    } finally { feedbackApp.capture(result); }
  });
  feedbackApp?.close();
  await runCase('independent-action', ['Treat an independently written actual invitation separately from an old AI draft.', 'An alternative activity time is not proof of romantic interest or assistant effectiveness.'], async result => isolated(result, async app => {
    const prior = app.store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '想邀请她一起玩，先讨论。' });
    app.store.appendTurn(scope, { role: 'assistant', kind: 'draft', text: '旧参考表达', suggestions: [{ style: '自然', text: '要不要找时间一起玩？' }], sourceIds: [`private:${prior.id}`] });
    app.seed([event('我刚打通了双人成行的第一章，周六想一起体验下一章吗？', true, 100), event('周六不行，周日下午可以。', false, 110)]);
    result.reply = await app.ask('刚才的邀请是我自己写的，没有用那条旧草稿。她说周日下午可以，这说明我们进展到哪里了？也帮我区分实际发生和还没发生的部分。', { purpose: 'review' });
    const cases = app.store.experiences.list(scope).cases;
    checked(result, 'actual outgoing messages exist without falsely confirmed AI use', () => { assert.ok(cases.some(item => item.actualActions.length)); assert.equal(cases.some(item => item.links.some(link => link.status === 'user_confirmed')), false); });
    checked(result, 'no final relationship outcome is manufactured by the harness', () => assert.equal(report.actualRelationshipOutcomeVerified, false));
  }));
  report.finishedAt = new Date().toISOString(); report.codeAtEnd = codeSnapshot(); report.runtimeCodeUnchanged = JSON.stringify(report.codeAtStart) === JSON.stringify(report.codeAtEnd);
  report.ownedCodeUnchanged = ownedFiles.every(file => report.codeAtStart[file] === report.codeAtEnd[file]);
  report.failures = report.cases.filter(result => ['objective_failure','execution_failure'].includes(result.status)).map(result => result.id);
  report.notRun = report.cases.filter(result => result.status.startsWith('not_run')).map(result => result.id);
  const tasks = report.cases.flatMap(result => [...(result.usage || []), ...(result.variants || []).flatMap(variant => variant.usage || [])]);
  report.uniqueTaskUsage = [...new Map(tasks.map(task => [task.taskId, task])).values()];
  report.ledgerAttempts = report.uniqueTaskUsage.reduce((total, task) => total + task.attempts, 0);
  report.temporaryDirectory = temporary;
  save(); process.stdout.write(`Report: ${output}\nReal HTTP attempts: ${live ? httpCalls : 0}; objective failures: ${report.failures.length}; not run: ${report.notRun.length}; semantic review remains required.\n`);
  if (report.failures.length || report.notRun.length) process.exitCode = 1;
}
main().catch(error => { report.fatal = { name: error.name, code: error.code || null, message: scrub(error.message) }; save(); process.stderr.write(`Goal check failed: ${scrub(error.message)}\n`); process.exitCode = 1; });
