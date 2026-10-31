'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPublicationSeal}=require('../src/publication-seal.cjs');
const {scope}=require('./fixtures/native.cjs');
function fixture(){
 const source={sourceId:'private:current',revision:'source-v1'},context={payload:{purpose:'discussion',intentAuthority:{sourceId:source.sourceId},sources:[{id:source.sourceId,text:'A complete current control.'}]},manifest:{scope:{...scope},sourceIds:[source.sourceId],sourceRevisions:{[source.sourceId]:source.revision},inputArtifactRefs:[]}},options=[{label:'An actual option',style:'natural',quotes:[]}],optionAdmission={options,groups:[],sourceRevisions:{}};
 const result={kind:'draft',text:'private body',discussionExplanation:{kind:'discussion',text:'The private reason.'},suggestions:[{style:'自然',text:'The actual message.'}],requestDelivery:{mode:'editable_message',blocker:{kind:'missing_fact',question:'Question?',missing:'detail'}}};
 const seal=createPublicationSeal({result,expressionOptions:options,contexts:[context],optionAdmission,scope,requestId:'seal-unit'});return {result,options,optionAdmission,context,seal};
}
test('a publication seal captures mechanical integrity without a semantic certificate or model call',()=>{
 const app=fixture(),receipt=app.seal.assert(app.result,app.options);assert.equal(receipt.semanticCheck,false);assert.equal(receipt.version,'primary-publication-seal-v1');assert.equal(app.seal.context.manifest.sourceRevisions['private:current'],'source-v1');assert.match(receipt.digest,/^[a-f0-9]{64}$/);
});
for(const [name,mutate]of Object.entries({
 text:a=>a.result.text+='changed',explanation:a=>a.result.discussionExplanation.text+='changed',message:a=>a.result.suggestions[0].text+='changed',style:a=>a.result.suggestions[0].style='different',option:a=>a.options[0].label+='changed',optionStyle:a=>a.options[0].style='casual',kind:a=>a.result.kind='question',disposition:a=>a.result.replyDisposition='wait',mode:a=>a.result.requestDelivery.mode='private_help',blocker:a=>a.result.requestDelivery.blocker.question='Changed?',recovery:a=>a.context.manifest.responseRecovery={kind:'private_help',metadataApplied:false},source:a=>a.context.manifest.sourceRevisions['private:current']='source-v2',payload:a=>a.context.payload.sources[0].text='Changed original',scope:a=>a.context.manifest.scope.peerUid='other',suggestionRef:a=>a.result.suggestions[0]={...a.result.suggestions[0]},suggestionsRef:a=>a.result.suggestions=[...a.result.suggestions],optionsRef:a=>a.options[0]={...a.options[0]},contextRef:a=>a.context.payload={...a.context.payload},blockerRef:a=>a.result.requestDelivery.blocker={...a.result.requestDelivery.blocker}
}))test(`post-capture ${name} mutation invalidates the seal`,()=>{
 const app=fixture();mutate(app);assert.throws(()=>app.seal.assert(app.result,app.options),error=>error.code==='publication_binding_invalid');
});
test('an equal-looking replacement candidate/options cannot reuse the sealed object identities',()=>{
 const app=fixture();assert.throws(()=>app.seal.assert({...app.result},app.options));assert.throws(()=>app.seal.assert(app.result,[...app.options]));
});
test('source unions retain prior reads, compaction roots, current controls and generated artifact dependencies separately',()=>{
 const app=fixture(),dependency={artifactRef:{artifactId:'turn:old:draft:0',version:2},selection:{turnId:'old',suggestionIndex:0},bodyDigest:'old-body'},prior={payload:{purpose:'discussion'},manifest:{scope,sourceRevisions:{'qq:91000000000000991':'qq-v1'},discussionCompaction:{sourceRevisions:{'private:older':'old-v1'}},inputArtifactRefs:[dependency]}};
 const seal=createPublicationSeal({result:app.result,expressionOptions:app.options,contexts:[prior,app.context],optionAdmission:app.optionAdmission,scope,requestId:'union'});
 assert.deepEqual(seal.context.manifest.sourceRevisions,{'qq:91000000000000991':'qq-v1','private:older':'old-v1','private:current':'source-v1'});assert.deepEqual(seal.context.manifest.inputArtifactRefs,[dependency]);assert.equal(Object.keys(seal.context.manifest.sourceRevisions).some(id=>id.includes('turn:old')),false);
 prior.manifest.inputArtifactRefs[0].artifactRef.version++;assert.throws(()=>seal.assert(app.result,app.options));
});
test('conflicting producer source revisions cannot be silently upgraded to a latest version',()=>{
 const app=fixture();assert.throws(()=>createPublicationSeal({result:app.result,expressionOptions:app.options,contexts:[app.context,{manifest:{scope,sourceRevisions:{'private:current':'different'}}}],scope}),error=>error.code==='publication_source_conflict');
});
