'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const PRIMARY='那家小店听起来挺有意思，我也想多认识你一点。';
function fixture(t,{origin='automatic'}={}){
 const store=new Store(':memory:');t.after(()=>store.close());
 const old=Array.from({length:50},(_,i)=>normalize(raw(String(96000+i),i%2===1,{msgTime:String(1700000000+i*60),elements:[{textElement:{content:`COLD_AUTO_INPUT_${i}`}}]}),scope));
 const current=normalize(raw('97001',false,{msgTime:'1792140000',elements:[{textElement:{content:'今天在小店看到了特别有趣的手工摆件。'}}]}),scope);store.add(scope,[...old,current]);
 const previous=store.appendTurn(scope,{role:'assistant',origin,kind:'draft',text:'AUTO_PRIVATE_ANALYSIS_NOT_THE_TARGET '.repeat(30),
  suggestions:[{style:'直白',text:PRIMARY},{style:'另一种',text:'UNSELECTED_AUTOMATIC_WORDING'}],sourceIds:old.map(m=>`qq:${m.messageId}`)});
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'这句改含蓄一点，为什么要这样说？'});
 const ref={turnId:previous.id,suggestionIndex:0,artifactRef:previous.suggestions[0].artifactRef,origin};
 const args={scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',requestId:'synthetic-feedback-anchor',coverage:{status:'partial'},currentCandidateRef:ref};
 return {store,previous,args,ref};
}
test('private feedback receives only the captured generated primary without expanding its old factual input',t=>{
 const {args,previous}=fixture(t),context=buildContext(args),items=context.payload.privateCandidates||[];
 const anchor=items.find(item=>item.turnId===previous.id);assert.ok(anchor);assert.equal(anchor.text,PRIMARY);assert.deepEqual(anchor.artifactRef,previous.suggestions[0].artifactRef);
 assert.match(anchor.authority,/generated/);assert.equal(anchor.selection,'implicit_discussion_anchor');assert.equal(anchor.origin,'automatic');
 assert.equal(items.filter(item=>item.turnId===previous.id).length,1);
 const wire=JSON.stringify(context.payload);for(const excluded of ['COLD_AUTO_INPUT_','AUTO_PRIVATE_ANALYSIS_NOT_THE_TARGET','UNSELECTED_AUTOMATIC_WORDING'])assert.equal(wire.includes(excluded),false,excluded);
 assert.equal(anchor.sourceIds,undefined);assert.equal(anchor.quotes,undefined);
 assert.ok(!context.manifest.sourceIds.includes(`private:${previous.id}`));
 const plan=withCurrentDraftControls({intent:'reply',quotes:[]},context.payload),draft=buildDraftContext(context,plan,args);
 assert.equal(JSON.stringify(draft.payload).includes(PRIMARY),false,'the private discussion object cannot leak into restricted wording');
 assert.throws(()=>buildDraftContext(context,{...plan,quotes:[{sourceId:`private:${previous.id}`,text:PRIMARY}]},args),/拟表达内容未能对应/);
});
test('automatic observation cannot inherit an implicit private feedback anchor',t=>{
 const {args,previous}=fixture(t),automatic=buildContext({...args,turn:{id:'synthetic-next-observation',role:'user',kind:'reply',text:'根据新实际交流提供参考',transient:true},purpose:'reply',generationOrigin:'qq_observation',invocation:{origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply'}});
 assert.ok(!(automatic.payload.privateCandidates||[]).some(item=>item.turnId===previous.id));
 assert.equal(JSON.stringify(automatic.payload).includes(PRIMARY),false);
});
test('explicit references supersede the implicit target and user-origin candidates are not duplicated',t=>{
 const {store,args,previous}=fixture(t,{origin:'user'}),context=buildContext(args);
 assert.equal(context.payload.privateCandidates.filter(item=>item.turnId===previous.id).length,1);
 assert.equal(context.payload.privateCandidates.find(item=>item.turnId===previous.id).text,PRIMARY);
 const selected=store.appendTurn(scope,{role:'assistant',origin:'user',kind:'draft',text:'另一份明确选择的生成帮助',suggestions:[{style:'自然',text:'EXPLICIT_OTHER_TARGET'}]});
 const explicit=buildContext({...args,companion:store.getCompanion(scope),sourceTurnIds:[selected.id]});
 assert.ok(explicit.payload.privateCandidates.some(item=>item.turnId===selected.id));
 assert.ok(!explicit.payload.privateCandidates.some(item=>item.selection==='implicit_discussion_anchor'));
});
test('stale artifact identity and withdrawn generated help cannot be restored by a captured reference',t=>{
 const {store,args,previous,ref}=fixture(t);
 const stale=buildContext({...args,currentCandidateRef:{...ref,artifactRef:{...ref.artifactRef,version:ref.artifactRef.version+1}}});
 assert.ok(!(stale.payload.privateCandidates||[]).some(item=>item.selection==='implicit_discussion_anchor'));
 store.deleteTurn(scope,previous.id);
 const withdrawn=buildContext({...args,companion:store.getCompanion(scope)});
 assert.ok(!(withdrawn.payload.privateCandidates||[]).some(item=>item.turnId===previous.id));
});
test('a captured noncandidate response remains a generated explanation target without granting its input closure',t=>{
 const {store,args}=fixture(t),previous=store.appendTurn(scope,{role:'assistant',origin:'automatic',kind:'discussion',text:'合成解释：当前缺少用户具体的周末安排，先私下核对这一点。',sourceIds:['qq:96000']});
 const context=buildContext({...args,companion:store.getCompanion(scope),currentCandidateRef:{turnId:previous.id,artifactRef:previous.artifactRef,origin:'automatic'}});
 const anchor=context.payload.privateCandidates.find(item=>item.selection==='implicit_discussion_anchor');
 assert.equal(anchor.field,'text');assert.equal(anchor.text,previous.text);assert.deepEqual(anchor.artifactRef,previous.artifactRef);
 assert.equal(anchor.sourceIds,undefined);assert.ok(!context.payload.sources.some(source=>source.id==='qq:96000'));
});
test('only an explicit user manual alternative can reuse the comparison target outside private consultation',t=>{
 const {args,previous}=fixture(t),base={...args,turn:{id:'synthetic-manual-alternative',role:'user',kind:'reply',text:'换一个实质不同的聊天切口，不只改词。',transient:true},purpose:'reply',generationOrigin:'qq_observation'};
 const inputs=[
  {candidateAlternative:true,invocation:{origin:'user',trigger:'manual_suggestion',requestedPurpose:'reply'},expected:true},
  {candidateAlternative:false,invocation:{origin:'user',trigger:'manual_suggestion',requestedPurpose:'reply'},expected:false},
  {candidateAlternative:true,invocation:{origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply'},expected:false},
  {candidateAlternative:true,invocation:{origin:'user',trigger:'automatic_observation',requestedPurpose:'reply'},expected:false},
  {candidateAlternative:true,expected:false}
 ];
 for(const {expected,...input}of inputs){const context=buildContext({...base,...input}),anchors=(context.payload.privateCandidates||[]).filter(item=>item.selection==='implicit_discussion_anchor');
  assert.equal(anchors.length,expected?1:0,JSON.stringify(input));
  if(expected){assert.equal(anchors[0].turnId,previous.id);assert.equal(anchors[0].text,PRIMARY);assert.equal(JSON.stringify(context.payload).includes('COLD_AUTO_INPUT_'),false);}
 }
});
