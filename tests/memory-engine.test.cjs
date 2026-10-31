'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {maintainMemory,consolidateMemory,parseMemory}=require('../src/memory-engine.cjs');
const {scope}=require('./fixtures/native.cjs');
const turn=s=>s.appendTurn(scope,{role:'user',kind:'discussion',text:'今天散步时想起她喜欢的展览'});
const noop=b=>({reviewedSourceIds:b.reviewedSourceIds,items:[],episodes:[],retire:[]});
const wireNoop=p=>({batchId:p.batchId,reviewedAll:true,relationshipPatch:{claims:[],events:[],retire:[]},episodes:[]});
const legacyWireNoop=p=>({batchId:p.batchId,reviewedAll:true,items:[],episodes:[],retire:[]});
const memoryInput=request=>{const p=JSON.parse(JSON.parse(request.body).messages[1].content);return p.originalInput||p;};
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
  });const {originalDelivery,...semanticResult}=response;assert.deepEqual(semanticResult,{...noop(b),relationshipPatch:{claims:[],events:[],retire:[]}});assert.deepEqual(originalDelivery,b.sources.filter(source=>!source.deleted),'decoded evidence is the actual captured scoped original, not model-authored text');
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
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({...legacyWireNoop(payload),retire:[{id:'m1',sourceIds:['s1','c1','s1'],status:'cancelled'}]})}}]})};
  });
  assert.equal(JSON.stringify(batch),before);assert.deepEqual(result.reviewedSourceIds,[`private:${later.id}`]);
  assert.equal(result.retire[0].id,prior.id);assert.deepEqual(result.retire[0].sourceIds,[`private:${later.id}`,`qq:${firstId}`]);
  assert.equal(s.applyMemoryBatch(scope,batch,result).applied,true);assert.equal(s.searchMemory(scope,'看展').items[0].status,'cancelled');
});

test('background wire aliases ordering, authors and reply edges without exposing native identifiers',async t=>{
  const {normalize}=require('../src/messages.cjs'),{raw}=require('./fixtures/native.cjs');
  const {prepareMemoryRequest}=require('../src/memory-engine.cjs');
  const s=new Store(':memory:');t.after(()=>s.close());
  const firstId='810000000000000000001',secondId='810000000000000000002',thirdId='810000000000000000003',fourthId='810000000000000000004',missingId='810000000000000000099';
  const firstSeq='910000000000000000001',secondSeq='910000000000000000002',thirdSeq='910000000000000000003',fourthSeq='910000000000000000004';
  const quote=messageId=>({replyElement:{replayMsgId:messageId,replayMsgSeq:firstSeq,senderUidStr:scope.accountUid,senderUin:scope.accountUin}});
  s.add(scope,[normalize(raw(firstId,true,{msgSeq:firstSeq,elements:[{textElement:{content:'Synthetic self proposal.'}}]}),scope),
    normalize(raw(secondId,false,{msgSeq:secondSeq,elements:[quote(firstId),{textElement:{content:'Synthetic contact acceptance.'}}]}),scope),
    normalize(raw(thirdId,false,{msgSeq:thirdSeq,elements:[quote(missingId),{textElement:{content:'Another synthetic quoted response.'}}]}),scope),
    normalize(raw(fourthId,false,{msgSeq:fourthSeq,elements:[{replyElement:{replayMsgSeq:firstSeq,senderUidStr:scope.accountUid,senderUin:scope.accountUin}},
      {textElement:{content:'Synthetic sequence-only quote.'}}]}),scope)]);
  const batch=s.memoryBatch(scope),before=JSON.stringify(batch),request=prepareMemoryRequest(settingsForMemory(),batch);
  const p=JSON.parse(JSON.parse(request.serialized).messages[1].content),[self,contact,unavailable,sequenceOnly]=p.sources;
  for(const value of [firstId,secondId,thirdId,fourthId,missingId,firstSeq,secondSeq,thirdSeq,fourthSeq,...Object.values(scope)])
    assert.equal(request.serialized.includes(value),false,'native structural identifiers stay local');
  assert.equal(self.author,'self');assert.equal(contact.author,'contact');
  assert.match(self.sequence,/^q\d+$/);assert.match(contact.sequence,/^q\d+$/);
  assert.ok(Number(self.sequence.slice(1))<Number(contact.sequence.slice(1)),'numeric sequence order survives aliasing');
  assert.equal(contact.replyTo.sourceId,self.id);assert.equal(contact.replyTo.sequence,self.sequence);assert.equal(contact.replyTo.author,'self');
  assert.equal(unavailable.replyTo.targetUnavailable,true);assert.match(unavailable.replyTo.messageRef,/^r\d+$/);
  assert.equal(unavailable.replyTo.sourceId,undefined,'an unavailable original is not introduced as citable evidence');
  assert.equal(unavailable.replyTo.sequence,self.sequence);assert.equal(unavailable.replyTo.author,'self');
  assert.equal(sequenceOnly.replyTo.sourceId,undefined);assert.equal(sequenceOnly.replyTo.targetUnavailable,true,'batch-only uniqueness is not complete-cache proof');
  assert.equal(sequenceOnly.replyTo.sequence,self.sequence);assert.equal(sequenceOnly.replyTo.author,'self');
  for(const source of p.sources){assert.equal(source.senderUid,undefined);assert.equal(source.senderUin,undefined);assert.equal(source.replyTo?.messageId,undefined);}
  assert.equal(JSON.stringify(batch),before,'wire projection does not rewrite local records or revision bindings');
  const decoded=request.decode(wireNoop(p));assert.deepEqual(decoded.reviewedSourceIds,batch.reviewedSourceIds);
  assert.equal(s.applyMemoryBatch(scope,batch,decoded).applied,true);
});

