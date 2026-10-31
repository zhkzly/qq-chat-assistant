'use strict';
// Sharing admission is a program capability distinct from semantic truth support.
const test=require('node:test'),assert=require('node:assert/strict');
const {buildFidelityContext,parseFidelityResult}=require('../src/whole-answer-fidelity.cjs');
const {scope}=require('./fixtures/native.cjs');
const FACT='我今天修好了自己的台灯。',SECRET='家人的检查安排只在这里说。';
function fixture({copy=FACT,privateBody='',admitted=[],draft=false}={}){
 const source={id:draft?'note:authored-fact':'private:private-fact',type:draft?'note':'private',role:'user',kind:draft?'material':'discussion',use:draft?'draft':'discussion',revision:'disclosure-original-rv',text:FACT+'这是愿意告诉她的小进展。'+SECRET,at:'2026-10-29T10:00:00Z'};
 const manifest={scope,requestId:'separate-truth-disclosure',sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}},prepared={payload:{purpose:'discussion',sources:[source],intentAuthority:{sourceId:source.id}},manifest,fullAvailableSources:[source]},result={kind:'draft',text:'',suggestions:[{text:copy,style:'自然'}],...(privateBody?{discussionExplanation:{kind:'discussion',text:privateBody}}:{})};
 const context=buildFidelityContext(prepared,result,{scope,admittedContext:{payload:{outboundQuotes:admitted.map(text=>({sourceId:source.id,text})),currentHumanControl:{sourceId:source.id,authority:'CONTROL_ONLY',text:source.text}},manifest},requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});return {context,source};
}
function check(app,{path='suggestions[0].text',quote=FACT,evidenceQuote=quote,disclosure}={}){
 const factual=app.context.payload.candidatePaths.map(field=>({path:field,statements:field===path?[{quote,kind:'assertion',support:'supported',evidence:[{sourceId:app.source.id,quote:evidenceQuote}],...(disclosure?{disclosure:disclosure.map(quote=>({sourceId:app.source.id,quote}))}:{})}]:[]}));return parseFidelityResult({checkRef:'c1',verdict:'allow',factual,issues:[]},app.context);
}
test('a true private or control-only fact is not automatically admitted for a copyable message',()=>{
 const app=fixture();const result=check(app);assert.equal(result.verdict,'reject');assert.equal(result.issues[0].code,'private_disclosure');
});
test('an exact admitted private fragment or authored draft note remains usable',()=>{
 assert.equal(check(fixture({admitted:[FACT]})).verdict,'allow');assert.equal(check(fixture({draft:true})).verdict,'allow');
 const app=fixture({admitted:[FACT]});assert.equal(check(app,{evidenceQuote:app.source.text,disclosure:[FACT]}).verdict,'allow');
});
test('admitting one private fragment does not authorize other facts from the same source',()=>{
 const app=fixture({copy:SECRET,admitted:[FACT]});assert.equal(check(app,{quote:SECRET}).verdict,'reject');assert.equal(check(app,{quote:SECRET,disclosure:[FACT]}).verdict,'reject');
});
test('private analysis may inspect true originals without outward sharing permission',()=>{
 const app=fixture({copy:'听起来挺好。',privateBody:SECRET});assert.equal(check(app,{path:'discussionExplanation.text',quote:SECRET}).verdict,'allow');
});

test('program-authorized QQ material cannot acquire an invented private restriction, while an independent newer restriction still blocks',()=>{
 const qq={id:'qq:91000000000000991',type:'qq',role:'contact',revision:'qq-permission-rv',text:'今天培训一整天。',at:'2026-10-29T10:00:00Z'},human={id:'private:newer-exclusion',type:'private',role:'user',kind:'discussion',revision:'human-restriction-rv',text:'她刚才的培训信息只留作背景，这条不要提培训。',at:'2026-10-29T10:01:00Z'},scope=require('./fixtures/native.cjs').scope;
 for(const restricted of [false,true]){
  const sources=restricted?[qq,human]:[qq],manifest={scope,sourceIds:sources.map(source=>source.id),sourceRevisions:Object.fromEntries(sources.map(source=>[source.id,source.revision]))},prepared={payload:{purpose:'discussion',sources,...(restricted?{intentAuthority:{sourceId:human.id}}:{})},manifest,fullAvailableSources:sources};
  const input=buildFidelityContext(prepared,{text:'',suggestions:[{text:'你今天培训辛苦了。',style:'自然'}]},{scope,requestMeasure:()=>1}),ref={sourceId:qq.id,quote:qq.text},factual=input.payload.candidatePaths.map(path=>({path,statements:path==='suggestions[0].text'?[{quote:'你今天培训辛苦了。',kind:'assertion',support:'supported',evidence:[ref]}]:[]}));
  const value={checkRef:'c1',factual,issues:[{path:'suggestions[0].text',quote:'你今天培训辛苦了。',code:'private_disclosure',evidence:[ref,...(restricted?[{sourceId:human.id,quote:human.text}]:[])]}]};
  assert.equal(parseFidelityResult(value,input).verdict,restricted?'reject':'allow');
 }
});
test('a privacy finding on an unrelated private fragment survives admission of another fragment in that source',()=>{
 const app=fixture({copy:SECRET,admitted:[FACT]}),factual=app.context.payload.candidatePaths.map(path=>({path,statements:[]}));
 const checked=parseFidelityResult({checkRef:'c1',factual,issues:[{path:'suggestions[0].text',code:'private_disclosure',quote:SECRET,evidence:[{sourceId:app.source.id,quote:SECRET}]}]},app.context);
 assert.equal(checked.verdict,'reject');
});
