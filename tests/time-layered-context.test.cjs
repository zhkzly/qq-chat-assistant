'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {loadRuntime}=require('../scripts/goal-help-quality-check.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const ROOT=path.resolve(__dirname,'..'),NOW=Date.parse('2026-10-16T01:00:00.000Z'),HOUR=3600000;
function atRuntime(stamp){return loadRuntime(ROOT,new Date(stamp).toISOString());}
function addPrivate(store,hours,text,extra={}){
  return atRuntime(NOW-hours*HOUR).Store.prototype.appendTurn.call(store,scope,{role:'user',kind:'discussion',text,...extra});
}
function actual(id,stamp,text,own=false){return normalize(raw(String(id),own,{msgTime:String(Math.floor(stamp/1000)),elements:[{elementType:1,textElement:{content:text}}]}),scope);}
function fixture(t){
  const store=new (atRuntime(NOW).Store)(':memory:');t.after(()=>store.close());
  store.setGoal(scope,'希望真实地相互了解，发展双方愿意的关系。');
  const turn={id:'synthetic-time-observation',role:'user',kind:'reply',transient:true,text:'结合当前实际QQ给合适的回复建议。'};
  const args=()=>({scope,records:store.messages(scope),availableSources:store.memorySources(scope),companion:store.getCompanion(scope),turn,
    purpose:'reply',generationOrigin:'qq_observation',invocation:{origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply'},
    coverage:{status:'partial'},requestId:'synthetic-time-layers',asOf:new Date(NOW).toISOString(),viewerTimeZone:'Asia/Shanghai',byteBudget:48000});
  return {store,args};
}

test('72-hour candidates exceed a turn quota while immediate exchange keeps its time boundary',t=>{
  const {store,args}=fixture(t),records=[];
  for(let i=0;i<40;i++){
    const stamp=i<20?NOW-48*HOUR+i*60000:i<38?NOW-4*HOUR+(i-20)*60000:NOW-120000+(i-38)*60000;
    records.push(actual(81000+i,stamp,`WITHIN_72H_ACTUAL_${i}：一条完整的虚构日常交流。`,i%2===0));
  }
  store.add(scope,records);
  const privateTurn=addPrivate(store,54,'WITHIN_72H_USER：前天商量的意思是先回应具体分享，不要把每句话都写成采访。');
  const prepared=buildContext(args()),selected=prepared.payload.sources.filter(source=>source.type==='qq');
  assert.equal(selected.length,40,'all complete short episodes fit the unchanged request budget; a fixed 24-message quota is insufficient');
  assert.ok(prepared.payload.sources.some(source=>source.id===`private:${privateTurn.id}`),'54-hour-old proactive consultation is a default candidate');
  assert.deepEqual(prepared.payload.taskContext.recentExchange.map(source=>source.sourceId),['qq:81038','qq:81039']);
  assert.equal(prepared.payload.taskContext.latestActual.sourceId,'qq:81039');
  assert.equal(prepared.payload.taskContext.consultationTask.focus[0].laterAvailableMessageCount,0);
  assert.equal(store.messages(scope).length,40);
});

test('advancing asOf moves a 72-hour boundary without dropping confirmed old expression preferences',t=>{
  const {store,args}=fixture(t);
  store.add(scope,[actual(82001,NOW-(72*60-1)*60000,'BOUNDARY_BACKGROUND：那次展览的安排已经结束。'),actual(82002,NOW-60000,'今天终于忙完了')]);
  const declaration=addPrivate(store,20*24,'以后给我的参考回复优先用短句，不用表情。PRIVATE_REASON_DO_NOT_SEND');
  const note=atRuntime(NOW-20*24*HOUR).Store.prototype.saveNote.call(store,scope,{kind:'preference',use:'discussion',
    text:'以后给我的参考回复优先用短句，不用表情。',evidenceSourceIds:[`private:${declaration.id}`]});
  const originalArgs=args(),before=buildContext(originalArgs),afterArgs={...args(),asOf:new Date(NOW+120000).toISOString()},after=buildContext(afterArgs);
  assert.ok(before.payload.sources.some(source=>source.id==='qq:82001'));
  assert.ok(!after.payload.sources.some(source=>source.id==='qq:82001'),'an unchanged record becomes deferred after the time window passes');
  assert.ok(after.payload.deferredContext.lookupAvailable);assert.ok(after.payload.deferredContext.qqSourceCount>=1);
  assert.ok(after.payload.preferences.some(preference=>preference.sourceId===`note:${note.id}`));
  const plan=withCurrentDraftControls({intent:'reply',quotes:[]},after.payload),draft=buildDraftContext(after,plan,afterArgs);
  assert.ok(draft.payload.wordingControls.items.some(control=>control.sourceIds.includes(`note:${note.id}`)));
  assert.equal(JSON.stringify(draft.payload).includes('PRIVATE_REASON_DO_NOT_SEND'),false);
  assert.equal(after.payload.taskContext.consultationTask.focus[0].laterAvailableMessageCount,0);
  assert.equal(store.messages(scope).length,2,'time-based selection never deletes original history');
});

test('automatic analysis volume cannot replace proactive consultation and withdrawn preference evidence',t=>{
  const {store,args}=fixture(t);store.add(scope,[actual(83001,NOW-60000,'我刚给窗台的小苗浇完水')]);
  const declaration=addPrivate(store,20*24,'以后回复优先短句，不用表情。');
  const note=atRuntime(NOW-20*24*HOUR).Store.prototype.saveNote.call(store,scope,{kind:'preference',use:'discussion',text:declaration.text,evidenceSourceIds:[`private:${declaration.id}`]});
  const consultation=addPrivate(store,54,'PROACTIVE_CONSULTATION：前天和你商量过，我想通过真实的日常分享慢慢了解她。');
  for(let i=0;i<50;i++)atRuntime(NOW).Store.prototype.appendTurn.call(store,scope,{role:'assistant',kind:'discussion',origin:'automatic',text:`AUTOMATIC_ANALYSIS_NO_AUTHORITY_${i} `.repeat(35)});
  const before=buildContext(args());
  assert.ok(before.payload.sources.some(source=>source.id===`private:${consultation.id}`));
  assert.equal(JSON.stringify(before.payload).includes('AUTOMATIC_ANALYSIS_NO_AUTHORITY_'),false);
  assert.ok(before.payload.preferences.some(preference=>preference.sourceId===`note:${note.id}`));
  store.deleteTurn(scope,declaration.id);
  const after=buildContext(args());
  assert.ok(!after.payload.preferences.some(preference=>preference.sourceId===`note:${note.id}`),'withdrawn evidence cannot stay authoritative in the permanent core');
  assert.ok(!after.payload.sources.some(source=>source.id===`private:${declaration.id}`));
  assert.ok(after.payload.sources.some(source=>source.id===`private:${consultation.id}`));
  assert.equal(store.messages(scope).length,1);
});