test('background quote aliases retain time and cannot replace excluded or missing targets with a same-sequence message',t=>{
  const {normalize}=require('../src/messages.cjs'),{raw}=require('./fixtures/native.cjs'),{prepareMemoryRequest}=require('../src/memory-engine.cjs');
  const s=new Store(':memory:');t.after(()=>s.close());
  const oldId='820000000000000000001',excludedId='820000000000000000002',missingId='820000000000000000099',recordRef='820000000000000000098';
  const sequence='920000000000000000001',oldTime=1791726000,newTime=oldTime+10;
  const quoted=(id,label,time,replayId='0')=>normalize(raw(id,false,{msgSeq:id,msgTime:String(newTime+1),elements:[
    {replyElement:{replayMsgId:replayId,sourceMsgIdInRecords:recordRef,replayMsgSeq:sequence,replyMsgTime:String(time),senderUidStr:scope.accountUid,senderUin:scope.accountUin}},
    {textElement:{content:label}}]}),scope);
  s.add(scope,[normalize(raw(oldId,true,{msgSeq:sequence,msgTime:String(oldTime),elements:[{textElement:{content:'Older synthetic target.'}}]}),scope),
    normalize(raw(excludedId,true,{msgSeq:sequence,msgTime:String(newTime),elements:[{textElement:{content:'Excluded newer synthetic target.'}}]}),scope),
    quoted('820000000000000000003','Quote of the excluded newer target.',newTime),
    quoted('820000000000000000004','Canonical target is missing.',oldTime,missingId),
    quoted('820000000000000000005','Verified older sequence-only target.',oldTime),
    quoted('820000000000000000006','Canonical older target with correct time.',oldTime,oldId),
    quoted('820000000000000000007','Canonical older target with conflicting time.',newTime,oldId)]);
  s.forgetSource(scope,`qq:${excludedId}`);
  const batch=s.memoryBatch(scope),request=prepareMemoryRequest(settingsForMemory(),batch),p=JSON.parse(JSON.parse(request.serialized).messages[1].content);
  const old=p.sources.find(source=>source.text==='Older synthetic target.');
  const excluded=p.sources.find(source=>source.text.includes('Quote of the excluded'));
  const canonicalMissing=p.sources.find(source=>source.text.includes('Canonical target'));
  const verified=p.sources.find(source=>source.text.includes('Verified older'));
  const canonicalVerified=p.sources.find(source=>source.text.includes('Canonical older target with correct'));
  const canonicalWrongTime=p.sources.find(source=>source.text.includes('Canonical older target with conflicting'));
  assert.equal(excluded.replyTo.targetUnavailable,true);assert.equal(excluded.replyTo.sourceId,undefined);
  assert.equal(excluded.replyTo.timestamp,newTime*1000,'time remains readable without exposing a native identity');
  assert.equal(canonicalMissing.replyTo.targetUnavailable,true);assert.equal(canonicalMissing.replyTo.sourceId,undefined);
  assert.equal(canonicalMissing.replyTo.timestamp,oldTime*1000,'a missing canonical ID never falls through to another message');
  assert.equal(verified.replyTo.sourceId,undefined);assert.equal(verified.replyTo.targetUnavailable,true,'even a uniquely matching live subset cannot certify sequence-only identity');
  assert.equal(verified.replyTo.timestamp,oldTime*1000);
  assert.equal(verified.replyTo.author,'self');assert.equal(verified.replyTo.sequence,old.sequence);
  assert.equal(canonicalVerified.replyTo.sourceId,old.id);assert.equal(canonicalVerified.replyTo.timestamp,oldTime*1000);
  assert.equal(canonicalWrongTime.replyTo.targetUnavailable,true);assert.equal(canonicalWrongTime.replyTo.sourceId,undefined,'a canonical ID does not override conflicting time');
  for(const id of [oldId,excludedId,missingId,recordRef,sequence,...Object.values(scope)])assert.equal(request.serialized.includes(id),false);
});

