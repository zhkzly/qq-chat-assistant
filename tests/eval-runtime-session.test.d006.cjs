'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test = require('node:test');
const {withRequestDelivery}=require('../scripts/synthetic-request-delivery.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createReplaySession, makeSyntheticTransport,projectPublicMemory } = require('../scripts/eval-runtime-session.cjs');

// Native-shaped records follow tests/fixtures/native.cjs. These responses test
// the versioned product adapter, never conversational quality or desktop QQ.
const sourceRoot = path.resolve(__dirname, '..');
const asOf = '2026-10-29T12:00:00.000Z';
const settings = { model: 'synthetic-replay-only', baseUrl: 'http://fixture.invalid/v1', anonymous: true, auto: false };
const event = (id, at, speaker, text) => ({ id, at, speaker, text });
const history = [event('original-incoming', '2026-10-29T11:59:00.000Z', 'contact', '书架终于装好了。')];
const OBSERVATION_CONDITION='scheduled_idle_public_memory_observation_v1';
const packet = result => new Response(JSON.stringify({ model: settings.model,
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { status: 200 });
function input(args) { return JSON.parse(JSON.parse(args.body).messages[1].content); }
async function setup(t, options = {}) {
  const session = await createReplaySession({ sourceRoot, asOf, history, goal: '保持朋友间真实的交流。', settings,
    transport: makeSyntheticTransport(), ...options });
  t.after(() => session.close());
  return session;
}

test('supplemental condition lets the real foreground request cancel slow scheduled memory without prewaiting',async t=>{
 const fixture=makeSyntheticTransport();let started=0,aborted=0;
 const session=await setup(t,{condition:OBSERVATION_CONDITION,settleTimeoutMs:150,settings:{...settings,memoryBatchThreshold:1},transport:async(url,args)=>{
  const p=input(args);if(p.batchId){started++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(fixture(url,args)),250);args.signal.addEventListener('abort',()=>{clearTimeout(timer);aborted++;reject(args.signal.reason||Error('aborted'));},{once:true});});}return fixture(url,args);
 }});
 await session.advanceTo('2026-10-29T12:00:01.800Z');assert.equal(started,1);
 const response=await session.post('/api/assistant',{text:'原定时间的问题。',taskId:'original-foreground'});
 assert.equal(aborted,1);assert.ok(response.companion.turns.some(row=>row.role==='assistant'&&row.requestId==='original-foreground'));
 assert.ok(session.trace.some(row=>row.component==='model_transport'&&row.event==='abort_signal'&&row.owner==='background_memory'));
 assert.equal(session.snapshot().derivedMemory.length,0);
});

test('supplemental idle deadline retains a pending public checkpoint and the fixed foreground question continues',async t=>{
 const fixture=makeSyntheticTransport();let aborted=0;
 const session=await setup(t,{condition:OBSERVATION_CONDITION,settings:{...settings,memoryBatchThreshold:1},transport:async(url,args)=>{
  if(input(args).batchId)return new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(fixture(url,args)),250);args.signal.addEventListener('abort',()=>{clearTimeout(timer);aborted++;reject(args.signal.reason||Error('aborted'));},{once:true});});return fixture(url,args);
 }});
 const checkpoint=await session.idleUntil('2026-10-29T12:00:10.000Z',{wallTimeoutMs:20});
 assert.equal(checkpoint.status,'incomplete');assert.equal(checkpoint.reason,'native_deadline');assert.ok(checkpoint.pending_tasks.length>0);
 const view=await session.publicMemoryView();assert.equal(view.as_of,'2026-10-29T12:00:10.000Z');assert.ok(view.memory_status.pending>0);
 const response=await session.post('/api/assistant',{text:'仍然按原定问题求助。',taskId:'after-idle-deadline'});assert.equal(aborted,1);
 assert.ok(response.companion.turns.some(row=>row.requestId==='after-idle-deadline'&&row.role==='assistant'));
});

