'use strict';
// Source-only review counterexamples executed through actual wire/Store/read
// consumers. Scripted decisions are not conversational/semantic quality scores.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{writeRelationshipRecords}=require('../src/relationship-store.cjs');
const {prepareMemoryRequest}=require('../src/memory-engine.cjs'),{RELATIONSHIP_PROTOCOL}=require('../src/assistant-model.cjs');
const {buildContext}=require('../src/assistant-context.cjs'),{reconcilePlanningViews}=require('../src/context/planning-view.cjs');
const capture=require('./fixtures/activity-uncertainty-039.json'),scope=capture.scope,copy=value=>structuredClone(value),settings={model:'gpt-6-luna',modelResponseMode:'result_tool'};
const wire=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content),noop=p=>({batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[]}});
function frame(t,store,text,at,id){t.mock.timers.setTime(Date.parse(at));store.appendTurn(scope,{id,role:'user',kind:'discussion',text});const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=wire(request),source=p.sources.find(source=>source.text===text);return {batch,request,p,source};}
function initial(t,{legacy=false}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse(capture.pre.asOf)});const store=new Store(':memory:');t.after(()=>store.close());store.add(scope,copy(capture.pre.messages));
  if(legacy){
    // Structural reason (D1 speaker-fingerprint cutover): the frozen capture
    // embeds old-formula source revisions. Re-key its live revision pointers
    // to the fingerprinted projection before writing the legacy row; the
    // gap/opaque-uncertainty semantics under test are unchanged.
    store.memorySources(scope);
    const live=new Map(store.memorySources(scope).map(source=>[source.id,source.revision]));
    const event=copy(capture.pre.event);
    const remap=value=>{
      if(Array.isArray(value))return value.map(remap);
      if(!value||typeof value!=='object')return value;
      const out={...value};
      for(const [key,child]of Object.entries(out)){
        if(/Revisions$/.test(key)&&child&&typeof child==='object'&&!Array.isArray(child)){
          const revised={};
          for(const [id,revision]of Object.entries(child))revised[id]=live.has(id)?live.get(id):revision;
          out[key]=revised;
        } else out[key]=remap(child);
      }
      if(typeof out.sourceId==='string'&&live.has(out.sourceId))out.revision=live.get(out.sourceId);
      return out;
    };
    writeRelationshipRecords(store,scope,[remap(event)]);
  }
 else{const b=store.memoryBatch(scope),r=prepareMemoryRequest(settings,b),p=wire(r),[invite,,cancel]=p.sources,e={activity:{ref:'NEW',definition:{sourceId:invite.id,quote:invite.text}},activityKey:'exhibit',eventKind:'cancellation',actor:'contact',text:cancel.text,sourceIds:[cancel.id],evidence:{statement:{sourceId:cancel.id,quote:cancel.text},time:{basis:'qq_statement'}}};assert.equal(store.applyMemoryBatch(scope,b,r.decode({...noop(p),relationshipPatch:{events:[e]}})).applied,true);}
 t.mock.timers.setTime(Date.parse(capture.recall.at));store.add(scope,capture.recall.messages.map(message=>({...copy(message),recalledAt:Date.now()})));store.memorySources(scope);return store;
}
function currentClaim(f,{activity={ref:f.p.activityContext.activities[0]?.ref},source=f.source}={}){return {subject:'dyad',aspect:'coordination',text:'A current accepted-state statement with its original as-of time.',assertionKind:source.type==='qq'?'stated':'reported',epistemicStatus:'supported',applicabilityKind:'temporary',attribution:source.type==='qq'?'speaker':'user_report',sourceIds:[source.id],activity,currentState:{status:'accepted',statement:{sourceId:source.id,quote:source.text}}};}
function apply(store,f,patch){const result=store.applyMemoryBatch(scope,f.batch,f.request.decode({...noop(f.p),relationshipPatch:patch}));assert.equal(result.applied,true,JSON.stringify(result));}
test('default canonical protocol interpolates enums, while native initial/correction never teach label identity',()=>{
 const frozen=require('./fixtures/activity-baseline-038.cjs')();assert.equal(RELATIONSHIP_PROTOCOL,frozen.relationshipProtocol);assert.equal(RELATIONSHIP_PROTOCOL.includes('${EVENT_KINDS'),false);
 const request=prepareMemoryRequest(settings,capture.batch),p=wire(request),error=Object.assign(Error('activity evidence missing'),{code:'invalid_activity_event',field:'relationshipPatch.events[0].activity'}),correction=request.correction(JSON.stringify(noop(p)),error);
 for(const body of [JSON.parse(request.serialized),JSON.parse(correction.serialized)]){const system=body.messages[0].content;assert.doesNotMatch(system,/activityKey is a short, stable label|use a new label for a genuinely new activity/);assert.match(system,/activityKey is display wording, never entity identity/);assert.match(system,/invitation\|acceptance\|decline\|reschedule\|cancellation\|occurred/);}
 assert.deepEqual(JSON.parse(JSON.parse(correction.serialized).messages[1].content).originalInput,p);
});
test('later undated contrary report qualifies an earlier current-state assertion without inventing event time',t=>{
 const store=initial(t),f=frame(t,store,'我们现在又约好了。','2026-10-07T11:18:00Z','current-accepted');apply(store,f,{claims:[currentClaim(f)]});assert.equal(store.relationshipView(scope).activities[0].status,'accepted');
 const next=frame(t,store,'后来又取消了，具体是哪一天我不记得了。','2026-10-08T11:18:00Z','later-undated-cancel'),event={activity:{ref:next.p.activityContext.activities[0].ref},activityKey:'exhibit',eventKind:'cancellation',actor:'unknown',text:next.source.text,sourceIds:[next.source.id],evidence:{statement:{sourceId:next.source.id,quote:next.source.text},time:{basis:'unknown'}}};apply(store,next,{events:[event]});
 const activity=store.relationshipView(scope).activities[0];assert.equal(activity.status,'needs_review');assert.equal(activity.currentReportedState,null);assert.equal(activity.priorCurrentReportedState.status,'accepted');assert.equal(store.relationshipView(scope).events[0].occurredAt,null);
});
test('a known older cancellation reported late does not override a later current-state assertion',t=>{
 const store=initial(t),f=frame(t,store,'我们现在又约好了。','2026-10-07T11:18:00Z','current-known-later');apply(store,f,{claims:[currentClaim(f)]});
 const next=frame(t,store,'补充：10月4日18:00那次取消过，我今天才告诉你。','2026-10-08T11:18:00Z','late-known-old-cancel'),event={activity:{ref:next.p.activityContext.activities[0].ref},activityKey:'exhibit',eventKind:'cancellation',actor:'unknown',text:next.source.text,sourceIds:[next.source.id],evidence:{statement:{sourceId:next.source.id,quote:next.source.text},time:{basis:'explicit',at:'2026-10-04T10:00:00Z',sourceId:next.source.id,quote:'10月4日18:00'}}};apply(store,next,{events:[event]});
 const activity=store.relationshipView(scope).activities[0];assert.equal(activity.status,'accepted');assert.equal(activity.currentReportedState.asOf,'2026-10-07T11:18:00.000Z');
});
test('old QQ acceptance cannot bypass a legacy opaque gap through NEW current-state claim mode',t=>{
 const store=initial(t,{legacy:true}),f=frame(t,store,'请核对这次安排。','2026-10-06T11:18:00Z','legacy-current-question'),all=[...f.p.sources,...f.p.contextSources],invite=all.find(source=>source.text===capture.pre.messages[0].text),accept=all.find(source=>source.text===capture.pre.messages[1].text);
 apply(store,f,{claims:[currentClaim(f,{activity:{ref:'NEW',definition:{sourceId:invite.id,quote:invite.text}},source:accept})]});let view=store.relationshipView(scope);assert.equal(view.activities[0].status,'needs_review');assert.equal(view.activityUncertainties.length,1);
 const fresh=frame(t,store,'我们现在又约好了。','2026-10-07T11:18:00Z','legacy-fresh-current');apply(store,fresh,{claims:[currentClaim(fresh)]});view=store.relationshipView(scope);assert.equal(view.activities[0].status,'accepted');assert.equal(view.activities[0].qualified,true);assert.equal(view.activityUncertainties.length,1,'fresh report does not recover the legacy activity identity or erase the opaque gap');
});
function currentContext(t){
 const store=initial(t),f=frame(t,store,'我们现在又约好了。','2026-10-07T11:18:00Z','context-current-report');apply(store,f,{claims:[currentClaim(f)]});const view=store.relationshipView(scope),definitionId=store._memoryRecords(scope).find(record=>record.currentActivityState).activityDefinition.sourceId,turn=store.getCompanion(scope).turns.find(turn=>turn.id==='context-current-report');
 const context=buildContext({scope,store,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',requestId:'activity-input-dependencies',coverage:{status:'complete'},availableSources:store.memorySources(scope),relationshipContext:view,asOf:turn.createdAt});return {store,context,view,definitionId};
}
test('late source eviction re-grounds activity label/report while preserving opaque historical uncertainty',t=>{
 const {context,definitionId}=currentContext(t),payload=copy(context.payload);assert.ok(payload.relationshipContext.activities[0].currentReportedState);assert.ok(payload.sources.some(source=>source.id===definitionId));
 payload.sources=payload.sources.filter(source=>source.id!==definitionId);reconcilePlanningViews(payload);const activity=payload.relationshipContext.activities[0];
 assert.equal(activity.activityKey,null);assert.equal(activity.definitionAvailable,false);assert.equal(activity.currentReportedState,null);assert.equal(activity.status,'needs_review');assert.equal(activity.historicalEvidenceGap,true);assert.equal(payload.relationshipContext.claims.some(claim=>claim.currentActivityState),false);
});
test('retained activity-derived content includes original identity dependencies and forget redacts its published artifact',t=>{
 const {store,context,view,definitionId}=currentContext(t),claim=view.claims.find(claim=>claim.currentActivityState);assert.ok(claim.sourceIds.includes(definitionId),'read provenance includes activity definition, not just the report source');assert.equal(context.manifest.sourceRevisions[definitionId],store.memorySources(scope).find(source=>source.id===definitionId).revision);
 const turn=store.appendTurn(scope,{role:'assistant',kind:'discussion',requestId:'published-activity-content',text:'The current report concerns the existing exhibition activity.',sourceIds:context.manifest.sourceIds,sourceRevisions:context.manifest.sourceRevisions});const artifact=store.experiences.artifact(scope,turn.artifactRef);assert.ok(artifact.sourceIds.includes(definitionId));assert.equal(artifact.availability,'active');
 assert.equal(store.forgetSource(scope,definitionId),true);assert.equal(store.experiences.artifact(scope,turn.artifactRef).availability,'redacted');assert.equal(store.experiences.artifact(scope,turn.artifactRef).body,'');
});
