'use strict';
// Source-shaped synthetic pointer-browser regression. No real QQ or provider traffic.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs');
const {Controller}=require('../src/controller.cjs');
const {createServer}=require('../src/server.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs');
const {CDP}=require('./cdp.cjs');
const {actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let n=0;n<120;n++){if(await check())return;await sleep(100);}throw Error(`Timed out: ${label}`);}

(async()=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-current-task-'));
 const profile=path.join(temp,'chrome'),evidence=fs.mkdtempSync(path.join(os.tmpdir(),'qq-current-task-evidence-'));
 const store=new Store(':memory:'),calls=[],callScopes=[],checks=[];
 let holdOptions=false,releaseOptions;
 const fictionalQQ=[raw('72057594037927937',false,{elements:[{elementType:1,textElement:{content:'这个游戏占的空间越来越多。'}}]}),raw('72057594037927938',true,{elements:[{elementType:1,textElement:{content:'我在杭州找了份实习。'}}]}),raw('72057594037927939',false,{elements:[{elementType:1,textElement:{content:'杭州离你平时住的地方远吗？'}}]})];
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-entry',auto:false,realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-entry'}};
 const controller=new Controller({store,settings,read:async(command,args)=>command==='bind'?(args.uin===scope.peerUin?scope:{...scope,peerUid:'other-peer',peerUin:args.uin}):{messages:command==='latest'?fictionalQQ:[],source:'synthetic'},assistantModel:async(_settings,input)=>{
  const p=input.payload;calls.push(structuredClone(p));callScopes.push(structuredClone(input.manifest.scope));
  if(p.purpose==='draft_prepare')return {draftPlan:{quotes:[{sourceId:p.userRequest.sourceId,text:p.userRequest.text}],style:'natural'}};
  if(p.purpose==='draft')return {kind:'draft',text:'参考表达',suggestions:[{style:'自然',text:'今天实习培训学到了一个新技巧。'}]};
  return {kind:p.purpose==='review'?'review':'question',text:p.purpose==='review'?'只回顾已经发生的交流。':'你愿意先说说这次想表达哪件真实小事吗？'};
 }});
 // Exercise the inspector's new projection with the agreed task contract,
 // deriving its QQ entries from the real source-shaped fixture and saved run.
 // This is an API readback fixture, not evidence of model or controller inference.
 const originalContext=controller.assistantContext.bind(controller);
 controller.assistantContext=()=>{const data=originalContext();if(!data.run)return data;const run=structuredClone(data.run),payload=run.payload;
  const recent=store.messages(controller.scope).map(record=>({sourceId:`qq:${record.messageId}`,text:record.text,speaker:record.direction==='outgoing'?'我':'对方',direction:record.direction,at:record.timestamp,sequence:record.sequence}));
  recent.at(-1).quote={sourceId:'qq:72057594037927930',availability:'unavailable'};
  const currentRequest=payload.userRequest||(run.requests||[]).map(request=>request.payload?.userRequest).findLast(Boolean);
  payload.taskContext={version:'relationship-task-2026-10-13.1',requestOrigin:'private_discussion',currentRequestSourceId:currentRequest?.sourceId,responsePreference:'自然一点，贴近我的说话方式',latestActual:{...recent.at(-1)},recentExchange:recent,selfMessagesAfterLastContact:[],contactMessagesAfterLastSelf:[recent.at(-1).sourceId],observationCoverage:{status:'partial',checkedAt:'2026-10-13T00:12:00.000Z'},selfEvidenceSourceIds:[recent[1].sourceId],auxiliaryPolicy:'best_effort'};
  payload.methodCatalog=[{id:'fixture-contingent',name:'顺着实际交流',version:'fixture1',brief:'先回应真实问题，再选择相关的下一步。'},{id:'fixture-clarify',name:'澄清缺少的事实',version:'fixture1',brief:'需要事实时在私下确认，不替用户编造。'}];
  payload.methodCards=[{id:'fixture-clarify',version:'fixture1'}];run.manifest.methodTrace={delivered:[{id:'fixture-clarify',version:'fixture1'}],reported:null};return {...data,run};};
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 const server=createServer({controller,token:'current-task-fixture',uiDir:path.join(root,'ui'),saveSettings(){},modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-entry'}]})})});
 const originalHandler=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',(request,response)=>{
  if(holdOptions&&request.method==='POST'&&request.url==='/api/options'){
   holdOptions=false;const end=response.end;
   response.end=function(...args){releaseOptions=()=>end.apply(response,args);return response;};
  }
  originalHandler(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`http://127.0.0.1:${server.address().port}/#current-task-fixture`],{stdio:'ignore'});
 let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Chrome');
  const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp=await CDP.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');await cdp.call('Page.enable');
  const ui=actions(cdp);await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});
  await until(()=>cdp.evaluate("!!document.querySelector('#contact-button')"),'helper');
  await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate("!!state?.scope&&!document.querySelector('#assistant-send').disabled"),'bound helper');

  if(!process.argv.includes('--scope-race-only')){
   const variants=[['discussion','我想主动补充一句今天的实习趣事，帮我先商量怎么接。','discussion'],['review','帮我回顾这些互动，先别写给她。','review'],['draft','我想告诉她今天实习培训学到了一个新技巧。','draft_prepare']];
   for(const [mode,text,firstPurpose]of variants){
    await ui.openDetails('#assistant-tools');await ui.click(`#assistant-${mode}`);await ui.fill('#assistant-input',text);
    const before=calls.length;await ui.click('#generate');await until(()=>calls.length>before&&!controller.assistantBusy,'typed quick help');
    assert.equal(calls[before].purpose,firstPurpose,'a typed shortcut preserves the selected help mode');
    assert.equal(calls[before].userRequest.text,text,'the natural private intent is the current request');
    assert.equal(await cdp.evaluate('nextPurpose'),mode,'the chosen mode is not silently reset');
    assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'','completed matching input is cleared like normal submit');
   checks.push(`Typed QQ shortcut preserves ${mode} intent and dispatch`);
   }
   await ui.click('#draft-button');await ui.fill('#draft','这份未发送草稿要保留。');await ui.click('#draft-close');
   await ui.workspace('background');await ui.openDetails('#goal-editor');await ui.fill('#goal-input','这个目标还没有保存，先保留。');await ui.workspace('discussion');
   await ui.fill('#assistant-input','未提交的后续想法不能被查看参考清掉。');const totalBefore=controller.snapshot().total;
   await ui.click('#assistant-context-button');await until(()=>cdp.evaluate("!!document.querySelector('[data-kind=current-task]')"),'task inspector');
   await ui.openDetails('[data-kind=current-task]');const taskText=await cdp.evaluate("document.querySelector('[data-kind=current-task]').textContent");
   assert.match(taskText,/杭州离你平时住的地方远吗/);assert.match(taskText,/我在杭州找了份实习/);assert.match(taskText,/复制操作不表示已经发送/);assert.match(taskText,/引用目标当前未提供/);
   await ui.openDetails('[data-kind=method-guidance]');const methodText=await cdp.evaluate("document.querySelector('[data-kind=method-guidance]').textContent");
   assert.match(methodText,/2 项概览.*1 项展开/s);assert.match(methodText,/fixture-clarify/);assert.match(methodText,/提供概览不代表已经采用/);
   await ui.click('#assistant-context-close');assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'未提交的后续想法不能被查看参考清掉。');
   assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'这份未发送草稿要保留。');assert.equal(await cdp.evaluate("document.querySelector('#goal-input').value"),'这个目标还没有保存，先保留。');assert.equal(controller.snapshot().total,totalBefore);
   checks.push('Synthetic task/readback shows actual QQ, unknown quote, self evidence and loaded guidance without clearing input, draft, goal or QQ');
   await ui.fill('#assistant-input','');
   const before=calls.length;await ui.click('#generate');await until(()=>calls.length===before+1&&!controller.assistantBusy,'empty scoped QQ help');
   const observation=calls.at(-1);assert.equal(observation.purpose,'reply');assert.notEqual(observation.userRequest.text,controller.instruction,'saved style is separate from the actual QQ task');
   assert.equal(observation.generationOrigin,'qq_observation');assert.equal(observation.taskContext.requestOrigin,'qq_observation');assert.equal(observation.taskContext.responsePreference,controller.instruction);
   assert.equal(observation.taskContext.latestActual.sourceId,'qq:72057594037927939');assert.deepEqual(callScopes.at(-1),scope,'observation remains bound to all four scope fields');
   checks.push('Empty shortcut retains the actual QQ task, separate style preference and complete captured scope');
  }

  await ui.fill('#assistant-input','');holdOptions=true;releaseOptions=null;const beforeRace=calls.length;
  await ui.click('#generate');await until(()=>!!releaseOptions,'held options response');
  await ui.click('#contact-button');await ui.fill('#qq-number','2222222222');await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate("state?.scope?.peerUin==='2222222222'"),'new contact');
  await ui.fill('#assistant-input','新联系人的未提交想法，不能被旧请求覆盖。');
  const release=releaseOptions;releaseOptions=null;release();await sleep(1100);
  assert.equal(calls.length,beforeRace,'old-scope options cannot trigger suggestion dispatch');
  assert.equal(await cdp.evaluate('state.scope.peerUin'),'2222222222','an old options response cannot restore the old contact');
  assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'新联系人的未提交想法，不能被旧请求覆盖。');
  checks.push('Contact changes during empty shortcut discard old response and preserve new unsent intent');
  await ui.composer('current-task help at390x650',{allowDisabled:true});
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({result:'PASS',evidence:'synthetic-pointer-browser',realModelCalls:0,nativeQQIntegration:false,checks},null,2));
  console.log(JSON.stringify({result:'PASS',checks:checks.length,report:path.join(evidence,'report.json')}));
 }catch(error){if(cdp)try{const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'failure.png'),Buffer.from(image.data,'base64'));console.error(`Screenshot: ${path.join(evidence,'failure.png')}`);}catch{}throw error;}
 finally{
  releaseOptions?.();cdp?.close();chrome.kill('SIGTERM');
  if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve();});});
  controller.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
