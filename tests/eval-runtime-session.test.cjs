'use strict';
const test = require('node:test');
const {withRequestDelivery}=require('../scripts/synthetic-request-delivery.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createReplaySession, makeSyntheticTransport } = require('../scripts/eval-runtime-session.cjs');

// Native-shaped records follow tests/fixtures/native.cjs. These responses test
// the versioned product adapter, never conversational quality or desktop QQ.
const sourceRoot = path.resolve(__dirname, '..');
const asOf = '2026-10-29T12:00:00.000Z';
const settings = { model: 'synthetic-replay-only', baseUrl: 'http://fixture.invalid/v1', anonymous: true, auto: false };
const event = (id, at, speaker, text) => ({ id, at, speaker, text });
const history = [event('original-incoming', '2026-10-29T11:59:00.000Z', 'contact', '书架终于装好了。')];
const packet = result => new Response(JSON.stringify({ model: settings.model,
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { status: 200 });
function input(args) { return JSON.parse(JSON.parse(args.body).messages[1].content); }
async function setup(t, options = {}) {
  const session = await createReplaySession({ sourceRoot, asOf, history, goal: '保持朋友间真实的交流。', settings,
    transport: makeSyntheticTransport(), ...options });
  t.after(() => session.close());
  return session;
}

test('product bind and paginated history normalize actual incoming/outgoing string IDs', async t => {
  const events = Array.from({ length: 65 }, (_, i) => event(`archive-${i}`,
    new Date(Date.parse(asOf) - (65 - i) * 1000).toISOString(), i % 2 ? 'self' : 'contact', `虚构原始记录 ${i}`));
  const session = await setup(t, { history: events });
  const state = session.snapshot();
  assert.equal(state.total, 65);
  assert.equal(state.coverage.status, 'accessible_end');
  assert.ok(state.sources.filter(s => s.type === 'qq').every(s => /^qq:\d+$/.test(s.id)));
  assert.ok(state.messages.every(m => typeof m.messageId === 'string'));
  assert.ok(state.messages.some(m => m.direction === 'outgoing'));
  assert.equal(state.companion.goal.text, '保持朋友间真实的交流。');
  assert.ok(session.trace.some(e => e.component === 'qq_read' && e.method === 'bind'));
  assert.ok(session.trace.some(e => e.component === 'qq_read' && e.method === 'older'));
  await assert.rejects(session.deliver([event('future', '2026-10-29T12:00:01.000Z', 'contact', '还没发生')]), /future/i);
  assert.equal(session.snapshot().total, 65);
});

test('production HTTP consultation preserves generated replies, actual events and same-session state', async t => {
  let sequence = 0;
  const session = await setup(t, { transport: async (_url, args) => {
    const p = input(args);
    const original=p.originalInput||p;return packet(original.operationProtocol?{operation:'advise',text:`真实适配器保存的合成回答 ${++sequence}：${original.userRequest.text}`} : withRequestDelivery({kind:'discussion',text:`真实适配器保存的合成回答 ${++sequence}：${original.userRequest.text}`},original));
  } });
  const first = await session.post('/api/assistant', { text: '先接她装书架的事。' });
  const firstAnswer = first.companion.turns.find(turn => turn.role === 'assistant');
  await session.advanceTo('2026-10-29T12:00:01.000Z');
  await session.deliver([event('actually-sent', '2026-10-29T12:00:01.000Z', 'self', '你打算放在哪里？')]);
  const second = await session.post('/api/assistant', { text: '刚才的回答先保留，现在继续商量。' });
  assert.equal(second.companion.turns.length, 4);
  assert.deepEqual(second.companion.turns.find(turn => turn.id === firstAnswer.id), firstAnswer);
  assert.equal(second.companion.turns.at(-1).createdAt, '2026-10-29T12:00:01.000Z');
  assert.equal(session.snapshot().total, 2);
  assert.ok(session.trace.some(e => e.component === 'store' && e.method === 'searchMemory'));
  assert.ok(session.trace.some(e => e.component === 'store' && e.method === 'saveRun'));
  assert.ok(session.trace.some(e => e.component === 'model_transport' && e.event === 'response'));
  assert.ok(session.snapshot().runs.length >= 2);
});

test('virtual controller clock exercises automatic scheduling without replacing real model adapters', async t => {
  const realBefore = Date.now();
  const session = await setup(t);
  await session.post('/api/options', { auto: true });
  assert.equal(session.snapshot().companion.turns.length, 0);
  await session.advanceTo('2026-10-29T12:00:01.799Z');
  assert.equal(session.snapshot().companion.turns.length, 0);
  await session.advanceTo('2026-10-29T12:00:01.800Z');
  const answer = session.snapshot().companion.turns.find(turn => turn.role === 'assistant');
  assert.equal(answer.origin, 'automatic');
  assert.equal(answer.createdAt, '2026-10-29T12:00:01.800Z');
  assert.ok(session.trace.some(e => e.component === 'controller_timer' && e.event === 'fired'));
  assert.ok(session.trace.some(e => e.component === 'assistant_adapter'));
  assert.ok(Date.now() >= realBefore);
  await assert.rejects(session.advanceTo('2026-10-29T11:00:00.000Z'), /backward/i);
});

test('actual memory and compaction adapters use explicit synthetic transport and real persistence', async t => {
  const transport = makeSyntheticTransport();
  let calls = 0;
  const session = await setup(t, { transport: async (url, args) => {
    const p = input(args);
    if (p.purpose === 'discussion' && ++calls === 1) return packet(p.operationProtocol?{operation:'advise',text:'合成历史解释。'.repeat(700)}:withRequestDelivery({kind:'discussion',text:'合成历史解释。'.repeat(700)},p));
    return transport(url, args);
  } });
  await session.post('/api/assistant', { text: '先商量书架。' });
  await session.post('/api/assistant', { text: '继续刚才的商量。' });
  assert.ok(session.trace.some(e => e.component === 'compaction_adapter' && e.event === 'result'));
  await session.post('/api/memory-maintain');
  assert.ok(session.trace.some(e => e.component === 'memory_adapter' && e.event === 'result'));
  assert.ok(session.trace.some(e => e.component === 'store' && e.method === 'applyMemoryBatch' && e.event === 'result' && e.result.applied));
  assert.ok(session.snapshot().memoryStatus.processed > 0);
});

test('automatic memory scheduling uses the same virtual controller clock and actual maintenance adapter', async t => {
  const session = await setup(t, { settings: { ...settings, memoryBatchThreshold: 1 } });
  assert.equal(session.snapshot().memoryStatus.processed, 0);
  await session.advanceTo('2026-10-29T12:00:01.800Z');
  assert.ok(session.snapshot().memoryStatus.processed > 0);
  assert.ok(session.trace.some(e => e.component === 'controller' && e.method === 'maintainMemory' && e.event === 'call' && !e.args[0].force));
  assert.ok(!session.trace.some(e => e.component === 'product_http' && e.route === '/api/memory-maintain'));
});

test('archived private transcript retains source dates and provenance, while live outputs cannot be replaced', async t => {
  const session = await setup(t);
  await session.restorePrivate([
    { id: 'old-user', at: '2026-10-28T10:00:00.000Z', role: 'user', text: '旧的用户商量。' },
    { id: 'old-assistant', at: '2026-10-28T10:01:00.000Z', role: 'assistant', text: '作者提供的历史助手原文。' }
  ]);
  assert.deepEqual(session.snapshot().companion.turns.map(t => [t.id, t.createdAt]), [
    ['old-user', '2026-10-28T10:00:00.000Z'], ['old-assistant', '2026-10-28T10:01:00.000Z']
  ]);
  assert.ok(session.trace.some(e => e.provenance === 'authored_archived_private_transcript'));
  await session.post('/api/assistant', { text: '现在真的走产品请求。' });
  await assert.rejects(session.restorePrivate([{ id: 'bad', at: asOf, role: 'assistant', text: '替换新的生成答案' }]), /before.*live|live.*output/i);
});

test('a swallowed automatic provider failure is surfaced by the bounded replay checkpoint', async t => {
  const session = await setup(t, { transport: async () => new Response('{}', { status: 400 }) });
  await session.post('/api/options', { auto: true });
  await assert.rejects(session.advanceTo('2026-10-29T12:00:02.000Z'), /HTTP 400|replay.*failed/i);
  assert.equal(session.snapshot().companion.turns.filter(turn => turn.role === 'assistant').length, 0);
  assert.ok(session.trace.some(e => e.event === 'error'));
});

test('archived notes preserve identity, time, declared kind/use and chronological raw evidence links',async t=>{
 const session=await setup(t);
 await session.restorePrivate([{id:'earlier-user',at:'2026-10-28T10:00:00.000Z',role:'user',text:'以后默认简短，不用表情。'}]);
 const notes=[
  {id:'historical-preference',at:'2026-10-29T11:59:20.000Z',role:'user',text:'以后默认简短，不用表情。',declared_use:'discussion',note_kind:'preference',evidence_source_ids:['earlier-user']},
  {id:'historical-material',at:'2026-10-29T11:59:30.000Z',role:'user',text:'愿意提到我自己装过书架。',declared_use:'draft',note_kind:'material',evidence_source_ids:['original-incoming','historical-preference']}
 ];
 await session.restoreNotes(notes);
 const state=session.snapshot(),saved=state.companion.notes;
 assert.deepEqual(saved.map(n=>[n.id,n.createdAt,n.updatedAt,n.use,n.kind]),notes.map(n=>[n.id,n.at,n.at,n.declared_use,n.note_kind]));
 assert.deepEqual(saved[1].evidenceSourceIds,[state.sourceAliases['original-incoming'],'note:historical-preference']);
 assert.equal(state.noteAliases['historical-preference'],'note:historical-preference');
 await assert.rejects(session.restoreNotes([{...notes[0],id:'future',at:'2026-10-30T12:00:00Z'}]),/future/);
 await assert.rejects(session.restoreNotes([{...notes[0],id:'earlier-user'}]),/distinct|collision/);
 await assert.rejects(session.restoreNotes([{...notes[0],id:'future-reference',at:'2026-10-29T11:58:00Z',evidence_source_ids:['original-incoming']}]),/future|later/);
 await assert.rejects(session.restoreNotes([{...notes[0],id:'unknown-reference',evidence_source_ids:['never-observed']}]),/unknown|unavailable/);
 await session.post('/api/assistant',{text:'现在开始真实产品请求。'});
 await assert.rejects(session.restoreNotes([{...notes[0],id:'late-restore'}]),/before.*live|live.*output/);
 await session.withdrawSources([{id:'earlier-user',at:asOf,channel:'private',operation:'delete'}]);
 assert.equal(session.snapshot().companion.notes.length,0,'dependent notes are invalidated with their actual raw source');
 await session.post('/api/note',{id:'normal-note',text:'普通接口在当前时间新增。',use:'discussion',createdAt:'2000-01-01T00:00:00Z',at:'2000-01-01T00:00:00Z'});
 assert.equal(session.snapshot().companion.notes.find(n=>n.id==='normal-note').createdAt,asOf,'public note API cannot set historical dates');
});

test('missing attachments retain text and unavailable media, while QQ recalls update actual stored evidence',async t=>{
 const missing=event('missing-picture','2026-10-29T11:59:00.000Z','contact','这张图你怎么看？');
 missing.attachments=[{id:'picture-1',kind:'image',availability:'unavailable'}];
 const session=await setup(t,{history:[missing]});
 assert.match(session.snapshot().messages[0].text,/这张图你怎么看/);
 assert.equal(session.snapshot().messages[0].media.length,1);
 await session.recallSource('missing-picture');
 assert.equal(session.snapshot().messages[0].recalled,true);
 assert.equal(session.snapshot().sources.some(s=>s.id===session.sourceAliases['missing-picture']),false);
});
