'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional real-assembly/Controller/transport fences. Compact origins convey
// anchors only; canonical permissions and dependency witnesses remain decisive.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store,sourceRevision}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {assertDraftSourcesCurrent}=require('../src/context/draft-material.cjs');
const {projectComposerEvidence}=require('../src/context/composer-evidence.cjs');
const {buildMaterialProvenance}=require('../src/context/material-provenance.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const NOW='2026-10-01T10:00:00.000Z',OLD='2026-08-31T10:00:00.000Z',FACT='周六下午我有空。',MESSAGE='周六下午我有空，可以一起看看那个小网页。',WHY='按本轮明确时段说明这句表达。';
const HUMAN='这次按我已选的原话准备完整表达，并解释修改的作用；PRIVATE_CURRENT_ONLY不要当成额外外发事实。';
const body=source=>source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function plan(p){const source=p.sources.find(source=>source.type==='note'&&body(source)===FACT);return {operation:'prepare_message',materials:[{materialRef:whole(source),authorityRef:source.authorityChoices.program[0].authorityRef}],...(p.editingReferences?.length?{editingReference:{choice:p.editingReferences[0].choice}}:{}),answer:{privateExplanation:WHY,suggestions:[{text:MESSAGE}]}};}
function response(value,name){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'compact-evidence-life',type:'function',function:{name,arguments:JSON.stringify(value)}}]}}]}),{status:200});}
async function application(t,producer,{previous=false}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse(OLD)});const store=new Store(':memory:'),roots=[];
 for(let index=0;index<12;index++){t.mock.timers.setTime(Date.parse(OLD)+index*86400000);roots.push(store.appendTurn(scope,{id:'evidence-root-'+String(index).padStart(2,'0'),role:'user',kind:'discussion',text:'我当时说明周六下午有空。ROOT_BODY_ONLY_'+index}));}
 t.mock.timers.setTime(Date.parse(NOW));const note=store.saveNote(scope,{text:FACT,use:'draft',evidenceSourceIds:roots.map(root=>'private:'+root.id)}),calls=[],contexts=[],model='synthetic-compact-evidence',baseUrl='http://fixture.invalid/v1';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestBytes:64000,assistantRequestLimit:6,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(settings,context,signal)=>{contexts.push(context);return assistModel(settings,context,signal,async(_url,args)=>{const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,wrapper,p,bytes:Buffer.byteLength(args.body)});return response(await producer(p,wrapper,calls.length-1),request.tool_choice.function.name);});}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000000371',false,{msgTime:String(Date.parse(NOW)/1000-60),elements:[{textElement:{content:'周六下午方便一起看看吗？'}}]})]});
 const currentNote=store.memorySources(scope).find(source=>source.id==='note:'+note.id),prior=previous?store.appendTurn(scope,{role:'assistant',kind:'draft',origin:'user',requestId:'compact-previous',text:MESSAGE,suggestions:[{style:'自然',text:MESSAGE}],expressionOptions:[{label:'直接确认本轮已选时段，保留邀请力度。',style:'casual',quotes:[{sourceId:currentNote.id,text:FACT,revision:currentNote.revision}]}],sourceIds:[currentNote.id]}):null;
 return {store,controller,note,roots,prior,calls,contexts,run:()=>store.getCompanion(scope).runs.at(-1),assist:()=>controller.assist({text:HUMAN,taskId:'compact-evidence-life',materialIds:[note.id],...(prior?{sourceTurnIds:[prior.id],selectedOption:{turnId:prior.id,index:0}}:{})})};
}
const allow=p=>({checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]});
const complete=p=>p.purpose==='fidelity_check'?allow(p):plan(p);