test('scheduled legal legacy item receives one bounded rereview and remains an incomplete semantic checkpoint',async t=>{
 const fixture=makeSyntheticTransport();let writes=0;
 const session=await setup(t,{condition:OBSERVATION_CONDITION,settings:{...settings,memoryBatchThreshold:1},transport:async(url,args)=>{
  const p=input(args);if(p.batchId){writes++;if(p.review?.purpose==='semantic_recovery')return packet({batchId:p.batchId,reviewedAll:true,relationshipPatch:{claims:[],events:[],retire:[]},episodes:[]});const source=p.sources.find(row=>!row.deleted);return packet({batchId:p.batchId,reviewedAll:true,items:[{kind:'fact',text:source.text,sourceIds:[source.id],topicKeys:[],status:'active',certainty:'stated'}],episodes:[],retire:[]});}return fixture(url,args);
 }});
 const checkpoint=await session.idleUntil('2026-10-29T12:00:10.000Z',{wallTimeoutMs:1000});
 assert.equal(writes,2);assert.equal(checkpoint.memory_status.pending,0);assert.equal(checkpoint.memory_status.semanticPending,1);assert.equal(checkpoint.memory_status.recoveryReady,0);assert.equal(checkpoint.memory_status.recoveryDeferred,1);assert.deepEqual(checkpoint.memory_status.errors,[]);assert.equal(checkpoint.product_coverage.semanticPending,0);
 assert.equal(checkpoint.status,'incomplete');assert.equal(checkpoint.reason,'partial_semantic_review');
 const view=await session.publicMemoryView();assert.equal(view.memory_status.semanticPending,1);assert.equal(view.as_of,'2026-10-29T12:00:10.000Z');
 const again=await session.idleUntil('2026-10-29T12:00:20.000Z',{wallTimeoutMs:1000});assert.equal(writes,2);assert.deepEqual(again.memory_status.errors,[]);assert.equal(again.status,'incomplete');assert.equal(again.memory_status.recoveryDeferred,1);
 const response=await session.post('/api/assistant',{text:'原定问题仍应继续，不将旧条目当成已核验。',taskId:'legacy-checkpoint-question'});
 assert.ok(response.companion.turns.some(row=>row.role==='assistant'&&row.requestId==='legacy-checkpoint-question'));
 assert.ok(!session.trace.some(row=>row.component==='product_http'&&row.route==='/api/memory-maintain'));
});

test('public errors array prevents a complete idle receipt even after source journal settles',async t=>{
 const session=await setup(t,{condition:OBSERVATION_CONDITION,settings:{...settings,memoryBatchThreshold:1}});
 await session.idleUntil('2026-10-29T12:00:10.000Z',{wallTimeoutMs:1000});
 session.store.recordMemoryError(session.scope,{code:'actual_public_error',message:'Synthetic persisted maintenance failure.'});
 const checkpoint=await session.idleUntil('2026-10-29T12:00:10.000Z',{wallTimeoutMs:1000});assert.equal(checkpoint.memory_status.pending,0);assert.equal(checkpoint.memory_status.errors[0].code,'actual_public_error');
 assert.equal(checkpoint.status,'incomplete');assert.equal(checkpoint.reason,'memory_error');
 assert.equal((await session.publicMemoryView()).memory_status.errors[0].code,'actual_public_error');
 const response=await session.post('/api/assistant',{text:'原定求助继续。',taskId:'public-error-question'});assert.ok(response.companion.turns.some(row=>row.role==='assistant'&&row.requestId==='public-error-question'));
});

test('actual pending understanding proposals prevent a complete idle receipt with an empty source journal',async t=>{
 const session=await setup(t,{condition:OBSERVATION_CONDITION,settings:{...settings,memoryBatchThreshold:1}});
 await session.idleUntil('2026-10-29T12:00:10.000Z',{wallTimeoutMs:1000});
 const source=session.store.memorySources(session.scope)[0],companion=session.store.getCompanion(session.scope);
 const proposal=session.store.queueUnderstandingProposal(session.scope,{claims:[{subject:'contact',aspect:'recent_context',text:source.text,assertionKind:'stated',epistemicStatus:'supported',sourceIds:[source.id]}],events:[],retire:[]},
  {baseRevision:companion.revision,sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision},requestId:'actual-pending-proposal'});
 assert.equal(proposal.queued,true);
 const checkpoint=await session.idleUntil('2026-10-29T12:00:10.000Z',{wallTimeoutMs:1000});assert.equal(checkpoint.memory_status.pending,0);assert.equal(checkpoint.memory_status.pendingProposals,1);
 assert.equal(checkpoint.status,'incomplete');assert.equal(checkpoint.reason,'pending_proposals');assert.equal((await session.publicMemoryView()).memory_status.pendingProposals,1);
});

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

