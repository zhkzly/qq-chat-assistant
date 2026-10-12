'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {maintainMemory,consolidateMemory,parseMemory}=require('../src/memory-engine.cjs');
const {scope}=require('./fixtures/native.cjs');
const turn=s=>s.appendTurn(scope,{role:'user',kind:'discussion',text:'今天散步时想起她喜欢的展览'});
const noop=b=>({reviewedSourceIds:b.reviewedSourceIds,items:[],episodes:[],retire:[]});
const wireNoop=p=>({batchId:p.batchId,reviewedAll:true,items:[],episodes:[],retire:[]});
test('maintenance resumes after failure and no-result never counts as processed',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());turn(s);let calls=0;
  let r=await maintainMemory({store:s,scope,settings:{},model:async()=>{calls++;throw new Error('synthetic network failure');}});
  assert.equal(r.status,'error');assert.equal(r.pending,1);assert.equal(r.processed,0);assert.equal(r.errors.length,1);
  r=await maintainMemory({store:s,scope,settings:{},model:async()=>({items:[]})});assert.equal(r.status,'rejected');assert.equal(r.processed,0);
  r=await maintainMemory({store:s,scope,settings:{},model:async(_,b)=>{calls++;return noop(b);}});assert.equal(r.status,'complete');assert.equal(r.processed,1);assert.deepEqual(r.errors,[]);assert.equal(calls,2);
});
test('stale revision, stopped scope and overlapping workers never commit a late result',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const first=turn(s);let finish;
  const pending=maintainMemory({store:s,scope,settings:{},model:(_,b)=>new Promise(resolve=>{finish=()=>resolve(noop(b));})});
  await new Promise(resolve=>setImmediate(resolve));
  const overlap=await maintainMemory({store:s,scope,settings:{},model:async(_,b)=>noop(b)});assert.equal(overlap.status,'already_running');
  s.updateTurn(scope,first.id,'已纠正');finish();const r=await pending;assert.equal(r.status,'rejected');assert.equal(r.processed,0);
  let allowed=true;const stopped=await maintainMemory({store:s,scope,settings:{},shouldContinue:()=>allowed,model:async(_,b)=>{allowed=false;return noop(b);}});
  assert.equal(stopped.status,'stopped');assert.equal(stopped.processed,0);
});
test('HTTP contract sends bounded evidence, no whole private transcript, and rejects missing receipts and auth',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());turn(s);const b=s.memoryBatch(scope);
  const response=await consolidateMemory({baseUrl:'http://127.0.0.1:8317/v1',model:'synthetic',anonymous:true},b,undefined,async(url,options)=>{
    assert.equal(url.pathname,'/v1/chat/completions');const body=JSON.parse(options.body);assert.equal(body.messages.length,2);
    const payload=JSON.parse(body.messages[1].content);assert.equal(payload.sources[0].id,'s1');assert.equal(payload.review.sourceCount,b.sources.length);assert.match(payload.batchId,/^b[0-9a-f]{16}$/);
    assert.equal(payload.privateConversation,undefined);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(wireNoop(payload))}}]})};
  });assert.deepEqual(response,noop(b));
  assert.throws(()=>parseMemory('{}'),/reviewedSourceIds/);
  await assert.rejects(()=>consolidateMemory({},b),/配置模型/);
});

test('memory model egress redacts concrete credentials from all projected text without changing raw evidence or hashes',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());
  const secret='sk-'+'a'.repeat(35),query='token='+'b'.repeat(35),bearer='Bearer '+'c'.repeat(35),key='-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----';
  const original=`今天去了展览 ${secret} https://example.test/?${query} ${bearer}\n${key}`;
  const u=s.appendTurn(scope,{role:'user',kind:'discussion',text:original});let b=s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope,b,{...noop(b),items:[{kind:'fact',text:original,sourceIds:[`private:${u.id}`],topicKeys:['展览',secret]}]}).applied,true);
  s.appendTurn(scope,{role:'user',kind:'discussion',text:'继续上次的展览'});b=s.memoryBatch(scope);b.baseState.focus=secret;const before=JSON.stringify(b);
  assert.ok(b.priorMemory.items.length);assert.ok(b.contextSources.some(source=>source.text.includes(secret)));
  await consolidateMemory({baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true},b,undefined,async(_,request)=>{
    for(const credential of [secret,query,bearer,'synthetic-private-key'])assert.equal(request.body.includes(credential),false);
    const payload=JSON.parse(JSON.parse(request.body).messages[1].content);
    assert.ok(payload.priorMemory.items[0].text.includes('展览'));assert.equal(payload.sources[0].id,'s1');assert.equal(payload.sources[0].revision,undefined);
    assert.equal(payload.review.sourceCount,b.reviewedSourceIds.length);
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(wireNoop(payload))}}]})};
  });
  assert.equal(JSON.stringify(b),before);assert.equal(s.memorySources(scope).find(source=>source.id===`private:${u.id}`).text,original);
});

