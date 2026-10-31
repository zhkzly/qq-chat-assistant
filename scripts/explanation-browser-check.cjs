'use strict';
// Synthetic model transport through the real controller/server and pointer UI.
// No private user data, native QQ integration or real provider calls.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs'),{Controller}=require('../tests/fixtures/whole-answer-fidelity.cjs'),{createServer}=require('../src/server.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs'),{CDP}=require('./cdp.cjs'),{actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let n=0;n<120;n++){if(await check())return;await sleep(100);}throw Error(`Timed out: ${label}`);}

(async()=>{
 const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-explanation-ui-'));
 const profile=path.join(temporary,'chrome'),evidence=fs.mkdtempSync(path.join(os.tmpdir(),'qq-explanation-evidence-'));
 const store=new Store(':memory:'),checks=[],requests=[];
 const originalQuestion='她刚说今天又加班了，帮我接一句，也说明你这样建议的依据。私下顾虑：担心自己接不住她的话，这个不要写给她。';
 const nextPrivateInput='这是下一段还未提交的想法。',unsentDraft='这是原先尚未发送的草稿。',unsavedGoal='这份尚未保存的关系目标需要保留。';
 const explanation='她明确分享的是今天加班，所以先具体接住她的近况。不能据此判断她是否愿意发展恋爱关系。PRIVATE_PLANNER_SENTINEL：你的私人顾虑留在这里讨论。';
 const wording='今天听着挺忙的，先喘口气吧。';
 const qq=[raw('72057594037927937',false,{elements:[{elementType:1,textElement:{content:'今天又加班了，终于下班。'}}]})];
 let releasePlanner;
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-explanation',auto:false,realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-explanation'}};
 const controller=new Controller({store,settings,read:async(command,args)=>{
  if(command==='bind')return args.uin===scope.peerUin?scope:{...scope,peerUid:'synthetic-other',peerUin:args.uin};
  return {messages:command==='latest'&&args.scope.peerUin===scope.peerUin?qq:[],source:'synthetic-native-fixture'};
 },assistantModel:async(_settings,input)=>{
  requests.push({purpose:input.payload.purpose,payload:structuredClone(input.payload)});
  if(requests.length===1){
   assert.equal(input.payload.userRequest.text,originalQuestion);await new Promise(resolve=>{releasePlanner=resolve});
   return {operation:'prepare_message',answer:{privateExplanation:explanation,suggestions:[{style:'自然',text:wording}]},methodIds:['respond']};
  }
  assert.equal(requests.length,2,'one complete primary and one read-only fidelity check');assert.equal(input.payload.purpose,'fidelity_check');
  assert.equal(input.payload.candidate.discussionExplanation.text,explanation);assert.equal(input.payload.candidate.text,'');
  assert.equal(JSON.stringify(input.payload.admittedFragments).includes('PRIVATE_PLANNER_SENTINEL'),false,'private explanation is not outward material');
  return {checkRef:input.payload.checkRef,verdict:'allow',issues:[]};
 },memoryModel:null});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 const server=createServer({controller,token:'synthetic-explanation-ui',uiDir:path.join(root,'ui'),saveSettings(){},modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-explanation'}]})})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`http://127.0.0.1:${server.address().port}/#synthetic-explanation-ui`],{stdio:'ignore'});
 let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Chrome');
  const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();cdp=await CDP.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');await cdp.call('Page.enable');const ui=actions(cdp);
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});
  await until(()=>cdp.evaluate("!!document.querySelector('#contact-button')"),'helper');
  await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate("!!state?.scope&&!loadingHistory&&!document.querySelector('#assistant-send').disabled"),'bound helper');
  const actualQQ=structuredClone(store.messages(scope));
  await ui.click('#draft-button');await ui.fill('#draft',unsentDraft);await ui.click('#draft-close');
  await ui.workspace('background');await ui.openDetails('#goal-editor');await ui.fill('#goal-input',unsavedGoal);await ui.workspace('discussion');
  await ui.fill('#assistant-input',originalQuestion);await ui.click('#assistant-send');
  await until(()=>requests.length===1&&!!releasePlanner,'planning stage');await ui.fill('#assistant-input',nextPrivateInput);releasePlanner();releasePlanner=null;
  await until(()=>cdp.evaluate('!assistantPending&&!state?.assistantBusy&&state?.companion.turns.some(turn=>turn.role==="assistant")'),'draft with private explanation');
  const answer=store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').at(-1),selector=`[data-turn-id="${answer.id}"]`;
  assert.equal(answer.discussionExplanation?.text,explanation,'the real controller displays only the explicit primary explanation');assert.equal(answer.text,'','outward text belongs only to the leaf');assert.equal(answer.suggestions[0].text,wording);
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector+' [data-discussion-explanation]')})?.textContent`),explanation);
  assert.equal(await cdp.evaluate(`(()=>{const turn=document.querySelector(${JSON.stringify(selector)}),r=turn.querySelector('[data-discussion-explanation]'),draft=turn.querySelector('.assistant-suggestion');return !!r&&!!draft&&!!(r.compareDocumentPosition(draft)&Node.DOCUMENT_POSITION_FOLLOWING)})()`),true,'independent rationale is displayed before the leaf-owned suggestion');
  assert.equal(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(selector+' [data-discussion-explanation] button')}).length`),0,'rationale has no adoption controls');
  const preserved=async()=>{
   assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),nextPrivateInput);
   assert.equal(await cdp.evaluate("document.querySelector('#goal-input').value"),unsavedGoal);
   assert.equal(await cdp.evaluate('nextPurpose'),'discussion');assert.deepEqual(store.messages(scope),actualQQ);
  };
  await preserved();assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),unsentDraft);await ui.composer('explanation preserves composer');
  const rationale=await ui.inspect(selector+' [data-discussion-explanation]',{scroll:true});assert.ok(rationale.ok,'private explanation is reachable in the normal conversation scroll area');await ui.composer('visible private explanation');
  const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'private-explanation.png'),Buffer.from(image.data,'base64'));
  checks.push('Explicit primary explanation is visible before the editable wording, with no adoption shortcut; independently edited input, draft, goal, mode and actual QQ are preserved');

  await ui.openDetails(selector+' .method-basis');
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector+' .method-basis summary')}).textContent`),'本次参考');
  assert.match(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector+' .method-basis')}).textContent`),/提供给助手/);
  await ui.closeDetails(selector+' .method-basis');
  const responseArtifact=store.experiences.artifact(scope,answer.artifactRef);
  assert.equal(responseArtifact.body,explanation,'whole-response artifact matches all displayed response text');
  await ui.click(selector+' > button');
  assert.equal(await cdp.evaluate("document.querySelector('#feedback-target-preview').textContent"),`这次评价：${responseArtifact.body.slice(0,220)}`);
  await ui.fill('#feedback-text','这次说明有帮助，请保持依据和表达分开。');await ui.click('#feedback-save');
  await until(()=>store.getCompanion(scope).feedback.length===1,'feedback saved');
  const feedback=store.getCompanion(scope).feedback[0],hydrated=store.experiences.hydrateFeedback(scope,feedback.id);
  assert.equal(hydrated.target.body,responseArtifact.body,'feedback evaluates the exact complete response, including private rationale');await preserved();
  checks.push('The reference fold labels supplied material accurately; whole-response feedback targets the exact independently owned rationale artifact');

  await ui.click(selector+' button[data-action=adopt]');assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),wording);
  await cdp.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.syntheticCopiedExplanation=text}},configurable:true})");
  await ui.click('#copy');assert.equal(await cdp.evaluate('window.syntheticCopiedExplanation'),wording);
  assert.equal(await cdp.evaluate('window.syntheticCopiedExplanation.includes("PRIVATE_PLANNER_SENTINEL")'),false);await ui.click('#draft-close');await preserved();
  checks.push('Explicit adoption and clipboard copy transfer only the suggestion, never the private rationale or summary; no QQ message is sent');

  const duplicate=store.appendTurn(scope,{role:'assistant',kind:'draft',requestId:'synthetic-identical-explanation',text:'同一段说明只显示一次。',discussionExplanation:{kind:'discussion',text:'同一段说明只显示一次。'},sourceIds:answer.sourceIds});controller.changed();
  await until(()=>cdp.evaluate(`!!document.querySelector('[data-turn-id="${duplicate.id}"]')`),'duplicate explanation fixture');
  assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-turn-id="${duplicate.id}"] .turn-text').length`),1);
  assert.equal(store.experiences.artifact(scope,duplicate.artifactRef).body,'同一段说明只显示一次。');await preserved();
  checks.push('Identical explicit final explanation and summary are displayed and evaluated once');

  await ui.click('#contact-button');await ui.fill('#qq-number','2222222222');await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate('state?.scope?.peerUin==="2222222222"&&!loadingHistory'),'other contact');
  assert.equal(await cdp.evaluate("document.querySelectorAll('[data-discussion-explanation]').length"),0);assert.deepEqual(store.messages(scope),actualQQ);assert.equal(requests.length,2);
  checks.push('Private rationale stays with its account/contact and does not leak after selection changes');
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({result:'PASS',evidence:'synthetic-model-real-controller-pointer-browser',nativeQQIntegration:false,realModelCalls:0,syntheticModelCalls:requests.length,checks},null,2));
  console.log(JSON.stringify({result:'PASS',checks:checks.length,realModelCalls:0,syntheticModelCalls:requests.length,nativeQQIntegration:false,report:path.join(evidence,'report.json')}));
 }catch(error){if(cdp)try{const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'failure.png'),Buffer.from(image.data,'base64'));console.error(`Screenshot: ${path.join(evidence,'failure.png')}`);}catch{}throw error;}
 finally{releasePlanner?.();cdp?.close();chrome.kill('SIGTERM');if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve()})});controller.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
