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
for(const mode of ['malformed','transport'])test(`${mode} semantic audit delivers honest incomplete help without consuming a second repair`,async t=>{
 const app=await application(t,p=>{if(p.purpose!=='fidelity_check')return candidate(GOOD);if(mode==='transport')throw Error('Scripted checker connection failure');return 'MALFORMED_CHECKER_JSON';}),reply=await app.assist();
 assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview.status,'incomplete');assert.equal(reply.semanticReview.exhaustive,false);assert.equal(app.calls.length,2);assert.equal(app.ledger().attempts,2);assert.equal(app.ledger().requests.some(r=>r.purpose==='delivery_repair'),false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
test('a valid fabrication finding alongside malformed metadata triggers the one bounded regeneration',async t=>{
 let primary=0,check=0;const app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return candidate(++primary===1?BAD:GOOD);
  if(++check===2)return report();
  return report([{path:'not-a-path',code:'unsupported_fact',quote:'absent',reason:'Malformed adjacent report.'},{path:'suggestions[0].text',code:'unsupported_fact',quote:BAD,reason:'No supplied original says the user planted mint last night.'}]);
 }),reply=await app.assist();
 assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview.status,'reviewed');assert.equal(app.calls.length,4);assert.equal(app.ledger().attempts,4);assert.equal(app.ledger().requests.filter(r=>r.purpose==='delivery_repair').length,1);assert.equal(app.store.getCompanion(scope).turns.filter(t=>t.role==='assistant').some(t=>t.suggestions?.some(s=>s.text===BAD)),false);
});
test('a concrete unadmitted private disclosure is not released as incomplete help',async t=>{
 const privateText='家人的检查安排只留在这里。';let primary=0,checks=0;const app=await application(t,(p,_w,_i,{store})=>{
  if(p.purpose!=='fidelity_check')return candidate(++primary===1?privateText:GOOD);
  if(++checks===2)return report();
  const source=p.evidence.find(s=>s.text===privateText);assert.ok(source);
  return report([{path:'suggestions[0].text',code:'private_disclosure',quote:privateText,reason:'The actual copied private fact was not admitted.',evidence:[{sourceId:source.sourceId,quote:source.text}]}]);
 });app.store.appendTurn(scope,{role:'user',kind:'discussion',text:privateText});const reply=await app.assist();
 assert.equal(reply.suggestions[0].text,GOOD);assert.equal(app.calls.length,4);assert.equal(app.store.getCompanion(scope).turns.filter(t=>t.role==='assistant').some(t=>t.suggestions?.some(s=>s.text===privateText)),false);
});
test('spent primary repair plus malformed audit preserves the original shared ledger and marks incomplete',async t=>{
 const app=await application(t,(p,_w,index)=>p.purpose==='fidelity_check'?'INVALID_CHECKER_JSON':index===0?{operation:'prepare_message',answer:{suggestions:[{text:GOOD}],privateExplanation:{invalid:'object'}}}:candidate(GOOD)),reply=await app.assist();
 assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview.status,'incomplete');assert.equal(app.calls.length,3);assert.equal(app.ledger().attempts,3);assert.equal(app.ledger().requests.filter(r=>r.purpose==='delivery_repair').length,1);
});
for(const mode of ['source-revision','forget','contact','cancel'])test(`audit failure cannot conceal ${mode} invalidation`,async t=>{
 const app=await application(t,(p,_w,_i,{store,controller,note})=>{
  if(p.purpose!=='fidelity_check')return candidate(GOOD);
  if(mode==='source-revision')store.saveNote(scope,{id:note.id,text:'新的台灯修订。',use:'draft'});
  if(mode==='forget')store.forgetSource(scope,'note:'+note.id);
  if(mode==='contact'){controller.scope={...scope,peerUid:'different-contact'};controller.changedContext();}
  if(mode==='cancel')controller.invalidateAssistant();
  throw Error('Scripted audit transport failure after state changed');
 });await app.assist().catch(()=>{});
 assert.equal(app.store.getCompanion(scope).turns.some(t=>t.role==='assistant'&&t.requestId==='manual-help-task'),false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
