'use strict';
// Scripted semantic decisions test authority/lifecycle, never output quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {buildFidelityContext,parseFidelityResult,deliveryFor,approvalFor,incompleteFidelity}=require('../src/whole-answer-fidelity.cjs');
const {PrimaryReferenceOwner}=require('../src/primary-reference-registry.cjs');
const {compilePrimaryFrame}=require('../src/primary-frame.cjs');
const {mapSourceReferences}=require('../src/source-handles.cjs');
const {projectVisibleTurn}=require('../scripts/eval-qq-adapter.cjs');
const {Store}=require('../src/store.cjs'),{scope}=require('./fixtures/native.cjs');
const captures=require('./fixtures/semantic-audit-029.json');
const FACT='我今天修好了自己的台灯。',PERMISSION='这件小进展可以告诉她。',SECRET='家人的检查安排只在这里说。';
function fixture({copy=FACT,admitted=[],extra=[]}={}){
 const source={id:'private:fact-with-separate-permission',type:'private',role:'user',kind:'discussion',text:FACT+PERMISSION+SECRET,revision:'fact-permission-r1',at:'2026-10-29T10:00:00Z'},sources=[source,...extra],manifest={scope:{...scope},requestId:'manual-help-authority',sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision]))},prepared={payload:{purpose:'discussion',sources,intentAuthority:{sourceId:source.id}},manifest,fullAvailableSources:sources},result={kind:'draft',text:'',suggestions:[{text:copy,style:'自然'}]};
 const input=buildFidelityContext(prepared,result,{scope,admittedContext:{payload:{outboundQuotes:admitted.map(text=>({sourceId:source.id,text}))},manifest},requestMeasure:()=>1});return {input,prepared,result,source};
}
const report=(issues=[],concerns=[])=>({checkRef:'c1',auditProtocol:'sparse-defects-v1',issues,concerns});
const defect=(code= 'unsupported_fact',quote=FACT,evidence=[])=>({path:'suggestions[0].text',quote,code,reason:'A scripted concrete defect for this exact candidate.',...(evidence.length?{evidence}:{})});

