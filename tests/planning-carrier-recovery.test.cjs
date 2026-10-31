'use strict';
const {withoutCurrentControl}=require('./fixtures/wording-lanes.cjs');
function admittedQuotes(quotes,canonicalQuotes,revisions){
 assert.equal(quotes.length,canonicalQuotes.length);
 return quotes.map((quote,index)=>{
  const canonical=canonicalQuotes[index],provenance=canonical.provenance,source=provenance?.source;
  assert.equal(provenance?.version,1);assert.equal(source.sourceId,canonical.sourceId);
  assert.equal(source.revision,revisions[canonical.sourceId]);assert.equal(typeof source.revision,'string');
  const origin=source.type==='note'?{speaker:source.role,noteEditedAt:source.recordedAt,
   originalRecords:provenance.roots.map(root=>root.type==='note'||root.timeMeaning==='note_edited'?{speaker:root.role,noteEditedAt:root.recordedAt}:{speaker:root.role,recordedAt:root.recordedAt}),
   originalRecordsStatus:provenance.metadataCompleteness==='roots_unknown'?'unknown':provenance.metadataCompleteness==='roots_summarized'?'partial':provenance.roots.length?'complete':'not_applicable'}
   :{speaker:source.role,recordedAt:source.recordedAt};
  assert.deepEqual(quote,{sourceId:canonical.sourceId,text:canonical.text,origin});
  return {sourceId:quote.sourceId,text:quote.text};
 });
}

const {canonicalSourceView}=require('./fixtures/source-wire.cjs');
const {withCurrentStatementAuthority}=require('./fixtures/current-statement-authority.cjs');
// Source-shaped fictional Controller/Store/model-transport handoffs. The fake
// responses prove delivered instructions and permissions, not model quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/assistant-protocol.cjs');
const {assistModel}=require('./fixtures/assistant-protocol.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const PRIOR='我想找个轻松幽默的说法，邀请她一起试这个双人拼图。因为PRIVATE_PRIOR_REASON我怕显得刻意。';
const CRITICISM='刚才那句“你是否愿意与我共同体验双人拼图项目？”太做作了，不像平时聊天。';
const NEW_MATERIAL='我周六下午有空';
const OBJECTIVE='邀请她一起试这个双人拼图。';
const APPROACH='保留轻松幽默，借各自计数的小玩笑自然邀请，不用正式项目口吻。';
const payloadFor=request=>{const content=request.messages[1].content;return JSON.parse(typeof content==='string'?content:content[0].text);};
const response=value=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})});

function fixture(t,mode){
 const store=new Store(':memory:'),requests=[];let priorId;
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-carrier-recovery',auto:false,assistantRequestLimit:3,
  realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-carrier-recovery'}};
 const controller=new Controller({store,settings,memoryModel:null,compactionModel:null,read:async()=>{throw Error('This regression cannot read native QQ');},
  assistantModel:(configured,context,signal)=>assistModel(configured,context,signal,async(_url,request)=>{
   const wire=JSON.parse(request.body),payload=payloadFor(wire);requests.push({wire,payload});
   if(payload.purpose==='fidelity_check')return response({checkRef:payload.checkRef,verdict:'allow',issues:[]});
   if(requests.length===1)return response({kind:'discussion',text:'保留你想邀请她的意思，换自然的说法。',answer:{suggestions:[{text:'还能分别计数，要不要一起拼，看看谁找到的边角多？'}]},draftPlan:{intent:'reply',quotes:[]}});
   if(payload.originalInput){
    const captured=context.extraRequests?.at(-1)?.payload?.originalInput||context.payload,manifest=context.extraRequests?.at(-1)?.manifest||context.manifest;
    const original=canonicalSourceView(payload.originalInput,manifest.sourceHandles,captured),currentId=original.userRequest.sourceId,ref=text=>({text,sourceIds:[priorId,currentId]});
    const quotes=mode==='unauthorized_old_quote'?[{sourceId:priorId,text:PRIOR}]:mode==='new_material'?[{sourceId:currentId,text:NEW_MATERIAL}]:[];
    const output={kind:'discussion',text:'保留邀请与幽默，只改掉做作的措辞。',answer:{suggestions:[{text:mode==='new_material'?'我周六下午有空，要不要一起拼，看看谁找到的边角多？':'还能分别计数，要不要一起拼，看看谁找到的边角多？'}]},draftPlan:{intent:'reply',quotes,
     guidance:{objective:ref(OBJECTIVE),allowedApproach:ref(APPROACH),avoidances:[{text:'不用“共同体验项目”式正式措辞。',sourceIds:[currentId]}]}}};
    return response(mode==='new_material'?withCurrentStatementAuthority(output,captured,manifest.primaryReferences):output);
   }
   assert.fail('Only the primary, one shared repair and read-only fidelity check are declared by this fixture');
  })});
 controller.scope={...scope};controller.ingest(scope,[raw('56801',false,{elements:[{elementType:1,textElement:{content:'这个拼图还能两个人一起拼，会显示各自拼了多少块。'}}]})]);
 const prior=store.appendTurn(scope,{role:'user',kind:'discussion',text:PRIOR});priorId=`private:${prior.id}`;
 store.appendTurn(scope,{role:'assistant',origin:'user',kind:'discussion',text:'这一轮先照你说的方向回应。',sourceIds:[priorId]});
 t.after(()=>{controller.close();store.close();});return {store,controller,requests,priorId};
}

