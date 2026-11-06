'use strict';
// Actual Controller/Store/assistModel with scripted transport and fictional data.
// No paid/provider calls, semantic quality grade or QQ integration claim.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs'),{assistModel}=require('../src/assistant-model.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const GOOD='你的薄荷终于冒新叶啦。',BAD='我昨晚也种了一盆薄荷。';
const report=(issues=[])=>({checkRef:'c1',auditProtocol:'sparse-defects-v1',issues});
const candidate=text=>({operation:'prepare_message',answer:{suggestions:[{text}]}});
const native=(value,name)=>new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'manual-help-result',type:'function',function:{name,arguments:typeof value==='string'?value:JSON.stringify(value)}}]}}]}),{status:200});
async function application(t,producer){
 const store=new Store(':memory:'),calls=[],model='synthetic-manual-help',baseUrl='http://fixture.invalid/v1',note=store.saveNote(scope,{text:'台灯今天修好了。',use:'draft'});
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async cmd=>cmd==='bind'?scope:{messages:[]},assistantModel:(settings,input,signal)=>assistModel(settings,input,signal,async(_url,args)=>{const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({p,wrapper});const value=await producer(p,wrapper,calls.length-1,{store,controller,note});return native(value,request.tool_choice.function.name);})});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000001231',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'薄荷今天冒新叶了。'}}]})]});
 return {store,controller,calls,note,assist:(taskId='manual-help-task')=>controller.assist({taskId,text:'接她这条，给我能改着发的话。',materialIds:[note.id]}),ledger:()=>controller.usage.get(scope,'manual-help-task')};
}
for(const mode of ['malformed','transport'])test(`a removed ${mode} critic is never called, ordinary help has no audit status`,async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check');return candidate(GOOD);}),reply=await app.assist();assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview,undefined);assert.equal(app.calls.length,1);assert.equal(app.ledger().attempts,1);assert.equal(app.ledger().requests.some(r=>r.purpose==='delivery_repair'||r.purpose==='fidelity_check'),false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
for(const text of [BAD,'家人的检查安排只留在这里。'])test(`no automatic semantic rewrite or certificate is generated for a scripted primary ${text}`,async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check');return candidate(text);}),reply=await app.assist();assert.equal(reply.suggestions[0].text,text);assert.equal(reply.semanticReview,undefined);assert.equal(app.calls.length,1);assert.equal(app.ledger().requests.some(r=>r.purpose==='delivery_repair'),false);
});
test('a real primary structural repair keeps its original shared ledger without buying a critic',async t=>{
 const app=await application(t,(p,_w,index)=>{assert.notEqual(p.purpose,'fidelity_check');return index===0?{operation:'prepare_message',answer:{suggestions:[{text:GOOD}],privateExplanation:{invalid:'object'}}}:candidate(GOOD);}),reply=await app.assist();assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview,undefined);assert.equal(app.calls.length,2);assert.equal(app.ledger().requests.filter(r=>r.purpose==='delivery_repair').length,1);
});
for(const mode of ['source-revision','forget','contact','cancel'])test(`primary publication cannot conceal ${mode} invalidation`,async t=>{
 const app=await application(t,()=>candidate(GOOD)),bind=app.controller.candidateSession.bindPlan.bind(app.controller.candidateSession);
 t.mock.method(app.controller.candidateSession,'bindPlan',(...args)=>{const {store,controller,note}=app;if(mode==='source-revision')store.saveNote(scope,{id:note.id,text:'台灯今天修好了。 revised',use:'draft'});if(mode==='forget')store.forgetSource(scope,'note:'+note.id);if(mode==='contact'){controller.scope={...scope,peerUid:'different-contact'};controller.changedContext();}if(mode==='cancel')controller.invalidateAssistant();return bind(...args);});
 await app.assist().catch(()=>{});assert.equal(app.store.getCompanion(scope).turns.some(t=>t.role==='assistant'&&t.requestId==='manual-help-task'),false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
