'use strict';
// Fictional actual assembly/model-view checks. These preserve evidence inputs;
// they do not prove that a model will interpret temporal language correctly.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store,sourceRevision}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {prepareAssistantRequest,assistModel}=require('../src/assistant-model.cjs');
const {buildMaterialProvenance}=require('../src/context/material-provenance.cjs');
const {assertDraftSourcesCurrent}=require('../src/context/draft-material.cjs');
const {projectComposerEvidence}=require('../src/context/composer-evidence.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const NOW='2026-10-01T10:00:00.000Z',OLD='2026-08-31T10:00:00.000Z',FACT='今天小葱已经长出两片新叶。';
const HUMAN=FACT+'我愿意告诉她这个近况。PRIVATE_CONTROL_CONTEXT只作本次商量，不要当作另外的外发事实。';
const clone=value=>structuredClone(value);
function source(id,text=FACT,extra={}){const value={id,text,type:'private',role:'user',use:'discussion',at:OLD,...extra};return {...value,revision:sourceRevision(value)};}
function note(id,parents=[],extra={}){return source(id,FACT,{type:'note',role:undefined,use:'draft',at:NOW,evidenceSourceIds:parents.map(parent=>parent.id),evidenceRevisions:Object.fromEntries(parents.map(parent=>[parent.id,parent.revision])),...extra});}
function evidence(selected,all=[selected],text=selected.text){const prepared={payload:{sources:[selected]},fullAvailableSources:all,manifest:{scope,sourceRevisions:Object.fromEntries(all.map(item=>[item.id,item.revision]))}},built=buildMaterialProvenance(prepared,[{sourceId:selected.id,text}],{scope});return {payload:{purpose:'draft',asOf:NOW,outboundQuotes:built.quotes,sources:[]},dependencies:built.dependencies};}
function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});const store=new Store(':memory:');t.after(()=>store.close());
 store.add(scope,[normalize(raw('91000000000000361',false,{msgTime:String(Date.parse(NOW)/1000-60),elements:[{textElement:{content:'你种的小葱最近怎么样？'}}]}),scope)]);
 const note=store.saveNote(scope,{text:FACT,use:'draft'}),turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:HUMAN});
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-conversational-evidence',modelResponseMode:'result_tool',assistantRequestBytes:64000};
 const args={scope,store,records:store.messages(scope),availableSources:store.memorySources(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',generationOrigin:'private_discussion',requestId:'conversational-evidence-view',asOf:NOW,materialIds:[note.id],settings,coverage:{status:'partial'}},prepared=buildContext(args),id=prepared.payload.intentAuthority.sourceId,c=text=>({text,sourceIds:[id]});
 const plan={intent:'reply',quotes:[{sourceId:'note:'+note.id,text:FACT}],guidance:{objective:c('分享已经准许的原话'),allowedApproach:c('保持原话中的时间与具体内容'),avoidances:[]}},draft=buildDraftContext(prepared,plan,args);
 return {store,note,turn,args,prepared,plan,draft,settings};
}

test('actual composer wire has compact conversational origins while canonical provenance and revision fences remain private',t=>{
 const app=fixture(t),canonical=clone(app.draft.payload),manifest=clone(app.draft.manifest),request=prepareAssistantRequest(app.settings,app.draft.payload,undefined,{sourceRevisions:app.draft.manifest.sourceRevisions}),quote=request.wirePayload.outboundQuotes[0];
 assert.ok(app.draft.payload.outboundQuotes[0].provenance.source.revision);assert.equal(quote.provenance,undefined,'rich audit metadata belongs to canonical program data, not the composer view');
 assert.deepEqual(quote.origin,{speaker:'unknown',noteEditedAt:NOW,originalRecords:[],originalRecordsStatus:'not_applicable'});assert.equal(quote.text,FACT);
 assert.deepEqual(request.payload,canonical);assert.deepEqual(app.draft.payload,canonical);assert.deepEqual(app.draft.manifest,manifest);
 assert.equal(app.draft.manifest.sourceRevisions['note:'+app.note.id],app.store.memorySources(scope).find(source=>source.id==='note:'+app.note.id).revision);
});

test('direct original words keep their exact time expressions and record-author attribution without an inferred event date',()=>{
 for(const [text,at,type,role]of [[FACT,NOW,'private','user'],['我今天已经给小葱浇过水。',NOW,'private','user'],['昨天先完成了查找功能。',OLD,'private','user'],['今天想起去年去过那家书店。',NOW,'private','user'],['我今天已经把小葱浇好了。',NOW,'qq','contact'],['今天这句需要保持原意。',NOW,'feedback','user']]){
  const original=source(type+':literal-time',text,{at,type,role}),{payload}=evidence(original),before=clone(payload),view=projectComposerEvidence(payload),quote=view.outboundQuotes[0];
  assert.equal(quote.text,text);assert.equal(quote.sourceId,original.id);assert.deepEqual(quote.origin,{speaker:role,recordedAt:at});assert.equal(quote.provenance,undefined);assert.deepEqual(payload,before);
  assert.equal(Object.hasOwn(quote.origin,'occurredAt'),false);assert.equal(Object.hasOwn(quote.origin,'eventAt'),false);
 }
});

test('quoted metadata-looking words are content and are never rewritten by structural audit projection',()=>{
 const text='今天调试时看到了 revision、rootCount 和 timeSemantics 字样，这些就是原话。',original=source('private:literal-fields',text,{at:NOW}),{payload}=evidence(original);
 assert.equal(projectComposerEvidence(payload).outboundQuotes[0].text,text);assert.equal(payload.outboundQuotes[0].text,text);
});

test('note editing and multiple bound original statements remain separate anchors instead of collapsing to the latest date',()=>{
 const first=source('private:first-statement','过去说的可用时段。',{at:OLD}),second=source('qq:second-statement','对方的原始描述。',{type:'qq',role:'contact',at:'2026-09-15T10:00:00.000Z'}),derived=note('note:multi-anchor',[first,second]),{payload,dependencies}=evidence(derived,[first,second,derived]),before=clone(payload),origin=projectComposerEvidence(payload).outboundQuotes[0].origin;
 assert.equal(origin.noteEditedAt,NOW);assert.equal(origin.speaker,'unknown');assert.equal(origin.originalRecordsStatus,'complete');assert.equal(origin.originalRecords.length,2);
 assert.deepEqual(new Set(origin.originalRecords.map(item=>JSON.stringify(item))),new Set([{speaker:'user',recordedAt:OLD},{speaker:'contact',recordedAt:'2026-09-15T10:00:00.000Z'}].map(item=>JSON.stringify(item))));
 assert.equal(dependencies.length,3);assert.deepEqual(payload,before);assert.equal(Object.hasOwn(origin,'rootCount'),false);
});

test('actual indirect note ancestry keeps authored leaf edits distinct from raw statement records without weakening private revision fences',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse(OLD)});const store=new Store(':memory:');t.after(()=>store.close());
 const leafA=store.saveNote(scope,{text:'我把较早的可用时段记在这条笔记中。',use:'discussion'});
 t.mock.timers.setTime(Date.parse('2026-09-01T10:00:00.000Z'));const leafB=store.saveNote(scope,{text:'这是另一条独立编辑的时段笔记。',use:'discussion'});
 t.mock.timers.setTime(Date.parse('2026-09-10T10:00:00.000Z'));const statement=store.appendTurn(scope,{role:'user',kind:'discussion',text:'我原话说明了这次可用的时段。'});
 t.mock.timers.setTime(Date.parse('2026-09-20T10:00:00.000Z'));const middle=store.saveNote(scope,{text:'中间整理只链接较早笔记。',use:'discussion',evidenceSourceIds:['note:'+leafA.id]});
 t.mock.timers.setTime(Date.parse(NOW));const top=store.saveNote(scope,{text:FACT,use:'draft',evidenceSourceIds:['note:'+middle.id,'note:'+leafB.id,'private:'+statement.id]}),turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:HUMAN});
 store.add(scope,[normalize(raw('91000000000000362',false,{msgTime:String(Date.parse(NOW)/1000-60),elements:[{textElement:{content:'最近的新近况呢？'}}]}),scope)]);
 const settings={model:'synthetic-note-root-type',modelResponseMode:'result_tool',assistantRequestBytes:64000},args={scope,store,records:store.messages(scope),availableSources:store.memorySources(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',requestId:'note-leaf-evidence',asOf:NOW,materialIds:[top.id],settings,coverage:{status:'partial'}},prepared=buildContext(args),id=prepared.payload.intentAuthority.sourceId,c=text=>({text,sourceIds:[id]}),draft=buildDraftContext(prepared,{intent:'reply',quotes:[{sourceId:'note:'+top.id,text:FACT}],guidance:{objective:c('保持明确原话'),allowedApproach:c('据原话区分来源记录'),avoidances:[]}},args);
 const before=clone(draft.payload),manifest=clone(draft.manifest),request=prepareAssistantRequest(settings,draft.payload,undefined,{sourceRevisions:draft.manifest.sourceRevisions}),origin=request.wirePayload.outboundQuotes[0].origin;
 assert.equal(origin.noteEditedAt,NOW);assert.equal(origin.originalRecordsStatus,'complete');assert.equal(origin.originalStatements,undefined);assert.equal(origin.originalRecords.length,3);
 assert.deepEqual(new Set(origin.originalRecords.map(row=>JSON.stringify(row))),new Set([{speaker:'unknown',noteEditedAt:OLD},{speaker:'unknown',noteEditedAt:'2026-09-01T10:00:00.000Z'},{speaker:'user',recordedAt:'2026-09-10T10:00:00.000Z'}].map(row=>JSON.stringify(row))));
 for(const row of origin.originalRecords.filter(row=>Object.hasOwn(row,'noteEditedAt')))assert.equal(Object.hasOwn(row,'recordedAt'),false,'a leaf note edit is never relabeled as original-statement recording');
 const roots=draft.payload.outboundQuotes[0].provenance.roots;assert.equal(roots.filter(root=>root.type==='note'&&root.timeMeaning==='note_edited').length,2);assert.equal(roots.length,3);
 for(const sourceId of ['note:'+leafA.id,'note:'+leafB.id,'note:'+middle.id,'note:'+top.id,'private:'+statement.id])assert.ok(draft.manifest.sourceRevisions[sourceId]);
 assert.deepEqual(draft.payload,before);assert.deepEqual(draft.manifest,manifest);assert.equal(request.wirePayload.outboundQuotes[0].text,FACT);
 store.saveNote(scope,{id:leafA.id,text:'这条叶子笔记已有新修订。',use:'discussion'});assert.throws(()=>assertDraftSourcesCurrent(draft,['note:'+leafA.id],{scope,availableSources:store.memorySources(scope)}),/版本已变化/);assert.deepEqual(draft.payload,before);
});

