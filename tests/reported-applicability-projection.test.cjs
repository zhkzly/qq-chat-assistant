'use strict';
// Functional read-view fixtures copied from the retained actual-model replay.
// These checks do not establish conversation quality or desktop integration.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {personUnderstanding,relationshipView}=require('../src/relationship-store.cjs');
const fixture=require('./fixtures/reported-applicability-baseline.json');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {buildContext}=require('../src/assistant-context.cjs');
const clone=value=>structuredClone(value);
function projection(t,scene=fixture.scenes[0]){
 const store=new Store(':memory:');t.after(()=>store.close());
 const data=clone(scene);
 // Only the read boundary is controlled; production grouping and source
 // revision admission are exercised unchanged on actual persisted shapes.
 store._rawMemorySources=()=>data.sources;
 store._memoryRecords=()=>data.records;
 store.correctionOverlays=()=>[];
 return {store,data,view:()=>personUnderstanding(store,data.scope,{asOf:data.as_of}),raw:()=>relationshipView(store,data.scope,{asOf:data.as_of})};
}

test('a fully read dated report with unspecified duration does not imply uncertain content or a stable fact',t=>{
 assert.equal(fixture.provenance.evidence,'actual_selected_model_fictional_stream');
 for(const scene of fixture.scenes){
  const {view,data}=projection(t,scene),before=clone(data),result=view();
  assert.ok(data.records.length>0);
  for(const record of data.records){
   assert.equal(record.assertionKind,'stated');assert.equal(record.epistemicStatus,'supported');assert.equal(record.reviewComplete,true);
   const projected=result.contact.recentCircumstances.find(item=>item.id===record.id);
   assert.ok(projected,`actual reported claim ${record.id} remains a dated circumstance`);
   assert.equal(projected.applicability,'unspecified');assert.equal(projected.applicabilityKind,'unspecified');
   assert.equal(projected.firstEvidenceAt,record.firstEvidenceAt);assert.equal(projected.lastEvidenceAt,record.lastEvidenceAt);
   assert.equal(projected.reportedAt,record.reportedAt);assert.equal(projected.reviewedAt,record.reviewedAt);
   assert.equal(projected.validFrom,record.validFrom);assert.equal(projected.validUntil,undefined);
   assert.equal(result.contact.uncertainties.some(item=>item.id===record.id),false);
   assert.equal(result.contact.knownFacts.some(item=>item.id===record.id),false,'unknown duration is not a stable biography');
  }
  assert.deepEqual(data,before,'read projection cannot mutate persisted understanding');
 }
});

test('epistemic and review uncertainty stays separate from a known original report',t=>{
 for(const variant of [
  {epistemicStatus:'tentative'},
  {epistemicStatus:'contested'},
  {epistemicStatus:'undetermined'},
  {assertionKind:'inferred',epistemicStatus:'tentative',attribution:'hypothesis'},
  {assertionKind:'reported',epistemicStatus:'supported',attribution:'hypothesis'},
  {reviewComplete:false}
 ]){
  const {view,data}=projection(t);Object.assign(data.records[0],variant);
  const result=view();assert.equal(result.contact.uncertainties[0].id,data.records[0].id);
  assert.equal(result.contact.recentCircumstances.length,0);assert.equal(result.contact.knownFacts.length,0);
 }
});

test('expired and not-yet-valid reports keep their applicability guard instead of becoming current',t=>{
 for(const [dates,applicability]of [[{validUntil:'2026-08-31T00:00:00Z'},'expired'],[{validFrom:'2026-09-02T00:00:00Z'},'not_yet_valid']]){
  const {view,data}=projection(t);Object.assign(data.records[0],dates);const result=view(),item=result.contact.uncertainties[0];
  assert.equal(item.id,data.records[0].id);assert.equal(item.applicability,applicability);
  assert.equal(result.contact.knownFacts.length,0);assert.equal(result.contact.recentCircumstances.length,0);
 }
});

test('withdrawn or revised original support cannot reappear as a known report',t=>{
 for(const operation of ['withdraw','revise']){
  const {view,data}=projection(t);const id=data.records[0].sourceIds[0];
  if(operation==='withdraw')data.sources=data.sources.filter(source=>source.id!==id);
  else data.sources.find(source=>source.id===id).revision='new-original-revision';
  const result=view();for(const subject of ['self','contact','dyad'])for(const entries of Object.values(result[subject]))assert.equal(entries.length,0);
 }
});

