'use strict';
// Checker scripts below are contract probes, never semantic quality ratings.
// Production owns admission; the checker cannot invent a source or a grant.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {boundedSource}=require('../src/context/source-delivery.cjs');
const {visibleCandidate,buildFidelityContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
const {scope}=require('./fixtures/native.cjs');
const HUMAN='这次先不要邀请。我只是觉得木色挺好看，想以后再自己尝试。';
const ORIGINAL='我看过朋友组装书架。补充的完整范围是：我没有自己组装过，也没有答应一起做。';
function fixture(t,{partial=false,requestId='fidelity-boundary',priorText,humanText=HUMAN}={}){
 const store=new Store(':memory:');t.after(()=>store.close());const note=store.saveNote(scope,{text:ORIGINAL,use:'draft'}),prior=priorText?store.appendTurn(scope,{role:'user',kind:'discussion',text:priorText}):null,turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:humanText}),all=store.memorySources(scope),material=all.find(source=>source.id==='note:'+note.id),current=all.find(source=>source.id==='private:'+turn.id);
 const delivered=partial?boundedSource(material,{maxChars:'我看过朋友组装书架。'.length,maxBytes:4000}):material;
 const prepared={payload:{purpose:'discussion',intentAuthority:{sourceId:current.id},sources:[delivered,current]},fullAvailableSources:all,essentialSourceIds:[material.id,current.id],manifest:{scope:structuredClone(scope),requestId,sourceRevisions:Object.fromEntries(all.map(source=>[source.id,source.revision]))}};
 const result={kind:'draft',text:'我觉得这种木色挺好看，以后想自己试试。',discussionExplanation:{kind:'discussion',text:'这里只表达当前的看法与未来打算。'},suggestions:[{style:'自然',text:'我觉得这种木色挺好看，以后想自己试试。'}],expressionOptions:[{label:'先聊木色，不发出邀请。'}]};
 const identity=structuredClone(scope),info={scope:identity,requestId,store,admittedContext:{payload:{outboundQuotes:[{sourceId:material.id,text:delivered.text}],currentHumanControl:{authority:'CONTROL_ONLY',sourceId:current.id,text:current.text}},manifest:{sourceRevisions:prepared.manifest.sourceRevisions}},settings:{assistantRequestBytes:64000},requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))};
 return {store,prepared,result,info,material,current,prior,context:buildFidelityContext(prepared,result,info)};
}
const allow=context=>({checkRef:context.payload.checkRef,verdict:'allow',issues:[]});
const invalid=error=>/^fidelity_/.test(error.code||'');

test('every visible candidate surface is exact and only a privately validated same-frame allow can approve it',t=>{
 const app=fixture(t),expected=visibleCandidate(app.result);assert.deepEqual(app.context.payload.candidate,expected);assert.equal(app.context.payload.candidate.suggestions[0].style,'自然');assert.equal(app.context.payload.candidate.expressionOptions[0].label,'先聊木色，不发出邀请。');
 const raw=allow(app.context);assert.equal(approvalFor(raw,app.context),undefined,'a plain checked/pass object is not a program receipt');
 const verdict=parseFidelityResult(raw,app.context),receipt=approvalFor(verdict,app.context);assert.ok(receipt);assert.match(receipt.candidateHash,/^[a-f0-9]{64}$/);assert.match(receipt.bindingHash,/^[a-f0-9]{64}$/);
 const other=fixture(t,{requestId:'another-fidelity-task'});assert.equal(approvalFor(verdict,other.context),undefined);assert.throws(()=>parseFidelityResult(verdict,other.context),invalid);
 for(const changed of [{...raw,checkRef:'c999'},{...raw,candidateHash:'model-supplied-substitution'},{...raw,checked:true},{...raw,candidate:{text:'Checker rewrite'}},{...raw,actions:[{type:'forget'}]}])assert.throws(()=>parseFidelityResult(changed,app.context),invalid);
});

test('checker issues can identify only real visible paths and supplied original evidence, never rewrite or grant',t=>{
 const app=fixture(t),sourceId=app.current.id;
 for(const path of ['text','discussionExplanation.text','suggestions[0].text','suggestions[0].style','expressionOptions[0].label']){
  const verdict=parseFidelityResult({checkRef:'c1',verdict:'reject',issues:[{path,code:'current_boundary',sourceIds:[sourceId],reason:'Scripted rejection exercises a source-bound visible path.'}]},app.context);assert.equal(approvalFor(verdict,app.context),undefined);
 }
 for(const issue of [{path:'draftPlan.guidance',code:'current_boundary',reason:'Not visible.'},{path:'text',code:'current_boundary',sourceIds:['private:unoffered'],reason:'Unknown source.'},{path:'text',code:'grant_permission',reason:'Checker cannot grant.'}])assert.throws(()=>parseFidelityResult({checkRef:'c1',verdict:'reject',issues:[issue]},app.context),invalid);
 const uncertain=parseFidelityResult({checkRef:'c1',verdict:'uncertain',issues:[]},app.context);assert.equal(approvalFor(uncertain,app.context),undefined);
});