test('legacy note-edited root meaning is preserved even if its old type label is not note',()=>{
 const root=note('note:legacy-meaning-root'),derived=note('note:legacy-meaning-parent',[root]),{payload}=evidence(derived,[root,derived]);
 payload.outboundQuotes[0].provenance.roots[0].type='unknown';assert.equal(payload.outboundQuotes[0].provenance.roots[0].timeMeaning,'note_edited');
 const view=projectComposerEvidence(payload);assert.deepEqual(view.outboundQuotes[0].origin.originalRecords,[{speaker:'unknown',noteEditedAt:NOW}]);assert.equal(view.outboundQuotes[0].origin.originalRecords[0].recordedAt,undefined);
});

test('an assistant-authored original anchor retains generated attribution rather than becoming the fact subject or a user statement',()=>{
 const root=source('private:generated-root','她当时说周六下午有空。',{role:'assistant',at:OLD}),derived=note('note:generated-origin',[root]),{payload}=evidence(derived,[root,derived]),view=projectComposerEvidence(payload);
 assert.equal(payload.outboundQuotes[0].provenance.roots[0].role,'assistant');assert.deepEqual(view.outboundQuotes[0].origin.originalRecords,[{speaker:'assistant',recordedAt:OLD}]);assert.equal(view.outboundQuotes[0].text,FACT);
 assert.equal(Object.hasOwn(view.outboundQuotes[0].origin.originalRecords[0],'timeMeaning'),false);
});