test('sparse no-defect report is a bounded review, never an exhaustive semantic approval',()=>{
 const app=fixture({admitted:[FACT]}),checked=parseFidelityResult(report(),app.input),receipt=deliveryFor(checked,app.input);
 assert.equal(receipt.reviewStatus,'reviewed');assert.equal(receipt.exhaustive,false);assert.equal(approvalFor(checked,app.input),undefined);assert.equal(checked.verdict,'no_concrete_defect_reported');assert.equal(app.input.manifest.fidelity.exhaustive,false);
});
test('a valid concrete fabrication finding survives a malformed adjacent finding and extra metadata',()=>{
 const app=fixture(),good={...defect(),extraOptional:'cannot erase the real defect'},bad={...defect(),path:'not-offered'};
 const checked=parseFidelityResult({...report([bad,good]),verdict:'allow'},app.input);
 assert.equal(checked.issues.length,1);assert.equal(checked.issues[0].code,'unsupported_fact');assert.equal(checked.reviewStatus,'incomplete');assert.ok(deliveryFor(checked,app.input).findings.some(item=>item.kind==='reported_defect'));
});
test('unavailable or malformed audit yields an honest incomplete receipt, not allow',()=>{
 for(const value of ['not JSON',{checkRef:'c1',verdict:'allow',issues:[]}]){
  const app=fixture(),checked=parseFidelityResult(value,app.input);
  assert.equal(checked.reviewStatus,'incomplete');assert.equal(deliveryFor(checked,app.input).reviewStatus,'incomplete');assert.equal(approvalFor(checked,app.input),undefined);
 }
});
test('private interpretation and condition uncertainty stay diagnostic, not factual proof',()=>{
 const app=fixture(),checked=parseFidelityResult(report([],[{path:'suggestions[0].text',code:'interpretation',reason:'An open interpretation is uncertain.'}]),app.input);
 assert.equal(checked.issues.length,0);assert.equal(checked.concerns.length,1);assert.ok(deliveryFor(checked,app.input));
});
test('same source admission never licenses a second unadmitted private fact',()=>{
 const app=fixture({copy:SECRET,admitted:[FACT]}),checked=parseFidelityResult(report([defect('private_disclosure',SECRET,[{sourceId:app.source.id,quote:SECRET}])]),app.input);
 assert.equal(checked.issues[0].code,'private_disclosure');assert.ok(deliveryFor(checked,app.input).findings.some(item=>item.kind==='reported_defect'));
});
test('program-authorized QQ cannot acquire invented privacy, newer private exclusion remains a separate witness',()=>{
 const qq={id:'qq:910000000000000123',type:'qq',role:'contact',revision:'qq-r1',text:'今天培训一整天。'},restriction={id:'private:new-exclusion',type:'private',kind:'discussion',role:'user',revision:'restriction-r1',text:'培训这件事只作背景，这轮别向她提。'};
 for(const exclude of [false,true]){
  const app=fixture({copy:qq.text,extra:[qq,...(exclude?[restriction]:[])]}),checked=parseFidelityResult(report([defect('private_disclosure',qq.text,[{sourceId:qq.id,quote:qq.text},...(exclude?[{sourceId:restriction.id,quote:restriction.text}]:[])])]),app.input);
  assert.equal(checked.issues.length,exclude?1:0);assert.equal(deliveryFor(checked,app.input).findings.length,exclude?1:0);
 }
});
test('incomplete audit cannot bypass candidate/evidence/account binding or cross-frame reuse',()=>{
 for(const mutation of ['candidate','source','account']){
  const app=fixture(),checked=incompleteFidelity(app.input,Error('scripted unavailable'));
  if(mutation==='candidate')app.result.suggestions[0].text+='changed';
  if(mutation==='source')app.prepared.manifest.sourceRevisions[app.source.id]='new-rv';
  if(mutation==='account')app.prepared.manifest.scope.accountUid='another-account';
  assert.throws(()=>deliveryFor(checked,app.input),error=>error.code==='fidelity_binding_invalid');
 }
 const a=fixture(),b=fixture(),checked=incompleteFidelity(a.input,'unavailable');assert.equal(deliveryFor(checked,b.input),undefined);
});
test('a chosen fact and permission remain separate exact spans, not same-source blanket authority',()=>{
 const app=fixture(),owner=new PrimaryReferenceOwner({scope,taskId:'fact-permission-spans'}),payload={purpose:'discussion',sources:[app.source],intentAuthority:{sourceId:'private:another-current'}},snapshot=owner.preview(payload,{foreground:true}),view=snapshot.payload.sources[0],whole=view.materialChoices.find(item=>item.from===view.segments[0].materialRef&&item.to===view.segments.at(-1).materialRef),authority=view.authorityChoices.originalUserStatementCandidates[0].authorityRef;snapshot.commit();
 const decoded=compilePrimaryFrame({materials:[{materialRef:whole.materialRef,authorityRef:authority,factQuote:FACT,permissionQuote:PERMISSION}]},snapshot,payload),q=decoded.materials[0];
 assert.equal(q.text,FACT);assert.equal(q.authorization.permission.text,PERMISSION);assert.equal(q.authorization.referent.text,FACT);
 assert.throws(()=>compilePrimaryFrame({materials:[{materialRef:view.segments[1].materialRef,authorityRef:authority,factQuote:SECRET,permissionQuote:PERMISSION}]},snapshot,payload),/factQuote|fact span|material/i);
 assert.throws(()=>compilePrimaryFrame({materials:[{materialRef:whole.materialRef,authorityRef:authority,factQuote:FACT,permissionQuote:'invented permission'}]},snapshot,payload),/permission/i);
});
for(const [key,saved]of Object.entries(captures))test(`actual029 ${key}: old census/uncertainty cannot masquerade as native sparse approval`,()=>{
 const sources=saved.payload.evidence.map(({sourceId,...s})=>({id:sourceId,...s,revision:saved.sourceRevisions[sourceId]})),manifest={scope:saved.scope,requestId:'capture-'+key,sourceIds:sources.map(s=>s.id),sourceRevisions:saved.sourceRevisions},prepared={payload:{purpose:'discussion',sources,intentAuthority:saved.payload.intentAuthority},manifest,fullAvailableSources:sources},input=buildFidelityContext(prepared,saved.payload.candidate,{scope:saved.scope,admittedContext:{payload:{outboundQuotes:saved.payload.admittedFragments},manifest},requestMeasure:()=>1}),bindings=new Map(saved.sourceHandles.bindings.map(s=>[s.handle,s.sourceId])),decoded=mapSourceReferences(saved.raw,id=>bindings.get(id)||id),checked=parseFidelityResult(decoded,input);
 assert.deepEqual(input.payload.candidate,saved.payload.candidate);assert.equal(checked.reviewStatus,'incomplete');assert.equal(approvalFor(checked,input),undefined);assert.ok(checked.diagnostics.length);
 if(!checked.issues.length)assert.equal(deliveryFor(checked,input).reviewStatus,'incomplete');
});
test('stored incomplete review and UI projection expose the exact bounded notice',()=>{
 const store=new Store(':memory:');try{
  const app=fixture(),receipt=deliveryFor(incompleteFidelity(app.input,'unavailable'),app.input),turn=store.appendTurn(scope,{role:'assistant',kind:'draft',text:'',suggestions:[{text:FACT}],semanticReview:{status:receipt.reviewStatus,candidateHash:receipt.candidateHash,bindingHash:receipt.bindingHash,exhaustive:false}}),again=store.getCompanion(scope).turns.find(t=>t.id===turn.id);
  assert.equal(again.semanticReview.status,'incomplete');assert.deepEqual(projectVisibleTurn(again).notices,[{text:'建议已生成；本次内容核对未完成，采用前请确认具体事实和私下信息。'}]);
  assert.throws(()=>store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Bad false guarantee',semanticReview:{...again.semanticReview,exhaustive:true}}),/audit/i);
 }finally{store.close();}
});

test('native wire decoding cannot let unrelated source references erase a valid fabrication finding',()=>{
 const {SourceHandleOwner}=require('../src/source-handles.cjs');
 for(const noise of [{extra:{sourceId:'s999'}},{reason:{sourceId:'s999'}},{related:{sourceId:'s999',path:'absent'}},{evidence:[{sourceId:'s999',quote:'irrelevant for no-support finding'}]}]){
  const app=fixture(),wire=new SourceHandleOwner({scope,taskId:'wire-hard-finding'}).preview(app.input.payload,{sourceRevisions:app.input.manifest.sourceRevisions});wire.commit();Object.defineProperty(app.input,'sourceWireSnapshot',{value:wire});
  const checked=parseFidelityResult(report([{...defect(),...noise}]),app.input);
  assert.equal(checked.issues.length,1);assert.equal(checked.issues[0].code,'unsupported_fact');assert.ok(deliveryFor(checked,app.input).findings.some(item=>item.kind==='reported_defect'));
 }
});
test('malformed historical census containers cannot erase an already valid native hard finding',()=>{
 for(const factual of [[{path:'suggestions[0].text',statements:{}}],[null],[{statements:[null,{}]}]]){
  const app=fixture(),checked=parseFidelityResult({...report([defect()]),factual},app.input);
  assert.equal(checked.issues.length,1);assert.equal(checked.issues[0].code,'unsupported_fact');assert.ok(deliveryFor(checked,app.input).findings.some(item=>item.kind==='reported_defect'));assert.equal(checked.reviewStatus,'incomplete');
 }
});
