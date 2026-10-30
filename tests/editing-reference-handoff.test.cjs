'use strict';
// Synthetic transport integration: edits are derived from the actual wording
// payload. These checks establish handoff and lifecycle, not language quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('./fixtures/assistant-protocol.cjs'),{Store}=require('../src/store.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {parseAssistant,prepareAssistantRequest}=require('./fixtures/assistant-protocol.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
function fixture(t,{select=true,intercept=async()=>{}}={}){
 const store=new Store(':memory:'),calls=[];
 const settings={auto:false,anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-editing-reference',discussionCompactionEnabled:false,
  realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-editing-reference'}};
 const controller=new Controller({store,settings,read:async()=>{throw Error('No native QQ read in this fixture');},assistantModel:async(_,input)=>{
  const p=input.payload;calls.push(structuredClone(p));await intercept(p);
  if(p.purpose==='draft'){
   const text=p.editingReference?p.editingReference.text.replace(/^(听起来|原来)/,''):`听起来${p.sources.find(source=>source.type==='qq').text}`;
   return {kind:'draft',text:'合成原句的有界改写。',suggestions:[{style:'自然',text},...(!p.editingReference?[{style:'另一种',text:text.replace(/^听起来/,'原来')}]:[])]};
  }
  const request=p.sources.find(source=>source.id===p.intentAuthority.sourceId)?.text||p.userRequest.text;
  const chosen=select&&/改|原句/.test(request)&&!/换话题|新问题|先不改/.test(request)?p.editingReferences?.[0]:undefined;
  return {kind:'discussion',text:'根据本轮意思处理表达。',draftPlan:withCurrentDraftControls({quotes:[],intent:'reply',...(chosen?{editingReference:{choice:chosen.choice}}:{})},p,
   {objective:'接住当前QQ分享',allowedApproach:chosen?'从选定原句去掉开头的听起来或原来，保持其余有依据内容':'自然接住当前QQ分享'})};
 }});
 controller.scope={...scope};controller.ingest(scope,[raw('58001',false,{elements:[{textElement:{content:'这盆薄荷终于冒新叶了。'}}]})]);
 t.after(()=>{controller.close();store.close();});return {controller,store,calls};
}
async function publish(controller,store){await controller.suggest({automatic:true});return store.getCompanion(scope).turns.find(turn=>turn.id===controller.currentAdvice().turnId);}
function contextFor(store,previous,{currentCandidateRef,feedback,byteBudget=48000,settings={}}={}){
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'从原句改，删去开头的听起来。'});
 return {scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',requestId:'synthetic-editing',store,byteBudget,settings,
  ...(currentCandidateRef?{currentCandidateRef}:{}),...(feedback?{feedbackTargets:[store.experiences.hydrateFeedback(scope,feedback.id)],intentSourceId:feedback.sourceId}: {})};
}
test('real Controller delivers the selected complete prior draft into wording and the edit derives from that input',async t=>{
 const {controller,store,calls}=fixture(t);const prior=await publish(controller,store);
 const original=prior.suggestions[0].text;assert.match(original,/^听起来/);
 const reply=await controller.assist({text:'从原句改，删去开头的听起来，其他不必改。'});
 const planning=calls.at(-2),wording=calls.at(-1);
 assert.equal(planning.editingReferences[0].selection,'offered_current_candidate');
 assert.equal(wording.editingReference.text,original);assert.deepEqual(wording.editingReference.artifactRef,prior.suggestions[0].artifactRef);
 assert.match(wording.editingReference.instruction,/FALLIBLE EDITING REFERENCE/);assert.match(wording.editingReference.authority,/not_facts_or_sharing_permission/);
 assert.equal(reply.suggestions[0].text,wording.editingReference.text.replace(/^听起来/,''));
 assert.equal(wording.sources.some(source=>source.id===`private:${prior.id}`),false);assert.deepEqual(wording.outboundQuotes,[]);
 const artifact=store.experiences.artifact(scope,reply.suggestions[0].artifactRef);
 assert.deepEqual(artifact.inputArtifactRefs.map(item=>item.artifactRef),[prior.suggestions[0].artifactRef]);
 const run=store.getCompanion(scope).runs.find(item=>item.replyId===reply.id);assert.equal(run.manifest.inputArtifactRefs[0].bodyDigest,wording.editingReference.bodyDigest);
 assert.match(run.manifest.candidateSession.validatedPlanDigest,/^[a-f0-9]{64}$/);
});
test('offered implicit handle requires explicit planning selection, and a changed request does not silently edit',async t=>{
 for(const select of [false,true]){
  const {controller,calls}=fixture(t,{select});await controller.suggest({automatic:true});
  await controller.assist({text:select?'换话题，这是新问题，接她刚才的薄荷分享。':'从原句改，删去开头的听起来。'});
  assert.ok(calls.at(-2).editingReferences?.length,'current reference is merely offered');
  assert.equal(calls.at(-1).editingReference,undefined);
 }
});
test('canonical explicit second-suggestion feedback selects that exact leaf; response and action option never coerce to suggestion zero',async t=>{
 const {controller,store,calls}=fixture(t);const prior=await publish(controller,store);
 const selected=prior.suggestions[1];
 let result=await controller.continueFeedback({taskId:'explicit-second-leaf',clientEventId:'explicit-second-leaf',requestId:prior.requestId,
  targetRef:{kind:'artifact',artifactRef:selected.artifactRef},text:'从选中的原句改，删去开头的原来。'});
 assert.equal(result.feedbackContinuation.status,'complete');assert.equal(calls.at(-1).editingReference.text,selected.text);
 assert.equal(calls.at(-1).editingReference.suggestionIndex,1);assert.equal(calls.at(-2).editingReferences[0].selection,'explicit_feedback_target');
 assert.equal(calls.at(-1).editingReference.text.includes(prior.suggestions[0].text),false);
 const optionTurn=store.appendTurn(scope,{role:'assistant',kind:'discussion',origin:'user',text:'PRIVATE_EXPLANATION_SENTINEL',
  expressionOptions:[{label:'ACTION_OPTION_SENTINEL',quotes:[]}],suggestions:[{style:'自然',text:'NOT_AN_IMPLIED_LEAF'}]});
 for(const [i,artifactRef]of [optionTurn.artifactRef,optionTurn.expressionOptions[0].artifactRef].entries()){
  result=await controller.continueFeedback({taskId:`non-leaf-${i}`,clientEventId:`non-leaf-${i}`,targetRef:{kind:'artifact',artifactRef},text:'从选中的原句改短一点。'});
  assert.equal(result.feedbackContinuation.status,'complete');assert.equal(calls.at(-1).editingReference,undefined);assert.equal(calls.at(-2).editingReferences,undefined);
  assert.equal(JSON.stringify(calls.at(-1)).includes('NOT_AN_IMPLIED_LEAF'),false);
 }
});
test('an observed reply reference offers each outgoing leaf and explicit plan chooses the actual second sentence',async t=>{
 const {controller,store,calls}=fixture(t);const prior=await publish(controller,store),reference=prior.suggestions[1].artifactRef;
 const model=controller.assistantModel;
 controller.assistantModel=async(settings,input,signal)=>{
  const output=await model(settings,input,signal);
  if(input.payload.purpose!=='draft'&&input.payload.editingReferences?.length>1)output.draftPlan.editingReference=reference;
  return output;
 };
 const reply=await controller.assist({text:'从上一轮实际给我的原句改，去掉开头。',sourceTurnIds:[prior.id]});
 assert.equal(calls.at(-2).editingReferences.length,2);assert.equal(calls.at(-1).editingReference.suggestionIndex,1);
 assert.equal(calls.at(-1).editingReference.text,prior.suggestions[1].text);assert.equal(reply.suggestions[0].text,prior.suggestions[1].text.replace(/^原来/,''));
});
test('an explicit bound leaf can be offered during feedback without forcing editing for unrelated new content',async t=>{
 const {controller,store,calls}=fixture(t);const prior=await publish(controller,store);
 const result=await controller.continueFeedback({taskId:'feedback-new-request',clientEventId:'feedback-new-request',targetRef:{kind:'artifact',artifactRef:prior.suggestions[1].artifactRef},text:'先不改原句，换话题，这是新问题。'});
 assert.equal(result.feedbackContinuation.status,'complete');assert.ok(calls.at(-2).editingReferences);assert.equal(calls.at(-1).editingReference,undefined);
});
test('parser and result schema preserve only an offered handle and program-owned text',t=>{
 const {store}=fixture(t),prior=store.appendTurn(scope,{role:'assistant',kind:'draft',text:'Private explanation.',suggestions:[{style:'自然',text:'听起来薄荷长新叶了。'}]});
 const args=contextFor(store,prior,{currentCandidateRef:{turnId:prior.id,suggestionIndex:0,artifactRef:prior.suggestions[0].artifactRef}}),prepared=buildContext(args),offered=prepared.payload.editingReferences[0];
 const plan=withCurrentDraftControls({quotes:[],intent:'reply',editingReference:{choice:offered.choice}},prepared.payload);
 const parsed=parseAssistant({kind:'discussion',text:'改这句。',draftPlan:plan},'discussion',prepared);assert.deepEqual(parsed.draftPlan.editingReference,prior.suggestions[0].artifactRef);
 const schema=prepareAssistantRequest({model:'claude-sonnet-4-6'},prepared.payload).request.tools[0].function.parameters;
 assert.equal(schema.properties.draftPlan.properties.editingReference.properties.choice.type,'string');assert.equal(schema.properties.draftPlan.properties.editingReference.oneOf,undefined);
 for(const invalid of [{...prior.suggestions[0].artifactRef,text:'MODEL_REPLACEMENT'},prior.artifactRef,{...prior.suggestions[0].artifactRef,version:99},{choice:'e99'}])
  assert.throws(()=>parseAssistant({kind:'discussion',text:'改这句。',draftPlan:{...plan,editingReference:invalid}},'discussion',prepared),/editingReference/);
});
test('editing reference never becomes fact or permission and current corrections and withdrawals still win',t=>{
 const {store}=fixture(t),u=store.appendTurn(scope,{role:'user',kind:'discussion',text:'私下说，我昨天养过薄荷。此事不分享。'});
 const prior=store.appendTurn(scope,{role:'assistant',kind:'draft',text:'An erroneous generated sentence.',suggestions:[{style:'自然',text:'我昨天养过薄荷。'}]});
 const args=contextFor(store,prior,{currentCandidateRef:{turnId:prior.id,suggestionIndex:0,artifactRef:prior.suggestions[0].artifactRef}}),prepared=buildContext(args),plan=withCurrentDraftControls({intent:'reply',quotes:[],editingReference:prior.suggestions[0].artifactRef},prepared.payload,{avoidances:['删去没有事实依据的自述，不披露私下理由']});
 const draft=buildDraftContext(prepared,plan,args);assert.equal(draft.payload.editingReference.text,prior.suggestions[0].text);assert.deepEqual(draft.payload.outboundQuotes,[]);
 assert.equal(draft.payload.sources.some(source=>source.id===`private:${u.id}`),false);assert.match(draft.payload.draftingGuidance.avoidances[0].text,/删去/);
 assert.throws(()=>buildDraftContext(prepared,{...plan,quotes:[{sourceId:`private:${prior.id}`,text:prior.suggestions[0].text}]},args),/拟表达内容未能对应/);
 assert.throws(()=>buildDraftContext(prepared,{...plan,quotes:[{sourceId:`private:${u.id}`,text:'我昨天养过薄荷'}]},args),/authorization|拟表达内容未能对应/);
 const linked=store.appendTurn(scope,{role:'assistant',kind:'draft',text:'Prior output.',sourceIds:[`private:${u.id}`],suggestions:[{style:'自然',text:'听起来薄荷不错。'}]});
 const linkedArgs=contextFor(store,linked,{currentCandidateRef:{turnId:linked.id,suggestionIndex:0,artifactRef:linked.suggestions[0].artifactRef}}),linkedContext=buildContext(linkedArgs),linkedPlan=withCurrentDraftControls({quotes:[],intent:'reply',editingReference:linked.suggestions[0].artifactRef},linkedContext.payload);
 store.updateTurn(scope,u.id,'更正：昨天没养薄荷，也不愿分享这件事。');
 assert.throws(()=>buildDraftContext(linkedContext,linkedPlan,linkedArgs),/artifact changed|unavailable/);
});
test('whole original sentence survives request rebuilding; byte pressure fails explicitly instead of truncating it',t=>{
 const {store}=fixture(t),body='整句'+ '薄荷'.repeat(560)+'结尾标记';
 const prior=store.appendTurn(scope,{role:'assistant',kind:'draft',text:'Prior output.',suggestions:[{style:'自然',text:body}]});
 const args=contextFor(store,prior,{currentCandidateRef:{turnId:prior.id,suggestionIndex:0,artifactRef:prior.suggestions[0].artifactRef}}),prepared=buildContext(args),plan=withCurrentDraftControls({quotes:[],intent:'reply',editingReference:prior.suggestions[0].artifactRef},prepared.payload),draft=buildDraftContext(prepared,plan,args);
 assert.equal(draft.payload.editingReference.text,body);assert.equal(draft.rebuildForRequest(()=>0).payload.editingReference.text,body);
 assert.throws(()=>buildDraftContext(prepared,plan,{...args,requestMeasure:payload=>payload?.editingReference?1000000:0}),/预算|截断/);
 store.experiences.invalidateArtifacts(scope,[prior.suggestions[0].artifactRef]);assert.throws(()=>draft.rebuildForRequest(()=>0),/artifact changed|unavailable/);
 assert.throws(()=>prepared.rebuildForRequest(()=>0),/artifact changed|unavailable/);
});
test('redaction and body mutation during actual wording return invalidate result before publication',async t=>{
 for(const mode of ['redact','body']){
  let store,prior,paused,release;
  const wait=new Promise(resolve=>{paused=resolve;});
  const app=fixture(t,{intercept:async p=>{if(p.editingReference){paused();await new Promise(resolve=>{release=resolve;});}}});store=app.store;prior=await publish(app.controller,store);
  const pending=app.controller.assist({text:'从原句改，删去开头的听起来。'});await wait;
  if(mode==='redact')store.experiences.invalidateArtifacts(scope,[prior.suggestions[0].artifactRef]);
  else {const artifact=store.experiences.artifact(scope,prior.suggestions[0].artifactRef);artifact.body='TAMPERED_LEAF_BODY';store.experiences._put(scope,'artifact',`${artifact.ref.artifactId}@${artifact.ref.version}`,artifact);}
  release();await assert.rejects(pending,/artifact changed|unavailable/);assert.equal(app.controller.currentAdvice(),null);
  assert.equal(store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);
 }
});
test('artifact invalidation in the atomic publication window is rejected by persistence',async t=>{
 const {controller,store}=fixture(t);const prior=await publish(controller,store),append=store.appendTurn.bind(store);let injected=false;
 store.appendTurn=(boundScope,turn)=>{if(turn.role==='assistant'&&turn.artifactMetadata?.inputArtifactRefs?.length&&!injected){injected=true;store.experiences.invalidateArtifacts(boundScope,[prior.suggestions[0].artifactRef]);}return append(boundScope,turn);};
 await assert.rejects(controller.assist({text:'从原句改，删去开头的听起来。'}),/artifact changed|unavailable/);
 assert.equal(injected,true);assert.equal(controller.currentAdvice(),null);assert.equal(store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);
});
