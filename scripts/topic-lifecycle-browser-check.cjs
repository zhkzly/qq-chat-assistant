'use strict';
// Synthetic real-pointer lifecycle regression. No native QQ or provider traffic.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{createServer}=require('../src/server.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs'),{CDP}=require('./cdp.cjs'),{actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let n=0;n<120;n++){if(await check())return;await sleep(100);}throw Error(`Timed out: ${label}`);}

(async()=>{
 const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-topic-lifecycle-'));
 const profile=path.join(temporary,'chrome'),evidence=fs.mkdtempSync(path.join(os.tmpdir(),'qq-topic-lifecycle-evidence-'));
 const store=new Store(':memory:'),requests=[],checks=[];let modelCalls=0,holdModel=false,resolveModel,beforeTopic=null,holdResponse=false,releaseResponse,holdState=false,releaseState;
 const otherScope={...scope,peerUid:'synthetic-other-peer',peerUin:'2222222222'};
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-offline',auto:false,realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-offline'}};
 const controller=new Controller({store,settings,read:async(command,args)=>command==='bind'?(args.uin===scope.peerUin?scope:otherScope):{messages:command==='latest'?[raw()]:[],source:'synthetic-native-fixture'},assistantModel:async()=>{
  modelCalls++;if(holdModel)return new Promise(resolve=>{resolveModel=resolve;});const error=Error('Synthetic HTTP 429 (capacity)');error.code='HTTP_429';throw error;
 }});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.setVisible(false);
 function topicPatchFor(target,text,operation='create',old=null){
  const turn=store.appendTurn(target,{role:'user',kind:'discussion',text,requestId:`fixture-${Date.now()}-${Math.random()}`}),sourceId=`private:${turn.id}`,sources=store.memorySources(target);
  const patch={operation,...(old?{topicId:old.id,direction:text}:{objective:text,direction:'先顺着真实交流商量'}),purposeSourceIds:[sourceId],intentQuote:text};
  const receipt=store.applyTopicPatch(target,patch,{baseRevision:store.getCompanion(target).revision,baseTopicVersion:store.topicView(target).version,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),currentSourceId:sourceId,origin:'private_discussion',requestId:turn.requestId});
  assert.equal(receipt.applied,true,JSON.stringify(receipt));controller.changed();return store.topicView(target).active;
 }
 store.setGoal(scope,'相互了解，发展彼此愿意的亲密关系');
 const initial=topicPatchFor(scope,'自然了解她玩的游戏');controller.assistantError='助手模型请求失败： HTTP 429 (capacity)';controller.changed();
 const server=createServer({controller,token:'synthetic-topic-lifecycle',uiDir:path.join(root,'ui'),saveSettings(){},modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-offline'}]})})});
 const originalHandler=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',(request,response)=>{
  if(holdState&&request.method==='GET'&&request.url==='/api/state'){
   holdState=false;const end=response.end;response.end=function(...args){releaseState=()=>end.apply(response,args);return response;};
  }
  if(request.method==='POST'&&request.url==='/api/topic-action'){
   let body='';request.on('data',chunk=>{body+=chunk;});request.on('end',()=>requests.push(JSON.parse(body)));
   const before=beforeTopic;beforeTopic=null;before?.();
   if(holdResponse){holdResponse=false;const end=response.end;response.end=function(...args){releaseResponse=()=>end.apply(response,args);return response;};}
  }
  originalHandler(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`http://127.0.0.1:${server.address().port}/#synthetic-topic-lifecycle`],{stdio:'ignore'});let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Chrome');const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp=await CDP.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Page.enable');const ui=actions(cdp);
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});await until(()=>cdp.evaluate("!!document.querySelector('#contact-button')&&typeof state!=='undefined'"),'helper renderer');await until(async()=>await cdp.evaluate('state?.topicContext?.active?.id')===initial.id,'active topic');
  await ui.openDetails('#assistant-tools');await ui.click('#assistant-review');await ui.fill('#assistant-input','我现在想聊工作，这句尚未提交。');
  await ui.click('#draft-button');await ui.fill('#draft','未发送草稿保持原样。');await ui.click('#draft-close');await ui.workspace('background');await ui.openDetails('#goal-editor');await ui.fill('#goal-input','尚未保存的长期目标也要保留。');await ui.workspace('discussion');
  const before=store.messages(scope),input='我现在想聊工作，这句尚未提交。',draft='未发送草稿保持原样。',goal='尚未保存的长期目标也要保留。';
  async function assertInputs(){assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),input);assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),draft);assert.equal(await cdp.evaluate("document.querySelector('#goal-input').value"),goal);assert.equal(await cdp.evaluate('nextPurpose'),'review');assert.equal(await cdp.evaluate('goalDirty'),true);}
  holdState=true;releaseState=null;await until(()=>!!releaseState,'held older active-topic poll');await ui.openDetails('#topic-direction');await ui.click('#topic-complete');await sleep(400);
  assert.equal(requests.length,1,'completion must directly submit a scoped topic action, even when the provider is at capacity');
  await until(()=>cdp.evaluate("document.querySelector('#topic-direction').hidden"),'completed card disappears');assert.equal(store.topicView(scope).active,null);assert.equal(store.topicView(scope).items.find(t=>t.id===initial.id).lifecycle,'completed');
  assert.deepEqual(requests[0],{id:initial.id,expectedVersion:initial.version,operation:'complete',...scope});await assertInputs();assert.equal(modelCalls,0);assert.deepEqual(store.messages(scope),before);checks.push('Completes immediately with HTTP 429 and preserves private input, unsent draft, dirty goal, mode and actual QQ');
  const completedVersion=store.topicView(scope).version;releaseState();releaseState=null;await sleep(150);assert.equal(await cdp.evaluate("document.querySelector('#topic-direction').hidden"),true);assert.equal(await cdp.evaluate('state.topicContext.version'),completedVersion);assert.equal(await cdp.evaluate('state.companion.topics.version'),completedVersion);await assertInputs();checks.push('An older same-contact poll cannot revive the completed card or its companion topic projection');
  await cdp.call('Page.reload');await until(()=>cdp.evaluate('!!state?.scope&&!loadingHistory'),'reloaded helper');assert.equal(await cdp.evaluate("document.querySelector('#topic-direction').hidden"),true);assert.equal(store.topicView(scope).items.find(t=>t.id===initial.id).lifecycle,'completed');assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),draft);checks.push('Completed topic stays closed after renderer reload');

  const remove=topicPatchFor(scope,'不再继续的游戏方向');await until(async()=>await cdp.evaluate('state?.topicContext?.active?.id')===remove.id,'new removable topic');const priorTurns=store.getCompanion(scope).turns.map(turn=>({id:turn.id,text:turn.text}));delete settings.realChatConsent;controller.changed();await until(()=>cdp.evaluate('state?.modelConsent===false'),'model is not permitted');await ui.fill('#assistant-input','换个话题的想法不要被删除。');await ui.openDetails('#topic-direction');await ui.click('#topic-remove');await until(()=>cdp.evaluate("document.querySelector('#topic-direction').hidden"),'removed card disappears');assert.equal(store.topicView(scope).items.some(t=>t.id===remove.id),false);assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'换个话题的想法不要被删除。');assert.equal(modelCalls,0);assert.deepEqual(store.messages(scope),before);assert.ok(priorTurns.every(turn=>store.getCompanion(scope).turns.some(item=>item.id===turn.id&&item.text===turn.text)));settings.realChatConsent={...scope,baseUrl:settings.baseUrl,model:settings.model};controller.changed();checks.push('Removal works without model consent and deletes only the topic record, preserving QQ and consultation without any model request');

  const stale=topicPatchFor(scope,'需要保护的当前方向');await until(async()=>await cdp.evaluate('state?.topicContext?.active?.id')===stale.id,'topic before conflict');await ui.fill('#assistant-input','发生冲突时保留这段输入。');beforeTopic=()=>topicPatchFor(scope,'另一个窗口已经调整了方向','update',store.topicView(scope).active);await ui.openDetails('#topic-direction');await ui.click('#topic-complete');await until(()=>cdp.evaluate("!document.querySelector('#assistant-error').hidden"),'stale-version error');assert.ok(store.topicView(scope).active);assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'发生冲突时保留这段输入。');assert.equal(await cdp.evaluate("document.querySelector('#topic-direction').hidden"),false);assert.equal(modelCalls,0);checks.push('Stale topic version is rejected without removing the current card or private input');

  // An in-flight model result must not reactivate a manually completed purpose.
  await until(async()=>await cdp.evaluate('state?.topicContext?.active?.version')===store.topicView(scope).active.version,'current topic version');holdModel=true;await ui.fill('#assistant-input','这次先帮我商量。');await ui.click('#assistant-send');await until(()=>!!resolveModel&&controller.assistantBusy,'held assistant request');await ui.openDetails('#topic-direction');await ui.click('#topic-complete');await until(()=>store.topicView(scope).active===null,'closure while busy');resolveModel({kind:'discussion',text:'迟到的旧方向不能重新出现。'});resolveModel=null;await until(()=>!controller.assistantBusy,'old assistant unwinds');await sleep(1100);assert.equal(store.topicView(scope).active,null);assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'这次先帮我商量。');assert.equal(await cdp.evaluate("document.querySelector('#topic-direction').hidden"),true);assert.equal(modelCalls,1);checks.push('Completion remains available while a model request is busy and its late result cannot restore the topic or clear the original pending input');

  const race=topicPatchFor(scope,'旧联系人的局部方向');topicPatchFor(otherScope,'新联系人的局部方向');await until(async()=>await cdp.evaluate('state?.topicContext?.active?.id')===race.id,'old contact topic');holdResponse=true;releaseResponse=null;await ui.openDetails('#topic-direction');await ui.click('#topic-remove');await until(()=>!!releaseResponse,'held lifecycle response');await ui.click('#contact-button');await ui.fill('#qq-number',otherScope.peerUin);await ui.click('#contact-form button[type=submit]');await until(async()=>await cdp.evaluate('state?.scope?.peerUid')===otherScope.peerUid,'new contact');await ui.fill('#assistant-input','新联系人的输入不能被旧结果覆盖。');const currentId=store.topicView(otherScope).active.id;releaseResponse();releaseResponse=null;await sleep(1100);assert.equal(await cdp.evaluate('state.scope.peerUid'),otherScope.peerUid);assert.equal(await cdp.evaluate('state.topicContext.active.id'),currentId);assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'新联系人的输入不能被旧结果覆盖。');assert.equal(modelCalls,1);checks.push('Delayed old-contact lifecycle response is discarded without replacing the new contact, its topic or new private input');
  await ui.composer('topic lifecycle at390x650',{allowDisabled:true});fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({result:'PASS',evidence:'synthetic-pointer-browser',realModelCalls:0,syntheticModelCalls:modelCalls,nativeQQIntegration:false,checks},null,2));console.log(JSON.stringify({result:'PASS',checks:checks.length,report:path.join(evidence,'report.json')}));
 }catch(error){if(cdp)try{const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'failure.png'),Buffer.from(shot.data,'base64'));console.error(`Screenshot: ${path.join(evidence,'failure.png')}`);}catch{}throw error;}
 finally{resolveModel?.({kind:'discussion',text:'Cleanup'});releaseResponse?.();releaseState?.();cdp?.close();chrome.kill('SIGTERM');if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve();});});controller.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