for(const mode of ['guidance_only','new_material'])test(`structured repair preserves prior intent and current correction through real wording: ${mode}`,async t=>{
 const {store,controller,requests,priorId}=fixture(t,mode),taskId=`carrier-repair-${mode}`,text=CRITICISM+(mode==='new_material'?`另外${NEW_MATERIAL}，愿意告诉她这点。`:'');
 const answer=await controller.assist({taskId,text});assert.equal(answer.kind,'draft');assert.equal(requests.length,3);
 const receipts=store.getCompanion(scope).runs.at(-1).requests;
 const normal={...requests[0],payload:canonicalSourceView(requests[0].payload,receipts[0].manifest.sourceHandles,receipts[0].payload)},repair={...requests[1],payload:canonicalSourceView(requests[1].payload,receipts[1].manifest.sourceHandles,receipts[1].payload)},checked=canonicalSourceView(requests[2].payload,receipts[2].manifest.sourceHandles,receipts[2].payload),run=store.getCompanion(scope).runs.at(-1),draft=require('../src/context/composer-evidence.cjs').projectComposerEvidence(run.payload),currentId=normal.payload.userRequest.sourceId;
 assert.match(normal.wire.messages[0].content,/quotes:\[\{materialRef,authorityRef\?\}\]/);
 assert.match(normal.wire.messages[0].content,/quotes≤8；仅当前精确QQ素材可省authorityRef，其他来源必需/);
 assert.match(normal.wire.messages[0].content,/动作\/提问\/口吻入guidance/);
 assert.match(repair.payload.task,/guidance只是有来源的动作\/方式提议/);assert.match(repair.payload.task,/不能把私人理由当外发素材/);
 assert.match(repair.payload.task,/原始用户发言候选不是许可/);
 assert.match(repair.payload.task,/完整上下文的指代、否定、引用、条件和最新限制/);
 assert.match(normal.wire.messages[0].content,/不切许可条件\/否定/);
 assert.match(normal.wire.messages[0].content,/UI只原精确范围/);
 assert.match(normal.wire.messages[0].content,/目录、模式、助手产物不授权/);
 assert.match(repair.payload.task,/不抄sourceId\/text\/authorization\/authorizationQuote/);
 assert.doesNotMatch(repair.payload.task,/只回应实际QQ时才可quotes:\[\]/);
 assert.ok(repair.payload.task.includes('选最小相关获准素材'),'repair must retain actual newly authorized meaning without forwarding the whole private source');
 assert.equal(repair.payload.originalInput.userRequest.text,text);assert.equal(repair.payload.originalInput.sources.find(source=>source.id===priorId).text,PRIOR);
 assert.equal(checked.purpose,'fidelity_check');assert.equal(draft.purpose,'draft');assert.equal(draft.draftingGuidance.objective.text,OBJECTIVE);assert.equal(draft.draftingGuidance.allowedApproach.text,APPROACH);
 assert.deepEqual(draft.draftingGuidance.objective.sourceIds,[priorId,currentId]);assert.deepEqual(draft.draftingGuidance.allowedApproach.sourceIds,[priorId,currentId]);
 assert.deepEqual(admittedQuotes(draft.outboundQuotes,run.payload.outboundQuotes,run.manifest.sourceRevisions),mode==='new_material'?[{sourceId:currentId,text:NEW_MATERIAL}]:[]);
 assert.ok(draft.sources.every(source=>source.type==='qq'),'private instructions are control references, not raw composer sources');
 const other=withoutCurrentControl(draft,text);assert.equal(draft.currentHumanControl.sourceId,currentId);assert.equal(draft.draftingGuidance.authority,'GENERATED_PROPOSAL');
 for(const privateBody of [PRIOR,CRITICISM,'PRIVATE_PRIOR_REASON'])assert.equal(JSON.stringify(other).includes(privateBody),false);
 assert.ok(answer.suggestions.every(item=>![PRIOR,CRITICISM,'PRIVATE_PRIOR_REASON'].some(privateBody=>item.text.includes(privateBody))));
 assert.equal(store.getCompanion(scope).turns.find(turn=>turn.id===priorId.slice('private:'.length)).text,PRIOR);
 const budget=controller.usage.get(scope,taskId);assert.equal(budget.status,'complete');assert.equal(budget.attempts,3);assert.equal(budget.limit,3);
 assert.deepEqual(budget.requests.map(request=>request.purpose),['discussion','delivery_repair','fidelity_check']);
});

test('a repaired plan still cannot promote old private instructions into unauthorized outbound quotes',async t=>{
 const {store,controller,requests,priorId}=fixture(t,'unauthorized_old_quote'),taskId='carrier-repair-old-quote-denied';
 await assert.rejects(controller.assist({taskId,text:CRITICISM}),/draftPlan\.quotes\[0\]\.authorityRef/);
 assert.equal(store.getCompanion(scope).turns.find(turn=>turn.id===priorId.slice(8)).text,PRIOR,'rejected bindings cannot rewrite the private instruction source');
 assert.equal(requests.length,2,'the unauthorized repaired plan must not purchase a wording call');
 assert.ok(!requests.some(request=>request.payload.purpose==='draft'));
 const budget=controller.usage.get(scope,taskId);assert.equal(budget.status,'failed');assert.equal(budget.attempts,2);assert.equal(budget.limit,3);
 const run=store.getCompanion(scope).runs.find(run=>run.id===taskId);assert.equal(run.status,'failed');assert.equal(run.manifest.formatRepair.planningCarrier,true);
});
