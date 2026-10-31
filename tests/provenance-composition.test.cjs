'use strict';
const {withoutCurrentControl}=require('./fixtures/wording-lanes.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {scope}=require('./fixtures/native.cjs');
const OLD='2026-08-31T10:00:00.000Z',NOW='2026-10-01T10:10:00.000Z',FACT='查找功能终于能按标题找回自己的摘记';
function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:Date.parse(OLD)});const store=new Store(':memory:');t.after(()=>store.close());
 const original=store.appendTurn(scope,{role:'user',kind:'discussion',text:`${FACT}。PRIVATE_BODY_MUST_NOT_CROSS。`});
 t.mock.timers.setTime(Date.parse(NOW));const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'我愿把网页的用途和查找进展告诉她，帮我成稿。'});
 const settings={model:'synthetic-provenance',assistantRequestBytes:64000};
 const args={scope,store,settings,turn,records:[],companion:store.getCompanion(scope),availableSources:store.memorySources(scope),sourceTurnIds:[original.id],purpose:'discussion',requestId:'dated-material',asOf:NOW,coverage:{status:'complete'}};
 const prepared=buildContext(args),id=`private:${turn.id}`,oldId=`private:${original.id}`,control=text=>({text,sourceIds:[id]});
 const plan={quotes:[{sourceId:oldId,text:FACT,authorization:{permission:{sourceId:id,text:'我愿把网页的用途和查找进展告诉她'},referent:{sourceId:oldId,text:FACT}}}],taskUse:'different',guidance:{objective:control('回复网页用途和查找进展'),allowedApproach:control('自然说明能按标题找自己的摘记'),avoidances:[]}};
 return {store,args,prepared,plan,oldId};
}
test('actual old admitted fragment reaches wording with its recording time, not current permission/asOf time',t=>{
 const f=fixture(t),draft=buildDraftContext(f.prepared,f.plan,f.args),quote=draft.payload.outboundQuotes[0];
 assert.equal(quote.provenance.source.recordedAt,OLD);assert.equal(quote.provenance.source.timeMeaning,'private_statement_recorded');assert.equal(quote.provenance.timeSemantics,'recording_not_occurrence');
 assert.equal(quote.text,FACT);assert.equal(draft.payload.outboundQuotes.length,1);assert.equal(draft.payload.asOf,NOW);
 const wire=prepareAssistantRequest(f.args.settings,draft.payload,[]);assert.ok(wire.serialized.includes(OLD));assert.equal(JSON.stringify(draft.payload).includes('PRIVATE_BODY_MUST_NOT_CROSS'),false);
 assert.equal(draft.payload.userRequest,undefined);assert.equal(draft.payload.privateConversation,undefined);
});
test('single admitted proposition remains single evidence while guidance controls composition rather than another sentence to echo',t=>{
 const f=fixture(t),draft=buildDraftContext(f.prepared,f.plan,f.args),request=prepareAssistantRequest(f.args.settings,draft.payload,[]).request;
 assert.equal(draft.payload.outboundQuotes.length,1);assert.equal(draft.payload.outboundQuotes[0].text,FACT);
 assert.match(request.messages[0].content,/不凭空补事件日期/);assert.match(request.messages[0].content,/同一.*一次/);
 assert.match(request.messages[0].content,/不否定原文明示日期/);assert.match(request.messages[0].content,/笔记编辑日期不代替原始陈述日期/);assert.match(request.messages[0].content,/未知时间不等于事实存疑/);
 assert.deepEqual(f.plan.quotes[0].text,FACT);
});
test('restricted repair and measured rebuild retain essential provenance without private or permission bodies',async t=>{
 const {assistModel}=require('../src/assistant-model.cjs');
 const f=fixture(t),draft=buildDraftContext(f.prepared,f.plan,f.args),calls=[];
 const result=await assistModel({...f.args.settings,anonymous:true,baseUrl:'http://fixture.invalid/v1'},draft,undefined,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,p,wrapper});
  assert.equal(p.outboundQuotes[0].origin.recordedAt,OLD);assert.equal(p.outboundQuotes[0].provenance,undefined);assert.equal(draft.payload.outboundQuotes[0].provenance.source.recordedAt,OLD);assert.equal(p.outboundQuotes[0].text,FACT);
  const other=withoutCurrentControl(p,f.prepared.payload.sources.find(source=>source.id===f.prepared.payload.intentAuthority.sourceId).text);
  assert.equal(JSON.stringify(other).includes('PRIVATE_BODY_MUST_NOT_CROSS'),false);assert.equal(JSON.stringify(other).includes('我愿把网页的用途和查找进展告诉她'),false);
  return new Response(JSON.stringify({choices:[{message:{content:calls.length===1?'invalid-json':JSON.stringify({kind:'draft',text:'查找功能已经能按标题找回自己的摘记了。'})}}]}),{status:200});
 });
 assert.equal(calls.length,2);assert.equal(result.kind,'draft');assert.equal(draft.extraRequests.length,1);assert.equal(draft.extraRequests[0].payload.originalInput.outboundQuotes[0].provenance.source.recordedAt,OLD);
 const rebuilt=draft.rebuildForRequest(payload=>prepareAssistantRequest(f.args.settings,payload,[]).requestBytes);
 assert.deepEqual(rebuilt.payload.outboundQuotes,draft.payload.outboundQuotes);assert.ok(calls.every(call=>Buffer.byteLength(JSON.stringify(call.request))<=64000));
 assert.throws(()=>buildDraftContext(f.prepared,f.plan,{...f.args,requestMeasure:payload=>JSON.stringify(payload).includes('provenance')?999999:0}),/预算/,'required provenance is not removed while its fragment remains');
});
test('derived-note root metadata does not deliver root bodies and every private dependency is fenced',t=>{
 const {assertDraftSourcesCurrent}=require('../src/context/draft-material.cjs');
 t.mock.timers.enable({apis:['Date'],now:Date.parse(OLD)});const store=new Store(':memory:');t.after(()=>store.close());
 const roots=Array.from({length:12},(_,index)=>store.appendTurn(scope,{role:'user',kind:'discussion',text:`PRIVATE_ROOT_BODY_${index}`}));
 t.mock.timers.setTime(Date.parse(NOW));const note=store.saveNote(scope,{text:FACT,use:'draft',evidenceSourceIds:roots.map(root=>`private:${root.id}`)}),turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'把这条可分享笔记告诉她。'});
 const settings={model:'synthetic-provenance',assistantRequestBytes:64000},args={scope,store,settings,turn,records:[],companion:store.getCompanion(scope),availableSources:store.memorySources(scope),materialIds:[note.id],purpose:'discussion',requestId:'note-root-date',asOf:NOW,coverage:{status:'complete'}};
 const prepared=buildContext(args),id=`private:${turn.id}`,control=text=>({text,sourceIds:[id]}),plan={quotes:[{sourceId:`note:${note.id}`,text:FACT}],guidance:{objective:control('分享笔记事实'),allowedApproach:control('自然说明'),avoidances:[]}},draft=buildDraftContext(prepared,plan,args),quote=draft.payload.outboundQuotes[0];
 assert.equal(quote.provenance.source.timeMeaning,'note_edited');assert.equal(quote.provenance.source.recordedAt,NOW);assert.equal(quote.provenance.rootCount,12);assert.equal(quote.provenance.roots.length,8);assert.equal(quote.provenance.metadataCompleteness,'roots_summarized');
 assert.ok(quote.provenance.roots.every(root=>root.recordedAt===OLD));assert.equal(JSON.stringify(draft.payload).includes('PRIVATE_ROOT_BODY'),false);
 for(const root of roots){const sourceId=`private:${root.id}`;assert.ok(draft.manifest.sourceRevisions[sourceId]);assert.equal(draft.payload.sources.some(source=>source.id===sourceId),false);assert.equal(draft.manifest.sourceDelivery.sources.some(source=>source.sourceId===sourceId&&source.status==='delivered'),false);}
 const outside=roots.find(root=>!quote.provenance.roots.some(meta=>meta.sourceId===`private:${root.id}`));store.updateTurn(scope,outside.id,'changed private root');
 assert.throws(()=>assertDraftSourcesCurrent({manifest:draft.manifest},roots.map(root=>`private:${root.id}`),{scope,store}),/变化/);
});

