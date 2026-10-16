'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const store=new Store(':memory:');let now=Date.parse('2026-10-16T10:00:00Z');
 const settings={auto:false,anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic',realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic'}};
 const c=new Controller({store,settings,now:()=>now,read:async()=>{throw Error('No native QQ reads in this fixture');}});c.scope={...scope};
 t.after(()=>{c.close();store.close();});return {c,store,advance:ms=>{now+=ms;}};
}
test('enabling automatic suggestions debounces an incoming burst and never schedules after actual outgoing',async t=>{
 const {c}=fixture(t);let calls=0;c.suggest=async()=>{calls++};
 t.mock.timers.enable({apis:['setTimeout']});
 c.live({scope,messages:[raw('51001')]});c.configure({auto:true});
 t.mock.timers.tick(1799);await tick();assert.equal(calls,0);t.mock.timers.tick(1);await tick();assert.equal(calls,1,'enabling auto schedules the already pending incoming exchange');
 c.live({scope,messages:[raw('51002')]});
 t.mock.timers.tick(1000);c.live({scope,messages:[raw('51003')]});
 t.mock.timers.tick(1799);await tick();assert.equal(calls,1);
 t.mock.timers.tick(1);await tick();assert.equal(calls,2);
 c.live({scope,messages:[raw('51004',true)]});c.setVisible(true);c.configure({auto:false});c.configure({auto:true});
 t.mock.timers.tick(2000);await tick();assert.equal(calls,2,'an already answered exchange does not automatically ask for another draft');
 t.mock.timers.reset();
});
test('actual outgoing cancels automatic continuation and keeps a user private request resumable',async t=>{
 const {c}=fixture(t);const calls=[];c.auto=true;c.assist=async args=>{calls.push(args)};
 t.mock.timers.enable({apis:['setTimeout']});
 c.busy=true;c.activeAssist={scope:{...scope},taskId:'automatic-fixture',turnId:'auto-turn',resumes:0,args:{text:'synthetic',purpose:'reply',transient:true,origin:'automatic'}};
 c.live({scope,messages:[raw('52001',true)]});
 t.mock.timers.tick(1800);await tick();assert.equal(calls.length,0);assert.equal(c.pendingAssist,null);assert.equal(c.busy,false,'cancellation unblocks the UI even before an old provider promise settles');
 c.activeAssist={scope:{...scope},taskId:'user-fixture',turnId:'user-turn',resumes:0,args:{text:'Help me think',purpose:'discussion',origin:'user'}};
 c.live({scope,messages:[raw('52002')]});
 c.configure({auto:false});t.mock.timers.tick(1800);await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].origin,'user');assert.equal(calls[0].resumes,1);
 t.mock.timers.reset();
});
test('disabling automatic suggestions aborts automatic work and pending retries without aborting user work',async t=>{
 const {c}=fixture(t);let calls=0;c.assist=async()=>{calls++};c.auto=true;
 t.mock.timers.enable({apis:['setTimeout']});
 const abort=new AbortController();c.assistantAbort=abort;c.assistantBusy=true;
 c.activeAssist={scope:{...scope},taskId:'automatic-fixture',turnId:'auto-turn',resumes:0,args:{text:'synthetic',purpose:'reply',transient:true,origin:'automatic'}};
 c.configure({auto:false});assert.equal(abort.signal.aborted,true);assert.equal(c.assistantBusy,false);
 c.auto=true;c.activeAssist={scope:{...scope},taskId:'pending-fixture',turnId:'auto-turn',resumes:0,args:{text:'synthetic',purpose:'reply',transient:true,origin:'automatic'}};
 c.live({scope,messages:[raw('53001')]});assert.ok(c.pendingAssist);c.configure({auto:false});t.mock.timers.tick(1800);await tick();assert.equal(calls,0);
 const userAbort=new AbortController();c.assistantAbort=userAbort;c.assistantBusy=true;c.activeAssist={scope:{...scope},taskId:'user-fixture',args:{origin:'user'}};
 c.configure({auto:false});assert.equal(userAbort.signal.aborted,false);assert.equal(c.assistantBusy,true);
 t.mock.timers.reset();
});
