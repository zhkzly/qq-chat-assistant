'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fork}=require('node:child_process');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/assistant-protocol.cjs'),{createServer}=require('../src/server.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let n=0;n<100;n++){if(await predicate())return;await sleep(50);}throw Error('Synthetic helper refresh timed out');}
test('refresh restore is scope-bound, held-only, selection-only and never saves provider or auto settings',async t=>{
 const store=new Store(':memory:'),controller=new Controller({store,read:async()=>{throw Error('No native QQ in this fixture');},settings:{auto:true,anonymous:true,model:'synthetic',baseUrl:'http://fixture.invalid/v1'}});
 controller.scope={...scope};let held=true,saves=0,resumes=0;
 const server=createServer({controller,token:'synthetic-refresh',uiDir:path.resolve(__dirname,'../ui'),saveSettings:()=>saves++,refreshIsHeld:()=>held,refreshResume:()=>{held=false;resumes++;}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{controller.close();await new Promise(resolve=>server.close(resolve));store.close();});
 const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer synthetic-refresh','Content-Type':'application/json'};
 const post=(route,args)=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(args)});
 assert.match(await(await fetch(base+'/')).text(),/<body[^>]*inert/);
 for(const field of Object.keys(scope)){
  const missing=Object.fromEntries(Object.entries(scope).filter(([key])=>key!==field));
  assert.equal((await post('/api/refresh-resume',missing)).status,400);
  assert.equal((await post('/api/options',{...scope,[field]:'stale',refreshRestore:true,images:[],replyMessageIds:[]})).status,400);
 }
 assert.equal(resumes,0);
 for(const extra of [{auto:false},{instruction:'overwrite'},{model:'different'}])assert.equal((await post('/api/options',{...scope,refreshRestore:true,...extra})).status,400);
 const before=structuredClone(controller.settings);
 assert.equal((await post('/api/options',{...scope,refreshRestore:true,images:[{messageId:'72057594037927941',index:0}],replyMessageIds:[]})).status,200);
 assert.deepEqual(controller.selectedImages,[{messageId:'72057594037927941',index:0}]);assert.deepEqual(controller.settings,before);assert.equal(saves,0);
 const resumed=await post('/api/refresh-resume',scope);assert.equal(resumed.status,200);assert.equal((await resumed.json()).refreshHeld,false);assert.equal(resumes,1);
 assert.equal((await post('/api/refresh-resume',scope)).status,400);assert.equal((await post('/api/options',{...scope,refreshRestore:true,images:[]})).status,400);assert.equal(resumes,1);
 assert.doesNotMatch(await(await fetch(base+'/')).text(),/<body[^>]*inert/);
});
test('the actual helper worker queues visibility during inherited refresh hold and resumes normal configured work only after scoped release',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'qq-refresh-worker-'));fs.mkdirSync(path.join(folder,'data'));fs.symlinkSync(path.resolve(__dirname,'../ui'),path.join(folder,'ui'),'dir');
 let modelRequests=0;
 const model=http.createServer(async(request,response)=>{for await(const _chunk of request){}modelRequests++;response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'discussion',text:'Synthetic held-worker help'})}}]}));});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
 const settings={auto:true,anonymous:true,model:'synthetic-held-worker',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,lastPeerByAccountUid:{[scope.accountUid]:scope.peerUin}};
 settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl};
 fs.writeFileSync(path.join(folder,'data/settings.json'),JSON.stringify(settings));const settingsBefore=fs.readFileSync(path.join(folder,'data/settings.json'));
 const child=fork(path.resolve(__dirname,'../src/server.cjs'),[],{env:{...process.env,CHAT_ASSISTANT_ROOT:folder,CHAT_ASSISTANT_PORT:'0',CHAT_ASSISTANT_REFRESH_HOLD:'1'},stdio:['ignore','ignore','pipe','ipc']});
 let url,errors='';child.stderr.on('data',data=>errors+=data);
 child.on('message',message=>{
  if(message.type==='ready'){url=message.url;child.send({type:'visibility',visible:true});child.send({type:'status',status:{phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}}});child.send({type:'open-contact',uin:scope.peerUin});}
  if(message.type==='read')child.send({type:'reply',id:message.id,result:message.command==='bind'?scope:{messages:message.command==='latest'?[raw()]:[],source:'synthetic-native-fixture'}});
 });
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await new Promise(resolve=>model.close(resolve));fs.rmSync(folder,{recursive:true,force:true});});
 await until(()=>!!url);const parsed=new URL(url),base=parsed.origin,headers={Authorization:`Bearer ${parsed.hash.slice(1)}`,'Content-Type':'application/json'};
 const state=async()=>await(await fetch(base+'/api/state',{headers})).json();
 await until(async()=>{const s=await state();return s.scope&&s.scope.peerUid===scope.peerUid&&!s.historyBusy;});
 assert.equal((await state()).refreshHeld,true);await sleep(2100);assert.equal(modelRequests,0,'normal native visibility must not start model work before restoring inputs');
 const released=await fetch(base+'/api/refresh-resume',{method:'POST',headers,body:JSON.stringify(scope)});assert.equal(released.status,200);assert.equal((await released.json()).refreshHeld,false);
 await until(()=>modelRequests>0);assert.deepEqual(fs.readFileSync(path.join(folder,'data/settings.json')),settingsBefore);assert.equal((await state()).scope.peerUid,scope.peerUid);assert.equal(errors,'');
});
