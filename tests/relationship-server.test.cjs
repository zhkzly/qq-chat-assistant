'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {Store}=require('../src/store.cjs');const {Controller}=require('./fixtures/whole-answer-fidelity.cjs');const {createServer}=require('../src/server.cjs');const {scope}=require('./fixtures/native.cjs');
test('relationship HTTP consumers bind full identities, preserve exact feedback and enforce versions without sending',async t=>{
 const store=new Store(':memory:');let calls=0;
 const settings={auto:false,apiKey:'fixture-secret',model:'fixture',baseUrl:'http://fixture.invalid',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'fixture',baseUrl:'http://fixture.invalid'}};
 const controller=new Controller({store,settings,read:async command=>command==='bind'?scope:{messages:[]},assistantModel:async(_,input)=>{calls++;if(input.payload.purpose==='fidelity_check')return {checkRef:input.payload.checkRef,verdict:'allow',issues:[]};return {kind:'discussion',text:'可以说说你想多认识她的意思。'}}});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 const server=createServer({controller,token:'fixture-token',uiDir:path.resolve(__dirname,'../ui')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{controller.close();await new Promise(resolve=>server.close(resolve));store.close()});
 const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer fixture-token','Content-Type':'application/json'};
 const post=async(route,args)=>{const response=await fetch(base+route,{method:'POST',headers,body:JSON.stringify({...scope,...args})});return {status:response.status,body:await response.json()}};
 assert.equal((await fetch(base+'/api/experiences')).status,401);
 for(const changed of [{accountUid:'other'},{peerUid:'other'},{accountUin:'other'},{peerUin:'other'},{accountUin:undefined}]){
  const result=await post('/api/interaction-events',{...changed,type:'draft_independent',text:'private',clientEventId:'stale'});assert.equal(result.status,400);
 }
 assert.equal(store.experiences.draft(scope),null);
 const args={text:'想多认识她，怎么表达比较自然？',taskId:'http-once'};
 assert.equal((await post('/api/assistant',args)).status,200);assert.equal((await post('/api/assistant',args)).status,200);assert.equal(calls,2);
 assert.equal((await post('/api/assistant',{...args,text:'different'})).status,400);
 const assistant=store.getCompanion(scope).turns.find(turn=>turn.role==='assistant');
 assert.equal((await post('/api/feedback',{requestId:assistant.requestId,targetRef:{kind:'artifact',artifactRef:assistant.artifactRef},text:'这次请具体一点',clientEventId:'feedback-once'})).status,200);
 const feedback=store.experiences.listFeedback(scope)[0];
 const hydrated=await post('/api/feedback-context',{feedbackId:feedback.id});assert.equal(hydrated.body.target.target.body,assistant.text);assert.equal(hydrated.body.target.feedback.kind,'local');
 assert.equal((await post('/api/interaction-events',{type:'clipboard_write',text:'我对你有好感',clientEventId:'copy',expectedRevision:0})).status,200);
 assert.equal((await post('/api/interaction-events',{type:'actual_send',text:'fake',clientEventId:'send'})).status,400);assert.equal(store.messages(scope).length,0);
 assert.equal((await post('/api/claim-action',{id:'missing',operation:'withdraw',expectedVersion:1})).status,400);
 assert.equal((await post('/api/experience-adaptation',{operation:'activate',id:'missing'})).status,400);
 assert.equal((await post('/api/experience-link',{caseId:'missing',linkId:'missing',status:'user_confirmed'})).status,400);
 const task=await(await fetch(base+'/api/task/http-once',{headers})).json();assert.equal(task.status,'complete');
 controller.scope={...scope,peerUid:'other'};assert.equal((await fetch(base+'/api/task/http-once',{headers})).status,400);
});
