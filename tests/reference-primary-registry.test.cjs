'use strict';
// Functional reference/range/authority handoff checks only. These do not rate
// permission semantics, wording quality, or desktop/E2E integration. The exact
// fictional canonical source below comes from actual023 long-history evidence:
// .goal-runs/context-023-candidate-live/coverage-long-private-consultation.run.json
// initial_diagnostics.snapshot.sources[1]. The old evidence is never rewritten.
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {PrimaryReferenceOwner,VERSION}=require('../src/primary-reference-registry.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {compilePrimaryFrame}=require('../src/primary-frame.cjs');
const {resolveDraftMaterial,assertDraftSourcesCurrent}=require('../src/context/draft-material.cjs');
const {parseRequestDelivery}=require('../src/request-delivery.cjs');
const {boundedSource}=require('../src/context/source-delivery.cjs');
const {scope}=require('./fixtures/native.cjs');
const ACTUAL023={"id":"private:lp-u0","type":"private","text":"我做的是给自己记读书笔记的小网页，不是公司项目，也没有替别人做商业网站。查找功能终于能按标题找回自己的摘记，这个小进展我愿意告诉她。我已经定下十月三日那个周六下午三点以后有空，也愿意在合适的时候让她看这个个人页面；之前的时段另有私事，不想解释给她。家里人的复查安排只在这里和你商量，不写进对外的话。平时可以直接说我自己的开心，不用把一个个人小项目包装成能力展示。","at":"2026-08-31T10:00:00.000Z","role":"user","use":"discussion","kind":"discussion","version":1,"revision":"cd55b0871967666658dfe29e12c36782df866a8d1a2fd264422207109c0b40a9"};
const CURRENT='private:current-primary',NOW='2026-10-01T10:25:00.000Z';
const AVAILABILITY='也愿意在合适的时候让她看这个个人页面；';
const clone=value=>structuredClone(value);
function source(id,text='Synthetic exact original.',extra={}){return {id,text,type:'private',role:'user',kind:'discussion',use:'discussion',revision:'rev-'+id,at:NOW,...extra};}
function input(sources=[],extra={}){const current=source(CURRENT,'这次想回应她的提问，帮我按已确认的真实内容写。');return {purpose:'discussion',asOf:NOW,draftMaterialPolicy:{version:1},requestDeliveryPolicy:{version:1},sources:[...sources,current],intentAuthority:{sourceId:CURRENT},userRequest:{sourceId:CURRENT,text:current.text},allowedMaterialIds:[],selectedMaterialIds:[],...extra};}
function owner(taskId='reference-primary-test',identity=scope){return new PrimaryReferenceOwner({scope:identity,taskId});}
function snapshot(payload,owned=owner()){const result=owned.preview(payload);result.commit();return result;}
function materialRef(snap,original,text=original.text,occurrence=0){let start=-1;for(let n=0;n<=occurrence;n++)start=original.text.indexOf(text,start+1);assert.ok(start>=0,'exact source span exists');const offset=original.delivery?.start||0,found=snap.receipt.materials.find(item=>item.sourceId===original.id&&item.start===offset+start&&item.end===offset+start+text.length);assert.ok(found,`offered exact span ${original.id}:${offset+start}..${offset+start+text.length}`);return found.materialRef;}
function programRef(snap,id){const found=snap.receipt.authorities.find(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.targetSourceId===id);assert.ok(found,`program source target ${id}`);return found.authorityRef;}
function statementRef(snap,id,ref){const found=snap.receipt.authorities.find(item=>item.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&item.sourceId===id&&(!ref||item.materialRef===ref));assert.ok(found,`original statement candidate ${id}`);return found.authorityRef;}
function canonicalQuote(snap,m,a){const material=snap.material(m),authorization=snap.authority(a,material);return {sourceId:material.sourceId,text:material.text,...(authorization?{authorization}:{})};}
function code(expected){return error=>error.code===expected;}
function segmentText(segment){
 if(Array.isArray(segment.parts)){assert.equal(Object.hasOwn(segment,'text'),false,'refined segments do not duplicate their readable body');return segment.parts.map(part=>Array.isArray(part)?part[1]:part.text).join('');}
 return segment.text;
}
const sourceText=view=>view.segments.map(segmentText).join('');
function programs(view){return Array.isArray(view.authorityChoices)?view.authorityChoices.filter(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'):(view.authorityChoices?.program||[]);}
function candidates(view){return Array.isArray(view.authorityChoices)?view.authorityChoices.filter(item=>item.kind==='ORIGINALUSERSTATEMENTCANDIDATE'):(view.authorityChoices?.originalUserStatementCandidates||[]);}
function anchors(snap,id){
 const view=snap.payload.sources.find(item=>item.id===id),result=new Map();
 for(const segment of view.segments){
  const captured=snap.receipt.materials.find(item=>item.materialRef===segment.materialRef);if(!captured||!segment.parts)continue;
  let offset=captured.start,lastAnchoredEnd;
  for(const [at,text]of segment.parts){if(at){result.set(at,offset);lastAnchoredEnd=offset+text.length;}offset+=text.length;}
  if(segment.endBoundary){assert.notEqual(lastAnchoredEnd,undefined);result.set(segment.endBoundary,lastAnchoredEnd);}
 }
 for(const [ref,offset]of result){const bound=snap.receipt.boundaries.find(item=>item.boundaryRef===ref);assert.equal(bound.sourceId,id);assert.equal(bound.offset,offset);}
 return result;
}
function refinement(snap,original,text,occurrence=0){
 let local=-1;for(let n=0;n<=occurrence;n++)local=original.text.indexOf(text,local+1);assert.ok(local>=0);
 const start=(original.delivery?.start||0)+local,end=start+text.length,boundaries=anchors(snap,original.id);
 const from=[...boundaries].find(([,offset])=>offset===start)?.[0],to=[...boundaries].find(([,offset])=>offset===end)?.[0];
 assert.ok(from,`offered start endpoint for ${text}`);assert.ok(to,`offered end endpoint for ${text}`);
 const parent=snap.receipt.materials.filter(item=>item.sourceId===original.id&&item.start<=start&&item.end>=end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];assert.ok(parent);
 return {ref:`${parent.materialRef}@${from}:${to}`,parent:parent.materialRef,from,to,start,end};
}

test('actual023 punctuation is restored by address with zero model-copied source text and no time freshening',()=>{
 assert.equal(createHash('sha256').update(JSON.stringify(ACTUAL023)).digest('hex'),'69b82d05d37e6ffb3f0c12e30d91fc48e309c5c3dfb0858973c96530be8d7c6e');
 assert.equal(createHash('sha256').update(ACTUAL023.text).digest('hex'),'368c1ea001cbce978c42d9a1a5f294f09022dfb9e1f17e23011e5d71f2db2dc8');
 const payload=input([clone(ACTUAL023)]),before=clone(payload),snap=snapshot(payload),m=materialRef(snap,ACTUAL023,AVAILABILITY);
 const current=payload.sources.find(item=>item.id===CURRENT),a=statementRef(snap,CURRENT,materialRef(snap,current));
 const modelChoice={materialRef:m,authorityRef:a},canonical=canonicalQuote(snap,modelChoice.materialRef,modelChoice.authorityRef);
 assert.equal(canonical.text,AVAILABILITY);assert.equal(canonical.text.endsWith('个人页面；'),true);assert.equal(canonical.sourceId,'private:lp-u0');
 assert.equal(canonical.authorization.referent.text,AVAILABILITY);assert.equal(JSON.stringify(modelChoice).includes(AVAILABILITY),false);
 assert.deepEqual(resolveDraftMaterial(payload,{quotes:[canonical]}).quotes,[{sourceId:ACTUAL023.id,text:AVAILABILITY}]);
 assert.equal(snap.payload.sources.find(item=>item.id===ACTUAL023.id).at,'2026-08-31T10:00:00.000Z');assert.deepEqual(payload,before);
});

test('delivered bodies occur once as labeled segments while additional material choices carry addresses only',()=>{
 const original=source('private:segments','第一句。第二句，补充；最后🙂。'),snap=snapshot(input([original])),view=snap.payload.sources.find(item=>item.id===original.id);
 assert.equal(Object.hasOwn(view,'text'),false);assert.equal(sourceText(view),original.text);
 for(const choice of view.materialChoices){assert.equal(Object.hasOwn(choice,'text'),false);assert.deepEqual(Object.keys(choice).sort(),Object.hasOwn(choice,'from')?['from','materialRef','to']:['end','materialRef','start']);}
 for(const choice of [...programs(view),...candidates(view)])assert.equal(Object.hasOwn(choice,'text'),false);
 assert.equal(snap.receipt.version,VERSION);assert.equal(JSON.stringify(snap.receipt).includes(original.text),false);
 for(const segment of view.segments){const captured=snap.receipt.materials.find(item=>item.materialRef===segment.materialRef);assert.ok(captured);assert.equal(original.text.slice(captured.start,captured.end),segmentText(segment));assert.equal(snap.material(segment.materialRef).text,segmentText(segment));}
 assert.equal(Object.isFrozen(snap),true);assert.equal(Object.isFrozen(snap.payload.sources[0].segments[0]),true);assert.equal(Object.isFrozen(snap.receipt.materials),true);
 assert.equal(Object.isFrozen(snap.material(materialRef(snap,original))),true);
 assert.throws(()=>{view.segments[0].text='changed';},TypeError);
});

test('identical text at different ranges and emoji retain distinct exact UTF16 addresses',()=>{
 const original=source('private:repeated','一样。一样。🙂尾巴。'),snap=snapshot(input([original]));
 const first=materialRef(snap,original,'一样。',0),second=materialRef(snap,original,'一样。',1),emoji=materialRef(snap,original,'🙂尾巴。');
 assert.notEqual(first,second);assert.equal(snap.material(first).text,'一样。');assert.equal(snap.material(second).text,'一样。');assert.equal(snap.material(emoji).text,'🙂尾巴。');
 assert.deepEqual(snap.receipt.materials.filter(item=>[first,second,emoji].includes(item.materialRef)).map(({start,end})=>[start,end]),[[0,3],[3,6],[6,11]]);
});

test('partial UTF16 delivery addresses only the delivered body and cannot expose hidden prefix or suffix',()=>{
 const full=source('private:partial','HIDDEN_PREFIX。🙂可见。HIDDEN_SUFFIX。'),start=full.text.indexOf('🙂'),partial=boundedSource(full,{start,maxChars:'🙂可见。'.length,maxBytes:10000});
 const payload=input([partial]),snap=snapshot(payload),m=materialRef(snap,partial,'🙂可见。'),view=snap.payload.sources.find(item=>item.id===full.id);
 assert.equal(snap.material(m).text,'🙂可见。');assert.equal(snap.receipt.materials.find(item=>item.materialRef===m).start,start);
 assert.equal(sourceText(view),'🙂可见。');assert.equal(JSON.stringify(view).includes('HIDDEN_PREFIX'),false);assert.equal(JSON.stringify(view).includes('HIDDEN_SUFFIX'),false);
 assert.equal(snap.receipt.materials.filter(item=>item.sourceId===full.id).every(item=>item.start>=partial.delivery.start&&item.end<=partial.delivery.end),true);
 assert.equal(snap.receipt.authorities.some(item=>item.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&item.sourceId===full.id),false,'partial source context cannot become original permission');
 const invalid=clone(partial);invalid.delivery.end++;const malformed=snapshot(input([invalid]));assert.equal(malformed.receipt.materials.some(item=>item.sourceId===full.id),false);
});

test('preview is pure, discarded budgets do not allocate handles, and only dispatched offers commit',()=>{
 const own=owner(),a=source('private:budget-a','A。'),b=source('private:budget-b','B。'),discarded=own.preview(input([b,a]));
 assert.equal(own.size,0);assert.throws(()=>discarded.material(discarded.receipt.materials[0].materialRef),code('primary_reference_not_dispatched'));
 const dispatched=own.preview(input([a]));assert.equal(dispatched.receipt.materials[0].materialRef,'m1');dispatched.commit();const size=own.size;
 assert.ok(size>0);dispatched.commit();assert.equal(own.size,size);assert.throws(()=>discarded.commit(),code('primary_reference_offer_changed'));
 assert.equal(own.size,size);assert.equal(JSON.stringify(own),'{}');
});

test('same-task lookup, repair rebuild and resume preserve exact range handles without offering old bodies',()=>{
 const own=owner(),a=source('private:stable','A。B。'),first=snapshot(input([a]),own),ref=materialRef(first,a,'A。'),b=source('private:new','NEW_BODY_SENTINEL。');
 const rebuilt=snapshot({purpose:'discussion',originalInput:input([b,a]),invalidResponse:'unchanged diagnostic'},own);
 assert.equal(materialRef(rebuilt,a,'A。'),ref);assert.equal(own.matches(scope,'reference-primary-test'),true);
 const resumed=snapshot(input([b]),own);assert.throws(()=>resumed.material(ref),code('unknown_material_reference'));
 assert.equal(resumed.payload.sources.some(item=>item.id===a.id),false);assert.equal(JSON.stringify(resumed.receipt).includes(a.text),false);
 assert.equal(JSON.stringify(own).includes('NEW_BODY_SENTINEL'),false);
});

test('unknown, revision-stale and foreign handles cannot redirect a current offer',()=>{
 const own=owner(),original=source('private:revision','Original。'),first=snapshot(input([original]),own),old=materialRef(first,original),changed={...original,revision:'new-revision',text:'Changed。'};
 const next=snapshot(input([changed]),own);assert.notEqual(materialRef(next,changed),old);
 for(const ref of [old,'m99999',original.id,{materialRef:old}])assert.throws(()=>next.material(ref),code('unknown_material_reference'));
 for(const key of ['accountUid','accountUin','peerUid','peerUin']){
  assert.equal(own.matches({...scope,[key]:'other'},'reference-primary-test'),false);
  assert.throws(()=>own.preview(input([{...original,scope:{...scope,[key]:'other'}}])),code('primary_reference_scope_invalid'));
 }
 assert.equal(own.matches(scope,'another-task'),false);
});

test('late source revision, withdrawal and scope changes retain the existing strict handoff fence',()=>{
 const original=source('private:late-fence','A。'),snap=snapshot(input([original])),material=snap.material(materialRef(snap,original));
 const prepared={manifest:{sourceRevisions:{[original.id]:material.revision}}};assert.doesNotThrow(()=>assertDraftSourcesCurrent(prepared,[original.id],{scope,availableSources:[original]}));
 for(const patch of [{revision:'changed'},{deleted:true},{excluded:true},{use:'disabled'},{scope:{...scope,peerUid:'foreign'}}])assert.throws(()=>assertDraftSourcesCurrent(prepared,[original.id],{scope,availableSources:[{...original,...patch}]}),/来源版本已变化/);
 assert.throws(()=>assertDraftSourcesCurrent(prepared,[original.id],{scope,availableSources:[]}),/来源版本已变化/);
});

test('program authority for QQ and allowed notes is target bound while generic current identity remains a statement candidate',()=>{
 const qq=source('qq:actual','Actual incoming。',{type:'qq',role:'contact'}),note=source('note:allowed','Allowed note。',{type:'note',role:undefined,use:'draft'}),privateOnly=source('private:unapproved','Private only。');
 const payload=input([qq,note,privateOnly],{allowedMaterialIds:[note.id]}),snap=snapshot(payload),foreignMaterial=snap.material(materialRef(snap,privateOnly));
 for(const id of [qq.id,note.id]){
  const original=payload.sources.find(item=>item.id===id),material=snap.material(materialRef(snap,original)),a=programRef(snap,id);
  assert.equal(snap.authority(a,material),undefined);assert.throws(()=>snap.authority(a,foreignMaterial),code('authority_target_mismatch'));
 }
 assert.equal(snap.receipt.authorities.some(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.targetSourceId===CURRENT),false);
 assert.ok(statementRef(snap,CURRENT));
 assert.equal(snap.receipt.authorities.some(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.targetSourceId===privateOnly.id),false);
 assert.throws(()=>snap.authority(programRef(snap,qq.id),clone(snap.material(materialRef(snap,qq)))),code('material_reference_binding_invalid'));
});

test('an exact selected UI tuple authorizes its exact fragment rather than neighboring material',()=>{
 const original=source('private:selected','保留这一段，不采用另一段。'),chosen='保留这一段',payload=input([original],{selectedOption:{turnId:'selected-ui',index:0},expressionOptions:[{turnId:'selected-ui',index:0,quotes:[{sourceId:original.id,text:chosen,revision:original.revision}]}]});
 const snap=snapshot(payload),m=materialRef(snap,original,chosen),a=snap.receipt.authorities.find(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.materialRef===m);
 assert.ok(a);assert.equal(snap.authority(a.authorityRef,snap.material(m)),undefined);
 assert.throws(()=>snap.authority(a.authorityRef,snap.material(materialRef(snap,original))),code('authority_target_mismatch'));
});

test('statement candidates keep complete quoted, negated, conditional and unrelated context without becoming semantic grants',()=>{
 for(const text of ['他说“可以告诉她”，但这不是我的意思。','我不愿意把这件事告诉她。','如果以后确认合适才告诉她，现在还没确认。','这只是在讨论另一个人的安排。']){
  const original=source('private:statement-context',text),snap=snapshot(input([original])),view=snap.payload.sources.find(item=>item.id===original.id);
  assert.equal(sourceText(view),text);const a=statementRef(snap,original.id,materialRef(snap,original));
  assert.equal(snap.receipt.authorities.find(item=>item.authorityRef===a).kind,'ORIGINALUSERSTATEMENTCANDIDATE');
  assert.equal(programs(view).length,0);assert.ok(candidates(view).length>0);
  if(!Array.isArray(view.authorityChoices))assert.equal(view.authorityChoices.candidateMeaning,'ORIGINALUSERSTATEMENTCANDIDATE_NOT_GRANT');
  // No test treats a matching candidate string as proof of semantic permission.
 }
});

test('historical unread, partial, generated and control sources cannot supply original permission',()=>{
 const cases=[source('private:historical','Old permission。',{historicalOnly:true}),
  source('private:partial-permission','许可片段',{delivery:{status:'partial',start:3,end:7,originalCharLength:12}}),
  source('private:assistant','Generated。',{role:'assistant'}),source('private:control','Control。',{kind:'user_control'}),source('feedback:continue','Continue。',{type:'feedback',kind:'feedback_continue'})];
 for(const original of cases){const snap=snapshot(input([original]));assert.equal(snap.receipt.authorities.some(item=>item.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&item.sourceId===original.id),false,original.id);}
});

test('disabled, withdrawn and explicitly private note material cannot bypass unchanged admission predicates',()=>{
 for(const patch of [{use:'disabled'},{deleted:true},{excluded:true}]){
  const note=source('note:hard-deny','Do not export。',{type:'note',use:'draft',...patch}),snap=snapshot(input([note],{allowedMaterialIds:[note.id]}));
  assert.equal(snap.receipt.materials.some(item=>item.sourceId===note.id),false);assert.equal(snap.receipt.authorities.some(item=>item.targetSourceId===note.id),false);
 }
 const note=source('note:discussion-only','PRIVATE_NOTE_SENTINEL。',{type:'note',use:'discussion'}),payload=input([note],{allowedMaterialIds:[note.id],privateRestrictions:[{sourceId:note.id,text:note.text}]}),snap=snapshot(payload);
 const q=canonicalQuote(snap,materialRef(snap,note),programRef(snap,note.id));assert.throws(()=>resolveDraftMaterial(payload,{quotes:[q]}),/私下讨论/);
});

test('current delivery binds the trusted intent rather than the first source and rejects conflicting legacy bindings',()=>{
 const decoy=source('private:first','A different first statement。'),payload=input([decoy]),snap=snapshot(payload),current=payload.sources.find(item=>item.id===CURRENT);
 assert.deepEqual(snap.currentDelivery({mode:'private_help'}),{mode:'private_help',sourceId:CURRENT,quote:current.text});
 assert.deepEqual(snap.currentDelivery({mode:'editable_message'}),{mode:'editable_message',sourceId:CURRENT,quote:current.text});
 assert.throws(()=>parseRequestDelivery({kind:'discussion',text:'Private help.',requestDelivery:snap.currentDelivery({mode:'private_help'}),draftPlan:{quotes:[],intent:'reply'}},payload),code('request_delivery_unfulfilled'),'binding a current identity does not let private_help enter an outward plan');
 for(const legacy of [{mode:'private_help',sourceId:decoy.id},{mode:'private_help',quote:decoy.text},{mode:'private_help',sourceId:CURRENT,quote:current.text}])assert.throws(()=>snap.currentDelivery(legacy),code('request_delivery_reference_invalid'));
 const material=snap.material(materialRef(snap,decoy));assert.throws(()=>resolveDraftMaterial(payload,{quotes:[{sourceId:material.sourceId,text:material.text}]}),error=>error.code==='draft_material_authorization_missing','current delivery identity alone grants no unrelated private material');
});

test('quotes and expression options use the same required material and authority reference shape',()=>{
 const note=source('note:uniform','Exact note。',{type:'note',use:'draft'}),payload=input([note],{allowedMaterialIds:[note.id]}),snap=snapshot(payload),choice={materialRef:materialRef(snap,note),authorityRef:programRef(snap,note.id)};
 const compiled=compilePrimaryFrame({draftPlan:{quotes:[choice]},expressionOptions:[{label:'A choice',quotes:[choice]}]},snap,payload);
 assert.deepEqual(compiled.draftPlan.quotes,[{sourceId:note.id,text:note.text}]);assert.deepEqual(compiled.expressionOptions[0].quotes,compiled.draftPlan.quotes);
 for(const field of ['draftPlan','expressionOptions'])for(const bad of [{materialRef:choice.materialRef},{authorityRef:choice.authorityRef},{...choice,text:'MODEL_COPIED_TEXT'}, {sourceId:note.id,text:note.text}]){
  const raw=field==='draftPlan'?{draftPlan:{quotes:[bad]}}:{expressionOptions:[{label:'A choice',quotes:[bad]}]};assert.throws(()=>compilePrimaryFrame(raw,snap,payload));
 }
});

test('private canonical marks prevent double parsing and cannot rebind across HTTP offers',()=>{
 const payload=input(),own=owner(),first=snapshot(payload,own),value={kind:'discussion',text:'Private help.'};
 assert.equal(first.isCanonical(value),false);const before=JSON.stringify(value);assert.equal(first.markCanonical(value),value);assert.equal(first.isCanonical(value),true);assert.equal(JSON.stringify(value),before);
 assert.equal(first.isCanonical(clone(value)),false);const second=snapshot(payload,own);
 assert.throws(()=>second.isCanonical(value),code('primary_reference_binding_invalid'));assert.throws(()=>second.markCanonical(value),code('primary_reference_binding_invalid'));
 const current=payload.sources.find(item=>item.id===CURRENT),material=first.material(materialRef(first,current));assert.throws(()=>second.authority(statementRef(second,CURRENT),material),code('material_reference_binding_invalid'));
 assert.equal(first.isCanonical(value),true);
});

test('source aliases stay distinct from material handles while quoted literal IDs and bodies remain unchanged',()=>{
 const original=source('private:literals','Literal m1, a1, s1 and private:canonical stay quoted。'),payload=input([original]),before=clone(payload),primary=snapshot(payload);
 const sourceOwner=new SourceHandleOwner({scope,taskId:'reference-primary-test'}),wire=sourceOwner.preview(primary.payload,{sources:payload.sources});wire.commit();
 const row=wire.wirePayload.sources.find(item=>item.segments.some(segment=>segmentText(segment).includes('Literal')));
 assert.match(row.id,/^s\d+$/);assert.equal(sourceText(row),original.text);assert.match(row.segments[0].materialRef,/^m\d+$/);
 assert.equal(primary.material(materialRef(primary,original)).sourceId,original.id);assert.deepEqual(payload,before);
});

test('offered interior endpoints select a general cross-comma phrase without copying source text',()=>{
 const target='我对她有好感，想多认识她',original=source('private:interior','私下说明：'+target+'，但这段理由留在这里。'),payload=input([original]),snap=snapshot(payload),selected=refinement(snap,original,target);
 assert.equal(snap.receipt.materials.some(item=>item.sourceId===original.id&&item.start===selected.start&&item.end===selected.end),false,'the phrase is an interior range, not a prewritten fixture choice');
 const choice={materialRef:selected.ref,authorityRef:statementRef(snap,CURRENT)},canonical=canonicalQuote(snap,choice.materialRef,choice.authorityRef);
 assert.equal(canonical.text,target);assert.equal(canonical.authorization.referent.text,target);assert.equal(JSON.stringify(choice).includes(target),false);
 assert.equal(sourceText(snap.payload.sources.find(item=>item.id===original.id)),original.text);
 assert.deepEqual(resolveDraftMaterial(payload,{quotes:[canonical]}).quotes,[{sourceId:original.id,text:target}]);
});

test('refined endpoints reject unknown, foreign, reversed, zero-length and outside-parent ranges',()=>{
 const original=source('private:endpoint-a','开头提醒：我对她有好感，想多认识她，但不写私人理由。'),other=source('private:endpoint-b','Other readable words here。'),snap=snapshot(input([original,other]));
 const selected=refinement(snap,original,'我对她有好感，想多认识她'),foreign=[...anchors(snap,other.id).keys()],firstAtom=snap.payload.sources.find(item=>item.id===original.id).segments[0].materialRef;
 assert.ok(foreign.length>=2);assert.throws(()=>snap.material(`${selected.parent}@b999999:b999998`),code('material_reference_boundary_invalid'));
 assert.throws(()=>snap.material(`${selected.parent}@${foreign[0]}:${foreign[1]}`),code('material_reference_boundary_invalid'));
 assert.throws(()=>snap.material(`${selected.parent}@${selected.to}:${selected.from}`),code('material_reference_boundary_invalid'));
 assert.throws(()=>snap.material(`${selected.parent}@${selected.from}:${selected.from}`),code('material_reference_boundary_invalid'));
 assert.throws(()=>snap.material(`${firstAtom}@${selected.from}:${selected.to}`),code('material_reference_boundary_invalid'));
 assert.throws(()=>snap.material(`m999999@${selected.from}:${selected.to}`),code('unknown_material_reference'));
 const material=snap.material(selected.ref);assert.throws(()=>snap.authority(`${statementRef(snap,CURRENT)}@${selected.from}:${selected.to}`,material),code('unknown_authority_reference'),'original permission context cannot itself be endpoint-refined');
});

test('emoji and repeated interior text keep distinct ranges with no offered surrogate-splitting boundary',()=>{
 const original=source('private:unicode-interior','先说🙂 coffee 再说👩‍💻 work 最后🙂 coffee。'),snap=snapshot(input([original])),a=refinement(snap,original,'🙂 coffee',0),b=refinement(snap,original,'🙂 coffee',1),zwj=refinement(snap,original,'👩‍💻 work');
 assert.notEqual(a.ref,b.ref);assert.equal(snap.material(a.ref).text,'🙂 coffee');assert.equal(snap.material(b.ref).text,'🙂 coffee');assert.equal(snap.material(zwj.ref).text,'👩‍💻 work');
 for(const offset of anchors(snap,original.id).values())assert.equal(/[\uDC00-\uDFFF]/u.test(original.text[offset]||''),false,'readable anchors never address a low surrogate');
 assert.throws(()=>snap.material(`${a.parent}@utf16_${a.start+1}:${a.to}`),error=>['unknown_material_reference','material_reference_boundary_invalid'].includes(error.code));
});

test('partial-body refinement stays within delivered endpoints and never exposes hidden neighboring text',()=>{
 const full=source('private:partial-refinement','HIDDEN_PREFIX。开始我对她有好感，想多认识她，结束。HIDDEN_SUFFIX。'),start=full.text.indexOf('开始'),partial=boundedSource(full,{start,maxChars:'开始我对她有好感，想多认识她，结束。'.length,maxBytes:10000}),snap=snapshot(input([partial]));
 const selected=refinement(snap,partial,'我对她有好感，想多认识她'),material=snap.material(selected.ref),view=snap.payload.sources.find(item=>item.id===full.id);
 assert.equal(material.text,'我对她有好感，想多认识她');assert.ok(selected.start>=partial.delivery.start&&selected.end<=partial.delivery.end);
 assert.equal(sourceText(view),partial.text);assert.equal(JSON.stringify(view).includes('HIDDEN_PREFIX'),false);assert.equal(JSON.stringify(view).includes('HIDDEN_SUFFIX'),false);
 for(const offset of anchors(snap,full.id).values())assert.ok(offset>=partial.delivery.start&&offset<=partial.delivery.end);
});

test('endpoint coverage is explicitly capped while unanchored source text remains readable once with a lookup route',()=>{
 const original=source('private:many-words','alpha beta gamma delta '.repeat(40)+'end。'),snap=snapshot(input([original])),view=snap.payload.sources.find(item=>item.id===original.id);
 assert.equal(view.refinementCoverage.status,'partial');assert.equal(view.refinementCoverage.maxParts,32);assert.equal(sourceText(view),original.text);
 assert.equal(view.segments.some(segment=>segment.parts?.some(([at])=>at===null)),true);
 const lookup=view.refinementCoverage.lookup;assert.equal(lookup.sourceId,original.id);assert.ok(Number.isSafeInteger(lookup.offset)&&lookup.offset>0&&lookup.offset<original.text.length);assert.ok(lookup.maxChars>0);
 assert.ok(anchors(snap,original.id).size<=33);assert.equal(JSON.stringify(snap.receipt).includes(original.text),false);
});

test('endpoint previews allocate no committed state and discarded probes cannot rebind a later offer',()=>{
 const own=owner(),original=source('private:stable-endpoints','开头我对她有好感，想多认识她，结束。'),discarded=own.preview(input([source('private:probe','Probe words。'),original]));
 assert.equal(own.size,0);const first=snapshot(input([original]),own),ref=refinement(first,original,'我对她有好感，想多认识她').ref,size=own.size;
 own.preview(input([source('private:another-probe','Different words。'),original]));assert.equal(own.size,size);
 const rebuilt=snapshot(input([original]),own);assert.equal(refinement(rebuilt,original,'我对她有好感，想多认识她').ref,ref);assert.throws(()=>discarded.commit(),code('primary_reference_offer_changed'));
 const changed={...original,revision:'new-endpoint-version'},next=snapshot(input([changed]),own);assert.throws(()=>next.material(ref),code('unknown_material_reference'));
});

test('an exact selected UI authority cannot broaden or narrow through an otherwise valid refined material',()=>{
 const original=source('private:selected-refinement','开头我对她有好感，想多认识她，结束。'),chosen='我对她有好感，想多认识她',payload=input([original],{selectedOption:{turnId:'endpoint-ui',index:0},expressionOptions:[{turnId:'endpoint-ui',index:0,quotes:[{sourceId:original.id,text:chosen,revision:original.revision}]}]}),snap=snapshot(payload);
 const exact=materialRef(snap,original,chosen),a=snap.receipt.authorities.find(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.materialRef===exact);assert.ok(a);
 assert.equal(snap.authority(a.authorityRef,snap.material(exact)),undefined);
 const narrower=snap.material(refinement(snap,original,'我对她有好感').ref);assert.throws(()=>snap.authority(a.authorityRef,narrower),code('authority_target_mismatch'));
 assert.throws(()=>snap.authority(a.authorityRef,snap.material(materialRef(snap,original))),code('authority_target_mismatch'));
});

test('negation beyond the endpoint cap remains in complete candidate context rather than becoming a prefix grant',()=>{
 const tail='但是我不愿意把这件事告诉她，前面的只是引用。',original=source('private:tail-negation','quoted background words '.repeat(30)+tail),payload=input([original]),snap=snapshot(payload),view=snap.payload.sources.find(item=>item.id===original.id);
 assert.equal(view.refinementCoverage.status,'partial');assert.equal(sourceText(view),original.text);assert.equal(sourceText(view).endsWith(tail),true);
 const full=materialRef(snap,original),a=statementRef(snap,original.id,full),candidate=snap.receipt.authorities.find(item=>item.authorityRef===a);
 assert.equal(candidate.kind,'ORIGINALUSERSTATEMENTCANDIDATE');assert.equal(programs(view).length,0);
 const addressed=snap.material(full),authorization=snap.authority(a,addressed);
 assert.equal(authorization.permission.text,original.text);assert.equal(authorization.permission.text.endsWith(tail),true);
 assert.throws(()=>snap.authority(`${a}@b1:b2`,addressed),code('unknown_authority_reference'));
 // This preserves the decisive context for interpretation; it does not assert
 // that the mechanical resolver can judge the meaning of this negation.
});

test('an opposite statement returned by lookup preserves its own full context and cannot reuse the prior offer',()=>{
 const own=owner(),earlier=source('private:lookup-opposite','我愿意告诉她这个进展。'),first=snapshot(input([earlier]),own),oldM=materialRef(first,earlier),oldA=statementRef(first,earlier.id,oldM);
 const opposite={...earlier,revision:'lookup-opposite-new-revision',text:'更正：我现在不愿意告诉她这个进展；之前的想法已经撤回。'},next=snapshot(input([opposite]),own),view=next.payload.sources.find(item=>item.id===opposite.id);
 assert.equal(sourceText(view),opposite.text);assert.equal(programs(view).length,0);
 assert.throws(()=>next.material(oldM),code('unknown_material_reference'));
 const material=next.material(materialRef(next,opposite));assert.throws(()=>next.authority(oldA,material),code('unknown_authority_reference'));
 const a=statementRef(next,opposite.id,materialRef(next,opposite)),authorization=next.authority(a,material);
 assert.equal(authorization.permission.text,opposite.text);assert.equal(authorization.referent.text,opposite.text);
 assert.equal(next.receipt.authorities.find(item=>item.authorityRef===a).kind,'ORIGINALUSERSTATEMENTCANDIDATE');
});
