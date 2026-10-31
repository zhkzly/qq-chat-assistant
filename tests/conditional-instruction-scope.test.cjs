'use strict';
// Scope/authority compilation only. This does not grade a model's interpretation
// of availability or require any fixed output wording for a development case.
const test=require('node:test'),assert=require('node:assert/strict');
const {wordingControls}=require('../src/context/wording-controls.cjs');
const {buildContext}=require('../src/assistant-context.cjs'),{buildAnswerAdmission}=require('../src/context/wording-view.cjs');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const CONDITIONAL='只有她明确说忙的时候，我才想简短回复、不用表情；她有空分享时不用套这个要求。';
test('a whole conditional instruction cannot become unconditional controls after comma splitting',()=>{
 const controls=wordingControls([{text:CONDITIONAL,sourceIds:['note:conditional']}]);assert.deepEqual(controls.items,[]);
 assert.deepEqual(controls.scoped[0].sourceIds,['note:conditional']);assert.equal(controls.scoped[0].bodyLocation,'original_instruction');
});
test('a causal lead-in does not hide a later whole conditional instruction',()=>{
 const controls=wordingControls([{text:'因为我容易写长篇，如果她说忙，回复简短点，不用表情。',sourceIds:['note:causal-conditional']}]);
 assert.deepEqual(controls.items,[]);assert.deepEqual(controls.scoped[0].sourceIds,['note:causal-conditional']);
});
test('plain unconditional behavior notes remain effective without a new preference state owner',()=>{
 const controls=wordingControls([{text:'以后默认回复简短，不用表情，表达自然。',sourceIds:['note:unconditional']}]);
 assert.ok(controls.items.some(item=>/简短/.test(item.text)));assert.ok(controls.items.some(item=>/不额外添加 emoji/.test(item.text)));assert.ok(controls.items.some(item=>/自然口语/.test(item.text)));
});
test('a conditional expression inside a separate private reason does not erase a plain standing instruction',()=>{
 const controls=wordingControls([{text:'以后默认回复简短，不用表情，因为只有这样我才能更快读完PRIVATE_REASON。',sourceIds:['note:plain-with-reason']}]);
 assert.ok(controls.items.some(item=>/简短/.test(item.text)));assert.ok(controls.items.some(item=>/不额外添加 emoji/.test(item.text)));assert.equal(JSON.stringify(controls).includes('PRIVATE_REASON'),false);
});
test('discussion privacy does not remove a confirmed behavior instruction, and final admission retains its scope without leaking private reasons',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const original=CONDITIONAL+'因为PRIVATE_SCOPE_REASON我不想让她误会。',note=store.saveNote(scope,{kind:'preference',use:'discussion',text:original}),turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'按当前实际交流帮我回应。'});
 store.add(scope,[normalize(raw('900719925474099878600',false,{elements:[{textElement:{content:'我现在只有几分钟，待会要处理别的事。'}}]}),scope)]);
 const info={scope,store,companion:store.getCompanion(scope),turn,purpose:'discussion',requestId:'conditional-scope',records:store.messages(scope),availableSources:store.memorySources(scope),settings:{model:'synthetic',assistantRequestBytes:64000}};
 const prepared=buildContext(info),preference=prepared.payload.preferences.find(item=>item.sourceId==='note:'+note.id);assert.equal(preference.text,original);assert.equal(preference.authority,'user_owned_behavior_instruction');
 const admitted=buildAnswerAdmission(prepared,{kind:'draft',text:'',suggestions:[{text:'先处理你的事，我们回头再聊。'}]},info);
 assert.deepEqual(admitted.payload.wordingControls.items,[]);assert.ok(admitted.payload.wordingControls.scoped.some(item=>item.sourceIds.includes('note:'+note.id)));assert.ok(admitted.manifest.wordingControlEvidence.sourceRefs.some(ref=>ref.sourceId==='note:'+note.id));
 assert.equal(JSON.stringify(admitted.payload.wordingControls).includes('PRIVATE_SCOPE_REASON'),false);assert.equal(store.getCompanion(scope).notes[0].text,original);
});