test('a version-bound leaf NOTE retains its edit anchor instead of becoming an original statement date',()=>{
 const {buildMaterialProvenance}=require('../src/context/material-provenance.cjs'),{resolveDraftMaterial}=require('../src/context/draft-material.cjs');
 const root={id:'note:authored-root',type:'note',role:'user',revision:'leaf-note-r1',at:OLD,use:'draft',text:'PRIVATE_ROOT_NOTE_BODY_DO_NOT_FORWARD'},fact='今天查找功能已经能用了。';
 const note={id:'note:derived-child',type:'note',role:'user',revision:'child-note-r1',at:NOW,use:'draft',text:fact,evidenceSourceIds:[root.id],evidenceRevisions:{[root.id]:root.revision}};
 const payload={purpose:'discussion',sources:[note],allowedMaterialIds:[note.id]},prepared={payload,fullAvailableSources:[root,note],manifest:{scope,sourceRevisions:{[root.id]:root.revision,[note.id]:note.revision}}};
 const material=resolveDraftMaterial(payload,{quotes:[{sourceId:note.id,text:fact}]}),canonical=buildMaterialProvenance(prepared,material.quotes,{scope});
 const input={purpose:'draft',outboundQuotes:canonical.quotes,sources:[]},packet=prepareAssistantRequest({model:'synthetic-note-root'},input,[],{sourceRevisions:prepared.manifest.sourceRevisions}),wire=packet.wirePayload.outboundQuotes[0];
 assert.equal(canonical.quotes[0].provenance.roots[0].timeMeaning,'note_edited');assert.equal(canonical.quotes[0].provenance.roots[0].recordedAt,OLD);
 assert.equal(wire.origin.originalStatements?.[0]?.recordedAt,undefined,'a leaf NOTE edit timestamp cannot be labelled an original statement recording date');
 assert.deepEqual(wire.origin.originalRecords,[{speaker:'user',noteEditedAt:OLD}]);assert.equal(wire.origin.originalRecordsStatus,'complete');assert.equal(wire.origin.noteEditedAt,NOW);assert.equal(wire.text,fact);
 assert.equal(wire.origin.originalRecords[0].recordedAt,undefined);assert.equal(JSON.stringify(packet.wirePayload).includes(root.text),false);
 assert.deepEqual(new Set(canonical.dependencies.map(ref=>ref.sourceId)),new Set([root.id,note.id]));assert.deepEqual(packet.payload,input);
});
