'use strict';
// Source-shaped synthetic pointer-browser regression. No native QQ or provider traffic.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{createServer}=require('../src/server.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs'),{CDP}=require('./cdp.cjs'),{actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let n=0;n<120;n++){if(await check())return;await sleep(100);}throw Error(`Timed out: ${label}`);}

(async()=>{
 const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-model-error-ui-'));
 const profile=path.join(temporary,'chrome'),evidence=fs.mkdtempSync(path.join(os.tmpdir(),'qq-model-error-evidence-'));
 const store=new Store(':memory:'),checks=[],calls=[];
 const modelFailure='助手模型请求失败：HTTP 429 (synthetic capacity)',readFailure='QQ 读取失败：synthetic latest timeout',localFailure='读取操作失败：synthetic HTTP 503';
 const privateInput='我想回顾刚才的交流，先和你商量。',unsentDraft='这份未发送草稿要保留。',unsavedGoal='这个尚未保存的关系目标要保留。';
 const fictionalQQ=[raw('72057594037927937'),raw('72057594037927938',true)];
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-model-error',auto:false,realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-model-error'}};
 let failLatest=false,failOlderOperation=false,legacySnapshot=false,releaseModel;
 const controller=new Controller({store,settings,read:async(command,args)=>{
  if(command==='bind')return args.uin===scope.peerUin?scope:{...scope,peerUid:'synthetic-other',peerUin:args.uin};
  if(command==='latest'&&failLatest)throw Error(readFailure);
  return {messages:command==='latest'&&args.scope.peerUin===scope.peerUin?fictionalQQ:[],source:'synthetic-native-fixture'};
 },assistantModel:async(_settings,input)=>{
  calls.push({purpose:input.payload.purpose,scope:structuredClone(input.manifest.scope)});
  if(calls.length===1)throw Object.assign(Error(modelFailure),{code:'model_http_429_capacity'});
  assert.equal(calls.length,2,'only the explicit retry may call the synthetic model');
  await new Promise(resolve=>{releaseModel=resolve;});
  return {kind:'review',text:'成功的合成回顾，只参考已有实际交流。'};
 },memoryModel:null});
 // Derive the legacy wire shape from the real snapshot. A distinct native
 // error always remains its own field; the fixture only copies model errors.
 const snapshot=controller.snapshot.bind(controller);
 controller.snapshot=()=>{const value=snapshot();return legacySnapshot&&value.assistantError&&!value.error?{...value,error:value.assistantError}:value;};
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 const server=createServer({controller,token:'synthetic-model-error',uiDir:path.join(root,'ui'),saveSettings(){},modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-model-error'}]})})});
 const handler=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',(request,response)=>{
  // A browser-local operation failure must not mutate backend error state.
  if(failOlderOperation&&request.method==='POST'&&request.url==='/api/older'){
   failOlderOperation=false;response.writeHead(503,{'Content-Type':'application/json'});response.end(JSON.stringify({error:localFailure}));return;
  }
  handler(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`http://127.0.0.1:${server.address().port}/#synthetic-model-error`],{stdio:'ignore'});
 let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Chrome');
  const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();cdp=await CDP.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');await cdp.call('Page.enable');
  const ui=actions(cdp);await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});
  const alerts=()=>cdp.evaluate("[...document.querySelectorAll('[role=alert]')].filter(el=>el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(el=>({id:el.id,text:el.textContent}))");
  await until(()=>cdp.evaluate("!!document.querySelector('#contact-button')"),'helper');
  await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate("!!state?.scope&&!loadingHistory&&!document.querySelector('#assistant-send').disabled"),'bound helper');
  const actualQQ=structuredClone(store.messages(scope));assert.ok(actualQQ.length===2&&actualQQ.every(record=>typeof record.messageId==='string'));
  await ui.click('#draft-button');await ui.fill('#draft',unsentDraft);await ui.click('#draft-close');
  await ui.workspace('background');await ui.openDetails('#goal-editor');await ui.fill('#goal-input',unsavedGoal);await ui.workspace('discussion');
  await ui.openDetails('#assistant-tools');await ui.click('#assistant-review');await ui.fill('#assistant-input',privateInput);
  const preserved=async(input)=>{
   assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),input);
   assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),unsentDraft);
   assert.equal(await cdp.evaluate("document.querySelector('#goal-input').value"),unsavedGoal);
   assert.equal(await cdp.evaluate('nextPurpose'),'review');assert.deepEqual(store.messages(scope),actualQQ,'errors and private discussion do not create actual QQ messages');
   assert.equal(settings.model,'synthetic-model-error');assert.equal(settings.baseUrl,'http://fixture.invalid/v1');assert.equal(controller.auto,false);
  };

  await ui.click('#assistant-send');
  await until(async()=>calls.length===1&&!controller.assistantBusy&&await cdp.evaluate('!assistantPending&&state?.assistantError.includes("429")'),'failed model submission');
  assert.equal(controller.error,'','model failure is not copied into the native/global channel');assert.equal(controller.assistantError,modelFailure);
  const failed=store.getCompanion(scope);assert.equal(failed.turns.filter(turn=>turn.role==='user').length,1);assert.equal(failed.turns[0].text,privateInput);
  assert.equal(failed.turns.filter(turn=>turn.role==='assistant').length,0,'a failed model request cannot invent an assistant reply');
  assert.equal(failed.runs.at(-1).status,'failed');assert.equal(failed.runs.at(-1).error,modelFailure);
  assert.deepEqual(await alerts(),[{id:'assistant-error',text:modelFailure}]);await preserved(privateInput);
  checks.push('Synthetic HTTP429 saves the private question, adds no assistant reply, preserves input/draft/goal/mode/QQ, and shows one assistant banner');

  legacySnapshot=true;controller.changed();
  await until(()=>cdp.evaluate('state?.error===state?.assistantError&&!!state?.assistantError'),'legacy duplicated snapshot');
  assert.deepEqual(await alerts(),[{id:'assistant-error',text:modelFailure}],'legacy duplicate error fields have one visible model banner');
  const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'single-model-error.png'),Buffer.from(image.data,'base64'));
  checks.push('A source-derived legacy snapshot with equal global/private model errors still has exactly one visible banner');

  failLatest=true;await assert.rejects(controller.loadLatest(),/synthetic latest timeout/);
  await until(()=>cdp.evaluate(`state?.error===${JSON.stringify(readFailure)}`),'separate native read failure');
  assert.deepEqual(await alerts(),[{id:'error',text:readFailure},{id:'assistant-error',text:modelFailure}],'distinct native and model failures remain separate');await preserved(privateInput);
  failLatest=false;await controller.loadLatest();
  await until(()=>cdp.evaluate('state?.coverage?.status!=="read_error"&&state?.error===state?.assistantError'),'native error cleared');
  assert.deepEqual(await alerts(),[{id:'assistant-error',text:modelFailure}],'cleared backend read failure is not cached as a local fault');
  checks.push('Distinct native/model errors both remain visible; clearing the backend read error removes its banner without a stale local copy');

  controller.error=modelFailure;controller.changed();await until(()=>cdp.evaluate('state?.error===state?.assistantError'),'copied controller error');
  await ui.click('#assistant-send');await until(()=>calls.length===2&&!!releaseModel,'explicit retry in progress');
  assert.equal(controller.error,'','a fresh attempt clears a copied legacy model error');assert.equal(controller.assistantError,'');
  await until(()=>cdp.evaluate('state?.assistantBusy&&!state?.error&&!state?.assistantError'),'retry cleared backend snapshot');
  assert.deepEqual(await alerts(),[],'a retry clears prior model banners before its result');await preserved(privateInput);
  releaseModel();releaseModel=null;
  await until(()=>cdp.evaluate('!assistantPending&&!state?.assistantBusy&&state?.companion.turns.some(turn=>turn.role==="assistant")'),'successful retry');
  assert.deepEqual(await alerts(),[]);await preserved('');
  assert.equal(store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);
  assert.deepEqual(calls.map(call=>call.purpose),['review','review']);calls.forEach(call=>assert.deepEqual(call.scope,scope));
  checks.push('One explicit successful retry clears copied legacy errors while pending and after completion, preserving draft/goal/mode and actual QQ');

  await ui.workspace('history');failOlderOperation=true;await ui.click('#older');
  await until(async()=>JSON.stringify(await alerts())===JSON.stringify([{id:'error',text:localFailure}]),'browser-local operation error');
  assert.equal(controller.error,'');await sleep(1200);
  assert.deepEqual(await alerts(),[{id:'error',text:localFailure}],'polling retains a real local operation error');
  await ui.click('#older');await until(async()=>(await alerts()).length===0,'successful local action retry');await ui.workspace('discussion');await preserved('');
  checks.push('A browser-local operation error survives backend polls and clears on the next successful action retry');

  legacySnapshot=false;controller.assistantError=modelFailure;controller.changed();
  await until(()=>cdp.evaluate(`state?.assistantError===${JSON.stringify(modelFailure)}`),'old contact model error');
  await ui.click('#contact-button');await ui.fill('#qq-number','2222222222');await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate('state?.scope?.peerUin==="2222222222"&&!state?.assistantError'),'new contact');
  assert.deepEqual(await alerts(),[],'the old contact model failure does not leak into another contact');
  assert.deepEqual(store.messages(scope),actualQQ);assert.equal(calls.length,2,'no automatic model retry or contact-switch model call');
  checks.push('Changing contacts clears the old model error without a hidden model retry or changes to the previous contact QQ records');
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({result:'PASS',evidence:'synthetic-pointer-browser',nativeQQIntegration:false,realModelCalls:0,syntheticModelCalls:calls.length,checks},null,2));
  console.log(JSON.stringify({result:'PASS',checks:checks.length,syntheticModelCalls:calls.length,realModelCalls:0,nativeQQIntegration:false,report:path.join(evidence,'report.json')}));
 }catch(error){if(cdp)try{const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'failure.png'),Buffer.from(image.data,'base64'));console.error(`Screenshot: ${path.join(evidence,'failure.png')}`);}catch{}throw error;}
 finally{
  releaseModel?.();cdp?.close();chrome.kill('SIGTERM');
  if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve();});});
  controller.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
