'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {wordingControls}=require('../src/context/wording-controls.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const OLD='以后回复用短句，不用表情，直接一点，语气轻松，表达口语，别像点评员。';
function fixture(t,{core=false,feedback=false,text='这轮不要用短句，可以加点表情，含蓄一点。邀请她一起听歌。',old=OLD}={}){
 const store=new Store(':memory:');t.after(()=>store.close());
 const declaration=store.appendTurn(scope,{role:'user',kind:'discussion',text:old});
 if(core){const batch=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,batch,{reviewedSourceIds:batch.reviewedSourceIds,items:[{kind:'preference',text:old,sourceIds:[`private:${declaration.id}`],explicitPreference:true}],episodes:[],retire:[]}).applied,true);}
 else store.saveNote(scope,{kind:'preference',use:'discussion',text:old,evidenceSourceIds:[`private:${declaration.id}`]});
 const asOf=new Date(Date.now()+(core?4*86400000:1000)).toISOString();
 store.add(scope,[normalize(raw('62001',false,{msgTime:String(Math.floor(Date.parse(asOf)/1000)-60),elements:[{elementType:1,textElement:{content:'刚发现这首歌有现场版'}}]}),scope)]);
 let turn,intentSourceId;
 if(feedback){const target=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'一份虚构参考。',requestId:'local-priority-target',sourceIds:['qq:62001']});
  const saved=store.addFeedback(scope,{text,targetRef:{kind:'artifact',artifactRef:target.artifactRef},clientEventId:'local-priority-feedback'});intentSourceId=saved.sourceId;
  turn={id:'priority-feedback-request',role:'user',kind:'discussion',text:'结合选中的反馈继续。',transient:true};
 }else turn=store.appendTurn(scope,{role:'user',kind:'discussion',text});
 const args={scope,store,records:store.messages(scope),availableSources:store.memorySources(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',intentSourceId,
  generationOrigin:feedback?'user_feedback':'private_discussion',asOf,requestId:'local-priority',responsePreference:'自然一点',settings:{model:'synthetic',anonymous:true,baseUrl:'http://fixture.invalid/v1'}};
 const prepared=buildContext(args),id=prepared.payload.intentAuthority.sourceId,ref=text=>({text,sourceIds:[id]});
 const plan={intent:'reply',quotes:[],useEmoji:true,style:'short',guidance:{objective:ref('邀请她一起听这首歌'),allowedApproach:ref('保留邀请；本轮不要求短句，表达含蓄，允许少量表情。'),avoidances:[]}};
 return {store,args,prepared,plan,text,draft:(changes={})=>buildDraftContext(prepared,{...plan,...changes},args)};
}
const texts=output=>(output.payload.wordingControls?.items||[]).map(item=>item.text).join(' ');
for(const core of [false,true])test(`current local controls override ${core?'core':'note'} defaults without discarding unrelated preferences`,t=>{
 const f=fixture(t,{core}),before=JSON.stringify(f.store.getCompanion(scope)),draft=f.draft(),controls=texts(draft);
 assert.doesNotMatch(controls,/用简短句子|不额外添加 emoji|直接表达用户/);
 assert.match(controls,/表达含蓄/);assert.match(controls,/可以自然地使用少量 emoji/);
 assert.match(controls,/语气轻松/);assert.match(controls,/点评和说教/);assert.match(controls,/自然口语/);
 assert.notEqual(draft.payload.style,'short');assert.equal(draft.payload.presentation.useEmoji,true);
 assert.equal(draft.payload.draftingGuidance.objective.text,'邀请她一起听这首歌');assert.deepEqual(draft.payload.outboundQuotes,[]);
 assert.equal(JSON.stringify(f.store.getCompanion(scope)),before);assert.equal(prepareAssistantRequest(f.args.settings,draft.payload).serialized.includes(f.text),false);
});
test('canonical local feedback has the same scoped override authority',t=>{
 const f=fixture(t,{feedback:true}),draft=f.draft();assert.doesNotMatch(texts(draft),/用简短句子|不额外添加 emoji|直接表达用户/);
 assert.ok(draft.payload.wordingControls.items.some(item=>item.sourceIds.includes(f.prepared.payload.intentAuthority.sourceId)));
});
test('negative clear removes defaults without forcing an opposite expression',t=>{
 const f=fixture(t,{old:'以后用短句，含蓄一点，不用表情。',text:'这次不要用短句，也不要太含蓄。邀请她一起听歌。'}),draft=f.draft({useEmoji:undefined});
 assert.doesNotMatch(texts(draft),/用简短句子|表达含蓄|直接表达/);assert.match(texts(draft),/不额外添加 emoji/);assert.notEqual(draft.payload.style,'short');
 assert.ok(draft.manifest.wordingControlEvidence.sourceRefs.some(ref=>ref.sourceId===f.prepared.payload.intentAuthority.sourceId));
});
test('an explicit direct expression can override an older subtle default',t=>{
 const f=fixture(t,{old:'以后含蓄一点，不用表情。',text:'这轮直接一点。邀请她一起听歌。'}),draft=f.draft();
 assert.match(texts(draft),/直接表达用户/);assert.doesNotMatch(texts(draft),/表达含蓄/);assert.match(texts(draft),/不额外添加 emoji/);
});
test('the reusable normalizer resolves an explicit request preference and supports negative clear',()=>{
 const result=wordingControls([{sourceId:'note:old',text:'以后用短句，不用表情，直接一点。'}],'这次不要用短句，可以加点表情，含蓄一点。');
 assert.doesNotMatch(result.items.map(item=>item.text).join(' '),/用简短句子|不额外添加 emoji|直接表达用户/);
});
test('model presentation cannot contradict grounded defaults, while permission does not force an emoji',t=>{
 const plain=fixture(t,{text:'邀请她一起听歌，给我一句。'}),unchanged=plain.draft();
 assert.match(texts(unchanged),/不额外添加 emoji/);assert.equal(unchanged.payload.presentation.useEmoji,false);assert.equal(unchanged.payload.style,'short');
 const allowed=fixture(t),withoutEmoji=allowed.draft({useEmoji:false});assert.equal(withoutEmoji.payload.presentation.useEmoji,false);assert.doesNotMatch(texts(withoutEmoji),/不额外添加 emoji/);
});
for(const text of [
 '她说：这次不要用短句，可以加点表情，含蓄一点。',
 '如果她忙，这次不要用短句，可以加点表情，含蓄一点。',
 '因为PRIVATE_LOCAL_REASON我担心，她喜欢我含蓄一点，可以加点表情，不要短句。',
 '我在分析“不要用短句，可以加点表情，含蓄一点”这句引用。'
])test('quoted, conditional or private reported wishes cannot clear persistent controls: '+text.slice(0,8),t=>{
 const f=fixture(t,{text}),draft=f.draft({useEmoji:undefined});assert.match(texts(draft),/用简短句子/);assert.match(texts(draft),/不额外添加 emoji/);assert.match(texts(draft),/直接表达用户/);
 assert.equal(JSON.stringify(draft.payload).includes('PRIVATE_LOCAL_REASON'),false);
});
for(const text of ['她平时表达很含蓄，我想回应她这次分享。','我今天做了简短的汇报。邀请她一起听歌。'])test('ordinary descriptive material does not create expression controls: '+text.slice(0,10),t=>{
 const f=fixture(t,{old:'以后直接一点，不用表情。',text}),draft=f.draft();
 assert.match(texts(draft),/直接表达用户/);assert.match(texts(draft),/不额外添加 emoji/);assert.doesNotMatch(texts(draft),/表达含蓄|用简短句子/);
});
test('a Markdown blockquote stays quoted across its comma-separated clauses',t=>{
 const f=fixture(t,{text:'> 这次不要用短句，可以加点表情，含蓄一点。'}),draft=f.draft();
 assert.match(texts(draft),/用简短句子/);assert.match(texts(draft),/不额外添加 emoji/);assert.match(texts(draft),/直接表达用户/);assert.equal(draft.payload.presentation.useEmoji,false);
});
test('a direct instruction outside a Markdown quote retains its own authority',t=>{
 const f=fixture(t,{text:'> 这次不要用短句，可以加点表情，含蓄一点。\n这次可以加点表情。'}),draft=f.draft();
 assert.match(texts(draft),/用简短句子/);assert.match(texts(draft),/直接表达用户/);assert.doesNotMatch(texts(draft),/不额外添加 emoji|表达含蓄/);assert.match(texts(draft),/可以自然地使用少量 emoji/);
});
test('automatic observation cannot turn a synthetic request into a local style override',t=>{
 const f=fixture(t),turn={id:'synthetic-observation',role:'user',kind:'discussion',text:'这次不要用短句，可以加点表情，含蓄一点。',transient:true};
 const args={...f.args,turn,generationOrigin:'qq_observation',purpose:'reply',invocation:'automatic'},prepared=buildContext(args),id=prepared.payload.intentAuthority.sourceId,ref=text=>({text,sourceIds:[id]});
 const draft=buildDraftContext(prepared,{intent:'reply',quotes:[],useEmoji:true,guidance:{objective:ref('接住当前来信'),allowedApproach:ref('自然回应'),avoidances:[]}},args);
 assert.match(texts(draft),/用简短句子/);assert.match(texts(draft),/不额外添加 emoji/);assert.match(texts(draft),/直接表达用户/);assert.equal(draft.payload.presentation.useEmoji,false);
});
test('a one-off override is not applied to a subsequent unrelated request',t=>{
 const f=fixture(t);f.draft();const turn=f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'这次就接她的来信。'});
 const args={...f.args,turn,companion:f.store.getCompanion(scope),availableSources:f.store.memorySources(scope)},prepared=buildContext(args),id=prepared.payload.intentAuthority.sourceId,ref=text=>({text,sourceIds:[id]});
 const draft=buildDraftContext(prepared,{intent:'reply',quotes:[],guidance:{objective:ref('回应实际分享'),allowedApproach:ref('轻松回应这件事'),avoidances:[]}},args);
 assert.match(texts(draft),/用简短句子/);assert.match(texts(draft),/不额外添加 emoji/);assert.match(texts(draft),/直接表达用户/);
});