test('a fresh authored note has no invented ancestry while declared unbound origins remain explicitly unknown',()=>{
 const authored=note('note:authored'),authoredOrigin=projectComposerEvidence(evidence(authored).payload).outboundQuotes[0].origin;
 assert.deepEqual(authoredOrigin,{speaker:'unknown',noteEditedAt:NOW,originalRecords:[],originalRecordsStatus:'not_applicable'});
 const root=source('private:legacy-parent','Old statement.'),legacy=note('note:legacy',[root]);delete legacy.evidenceRevisions;
 const unknown=projectComposerEvidence(evidence(legacy,[root,legacy]).payload).outboundQuotes[0].origin;assert.equal(unknown.noteEditedAt,NOW);assert.equal(unknown.originalRecordsStatus,'unknown');assert.deepEqual(unknown.originalRecords,[]);
});

test('invalid or absent original recording dates remain null instead of borrowing the note edit date or request time',()=>{
 for(const at of [undefined,null,'not-a-date','2026-02-30T10:00:00.000Z']){
  const root=source('private:undated','A statement with unknown recording time.',{at}),derived=note('note:known-edit',[root]),direct=projectComposerEvidence(evidence(root).payload).outboundQuotes[0].origin,origin=projectComposerEvidence(evidence(derived,[root,derived]).payload).outboundQuotes[0].origin;
  assert.deepEqual(direct,{speaker:'user',recordedAt:null});assert.equal(origin.noteEditedAt,NOW);assert.deepEqual(origin.originalRecords,[{speaker:'user',recordedAt:null}]);assert.equal(origin.originalRecordsStatus,'complete');
 }
});

