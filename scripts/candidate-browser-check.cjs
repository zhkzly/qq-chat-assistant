'use strict';
const {factualReview}=require('../tests/fixtures/factual-assessment.cjs');
// Synthetic continuous UI evidence. This fixture never reads real QQ or calls a provider.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs'),{Controller}=require('../tests/fixtures/whole-answer-fidelity.cjs'),{createServer}=require('../src/server.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs'),{withCurrentDraftControls}=require('../tests/fixtures/draft-controls.cjs');
const {CDP}=require('./cdp.cjs'),{actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label){for(let attempt=0;attempt<100;attempt++){if(await predicate())return;await sleep(100);}throw Error(`Timed out: ${label}`);}
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-current-candidates-')),profile=path.join(directory,'chrome'),store=new Store(':memory:');
 const calls=[],checks=[];let selected={...scope},clockOffset=0,drafts=0,subtle=false,holdNextAutomatic=false,releaseAutomatic,holdPath=null,releaseHeld;
 const message=(id,own,text,seconds=0)=>raw(id,own,{msgTime:String(Math.floor(Date.now()/1000)+seconds),elements:[{textElement:{content:text}}]});
 const first=message('61001',false,'今天的画终于画完了。');
 const settings={auto:false,anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-candidates',realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-candidates'}};
 const controller=new Controller({store,settings,now:()=>Date.now()+clockOffset,read:async(command,args)=>{
  if(command==='bind'){selected=args.uin===scope.peerUin?{...scope}:{...scope,peerUid:'u_other',peerUin:args.uin};return selected;}
  return {source:'synthetic',messages:command==='latest'&&selected.peerUid===scope.peerUid?[first]:[]};
 },assistantModel:async(_,context)=>{
  const p=context.payload;calls.push(structuredClone(p));
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[]};
  const complete=()=>{drafts++;return {privateExplanation:'回应她分享的近况。',suggestions:[{style:'自然',text:subtle?'画到忘记时间，看来这幅画还挺让你投入的。':drafts===1?'终于完成啦，感觉可以长舒一口气了。':'那种画到忘记时间的感觉真好。'},{style:'轻松',text:'这下可以好好欣赏自己的作品啦。'}]};};
  if(p.purpose==='reply'){subtle=false;if(holdNextAutomatic&&p.taskContext.invocation.origin==='automatic'){holdNextAutomatic=false;await new Promise(resolve=>{releaseAutomatic=resolve});}return {kind:'discussion',text:'接住她分享的完成感，不预设画的内容。',answer:complete(),draftPlan:withCurrentDraftControls({quotes:[],intent:'reply'},p)};}
  if(p.userRequest?.text.includes('换含蓄')){subtle=true;return {kind:'discussion',text:'按新的局部要求改写。',answer:complete(),draftPlan:withCurrentDraftControls({quotes:[],intent:'reply'},p)};}
  if(p.purpose==='draft'){drafts++;return {kind:'draft',text:'回应她分享的近况。',suggestions:[{style:'自然',text:subtle?'画到忘记时间，看来这幅画还挺让你投入的。':drafts===1?'终于完成啦，感觉可以长舒一口气了。':'那种画到忘记时间的感觉真好。'},{style:'轻松',text:'这下可以好好欣赏自己的作品啦。'}]};}
  return {kind:'discussion',text:'可以按你刚才说的想法继续，不急着把私下顾虑写给她。'};
 }});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 const server=createServer({controller,token:'synthetic-candidates-token',uiDir:path.resolve(__dirname,'../ui'),saveSettings(){},modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-candidates'}]})})});
 const handle=server.listeners('request')[0];server.removeAllListeners('request');server.on('request',(request,response)=>{
  if(request.method==='POST'&&request.url===holdPath){holdPath=null;releaseHeld=()=>handle(request,response);return;}handle(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--window-size=480,900',`${base}/#synthetic-candidates-token`],{stdio:'ignore'});let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'headless Chrome');const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();cdp=await CDP.connect(targets.find(target=>target.type==='page').webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Browser.grantPermissions',{origin:base,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});const ui=actions(cdp);
  const captureTransfers=async()=>{await cdp.evaluate("window.previousCandidateTransfers={copy:document.querySelector('#suggestions [data-action=copy]').onclick,adopt:document.querySelector('#suggestions [data-action=adopt]').onclick};navigator.clipboard.writeText('CANDIDATE_FENCE_SENTINEL')")};
  const assertImmediateFence=async(prior,label)=>{
   await until(()=>!!releaseHeld,`${label} request held before backend dispatch`);assert.equal(controller.currentAdvice()?.requestId,prior.requestId,'the backend has not yet withdrawn the old candidate');
   await cdp.evaluate('previousCandidateTransfers.copy();previousCandidateTransfers.adopt();new Promise(resolve=>setTimeout(resolve,80))');
   assert.equal(await cdp.evaluate('navigator.clipboard.readText()'),'CANDIDATE_FENCE_SENTINEL',`${label}: an old captured copy closure must be inert immediately`);
   assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'保留我自己尚未发送的修改。',`${label}: old adoption cannot overwrite edited draft`);
   assert.equal(await cdp.evaluate('currentCandidate()===null'),true);assert.equal(await cdp.evaluate("document.querySelector('#draft-dialog').open"),false);
   const dispatch=releaseHeld;releaseHeld=null;dispatch();
  };
  await until(()=>cdp.evaluate("!!document.querySelector('#current-candidates')"),'candidate panel');await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');await until(()=>cdp.evaluate('!!state?.scope'),'selected scope');
  await ui.click('#settings-button');await until(()=>cdp.evaluate("document.querySelector('#settings').open"),'settings');await ui.click('#auto');await until(()=>controller.auto,'automatic preference saved');await ui.click('#settings-close');
  await until(()=>cdp.evaluate("document.querySelectorAll('#suggestions .suggestion').length===2"),'debounced automatic candidates');
  assert.equal(await cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-turn').length"),0);
  assert.equal(await cdp.evaluate("document.querySelector('#candidate-analysis').open"),false);
  assert.ok(await cdp.evaluate("document.querySelector('#candidate-status').textContent.includes('自动生成')"));
  assert.ok(await cdp.evaluate("document.querySelector('#candidate-target').textContent.includes('今天的画')"));
  for(const [width,height]of [[370,560],[370,640],[480,900]]){
   await cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await ui.composer(`current candidate ${width}x${height}`);
   const target=await ui.inspect('#suggestions .suggestion button[data-action=copy]');assert.ok(target.ok&&target.full,JSON.stringify(target));
   assert.equal(await cdp.evaluate("document.querySelector('#current-candidates').getBoundingClientRect().top<document.querySelector('.discussion-heading').getBoundingClientRect().top"),true);
   const screenshot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(directory,`current-${width}x${height}.png`),Buffer.from(screenshot.data,'base64'));
  }
  checks.push('Automatic candidates appear before private consultation with scoped QQ target, time, collapsed explanation and visible copy action at 370x560, 370x640 and 480x900');
  await ui.click('#suggestions .suggestion button[data-action=copy]');await until(()=>store.experiences._all(scope,'event').some(event=>event.type==='clipboard_write'),'clipboard checkpoint');assert.equal(await cdp.evaluate('navigator.clipboard.readText()'),controller.advice.suggestions[0].text);
  await ui.click('#suggestions .suggestion button[data-action=adopt]');await ui.fill('#draft','保留我自己尚未发送的修改。');await ui.click('#draft-close');await until(()=>store.experiences.draft(scope)?.text==='保留我自己尚未发送的修改。','edited draft checkpoint');
  controller.live({scope,messages:[message('61002',true,'终于完成啦，感觉可以长舒一口气了。',1)]});await until(()=>cdp.evaluate("document.querySelectorAll('#suggestions .suggestion').length===0"),'outgoing expires candidate');assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'保留我自己尚未发送的修改。');
  const afterSent=calls.length;await sleep(2000);assert.equal(calls.length,afterSent);
  controller.live({scope,messages:[message('61003',false,'是啊，画的时候都忘记时间了。',2)]});await until(()=>cdp.evaluate("state?.advice?.binding?.messageIds?.includes('61003')"),'next incoming binds next candidate');assert.equal(controller.snapshot().companion.turns.length,0);
  checks.push('Actual sent message withdraws the current candidate without an extra automatic reply or loss of edited draft; next incoming creates a newly bound candidate');
  const thought='先不邀约，我只是想自然接着聊。';await ui.fill('#assistant-input',thought);const beforeRefresh=calls.length;await ui.click('#generate');await until(()=>calls.length>beforeRefresh&&!controller.assistantBusy,'manual opening with unsent private thought');assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),thought);assert.equal(store.getCompanion(scope).turns.filter(turn=>turn.role==='user').length,0);
  await until(()=>cdp.evaluate('!assistantPending&&!!state?.advice?.suggestions?.length'),'manual candidate rendered');const comparison=controller.currentAdvice(),beforeVariation=calls.length;
  await captureTransfers();holdPath='/api/options';await ui.click('#candidate-refresh');await assertImmediateFence(comparison,'manual variation');await until(()=>calls.length===beforeVariation+2&&!controller.assistantBusy,'explicit alternative action');const variation=calls[beforeVariation];
  assert.match(variation.userRequest.text,/不只是换词/);assert.equal((variation.privateCandidates||[]).filter(item=>item.selection==='implicit_discussion_anchor').length,1);assert.equal(variation.privateCandidates.find(item=>item.selection==='implicit_discussion_anchor').turnId,comparison.turnId);assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),thought);
  await until(()=>cdp.evaluate('!assistantPending'),'alternative response rendered');const consultationRows=controller.snapshot().companion.turns.length+2;
  await ui.click('#assistant-send');await until(()=>cdp.evaluate(`document.querySelectorAll('#assistant-thread .assistant-turn').length===${consultationRows}`),'private consultation stays distinct');
  assert.equal(controller.snapshot().advice,null,'private consultation withdraws an earlier primary candidate');
  await ui.click('#candidate-refresh');await until(()=>cdp.evaluate('!!state?.advice?.suggestions?.length'),'current candidate before correction');const beforeCorrection=controller.currentAdvice();
  await ui.fill('#assistant-input','别这么直白，换含蓄一点的说法。');assert.equal(await cdp.evaluate('currentCandidate()!==null'),true,'typing alone keeps a current candidate available');await captureTransfers();holdPath='/api/assistant';await ui.click('#assistant-send');await assertImmediateFence(beforeCorrection,'private correction');await until(()=>cdp.evaluate("state?.advice?.suggestions?.[0]?.text==='画到忘记时间，看来这幅画还挺让你投入的。'"),'private correction replaces the primary candidate');
  assert.notEqual(controller.currentAdvice().requestId,beforeCorrection.requestId);assert.ok(controller.currentAdvice().binding.privateInputSeq>beforeCorrection.binding.privateInputSeq);assert.ok(controller.currentAdvice().binding.planDigest);assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'保留我自己尚未发送的修改。');
  await ui.fill('#assistant-input','为什么这样接？');await ui.click('#assistant-send');await until(()=>cdp.evaluate("!state?.assistantBusy&&!assistantPending&&state?.advice===null"),'explanation does not restore an older candidate');assert.ok(await cdp.evaluate("document.querySelector('#assistant-thread').textContent.includes('画到忘记时间，看来这幅画还挺让你投入的。')"));
  checks.push('Private correction and manual variation synchronously fence old captured copy/adopt callbacks before backend dispatch; typing keeps candidates available; alternative requests include one generated comparison target and preserve unsent input; corrected drafts replace primary wording and explanations preserve history');
  await ui.click('#candidate-refresh');await until(()=>cdp.evaluate('!!state?.advice?.suggestions?.length'),'new current candidate for lifetime');
  clockOffset=6*60000;await until(()=>cdp.evaluate("state?.candidateStatus?.phase==='expired'&&document.querySelectorAll('#suggestions .suggestion').length===0"),'candidate lifetime');assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'保留我自己尚未发送的修改。');
  holdNextAutomatic=true;releaseAutomatic=null;controller.live({scope,messages:[message('61004',false,'刚放下画笔，准备歇一会儿。',3)]});await until(()=>!!releaseAutomatic,'held automatic request');await until(()=>cdp.evaluate("state?.assistantOrigin==='automatic'"),'automatic progress visible');
  await ui.fill('#assistant-input','先陪我理清想法，不要替我写新句子。');await ui.click('#assistant-send');await until(()=>cdp.evaluate('!assistantPending&&!state?.assistantBusy'),'user consultation preempts automatic work');const afterUser=calls.length;releaseAutomatic();await sleep(1100);assert.equal(calls.length,afterUser,'the obsolete automatic plan cannot advance to wording');assert.equal(controller.snapshot().advice,null);
  assert.equal(store.messages(scope).length,4);assert.ok(store.experiences._all(scope,'event').every(event=>event.sent===false));checks.push('User consultation can preempt a running automatic request; finite candidate lifetime and cancellation keep edits and actual QQ intact; clipboard and adoption never become sends');
  const report={result:'PASS',evidence:'continuous_synthetic_controller_browser',desktopQQIntegration:false,realQQRead:false,providerCalls:0,actualQQSendActions:0,checks,screenshots:directory};fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{if(releaseHeld){const dispatch=releaseHeld;releaseHeld=null;dispatch();}cdp?.close();chrome.kill('SIGTERM');controller.close();await new Promise(resolve=>server.close(resolve));store.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
