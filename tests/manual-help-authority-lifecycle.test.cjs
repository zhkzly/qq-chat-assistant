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
for(const mode of ['malformed','transport'])test(`a required ${mode} audit retains the request and prevents copyable publication`,async t=>{
 const app=await application(t,p=>{if(p.purpose!=='fidelity_check')return candidate(GOOD);if(mode==='transport')throw Error('Fictional required audit unavailable');return {checkRef:p.checkRef,issues:[]};});
 await assert.rejects(app.assist(),error=>error.code==='terminal_fact_audit_incomplete');assert.equal(app.calls.length,2);assert.equal(app.ledger().attempts,2);assert.deepEqual(app.ledger().requests.map(r=>r.purpose),['discussion','fidelity_check']);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='user').at(-1).text,'接她这条，给我能改着发的话。');assert.equal(app.controller.advice,null);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
for(const [code,text] of [['unsupported_fact',BAD],['private_disclosure','家人的检查安排只留在这里。']])test(`a reported ${code} regenerates the complete candidate once and obtains a fresh audit`,async t=>{
 const app=await application(t,(p,w)=>{if(p.purpose!=='fidelity_check')return candidate(w.originalInput?GOOD:text);if(!p.candidate.text.includes(text))return {checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues:[]};const source=p.evidence.find(source=>source.text===text);return {checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues:[{path:'suggestions[0].text',code,quote:text,claim:{kind:'assertion',quote:text},...(code==='private_disclosure'?{privacyBasis:'explicit_restriction',evidence:[{sourceId:source.sourceId,quote:source.text}]}:{})}]};});
 if(code==='private_disclosure')app.store.appendTurn(scope,{role:'user',kind:'discussion',text});
 const reply=await app.assist();assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview.status,'reviewed');assert.equal(reply.semanticReview.exhaustive,false);assert.equal(app.calls.length,4);assert.deepEqual(app.ledger().requests.map(r=>r.purpose),['discussion','fidelity_check','delivery_repair','fidelity_check']);assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
test('a real primary structural repair shares its ledger with the required final audit',async t=>{
 const app=await application(t,(p,_w,index)=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues:[]}:index===0?{operation:'prepare_message',answer:{suggestions:[{text:GOOD}],privateExplanation:{invalid:'object'}}}:candidate(GOOD)),reply=await app.assist();assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview.exhaustive,false);assert.equal(app.calls.length,3);assert.equal(app.ledger().requests.filter(r=>r.purpose==='delivery_repair').length,1);assert.equal(app.ledger().requests.filter(r=>r.purpose==='fidelity_check').length,1);assert.equal(app.ledger().attempts,3);
});
for(const mode of ['source-revision','forget','contact','cancel'])test(`primary publication cannot conceal ${mode} invalidation`,async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues:[]}:candidate(GOOD)),bind=app.controller.candidateSession.bindPlan.bind(app.controller.candidateSession);
 t.mock.method(app.controller.candidateSession,'bindPlan',(...args)=>{const {store,controller,note}=app;if(mode==='source-revision')store.saveNote(scope,{id:note.id,text:'台灯今天修好了。 revised',use:'draft'});if(mode==='forget')store.forgetSource(scope,'note:'+note.id);if(mode==='contact'){controller.scope={...scope,peerUid:'different-contact'};controller.changedContext();}if(mode==='cancel')controller.invalidateAssistant();return bind(...args);});
 await app.assist().catch(()=>{});assert.equal(app.store.getCompanion(scope).turns.some(t=>t.role==='assistant'&&t.requestId==='manual-help-task'),false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