test('recorded admission and the isolated legacy compact view retains every hidden canonical root revision in manifest and generated artifact fences',async t=>{
 const app=await application(t,complete),reply=await app.assist(),context=app.run(),wire=projectComposerEvidence({...context.payload,purpose:'draft'}),canonical=context.payload.outboundQuotes[0];
 assert.equal(wire.outboundQuotes[0].provenance,undefined);assert.equal(wire.outboundQuotes[0].origin.originalRecordsStatus,'partial');assert.equal(wire.outboundQuotes[0].origin.originalRecords.length,8);assert.equal(canonical.provenance.rootCount,12);assert.equal(canonical.provenance.roots.length,8);
 const refs=app.store.experiences.artifact(scope,reply.suggestions[0].artifactRef).sourceRefs;
 for(const root of app.roots){const id='private:'+root.id,source=app.store.memorySources(scope).find(source=>source.id===id);assert.equal(context.manifest.sourceRevisions[id],source.revision);assert.equal(refs.find(ref=>ref.sourceId===id).revision,source.revision);}
 assert.equal(JSON.stringify(wire.outboundQuotes).includes('ROOT_BODY_ONLY_'),false);assert.equal(reply.discussionExplanation.text,WHY);assert.equal(reply.suggestions[0].text,MESSAGE);
});

test('late date, revision, withdrawal or foreign scope beyond visible roots is checked from canonical private dependencies',async t=>{
 const app=await application(t,complete);await app.assist();const context=app.run(),all=app.store.memorySources(scope),id='private:'+app.roots.at(-1).id;
 assert.equal(context.payload.outboundQuotes[0].provenance.roots.some(root=>root.sourceId===id),false);assert.ok(context.manifest.sourceRevisions[id]);
 const ids=Object.keys(context.manifest.sourceRevisions);assert.doesNotThrow(()=>assertDraftSourcesCurrent(context,ids,{scope,availableSources:all}));
 for(const patch of [{revision:'changed-root-revision'},{deleted:true},{excluded:true},{use:'disabled'},{scope:{...scope,peerUid:'foreign'}}])assert.throws(()=>assertDraftSourcesCurrent(context,ids,{scope,availableSources:all.map(source=>source.id===id?{...source,...patch}:source)}),/版本已变化/);
 const changedDate=all.map(source=>{if(source.id!==id)return source;const {revision,...rest}=source,newValue={...rest,at:'2026-09-25T10:00:00.000Z'};return {...newValue,revision:sourceRevision(newValue)};});assert.throws(()=>assertDraftSourcesCurrent(context,ids,{scope,availableSources:changedDate}),/版本已变化/);
 assert.throws(()=>assertDraftSourcesCurrent(context,ids,{scope,availableSources:all.filter(source=>source.id!==id)}),/版本已变化/);
});

test('the wire projection cannot turn a discussion-only source into a new material permission',async t=>{
 const app=await application(t,complete);app.store.saveNote(scope,{id:app.note.id,text:FACT,use:'discussion'});const turn=app.store.appendTurn(scope,{role:'user',kind:'discussion',text:'先只在这里分析旧笔记“'+FACT+'”，不准备外发。'}),all=app.store.memorySources(scope),source=all.find(source=>source.id==='note:'+app.note.id),args={scope,store:app.store,records:app.store.messages(scope),availableSources:all,companion:app.store.getCompanion(scope),turn,purpose:'discussion',requestId:'compact-not-permission',asOf:NOW,materialIds:[],retrievedSources:[source],settings:app.controller.settings,coverage:{status:'partial'}},prepared=buildContext(args);
 assert.ok(prepared.payload.sources.some(item=>item.id===source.id));assert.equal(prepared.payload.allowedMaterialIds.includes(source.id),false);
 const full=buildMaterialProvenance(prepared,[{sourceId:source.id,text:FACT}],{scope}),projected=projectComposerEvidence({purpose:'draft',outboundQuotes:full.quotes}).outboundQuotes;
 assert.ok(projected[0].origin);assert.equal(projected[0].authorization,undefined);assert.throws(()=>buildDraftContext(prepared,{intent:'reply',quotes:projected},args),error=>error.code==='draft_material_authorization_missing'||/仅供私下讨论/.test(error.message));
});