test('partial anchor visibility preserves all eight visible originals and every canonical dependency beyond the cap',()=>{
 const roots=Array.from({length:12},(_,index)=>source('private:many-'+String(index).padStart(2,'0'),'ROOT_BODY_NOT_IN_MODEL_'+index,{at:new Date(Date.parse(OLD)+index*86400000).toISOString()})),derived=note('note:many-roots',roots),{payload,dependencies}=evidence(derived,[...roots,derived]),canonical=clone(payload),view=projectComposerEvidence(payload),origin=view.outboundQuotes[0].origin;
 assert.equal(origin.originalRecordsStatus,'partial');assert.equal(origin.originalRecords.length,8);assert.deepEqual(origin.originalRecords.map(item=>item.recordedAt),payload.outboundQuotes[0].provenance.roots.map(item=>item.recordedAt));
 assert.equal(dependencies.length,13);assert.equal(payload.outboundQuotes[0].provenance.rootCount,12);assert.deepEqual(payload,canonical);
 for(const item of origin.originalRecords)assert.deepEqual(Object.keys(item).sort(),['recordedAt','speaker']);assert.equal(JSON.stringify(view).includes('ROOT_BODY_NOT_IN_MODEL_'),false);
});

test('only composer evidence is projected in ordinary and repair requests; QQ, human/UI controls and e1 remain exact',()=>{
 const original=source('private:preserved-input'),{payload}=evidence(original);Object.assign(payload,{sources:[{id:'qq:actual',text:'对方今天说的原话。',role:'contact',revision:'qq-r1'}],currentHumanControl:{authority:'CONTROL_ONLY',sourceId:'private:human',text:HUMAN},selectedDirectionControl:{authority:'CONTROL_ONLY_UI_SELECTION',label:'我实际选择的方向。'},editingReference:{text:'真实旧稿，不独立证明事实。',kind:'message_candidate',bodyDigest:'private-existing-witness'},methodCards:[{id:'compose',version:'existing-method-version'}]});
 const before=clone(payload),wrapped={purpose:'draft',originalInput:payload,invalidResponse:'{"provenance":{"revision":"diagnostic-only"}}',formatError:'The original typed response was invalid.'},view=projectComposerEvidence(wrapped);
 assert.equal(view.originalInput.outboundQuotes[0].provenance,undefined);assert.deepEqual(view.originalInput.outboundQuotes[0].origin,{speaker:'user',recordedAt:OLD});
 for(const field of ['sources','currentHumanControl','selectedDirectionControl','editingReference','methodCards'])assert.deepEqual(view.originalInput[field],payload[field]);assert.equal(view.invalidResponse,wrapped.invalidResponse);assert.deepEqual(payload,before);
 const nonDraft={purpose:'review',outboundQuotes:clone(payload.outboundQuotes),arbitrary:{purpose:'draft',outboundQuotes:clone(payload.outboundQuotes)}};assert.deepEqual(projectComposerEvidence(nonDraft),nonDraft);assert.equal(projectComposerEvidence(null),null);
});

