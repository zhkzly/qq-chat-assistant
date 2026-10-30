'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {prepareAssistantRequest}=require('./fixtures/assistant-protocol.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {wordingControls}=require('../src/context-task.cjs');
function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());store.add(scope,[normalize(raw(),scope)]);store.setGoal(scope,'PRIVATE_GOAL_SENTINEL');store.saveNote(scope,{kind:'preference',use:'discussion',text:'以后用短句，别写得像点评员，因为PRIVATE_REASON_SENTINEL我担心被嫌烦。'});store.saveNote(scope,{kind:'material',use:'discussion',text:'PRIVATE_NOTE_SENTINEL'});const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'PRIVATE_REQUEST_SENTINEL，但帮我自然接一句。'});const args={scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,requestId:'synthetic-wording',responsePreference:'自然一点，贴近我的说话方式，允许emoji，因为PRIVATE_STYLE_REASON我很紧张。'};const prepared=buildContext(args);return {store,args,prepared};}
test('wording receives normalized expression controls without private reasons or outbound authorization',t=>{
 const {args,prepared}=fixture(t),plan=withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload),draft=buildDraftContext(prepared,plan,args);
 assert.equal(draft.payload.wordingControls.authority,'expression_control_not_outbound_material');
 const controls=JSON.stringify(draft.payload.wordingControls);assert.match(controls,/短句|简短/);assert.match(controls,/点评|评价/);assert.match(controls,/口语|表达习惯/);assert.match(controls,/emoji/);
 assert.ok(draft.payload.wordingControls.items.some(item=>item.sourceIds.some(id=>id.startsWith('note:'))));
 assert.deepEqual(draft.payload.outboundQuotes,[]);
 const wire=prepareAssistantRequest({},draft.payload).serialized;
 for(const secret of ['PRIVATE_GOAL_SENTINEL','PRIVATE_REASON_SENTINEL','PRIVATE_NOTE_SENTINEL','PRIVATE_REQUEST_SENTINEL','PRIVATE_STYLE_REASON'])assert.equal(wire.includes(secret),false,secret);
 assert.equal(draft.payload.preferences,undefined);assert.equal(draft.payload.responsePreference,undefined);
});
test('unspecified emoji and followup stay unspecified while explicit presentation controls survive',t=>{
 const {args,prepared}=fixture(t),plan=withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload);
 const draft=buildDraftContext(prepared,plan,args);assert.equal(Object.hasOwn(draft.payload.presentation,'useEmoji'),false);assert.equal(Object.hasOwn(draft.payload.presentation,'askFollowup'),false);
 const explicit=buildDraftContext(prepared,{...plan,useEmoji:false,askFollowup:true},args);assert.equal(explicit.payload.presentation.useEmoji,false);assert.equal(explicit.payload.presentation.askFollowup,true);
});
test('withdrawn preference cannot be restored into a restricted draft',t=>{
 const {args,prepared}=fixture(t);const context=buildContext({...args,availableSources:prepared.fullAvailableSources.filter(s=>s.kind!=='preference')});
 const draft=buildDraftContext(context,withCurrentDraftControls({intent:'reply',quotes:[]},context.payload),args);
 assert.equal(draft.payload.wordingControls.items.some(item=>item.sourceIds.some(id=>id.startsWith('note:'))),false);
});
test('safe projection does not invert negation or broaden conditional preferences',()=>{
 const controls=wordingControls([{sourceId:'note:synthetic',text:'不要用短句，不想太含蓄，别用emoji，如果她忙的时候就简短一点。'}],'直接一点');
 const text=controls.items.map(item=>item.text).join(' ');
 assert.doesNotMatch(text,/简短|含蓄/);assert.match(text,/不额外添加 emoji/);assert.match(text,/直接表达/);
 assert.deepEqual(wordingControls([{sourceId:'note:synthetic',text:'以后像点评员一样认真评论。'}]).items,[]);
});
