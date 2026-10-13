'use strict';
// Synthetic pointer-browser check of the public status contract. No native QQ,
// real account data, provider calls, or message sending are used.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs');
const {Controller}=require('../src/controller.cjs');
const {createServer}=require('../src/server.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs');
const {CDP}=require('./cdp.cjs');
const {actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let n=0;n<100;n++){if(await check())return;await sleep(100)}throw Error(`Timed out: ${label}`)}
(async()=>{
 const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-readiness-ui-'));
 const profile=path.join(temporary,'chrome'),evidence=fs.mkdtempSync(path.join(os.tmpdir(),'qq-readiness-evidence-'));
 const store=new Store(':memory:'),checks=[],calls=[];
 const account={uid:scope.accountUid,uin:scope.accountUin};
 const controller=new Controller({store,settings:{anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-readiness',auto:false,
  realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-readiness'}},
  read:async command=>command==='bind'?scope:{messages:[raw()],source:'synthetic'},
  assistantModel:async(_settings,input)=>{calls.push(structuredClone(input.payload));return {kind:input.payload.purpose==='review'?'review':'discussion',text:'可以根据已有交流，继续商量你想表达的意思。'}}});
 controller.updateStatus({phase:'ready',account});
 const server=createServer({controller,token:'readiness-fixture',uiDir:path.join(root,'ui'),saveSettings(){},
  modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-readiness'}]})})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',
  `--user-data-dir=${profile}`,'--remote-debugging-port=0',`http://127.0.0.1:${server.address().port}/#readiness-fixture`],{stdio:'ignore'});
 let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Chrome');
  const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp=await CDP.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');await cdp.call('Page.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:370,height:560,deviceScaleFactor:1,mobile:false});
  const ui=actions(cdp);await until(()=>cdp.evaluate("!!document.querySelector('#contact-button')"),'helper');
  await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate("!!state?.scope&&!state.historyBusy&&!document.querySelector('#assistant-send').disabled"),'bound helper');
  assert.equal(await cdp.evaluate("document.querySelector('#workspace-status').textContent"),'QQ 已连接');
  assert.match(await cdp.evaluate("document.querySelector('#connection-label').textContent"),/只读监听/);
  checks.push('A legacy logged-in status without nativeReadReady keeps the existing display and available private discussion');

  const feedbackTurn=store.appendTurn(scope,{role:'assistant',kind:'discussion',requestId:'synthetic-feedback-target',text:'可以先聊聊你们都愿意分享的近况。'});
  controller.changed();await until(()=>cdp.evaluate(`!!document.querySelector('[data-turn-id="${feedbackTurn.id}"]')`),'feedback target');
  await ui.click(`[data-turn-id="${feedbackTurn.id}"] > button`);await ui.fill('#feedback-text','这条反馈还没有提交。');
  await ui.fill('#assistant-input','尚未提交的私下想法。');await ui.openDetails('#assistant-tools');await ui.click('#assistant-review');
  await ui.click('#draft-button');await ui.fill('#draft','独立编辑的未发送回复。');await ui.click('#draft-close');
  await ui.workspace('background');await ui.openDetails('#goal-editor');await ui.fill('#goal-input','尚未保存的关系目标。');
  await ui.openDetails('#note-editor');await ui.fill('#note-text','尚未保存的近况。');await ui.select('#note-use','discussion');
  await ui.workspace('discussion');
  const values=()=>cdp.evaluate("Object.fromEntries(['assistant-input','draft','goal-input','note-text','note-use','feedback-text','feedback-request-id'].map(id=>[id,document.getElementById(id).value]))");
  const before=await values(),beforeEpoch=await cdp.evaluate('historyEpoch'),beforeScope=await cdp.evaluate('scopeKey');
  controller.updateStatus({phase:'ready',account,nativeReadReady:false});
  await until(()=>cdp.evaluate('state?.status.nativeReadReady===false'),'read channel unavailable');
  assert.equal(await cdp.evaluate("document.querySelector('#workspace-status').textContent"),'QQ 读取待恢复');
  assert.equal(await cdp.evaluate("document.querySelector('#native-read-status').hidden"),false);
  assert.match(await cdp.evaluate("document.querySelector('#native-read-status').textContent"),/仍可继续私下商量/);
  assert.match(await cdp.evaluate("document.querySelector('#connection-label').textContent"),/已登录.*读取暂未就绪/);
  assert.equal(await cdp.evaluate("document.querySelector('#workspace-dot').classList.contains('ready')"),false);
  assert.deepEqual(await values(),before);assert.equal(await cdp.evaluate('scopeKey'),beforeScope);assert.equal(await cdp.evaluate('historyEpoch'),beforeEpoch);
  assert.equal(await cdp.evaluate('nextPurpose'),'review');assert.equal(calls.length,0);
  assert.deepEqual(controller.scope,scope);await ui.composer('readiness loss at370x560');
  checks.push('Read-channel loss is visible separately from login, with every prepared field, exact feedback target, next mode, scope and cached record retained');

  await ui.workspace('history');assert.match(await cdp.evaluate("document.querySelector('#history').textContent"),/今天有点累，刚忙完/);await ui.workspace('discussion');
  await ui.openDetails('#assistant-tools');await ui.click('#assistant-discussion');await ui.click('#assistant-send');
  await until(()=>calls.length===1&&!controller.assistantBusy,'private discussion using cached QQ');
  assert.equal(calls[0].purpose,'discussion');assert.ok(calls[0].sources.some(source=>source.id===`qq:${raw().msgId}`&&source.text==='今天有点累，刚忙完'));
  assert.equal(store.messages(scope).length,1);assert.equal(store.messages(scope).filter(message=>message.direction==='outgoing').length,0);
  for(const id of ['draft','goal-input','note-text','note-use','feedback-text','feedback-request-id'])assert.equal((await values())[id],before[id]);
  await ui.fill('#assistant-input','恢复读取时也保留这句新想法。');const remaining=await values();
  controller.updateStatus({phase:'ready',account,nativeReadReady:true});
  await until(()=>cdp.evaluate('state?.status.nativeReadReady===true'),'read channel restored');
  assert.equal(await cdp.evaluate("document.querySelector('#workspace-status').textContent"),'QQ 已连接');
  assert.equal(await cdp.evaluate("document.querySelector('#native-read-status').hidden"),true);assert.deepEqual(await values(),remaining);
  controller.updateStatus({phase:'ready',account});await until(()=>cdp.evaluate('state?.status.nativeReadReady===undefined'),'legacy status restored');
  assert.equal(await cdp.evaluate("document.querySelector('#native-read-status').hidden"),true);assert.deepEqual(await values(),remaining);await ui.composer('restored readiness at370x560');
  checks.push('Cached QQ remains viewable and usable for explicit private help while unavailable; true or absent readiness clears only the notice, without sending QQ');
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({result:'PASS',evidence:'synthetic-pointer-browser-public-native-readiness',realModelCalls:0,syntheticModelCalls:calls.length,nativeQQIntegration:false,qqMessagesSent:0,checks},null,2));
  console.log(JSON.stringify({result:'PASS',checks:checks.length,report:path.join(evidence,'report.json')}));
 }catch(error){
  if(cdp)try{const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'failure.png'),Buffer.from(shot.data,'base64'));console.error(`Screenshot: ${path.join(evidence,'failure.png')}`)}catch{}
  throw error;
 }finally{
  cdp?.close();chrome.kill('SIGTERM');if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve()})});
  controller.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1});