test('real e1, explicit UI selection and current human controls remain independent of compact fact attribution',async t=>{
 const app=await application(t,complete,{previous:true});await app.assist();const context=app.run(),wire=projectComposerEvidence({...context.payload,purpose:'draft'});
 assert.deepEqual(wire.editingReference,context.payload.editingReference);assert.equal(wire.editingReference.text,MESSAGE);assert.deepEqual(wire.selectedDirectionControl,context.payload.selectedDirectionControl);assert.equal(wire.selectedDirectionControl.authority,'CONTROL_ONLY_UI_SELECTION');
 assert.equal(wire.currentHumanControl.text,HUMAN);assert.equal(wire.currentHumanControl.authority,'CONTROL_ONLY');assert.equal(wire.outboundQuotes.some(quote=>quote.text===MESSAGE||quote.text.includes('PRIVATE_CURRENT_ONLY')),false);
 assert.ok(context.manifest.inputArtifactRefs.some(ref=>ref.kind==='message_candidate'));assert.ok(context.manifest.inputArtifactRefs.some(ref=>ref.kind==='action_option'));
});

test('repaired complete primary preserves rich canonical dependencies, exact compact admission and actual byte accounting',async t=>{
 const app=await application(t,(p,wrapper)=>{if(p.purpose==='fidelity_check')return allow(p);const value=plan(p);if(!wrapper.originalInput)value.answer.privateExplanation={invalid:'requires one repair'};return value;}),reply=await app.assist(),context=app.run(),wire=projectComposerEvidence({...context.payload,purpose:'draft'});
 assert.equal(app.calls.length,3);assert.deepEqual(app.calls.map(call=>call.request.tool_choice.function.name),['assistant_result','assistant_result','fidelity_result']);
 assert.deepEqual(app.calls[0].p.sources,app.calls[1].p.sources,'the shared primary repair retains the actual offered originals');
 assert.equal(wire.outboundQuotes[0].provenance,undefined);assert.equal(wire.outboundQuotes[0].origin.originalRecordsStatus,'partial');assert.equal(wire.outboundQuotes[0].text,FACT);assert.equal(context.payload.outboundQuotes[0].provenance.rootCount,12);
 const repair=app.contexts[0].extraRequests[0];assert.equal(repair.purpose,'delivery_repair');const repairNote=repair.payload.originalInput.sources.find(source=>source.id==='note:'+app.note.id);
 for(const root of app.roots){const id='private:'+root.id;assert.equal(repairNote.evidenceRevisions[id],context.manifest.sourceRevisions[id],'the canonical primary repair retains every note-lineage revision before admission expands the full dependency manifest');}
 const ledger=app.controller.usage.get(scope,'compact-evidence-life');assert.equal(ledger.attempts,3);assert.equal(ledger.requests.filter(request=>request.purpose==='delivery_repair').length,1);for(let index=0;index<app.calls.length;index++)assert.equal(ledger.requests[index].inputBytes,app.calls[index].bytes);
 assert.equal(reply.discussionExplanation.text,WHY);assert.equal(reply.suggestions[0].text,MESSAGE);assert.deepEqual(context.manifest.preparedResponse,{owner:'primary_answer',message:'provided',privateBodyOwner:'answer.privateExplanation',privateExplanation:'provided'});
});

for(const mutation of ['root-version','root-forget','contact'])test(`late ${mutation} invalidates the exact checked response across the complete canonical dependency closure`,async t=>{
 let release,enter;const entered=new Promise(resolve=>{enter=resolve;});const app=await application(t,p=>p.purpose==='fidelity_check'?new Promise(resolve=>{release=()=>resolve(allow(p));enter();}):plan(p));
 const pending=app.assist();pending.catch(()=>{});t.after(()=>release?.());await Promise.race([entered,pending.then(()=>{throw Error('Expected the controlled checker to be pending');})]);
 const id='private:'+app.roots.at(-1).id,check=app.contexts[1];assert.equal(check.payload.purpose,'fidelity_check');assert.ok(check.manifest.sourceRevisions[id]);assert.ok(check.payload.evidence.some(source=>source.sourceId===id),'the read-only check sees the original root while the compact material remains only the admitted note');assert.deepEqual(check.payload.admittedFragments,[{sourceId:'note:'+app.note.id,text:FACT}]);
 if(mutation==='root-version')app.store.updateTurn(scope,app.roots.at(-1).id,'这条旧来源已有新的修订。');
 if(mutation==='root-forget')app.store.forgetSource(scope,id);
 if(mutation==='contact'){app.controller.scope={...scope,peerUid:'another-contact',peerUin:'66778899'};app.controller.changedContext();}
 release();await pending.catch(()=>{});assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&turn.requestId==='compact-evidence-life'),false);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