test('public memory observation reads the assistant-window route without starting model work', async t => {
  let calls=0;const transport=makeSyntheticTransport();
  const session=await setup(t,{transport:async(...args)=>{calls++;return transport(...args);}});
  const before=session.snapshot(),view=await session.publicMemoryView();
  assert.deepEqual(view.relationship,projectPublicMemory(before).relationship);
  assert.deepEqual(view.scope,before.scope);assert.equal(view.as_of,asOf);assert.equal(calls,0);
  assert.equal(view.capture_scope,'public_read_model_ui_selected_branch_not_rendered_dom');
  assert.equal(view.source_aliases,undefined);assert.equal(view.source_identities,undefined);
  assert.ok(session.trace.some(e=>e.component==='product_http'&&e.method==='GET'&&e.route==='/api/state'&&e.event==='response'));
  assert.ok(!session.trace.some(e=>e.route==='/api/memory-maintain'));
  const subject=view.relationship.understanding?.contact?.uncertainties||view.relationship.contact;
  subject.push({id:'observer-mutation'});
  assert.ok(!JSON.stringify((await session.publicMemoryView()).relationship).includes('observer-mutation'));
});

test('production HTTP consultation preserves generated replies, actual events and same-session state', async t => {
  let sequence = 0;
  const session = await setup(t, { transport: async (_url, args) => {
    const p = input(args);
    const original=p.originalInput||p;
    if(original.purpose==='fidelity_check')return packet({checkRef:original.checkRef,auditProtocol:'sparse-defects-v1',issues:[]});
    return packet(original.operationProtocol?{operation:'advise',text:`真实适配器保存的合成回答 ${++sequence}：${original.userRequest.text}`} : withRequestDelivery({kind:'discussion',text:`真实适配器保存的合成回答 ${++sequence}：${original.userRequest.text}`},original));
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

test('optional compaction rejection preserves its trace without rejecting a successful foreground fallback', async t => {
  const fixture=makeSyntheticTransport();let initial=true;
  const session=await setup(t,{transport:async(url,args)=>{
    const p=input(args);
    if(p.purpose==='discussion_compaction')return new Response('{}',{status:400});
    if(p.purpose==='discussion'&&initial){initial=false;return packet(p.operationProtocol?{operation:'advise',text:'合成历史解释。'.repeat(700)}:withRequestDelivery({kind:'discussion',text:'合成历史解释。'.repeat(700)},p));}
    return fixture(url,args);
  }});
  await session.post('/api/assistant',{text:'先商量书架。',taskId:'before-compaction'});
  const response=await session.post('/api/assistant',{text:'继续刚才的商量。',taskId:'after-optional-failure'});
  assert.equal(response.error,'');
  assert.ok(response.companion.turns.some(turn=>turn.role==='assistant'&&turn.requestId==='after-optional-failure'));
  assert.ok(session.trace.some(row=>row.component==='compaction_adapter'&&row.event==='error'&&/HTTP 400/.test(row.error.message)));
  assert.ok(session.trace.some(row=>row.component==='model_transport'&&row.event==='response'&&row.status===400));
  assert.equal(session.snapshot().discussionCompaction.phase,'skipped');
  const next=await session.post('/api/assistant',{text:'再继续商量。',taskId:'after-fallback-checkpoint'});
  assert.ok(next.companion.turns.some(turn=>turn.role==='assistant'&&turn.requestId==='after-fallback-checkpoint'));
});

test('terminal foreground provider failures remain replay failures',async t=>{
  const session=await setup(t,{transport:async()=>new Response('{}',{status:400})});
  await assert.rejects(session.post('/api/assistant',{text:'现在实际求助。',taskId:'terminal-failure'}),/HTTP 400|replay.*failed/i);
  assert.equal(session.snapshot().companion.turns.filter(turn=>turn.role==='assistant').length,0);
  assert.ok(session.trace.some(row=>row.component==='assistant_adapter'&&row.event==='error'));
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
  const restoredTurn=session.trace.find(row=>row.component==='private_boundary'&&row.event==='restore'&&row.input_event?.id==='earlier-user');
  assert.ok(restoredTurn,'archive input must not overwrite the trace event envelope');
  assert.ok(session.trace.some(row=>row.component==='private_boundary'&&row.event==='restore_note'&&row.input_event?.id==='historical-material'));
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
  assert.ok(session.trace.some(row=>row.component==='external_action'&&row.event==='source_withdrawn'&&row.input_event?.id==='earlier-user'));
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
