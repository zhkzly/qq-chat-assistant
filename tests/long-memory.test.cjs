'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
function turn(store,text) { return store.appendTurn(scope,{role:'user',kind:'discussion',text}); }
function receipt(batch,extra={}) { return { reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[],...extra }; }

test('old private user context and actual QQ remain searchable after many later exchanges and restart', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-long-memory-')); const file=path.join(dir,'m.db'); let s=new Store(file);
  t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});
  const old=turn(s,'她想去看敦煌壁画，我也喜欢博物馆。');
  for(let i=0;i<35;i++) {turn(s,`后来的普通交流 ${i}`);s.appendTurn(scope,{role:'assistant',kind:'discussion',text:'助手推测她喜欢滑雪'});}
  s.add(scope,[normalize(raw(),scope)]);s.saveNote(scope,{text:'我周末去了敦煌展览',use:'discussion'});s.close();s=new Store(file);
  const found=s.searchMemory(scope,'敦煌 壁画'); assert.ok(found.sources.some(x=>x.id===`private:${old.id}`));
  assert.ok(found.sources.some(x=>x.type==='note')); assert.ok(s.memorySources(scope).some(x=>x.type==='qq'));
  assert.equal(s.searchMemory(scope,'滑雪').sources.length,0);
  assert.equal(s.searchMemory({...scope,peerUin:'other'},'敦煌').sources.length,0);
  assert.equal(JSON.stringify(JSON.parse(s.export(scope,'json').data)).includes('敦煌'),false);
});

test('durable pending journal reviews contiguous bounded batches; full no-change advances, missing receipts do not',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());for(let i=0;i<5;i++)turn(s,`source ${i}`);
  const b=s.memoryBatch(scope,{limit:2,maxBytes:12000});assert.equal(b.sources.length,2);assert.equal(s.memoryStatus(scope).pending,5);
  assert.equal(s.applyMemoryBatch(scope,b,{items:[]}).applied,false);assert.equal(s.memoryStatus(scope).pending,5);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b)).applied,true);assert.equal(s.memoryStatus(scope).pending,3);
  assert.equal(s.memoryStatus(scope).processed,2);assert.equal(s.applyMemoryBatch(scope,b,receipt(b)).applied,false);
  const next=s.memoryBatch(scope,{limit:10});assert.equal(next.sources.length,3);assert.equal(s.applyMemoryBatch(scope,next,receipt(next)).applied,true);
  assert.equal(s.memoryStatus(scope).pending,0);assert.equal(s.memoryBatch(scope),null);
});

test('source-cited memories recover history, reject invented facts and cascade source change/deletion across summaries',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const a=turn(s,'周六想一起去看展');const b=s.memoryBatch(scope);
  const item={kind:'commitment',text:'用户提议周六看展',sourceIds:[`private:${a.id}`],topicKeys:['看展'],status:'active'};
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{items:[{...item,sourceIds:['qq:missing']}]})).applied,false);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{items:[item],episodes:[{text:'讨论了一次看展意向',sourceIds:item.sourceIds,topicKeys:['看展']}]})).applied,true);
  assert.equal(s.searchMemory(scope,'看展').items.length,1);assert.equal(s.searchMemory(scope,'看展').episodes.length,1);
  s.updateTurn(scope,a.id,'纠正：周六看展取消了');
  assert.equal(s.searchMemory(scope,'看展').items.length,0);assert.equal(s.searchMemory(scope,'看展').episodes.length,0);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{items:[item]})).applied,false);
  const update=s.memoryBatch(scope);assert.equal(s.applyMemoryBatch(scope,update,receipt(update,{items:[{...item,text:'用户说看展取消',status:'cancelled'}]})).applied,true);
  s.forgetSource(scope,`private:${a.id}`);assert.equal(s.searchMemory(scope,'看展').sources.length,0);assert.equal(s.searchMemory(scope,'看展').items.length,0);
  const removed=s.memoryBatch(scope);assert.ok(removed.sources.every(x=>x.deleted));assert.equal(JSON.stringify(removed).includes('取消了'),false);
});