test('malformed memory responses do not echo private model text into persisted error messages',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());turn(s);const sensitive='PRIVATE_SYNTHETIC_SENTENCE';
  const result=await maintainMemory({store:s,scope,settings:{},model:async()=>parseMemory('{"text":'+sensitive)});
  assert.equal(result.status,'error');assert.equal(JSON.stringify(result.errors).includes(sensitive),false);assert.match(result.errors[0].message,/invalid JSON/);assert.equal(result.pending,1);
});

test('wire aliases reconstruct exact long original IDs and prior record identities without making the model echo them',async t=>{
  const {normalize}=require('../src/messages.cjs'),{raw}=require('./fixtures/native.cjs');
  const s=new Store(':memory:');t.after(()=>s.close());const firstId='7205759403792793700000123456789';
  s.add(scope,[normalize(raw(firstId,false,{elements:[{textElement:{content:'周六一起看展览？'}}]}),scope)]);
  let batch=s.memoryBatch(scope);assert.equal(s.applyMemoryBatch(scope,batch,{...noop(batch),items:[{kind:'commitment',text:'看展邀请，尚未确认',sourceIds:[`qq:${firstId}`],topicKeys:['看展'],status:'active'}]}).applied,true);
  const later=s.appendTurn(scope,{role:'user',kind:'discussion',id:'private-source-with-a-long-original-identifier',text:'这次看展取消了'});
  batch=s.memoryBatch(scope);const prior=batch.priorMemory.items[0],before=JSON.stringify(batch);
  const result=await consolidateMemory({baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true},batch,undefined,async(_,request)=>{
    const payload=JSON.parse(JSON.parse(request.body).messages[1].content);
    assert.equal(payload.sources[0].id,'s1');assert.equal(payload.contextSources[0].id,'c1');assert.equal(payload.priorMemory.items[0].id,'m1');
    assert.deepEqual(payload.priorMemory.items[0].sourceIds,['c1']);
    for(const id of [firstId,later.id,prior.id])assert.equal(request.body.includes(id),false);
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({...wireNoop(payload),retire:[{id:'m1',sourceIds:['s1','c1','s1'],status:'cancelled'}]})}}]})};
  });
  assert.equal(JSON.stringify(batch),before);assert.deepEqual(result.reviewedSourceIds,[`private:${later.id}`]);
  assert.equal(result.retire[0].id,prior.id);assert.deepEqual(result.retire[0].sourceIds,[`private:${later.id}`,`qq:${firstId}`]);
  assert.equal(s.applyMemoryBatch(scope,batch,result).applied,true);assert.equal(s.searchMemory(scope,'看展').items[0].status,'cancelled');
});

test('wire review receipt rejects absent, false and mismatched acknowledgments without advancing any queued source',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());turn(s);const batch=s.memoryBatch(scope);
  for(const change of [p=>({...wireNoop(p),reviewedAll:false}),p=>{const r=wireNoop(p);delete r.reviewedAll;return r;},p=>({...wireNoop(p),batchId:'b0000000000000000'}),p=>{const r=wireNoop(p);delete r.items;return r;},p=>({...noop(batch)})]) {
    const result=await maintainMemory({store:s,scope,settings:{baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true},model:(settings,b,signal)=>consolidateMemory(settings,b,signal,async(_,request)=>{
      const p=JSON.parse(JSON.parse(request.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(change(p))}}]})};
    })});assert.equal(result.status,'error');assert.equal(result.pending,1);assert.equal(result.processed,0);
    assert.ok(['incomplete_review_receipt','memory_batch_identity_mismatch','invalid_memory_wire_fields'].includes(result.errors[0].code));
  }
});

test('unknown aliases and original IDs in model citations are rejected with content-free diagnostics',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const user=turn(s),batch=s.memoryBatch(scope),secret='PRIVATE_UNKNOWN_REFERENCE';
  for(const entry of [{kind:'fact',text:'Statement',sourceIds:['s999']},{kind:'fact',text:'Statement',sourceIds:[`private:${user.id}`]},{id:secret,kind:'fact',text:'Statement',sourceIds:['s1']}]) {
    await assert.rejects(()=>consolidateMemory({baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true},batch,undefined,async(_,request)=>{
      const p=JSON.parse(JSON.parse(request.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({...wireNoop(p),items:[entry]})}}]})};
    }),error=>{assert.ok(/unknown/.test(error.message));assert.equal(error.message.includes(secret),false);assert.equal(error.message.includes(user.id),false);return true;});
  }
  assert.equal(s.memoryStatus(scope).pending,1);assert.equal(s.memoryStatus(scope).processed,0);
});

test('an explicit bound no-change acknowledgment creates reviewed_no_change and nothing else',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());turn(s);turn(s);
  const result=await maintainMemory({store:s,scope,settings:{baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true},model:(settings,b,signal)=>consolidateMemory(settings,b,signal,async(_,request)=>{
    const p=JSON.parse(JSON.parse(request.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(wireNoop(p))}}]})};
  })});assert.equal(result.status,'complete');assert.equal(result.processed,2);assert.equal(result.lastReview.outcome,'reviewed_no_change');assert.equal(result.counts.items,0);
});

