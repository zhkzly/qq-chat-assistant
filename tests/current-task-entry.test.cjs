'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {Store}=require('../src/store.cjs');
const {Controller}=require('../src/controller.cjs');
const {createServer}=require('../src/server.cjs');
const {scope}=require('./fixtures/native.cjs');

test('manual QQ shortcut validates the complete captured scope before suggestion dispatch',async t=>{
 const store=new Store(':memory:'),calls=[];
 const controller=new Controller({store,settings:{anonymous:true,model:'synthetic',baseUrl:'http://fixture.invalid/v1'},read:async()=>{throw Error('No native QQ reads in this fixture');}});
 controller.scope={...scope};controller.suggest=async()=>{calls.push({...controller.scope});};
 const server=createServer({controller,token:'synthetic-entry',uiDir:path.resolve(__dirname,'../ui')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{controller.close();await new Promise(resolve=>server.close(resolve));store.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=args=>fetch(`${base}/api/suggest`,{method:'POST',headers:{Authorization:'Bearer synthetic-entry','Content-Type':'application/json'},body:JSON.stringify(args)});
 for(const field of ['accountUid','accountUin','peerUid','peerUin']){
  for(const args of [{...scope,[field]:`${scope[field]}-stale`},Object.fromEntries(Object.entries(scope).filter(([key])=>key!==field))]){
   const response=await post(args);assert.equal(response.status,400,`${field} must be present and current`);
   assert.match((await response.json()).error,/会话已改变/);
  }
 }
 assert.equal(calls.length,0,'stale requests never reach suggestion dispatch');
 const captured={...scope};controller.scope={...scope,peerUid:'new-peer',peerUin:'2222222222'};
 const switched=await post(captured);assert.equal(switched.status,400,'a contact change after capture is rejected');
 assert.equal(calls.length,0);
 const accepted=await post({...controller.scope});assert.equal(accepted.status,200);
 assert.deepEqual(calls,[controller.scope]);
});
test('the scoped suggestion API forwards only an explicit boolean alternative action',async t=>{
 const store=new Store(':memory:'),calls=[];const controller=new Controller({store,settings:{},read:async()=>{throw Error('No QQ reads');}});controller.scope={...scope};controller.suggest=async options=>{calls.push(options)};
 const server=createServer({controller,token:'synthetic-alternative',uiDir:path.resolve(__dirname,'../ui')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{controller.close();await new Promise(resolve=>server.close(resolve));store.close();});const base=`http://127.0.0.1:${server.address().port}`;
 for(const alternative of [true,false,'true']){const response=await fetch(`${base}/api/suggest`,{method:'POST',headers:{Authorization:'Bearer synthetic-alternative','Content-Type':'application/json'},body:JSON.stringify({...scope,alternative})});assert.equal(response.status,200);}
 assert.deepEqual(calls,[{alternative:true},{alternative:false},{alternative:false}]);
});