test('wire review receipt rejects absent, false and mismatched acknowledgments without advancing any queued source',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());turn(s);const batch=s.memoryBatch(scope);
  for(const change of [p=>({...wireNoop(p),reviewedAll:false}),p=>{const r=wireNoop(p);delete r.reviewedAll;return r;},p=>({...wireNoop(p),batchId:'b0000000000000000'}),p=>{const r=wireNoop(p);delete r.relationshipPatch;return r;},p=>({...noop(batch)})]) {
    const result=await maintainMemory({store:s,scope,settings:{baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true},model:(settings,b,signal)=>consolidateMemory(settings,b,signal,async(_,request)=>{
      const p=memoryInput(request);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(change(p))}}]})};
    })});assert.equal(result.status,'error');assert.equal(result.pending,1);assert.equal(result.processed,0);
    assert.ok(['incomplete_review_receipt','memory_batch_identity_mismatch','invalid_memory_wire_fields'].includes(result.errors[0].code));
  }
});

test('unknown aliases and original IDs in model citations are rejected with content-free diagnostics',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const user=turn(s),batch=s.memoryBatch(scope),secret='PRIVATE_UNKNOWN_REFERENCE';
  for(const entry of [{kind:'fact',text:'Statement',sourceIds:['s999']},{kind:'fact',text:'Statement',sourceIds:[`private:${user.id}`]},{id:secret,kind:'fact',text:'Statement',sourceIds:['s1']}]) {
    await assert.rejects(()=>consolidateMemory({baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true},batch,undefined,async(_,request)=>{
      const p=memoryInput(request);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({...legacyWireNoop(p),items:[entry]})}}]})};
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
  { baseRevision: s.getCompanion(scope).revision, sourceIds: [sourceId],deliveredSources:s.readOriginalEvidence(scope,{sourceIds:[sourceId],maxBytes:100000}).sources }).applied, true);
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
    const p = memoryInput(request);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ...wireNoop(p), relationshipPatch: { claims: [claim] } }) } }] }) };
  }), /epistemicStatus|unknown.*alias|relationshipPatch/);
  assert.equal(s.memoryStatus(scope).processed, 0);
});