test('supported reported circumstances remain bound to the recorded holder',t=>{
 for(const subject of ['self','contact','dyad']){
  const {view,data}=projection(t);data.records[0].subject=subject;
  const result=view();assert.equal(result[subject].recentCircumstances[0].subject,subject);
  for(const other of ['self','contact','dyad'].filter(value=>value!==subject))assert.equal(Object.values(result[other]).flat().length,0);
 }
});

test('an unspecified-duration boundary or arrangement remains a dated report rather than an active standing control',t=>{
 for(const aspect of ['boundary','coordination']){
  const {view,data}=projection(t);data.records[0].aspect=aspect;const result=view();
  assert.equal(result.contact.recentCircumstances[0]?.id,data.records[0].id);
  assert.equal(result.contact.boundaries.length,0);assert.equal(result.contact.knownFacts.length,0);
  assert.equal(result.contact.recentCircumstances[0].applicability,'unspecified');
 }
});

test('planning context keeps the original applicability and evidence clocks with the corrected read category',t=>{
 const {store,data,view,raw}=projection(t);
 t.mock.timers.enable({apis:['Date'],now:Date.parse(data.as_of)});
 const turn=store.appendTurn(data.scope,{role:'user',kind:'discussion',text:'她明确提到跑步，我目前可以可靠知道什么？'});
 const current=store._deriveSources(data.scope).find(source=>source.id===`private:${turn.id}`);assert.ok(current);data.sources.push(current);
 const records=data.sources.filter(source=>source.type==='qq').map(source=>({kind:'actual',...data.scope,messageId:source.messageId,text:source.text,direction:source.direction,timestamp:Date.parse(source.at),sequence:source.sequence}));
 const context=buildContext({scope:data.scope,records,companion:store.getCompanion(data.scope),turn,purpose:'discussion',requestId:'reported-context-functional',
  asOf:data.as_of,coverage:{status:'partial'},availableSources:data.sources,relationshipContext:{...raw(),understanding:view()},settings:{model:'synthetic-functional'}});
 const actual=context.payload.relationshipContext.claims.find(item=>item.id===data.records[0].id);
 assert.ok(actual,'the actual supported report is delivered to planning');
 assert.equal(actual.readCategory,'recentCircumstances');assert.equal(actual.applicability,'unspecified');
 assert.equal(actual.applicabilityKind,'unspecified');assert.equal(actual.epistemicStatus,'supported');
 assert.equal(actual.firstEvidenceAt,data.records[0].firstEvidenceAt);assert.equal(actual.lastEvidenceAt,data.records[0].lastEvidenceAt);
 assert.equal(actual.validUntil,undefined);assert.equal(context.payload.sources.find(source=>source.id===data.sources[0].id).at,data.sources[0].at);
});

test('actual UI distinguishes report certainty, unknown duration and source-evidence clocks',t=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.open=false;this.textContent='';}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}querySelectorAll(){return [];}}
 const flatten=element=>[element,...element.children.flatMap(flatten)],root=new Element('section');
 const {view,data}=projection(t);data.records[0].reviewedAt='2040-01-01T00:00:00.000Z';
 const context={state:{relationship:{understanding:view()}},scopeKey:'fixture-scope',historyEpoch:1,relationshipViewKey:null,$:()=>root,
  document:{createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment')},sourceDescription:id=>`原始来源：${id}`,
  paragraph:(text,className)=>Object.assign(new Element('p'),{textContent:text,className}),button:(text,action)=>Object.assign(new Element('button'),{textContent:text,action}),
  experienceAction(){throw Error('Read rendering must not write');},attachDiscussionContext(){throw Error('Read rendering must not write');}};
 vm.createContext(context);const app=fs.readFileSync(path.resolve(__dirname,'../ui/app.js'),'utf8'),start=app.indexOf('function renderRelationship(){'),end=app.indexOf('\nfunction openExperienceReview',start);
 vm.runInContext(app.slice(start,end),context);context.renderRelationship();
 const text=flatten(root).map(item=>item.textContent).join('\n');
 for(const expected of ['近期处境／有据报告','明确说过','适用情况：适用期限未确认，不代表当前仍适用','原始依据：',new Date(data.records[0].firstEvidenceAt).toLocaleString('zh-CN'),data.records[0].text])assert.ok(text.includes(expected),expected);
 assert.equal(text.includes('仍待核对的理解或适用情况'),false,'supported report is not presented as uncertain content');
 assert.equal(text.includes('2040'),false,'review time must not masquerade as report time');
 assert.equal(text.includes('有据的重复适用'),false,'unknown duration must not render as recurring');
});