test('the same current human fact remains independently admitted while its full control-only context is unchanged',t=>{
 const app=fixture(t),current=app.prepared.payload.intentAuthority.sourceId,plan={...app.plan,quotes:[{sourceId:current,text:FACT}]},draft=buildDraftContext(app.prepared,plan,app.args),before=clone(draft.payload),request=prepareAssistantRequest(app.settings,draft.payload,undefined,{sourceRevisions:draft.manifest.sourceRevisions});
 assert.equal(request.wirePayload.outboundQuotes[0].text,FACT);assert.deepEqual(request.wirePayload.outboundQuotes[0].origin,{speaker:'user',recordedAt:NOW});assert.equal(request.wirePayload.currentHumanControl.text,HUMAN);assert.equal(request.wirePayload.currentHumanControl.authority,'CONTROL_ONLY');assert.equal(request.wirePayload.outboundQuotes.some(item=>item.text.includes('PRIVATE_CONTROL_CONTEXT')),false);assert.deepEqual(draft.payload,before);
});

test('actual serialized byte measurement and null probes use the compact wire rather than mutating the canonical evidence',async t=>{
 const app=fixture(t),before=clone(app.draft.payload),calls=[];assert.ok(prepareAssistantRequest(app.settings,null).requestBytes>0);const measured=prepareAssistantRequest(app.settings,app.draft.payload,undefined,{sourceRevisions:app.draft.manifest.sourceRevisions});
 assert.equal(measured.requestBytes,Buffer.byteLength(measured.serialized));assert.equal(measured.payloadWireBytes,measured.requestBytes-measured.envelopeBytes);assert.equal(JSON.stringify(measured.wirePayload.outboundQuotes).length<JSON.stringify(measured.payload.outboundQuotes).length,true);
 await assistModel(app.settings,app.draft,undefined,async(_url,args)=>{const request=JSON.parse(args.body),wire=JSON.parse(request.messages[1].content);calls.push({request,wire,bytes:Buffer.byteLength(args.body)});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'draft',text:'小葱今天多了两片新叶。',privateExplanation:'保留原话中的明确近况。'})}}]}),{status:200});});
 assert.equal(calls.length,1);assert.equal(calls[0].wire.outboundQuotes[0].provenance,undefined);assert.equal(calls[0].wire.outboundQuotes[0].text,FACT);assert.equal(app.draft.manifest.serializedTextRequestBytes,calls[0].bytes);assert.equal(calls[0].request.tool_choice.function.name,'draft_result');assert.ok(calls[0].request.tools[0].function.parameters.properties.privateExplanation);assert.deepEqual(app.draft.payload,before);
});