test('maintenance fits the complete serialized memory request and reviews every original segment without gaps', async t => {
  for (const [name, original] of [['ordinary Chinese', '合成共同活动记录😀。'.repeat(5000)], ['JSON escaping', '"\\\n'.repeat(20000)]]) await t.test(name, async () => {
    const s = new Store(':memory:');
    try {
      const user = s.appendTurn(scope, {role:'user', kind:'discussion', text:original});
      const sourceBefore = s.memorySources(scope).find(source => source.id === `private:${user.id}`);
      const segments = [], requests = [];
      const result = await maintainMemory({store:s, scope, settings:settingsForMemory(), maxBatches:50,
        model:(settings, batch, signal) => consolidateMemory(settings, batch, signal, async (_, request) => {
          const bytes = Buffer.byteLength(request.body, 'utf8');assert.ok(bytes <= 48000, `${bytes} exceeds the unchanged complete request limit`);
          requests.push(bytes);const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
          for (const source of payload.sources) segments.push({text:source.text, offset:source.segment?.offset || 0, end:source.segment?.end ?? original.length});
          return {ok:true, json:async()=>({choices:[{message:{content:JSON.stringify(wireNoop(payload))}}]})};
        })});
      assert.equal(result.status, 'complete', JSON.stringify(result.errors));assert.equal(result.pending, 0);assert.equal(result.processed, 1);
      assert.ok(requests.length > 1);assert.equal(segments[0].offset, 0);
      for (let index=1; index<segments.length; index++) assert.equal(segments[index].offset, segments[index-1].end);
      assert.equal(segments.at(-1).end, original.length);assert.equal(segments.map(segment=>segment.text).join(''), original);
      assert.deepEqual(s.memorySources(scope).find(source => source.id === `private:${user.id}`), sourceBefore);
    } finally {s.close();}
  });
});

test('an impossible complete memory request budget makes zero transport calls and preserves the pending cursor', async t => {
  const s = new Store(':memory:');t.after(()=>s.close());turn(s);let calls=0;
  const before=s.memoryBatch(scope).events;
  const result=await maintainMemory({store:s,scope,settings:{...settingsForMemory(),memoryInputBytes:8000},
    model:(settings,batch,signal)=>consolidateMemory(settings,batch,signal,async()=>{calls++;throw new Error('Transport must not run');})});
  assert.equal(result.status,'error');assert.equal(calls,0);assert.equal(result.pending,1);assert.equal(result.processed,0);
  assert.equal(result.errors[0].code,'memory_request_budget_exceeded');assert.match(result.errors[0].message,/complete.*budget|budget.*complete/i);
  assert.deepEqual(s.memoryBatch(scope).events,before);assert.equal(result.lastReview,null);
});

test('the minimum raw batch size fails explicitly when its escaped segment still cannot fit the complete budget', async t => {
  const s=new Store(':memory:');t.after(()=>s.close());s.appendTurn(scope,{role:'user',kind:'discussion',text:'"\\\n'.repeat(20000)});let calls=0;
  const before=s.memoryBatch(scope).events;
  const result=await maintainMemory({store:s,scope,settings:{...settingsForMemory(),memoryInputBytes:12000},
    model:(settings,batch,signal)=>consolidateMemory(settings,batch,signal,async()=>{calls++;throw new Error('Transport must not run');})});
  assert.equal(result.status,'error');assert.equal(calls,0);assert.equal(result.errors[0].code,'memory_request_budget_exceeded');
  assert.ok(result.errors[0].requiredBytes>12000);assert.equal(result.pending,1);assert.equal(result.processed,0);
  assert.deepEqual(s.memoryBatch(scope).events,before);assert.equal(result.lastReview,null);
});