test('typed background extraction preserves legacy memories and aliases existing claims and events through the real Store', async t => {
  const { normalize } = require('../src/messages.cjs'), { raw } = require('./fixtures/native.cjs');
  const s = new Store(':memory:'); t.after(() => s.close());
  const originalId = '7205759403792793700012345678901';
  s.add(scope, [normalize(raw(originalId, false, { elements: [{ textElement: { content: '这周忙着考试，周六先不约。' } }] }), scope)]);
  const sourceId = `qq:${originalId}`;
  let batch = s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope, batch, { ...noop(batch), items: [{ kind: 'fact', text: '她这周备考', sourceIds: [sourceId], topicKeys: ['考试'] }] }).applied, true);
  assert.equal(s.applyRelationshipPatch(scope, { claims: [{ subject: 'contact', aspect: 'recent_context', text: '她说这周忙着考试', assertionKind: 'stated', epistemicStatus: 'supported', sourceIds: [sourceId] }],
    events: [{ activityKey: 'weekend-game', eventKind: 'decline', actor: 'contact', text: '她说周六先不约', sourceIds: [sourceId] }] },
  { baseRevision: s.getCompanion(scope).revision, sourceIds: [sourceId] }).applied, true);
  const later = s.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她之前说这周忙着考试、周六先不约。现在她告诉我考完试了，但我不确定她想不想一起玩。' });
  batch = s.memoryBatch(scope);
  assert.ok(batch.priorMemory.claims.length && batch.priorMemory.events.length);
  const before = JSON.stringify(batch), oldClaim = batch.priorMemory.claims[0], oldEvent = batch.priorMemory.events[0];
  const decoded = await consolidateMemory({ ...settingsForMemory() }, batch, undefined, async (_, request) => {
    const body = JSON.parse(request.body), p = JSON.parse(body.messages[1].content);
    assert.ok(p.priorMemory.claims.length && p.priorMemory.events.length, 'the updater must see previous typed understanding');
    const claim = p.priorMemory.claims[0], event = p.priorMemory.events[0];
    assert.match(claim.id, /^m\d+$/); assert.match(event.id, /^m\d+$/);
    assert.notEqual(claim.id, event.id);
    for (const original of [originalId, oldClaim.id, oldEvent.id, later.id]) assert.equal(request.body.includes(original), false);
    assert.match(body.messages[0].content, /relationshipPatch/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ...wireNoop(p), relationshipPatch: {
      claims: [{ id: claim.id, expectedVersion: claim.version, subject: 'contact', aspect: 'recent_context', text: '用户转述她已经考完试', assertionKind: 'reported', epistemicStatus: 'supported', sourceIds: ['s1'] }],
      events: [], retire: [{ id: event.id, expectedVersion: event.version, sourceIds: ['s1'], lifecycle: 'superseded' }]
    } }) } }] }) };
  });
  assert.equal(JSON.stringify(batch), before);
  assert.equal(decoded.relationshipPatch.claims[0].id, oldClaim.id);
  assert.deepEqual(decoded.relationshipPatch.claims[0].sourceIds, [`private:${later.id}`]);
  assert.equal(decoded.relationshipPatch.retire[0].id, oldEvent.id);
  const applied = s.applyMemoryBatch(scope, batch, decoded);
  assert.equal(applied.applied, true, applied.detail);
  assert.equal(s.searchMemory(scope, '考试').items.length, 1, 'an omitted useful legacy record must not be deleted');
  assert.equal(s.relationshipView(scope).claims.find(item => item.id === oldClaim.id).assertionKind, 'reported');
});

function settingsForMemory() { return { baseUrl: 'http://fixture.invalid/v1', model: 'synthetic', anonymous: true }; }

test('background typed aliases reject unseen IDs and cannot promote an inferred mental state to supported', async t => {
  const s = new Store(':memory:'); t.after(() => s.close()); turn(s); const batch = s.memoryBatch(scope);
  for (const claim of [
    { subject: 'contact', aspect: 'interaction_hypothesis', text: '猜测她有好感', assertionKind: 'inferred', epistemicStatus: 'supported', sourceIds: ['s1'] },
    { subject: 'contact', aspect: 'recent_context', text: '未提供的事情', assertionKind: 'reported', epistemicStatus: 'tentative', sourceIds: ['c999'] }
  ]) await assert.rejects(() => consolidateMemory(settingsForMemory(), batch, undefined, async (_, request) => {
    const p = JSON.parse(JSON.parse(request.body).messages[1].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ...wireNoop(p), relationshipPatch: { claims: [claim] } }) } }] }) };
  }), /epistemicStatus|unknown.*alias|relationshipPatch/);
  assert.equal(s.memoryStatus(scope).processed, 0);
});
