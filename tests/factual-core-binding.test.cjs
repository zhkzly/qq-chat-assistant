'use strict';
// Mechanical frame integrity checks, not semantic assertion detection.
const test=require('node:test'),assert=require('node:assert/strict');
const {buildFidelityContext,parseFidelityResult}=require('../src/whole-answer-fidelity.cjs');
const {prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {scope}=require('./fixtures/native.cjs');
function fixture(){
 const source={id:'private:binding-human',type:'private',role:'user',kind:'discussion',use:'discussion',revision:'binding-revision',text:'Help me respond without inventing a personal event.',at:'2026-10-29T10:00:00Z'};
 const prepared={payload:{purpose:'discussion',sources:[source],intentAuthority:{sourceId:source.id}},manifest:{scope,requestId:'factual-set-binding',sourceRevisions:{[source.id]:source.revision},sourceIds:[source.id]},fullAvailableSources:[source]};
 const result={kind:'draft',text:'',suggestions:[{style:'Natural',text:'I finished a personal errand just now.'}]};return buildFidelityContext(prepared,result,{scope,requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});
}
test('clearing an exposed path set cannot turn missing mandatory factual coverage into approval',()=>{
 const input=fixture();input.fidelityFrameSnapshot.paths.clear();assert.ok(input.payload.candidatePaths.length>0);
 assert.throws(()=>parseFidelityResult({checkRef:'c1',verdict:'allow',issues:[],factual:[]},input),error=>typeof error.code==='string');
});
test('mutating the exposed source set invalidates its frame even when the scripted assessment uses no witnesses',()=>{
 const input=fixture();input.fidelityFrameSnapshot.sourceIds.clear();
 const factual=input.payload.candidatePaths.map(path=>({path,statements:[]}));assert.throws(()=>parseFidelityResult({checkRef:'c1',verdict:'allow',issues:[],factual},input),error=>error.code==='fidelity_binding_invalid');
});
test('a private truth condition may quote the example inside the condition without becoming a copyable assertion',()=>{
 const source={id:'private:conditional-human',type:'private',role:'user',kind:'discussion',revision:'conditional-revision',text:'Explain how to use a hypothetical example.'},condition='只有当“我今天修好了灯”是真的',quote='我今天修好了灯',text=condition+'才可用。';
 const prepared={payload:{purpose:'discussion',sources:[source]},manifest:{scope,requestId:'nested-conditional',sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}},fullAvailableSources:[source]};
 const input=buildFidelityContext(prepared,{kind:'discussion',text},{scope,requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});
 const factual=input.payload.candidatePaths.map(path=>({path,statements:path==='text'?[{quote,kind:'private_conditional',condition,contextQuote:text}]:[]}));
 assert.equal(parseFidelityResult({checkRef:'c1',verdict:'allow',issues:[],factual},input).verdict,'allow');
});
test('malformed optional factual prose cannot veto an otherwise valid unsupported finding at the source decoder',()=>{
 const input=fixture(),request=prepareAssistantRequest({model:'synthetic'},input.payload,[],{sourceRevisions:input.manifest.sourceRevisions});request.sourceWire.commit();Object.defineProperty(input,'sourceWireSnapshot',{value:request.sourceWire});
 const factual=input.payload.candidatePaths.map(path=>({path,statements:path==='suggestions[0].text'?[{quote:input.payload.candidate.suggestions[0].text,kind:'assertion',support:'unsupported',basis:'no_support_in_supplied_evidence',reason:{sourceIds:['s999'],text:'Malformed optional prose.'}}]:[]}));
 const parsed=parseFidelityResult({checkRef:'c1',verdict:'allow',issues:[],factual},input);assert.equal(parsed.verdict,'reject');assert.equal(parsed.issues[0].code,'unsupported_fact');assert.equal(input.manifest.fidelity.unusableAdvisory[0].code,'invalid_explanatory_reason');
});
test('a supported full original witness remains allowable when only its optional factual prose is malformed',()=>{
 const text='I repaired my reading lamp yesterday.',source={id:'note:true-self',type:'note',role:'user',use:'draft',revision:'true-self-revision',text},prepared={payload:{purpose:'discussion',sources:[source]},manifest:{scope,requestId:'supported-optional-prose',sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}},fullAvailableSources:[source]};
 const input=buildFidelityContext(prepared,{kind:'draft',text:'',suggestions:[{style:'Natural',text}]},{scope,requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))}),request=prepareAssistantRequest({model:'synthetic'},input.payload,[],{sourceRevisions:input.manifest.sourceRevisions});request.sourceWire.commit();Object.defineProperty(input,'sourceWireSnapshot',{value:request.sourceWire});
 const offered=request.wirePayload.evidence[0].sourceId,factual=input.payload.candidatePaths.map(path=>({path,statements:path==='suggestions[0].text'?[{quote:text,kind:'assertion',support:'supported',evidence:[{sourceId:offered,quote:text}],reason:{sourceId:'s999'}}]:[]}));
 assert.equal(parseFidelityResult({checkRef:'c1',verdict:'allow',issues:[],factual},input).verdict,'allow');assert.equal(input.manifest.fidelity.unusableAdvisory[0].code,'invalid_explanatory_reason');
});