test('note permission withdrawal and QQ recall invalidate reviewed memory and block stale native resurrection',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const m=normalize(raw(),scope);s.add(scope,[m]);
  const n=s.saveNote(scope,{text:'不能给她看的家庭背景',use:'discussion'});const b=s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{episodes:[{text:'背景讨论',sourceIds:b.sources.map(x=>x.id)}]})).applied,true);
  s.saveNote(scope,{id:n.id,text:n.text,use:'disabled'});assert.equal(s.searchMemory(scope,'背景').episodes.length,0);
  s.add(scope,[{...m,recalled:true,text:'[已撤回]'}]);s.add(scope,[m]);
  assert.equal(s.memorySources(scope).length,0);assert.equal(s.messages(scope)[0].recalled,true);
});

test('forgetting observed QQ persists exclusion across reimport without changing actual history or export',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const m=normalize(raw(),scope);s.add(scope,[m]);
  assert.equal(s.forgetSource(scope,`qq:${m.messageId}`),true);s.add(scope,[m]);
  assert.equal(s.memorySources(scope).length,0);assert.equal(s.messages(scope).length,1);assert.equal(JSON.parse(s.export(scope,'json').data).messages.length,1);
});

test('memory cannot update user goals, grant material permission, promote local feedback or revive later cancelled plan from backfill',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());s.setGoal(scope,'逐渐了解');s.saveRun(scope,{id:'r'});s.addFeedback(scope,{requestId:'r',text:'这次太长了'});
  let b=s.memoryBatch(scope);assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{goal:'hack'})).applied,false);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{items:[{kind:'preference',text:'永远喜欢短回复',sourceIds:b.sources.map(x=>x.id),explicitPreference:true}]})).applied,false);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b)).applied,true);assert.equal(s.getCompanion(scope).goal.text,'逐渐了解');
  const now=normalize(raw('72057594037927999',false,{msgTime:'1791926000',elements:[{textElement:{content:'周六看展取消了'}}]}),scope);s.add(scope,[now]);b=s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{items:[{kind:'commitment',text:now.text,sourceIds:[`qq:${now.messageId}`],topicKeys:['周六看展'],status:'cancelled'}]})).applied,true);
  const old=normalize(raw('72057594037927997',false,{msgTime:'1791726000',elements:[{textElement:{content:'周六一起看展'}}]}),scope);s.add(scope,[old]);b=s.memoryBatch(scope);
  const prior=b.priorMemory.items[0];assert.ok(prior);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{items:[{id:prior.id,kind:'commitment',text:old.text,sourceIds:[`qq:${old.messageId}`],topicKeys:['周六看展'],status:'active'}]})).applied,false);
  assert.equal(s.searchMemory(scope,'周六看展').items[0].status,'cancelled');
});

test('large source is durably reviewed in bounded contiguous segments without claiming premature complete coverage',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());turn(s,'历史内容'.repeat(1500)+'最后取消了之前的计划');
  let total=0,end=0,parts=0;
  while(s.memoryStatus(scope).pending) {
    const b=s.memoryBatch(scope,{maxBytes:4000});assert.ok(b);assert.ok(Buffer.byteLength(JSON.stringify(b),'utf8')<=b.maxBytes);
    const source=b.sources[0];assert.equal(b.events[0].offset,end);end=b.events[0].end;total=source.segment?.total||source.text.length;
    assert.equal(s.applyMemoryBatch(scope,b,receipt(b)).applied,true);parts++;
    if(end<total)assert.equal(s.memoryStatus(scope).processed,0);
    assert.ok(parts<40);
  }
  assert.ok(parts>1);assert.equal(end,total);assert.equal(s.memoryStatus(scope).processed,1);
});

test('natural extracted notes and goals cannot retain a deleted or corrected source, including undo receipts',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=turn(s,'我要保留这段私人背景');const id=`private:${u.id}`;
  s.saveNote(scope,{text:'这段私人背景',use:'discussion',evidenceSourceIds:[id]});s.setGoal(scope,'这个私人目标',{evidenceSourceIds:[id]});
  s.recordActionReceipt(scope,{id:'undo',undo:{previous:{text:'这段私人背景'}}});s.savePendingAction(scope,{text:'这段私人背景'});
  s.updateTurn(scope,u.id,'纠正后的不同背景');
  assert.equal(s.getCompanion(scope).notes.length,0);assert.equal(s.getCompanion(scope).goal.text,'');
  assert.equal(s.getCompanion(scope).actionReceipts.length,0);assert.equal(s.getCompanion(scope).pendingActions.length,0);
  assert.equal(s.searchMemory(scope,'私人背景').sources.some(source=>source.text.includes('这段私人背景')),false);
});