test('mutating the original candidate after a check invalidates approval while the checker candidate copy is immutable',t=>{
 const app=fixture(t),checked=parseFidelityResult(allow(app.context),app.context);assert.ok(approvalFor(checked,app.context));
 assert.throws(()=>{app.context.payload.candidate.suggestions[0].text='Mutated checker packet';},TypeError);
 app.result.discussionExplanation.text='A new unchecked explanation.';assert.throws(()=>approvalFor(checked,app.context),invalid);
});

test('a substituted original evidence body cannot retain the old source-bound allow receipt',t=>{
 const app=fixture(t),checked=parseFidelityResult(allow(app.context),app.context),evidence=app.context.payload.evidence.find(source=>source.sourceId===app.material.id);let immutable=false;
 try{evidence.text='A substituted body with the qualifier removed.';}catch(error){assert.equal(error instanceof TypeError,true);immutable=true;}
 if(!immutable)assert.throws(()=>approvalFor(checked,app.context),invalid,'source revisions alone cannot authorize a different checker evidence body');
});

test('a same-frame parsed rejection cannot be mutated into an allowed checker receipt',t=>{
 const app=fixture(t),rejected=parseFidelityResult({checkRef:'c1',verdict:'reject',issues:[{path:'text',code:'current_boundary',sourceIds:[app.current.id],reason:'A scripted rejection, not a quality rating.'}]},app.context);assert.equal(approvalFor(rejected,app.context),undefined);let immutable=false;
 try{rejected.verdict='allow';rejected.issues=[];}catch(error){assert.equal(error instanceof TypeError,true);immutable=true;}
 if(!immutable){let receipt;try{receipt=approvalFor(rejected,app.context);}catch(error){assert.equal(invalid(error),true);}assert.equal(receipt,undefined,'the original checker decision itself must be privately bound');}
});

test('an available full original qualifier is not replaced by the selected partial span in checker evidence',t=>{
 const app=fixture(t,{partial:true}),selected=app.prepared.payload.sources.find(source=>source.id===app.material.id);assert.notEqual(selected.text,ORIGINAL);assert.equal(selected.delivery.status,'partial');
 const original=app.context.payload.evidence.find(source=>source.sourceId===app.material.id);assert.equal(original.text,ORIGINAL,'the original no-firsthand-experience qualifier is available in the captured canonical source');assert.equal(original.delivery?.status==='partial',false);
 assert.equal(app.context.payload.admittedFragments[0].text,selected.text,'selected material remains a separate exact span');assert.equal(app.context.payload.evidence.find(source=>source.sourceId===app.current.id).text,HUMAN);
 const unavailable=buildFidelityContext({...app.prepared,fullAvailableSources:[selected,app.current]},app.result,{...app.info,store:undefined}),partial=unavailable.payload.evidence.find(source=>source.sourceId===app.material.id);
 assert.equal(partial.text,selected.text);assert.equal(partial.delivery.status,'partial');assert.ok(unavailable.payload.coverage.partialSourceIds.includes(app.material.id));
 const uncertain=parseFidelityResult({checkRef:'c1',verdict:'uncertain',issues:[{path:'text',code:'coverage_unknown',sourceIds:[app.material.id],reason:'Scripted coverage uncertainty; unavailable remainder is not invented.'}]},unavailable);assert.equal(approvalFor(uncertain,unavailable),undefined);
});

test('a delivered prior human boundary without typed topic refs is retained under byte pressure or fails explicitly',t=>{
 const priorText='这次只接她刚说的小事，还不要邀请。',app=fixture(t,{priorText,humanText:'帮我想一句自然的接话。'}),optional=app.store.saveNote(scope,{text:'UNRELATED_OPTIONAL_CONTEXT '.repeat(1400),use:'discussion'}),all=app.store.memorySources(scope),prior=all.find(source=>source.id==='private:'+app.prior.id),extra=all.find(source=>source.id==='note:'+optional.id);
 app.prepared.payload.sources=[prior,extra,app.material,app.current];app.prepared.fullAvailableSources=all;app.prepared.manifest.sourceRevisions=Object.fromEntries(all.map(source=>[source.id,source.revision]));app.info.admittedContext.manifest.sourceRevisions=app.prepared.manifest.sourceRevisions;app.info.settings={assistantRequestBytes:12000,model:'synthetic-fidelity-boundary',modelResponseMode:'result_tool'};delete app.info.requestMeasure;
 assert.equal(app.prepared.payload.topicContext?.controlRefs,undefined);let context,error;try{context=buildFidelityContext(app.prepared,{kind:'discussion',text:'先回应她的小事。'},app.info);}catch(value){error=value;}
 if(error){assert.equal(error.code,'fidelity_context_budget');return;}
 assert.equal(context.payload.evidence.find(source=>source.sourceId===prior.id)?.text,priorText,'the earlier original no-invite boundary is not optional merely because topic controlRefs are absent');
 assert.equal(context.payload.coverage.omittedSourceIds.includes(prior.id),false);assert.equal(context.payload.coverage.omittedSourceIds.includes(extra.id),true);
});
