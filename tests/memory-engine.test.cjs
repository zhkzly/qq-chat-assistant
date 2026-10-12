'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {maintainMemory,consolidateMemory,parseMemory}=require('../src/memory-engine.cjs');
const {scope}=require('./fixtures/native.cjs');
const turn=s=>s.appendTurn(scope,{role:'user',kind:'discussion',text:'今天散步时想起她喜欢的展览'});
const noop=b=>({reviewedSourceIds:b.reviewedSourceIds,items:[],episodes:[],retire:[]});
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
    const payload=JSON.parse(body.messages[1].content);assert.deepEqual(payload.requiredReviewIds,b.reviewedSourceIds);assert.ok(payload.sources[0].revision);
    assert.equal(payload.privateConversation,undefined);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(noop(b))}}]})};
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
    assert.ok(payload.priorMemory.items[0].text.includes('展览'));assert.equal(payload.sources[0].revision,b.sources[0].revision);
    assert.deepEqual(payload.requiredReviewIds,b.reviewedSourceIds);
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(noop(b))}}]})};
  });
  assert.equal(JSON.stringify(b),before);assert.equal(s.memorySources(scope).find(source=>source.id===`private:${u.id}`).text,original);
});

test('malformed memory responses do not echo private model text into persisted error messages',async t=>{
  const s=new Store(':memory:');t.after(()=>s.close());turn(s);const sensitive='PRIVATE_SYNTHETIC_SENTENCE';
  const result=await maintainMemory({store:s,scope,settings:{},model:async()=>parseMemory('{"text":'+sensitive)});
  assert.equal(result.status,'error');assert.equal(JSON.stringify(result.errors).includes(sensitive),false);assert.match(result.errors[0].message,/invalid JSON/);assert.equal(result.pending,1);
});