test('control messages containing forgotten quotations remain in visible history but not memory authority',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const a=turn(s,'秘密A');const cmd=turn(s,'忘掉秘密A');
  s.markTurnControl(scope,cmd.id);s.forgetSource(scope,`private:${a.id}`);
  assert.equal(s.memorySources(scope).length,0);assert.equal(s.getCompanion(scope).turns[0].text,'忘掉秘密A');
  assert.equal(s._sourceIds(scope).has(`private:${cmd.id}`),false);
});

test('topic-free cancellation receives preceding reviewed exchange and can retire its commitment with exact source provenance',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const invite=turn(s,'周六一起看敦煌展览');let b=s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{items:[{kind:'commitment',text:'用户提出周六看展，尚未确认',sourceIds:[`private:${invite.id}`],topicKeys:['敦煌展览'],status:'active'}]})).applied,true);
  const cancel=turn(s,'算了，这次不去了。');b=s.memoryBatch(scope);assert.ok(b.contextSources.some(x=>x.id===`private:${invite.id}`));
  const prior=b.priorMemory.items.find(x=>x.kind==='commitment');assert.ok(prior);
  assert.equal(s.applyMemoryBatch(scope,b,receipt(b,{retire:[{id:prior.id,sourceIds:[`private:${cancel.id}`],status:'cancelled'}]})).applied,true);
  const found=s.searchMemory(scope,'敦煌展览');assert.equal(found.items[0].status,'cancelled');assert.ok(found.sources.some(x=>x.id===`private:${cancel.id}`));
});

test('bounded batches and unfinished segment cursors survive restart without re-reviewing completed prefixes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-resume-')),file=path.join(dir,'m.db');let s=new Store(file);
  t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});turn(s,'非常长的历史原文'.repeat(600));
  const batch=s.memoryBatch(scope,{maxBytes:4000});assert.equal(s.applyMemoryBatch(scope,batch,receipt(batch)).applied,true);const end=batch.events[0].end;
  s.close();s=new Store(file);const next=s.memoryBatch(scope,{maxBytes:4000});assert.equal(next.events[0].offset,end);assert.equal(s.memoryStatus(scope).processed,0);
  assert.equal(s.applyMemoryBatch(scope,{...next,scopeKey:'other'},receipt(next)).reason,'wrong_scope');assert.equal(s.memoryStatus(scope).processed,0);
});

test('failure in a QQ source batch rolls back its source journal as well as original messages',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());s.add(scope,[normalize(raw(),scope)]);const before=s.memoryStatus(scope);
  const later=normalize(raw('72057594037927988'),scope);
  assert.throws(()=>s.add(scope,[later,{...later,kind:'draft'}]),/provenance/);
  assert.equal(s.memoryStatus(scope).pending,before.pending);assert.equal(s.memorySources(scope).some(x=>x.id===`qq:${later.messageId}`),false);
});

test('numeric QQ IDs are rejected before precision loss can become a durable source identity',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const message=normalize(raw(),scope);
  assert.throws(()=>s.add(scope,[{...message,messageId:Number(message.messageId)}]),/must remain a string/);
  assert.equal(s.memoryStatus(scope).pending,0);assert.deepEqual(s.messages(scope),[]);
});

test('changing the user goal resets current plans but preserves private dialogue and feedback history',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=turn(s,'希望先多了解彼此');
  s.saveRun(scope,{id:'run',requestId:'request'});s.appendTurn(scope,{role:'assistant',kind:'discussion',text:'可以先聊聊共同兴趣',requestId:'request',actionReceipts:[{id:'r',status:'applied'}]});
  s.addFeedback(scope,{requestId:'request',text:'这次很有帮助'});const record=s.getCompanion(scope);
  s.applyState(scope,{focus:'旧目标下的计划',openThreads:[{text:'待讨论的选择',sourceIds:[`private:${u.id}`]}]},{baseRevision:record.revision,sourceIds:[`private:${u.id}`],coverage:{complete:false,sourceIds:[`private:${u.id}`]}});
  s.setGoal(scope,'希望更自然地相互了解');const after=s.getCompanion(scope);
  assert.equal(after.turns.length,2);assert.equal(after.feedback.length,1);assert.equal(after.runs.length,0);assert.equal(after.state.focus,'');assert.deepEqual(after.state.openThreads,[]);
  assert.equal(after.turns[1].actionReceipts[0].id,'r');assert.ok(after.revision>record.revision);
});
