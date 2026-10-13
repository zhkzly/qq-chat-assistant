'use strict';
// Real browser execution with synthetic native records and an injected model.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs');const {Controller}=require('../src/controller.cjs');const {createServer}=require('../src/server.cjs');
const {raw,scope}=require('../tests/fixtures/native.cjs');const {CDP}=require('./cdp.cjs');const {actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){for(let n=0;n<120;n++){if(await check())return;await sleep(100)}throw Error(`Timed out: ${label}`)}
(async()=>{
 const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-direction-ui-')),profile=path.join(temporary,'chrome'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'qq-direction-evidence-'));
 const store=new Store(path.join(temporary,'synthetic.sqlite')),calls=[],checks=[];let failedOnce=false;
 const controller=new Controller({store,settings:{apiKey:'synthetic-only',baseUrl:'http://fixture.invalid/v1',model:'synthetic-experience',auto:false,realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,baseUrl:'http://fixture.invalid/v1',model:'synthetic-experience'}},
  read:async(command,args)=>command==='bind'?{...scope,...(args.uin!==scope.peerUin?{peerUid:'other',peerUin:args.uin}:{})}:{messages:[],source:'synthetic'},
  assistantModel:async(_settings,context)=>{calls.push(structuredClone(context.payload));const p=context.payload,text=p.userRequest?.text||'',active=p.topicContext?.active;
   if(p.purpose==='draft')return {kind:'draft',text:'可以这样说：',suggestions:[{style:'自然',text:p.draftingGuidance?.allowedApproach?.text.includes('直接')?'我对你有好感，想多认识你一点。':'周末有空的话，要不要一起玩会儿？'}]};
   const current=p.userRequest?.sourceId,feedback=(p.sources||[]).filter(s=>s.type==='feedback').at(-1);
   if(text.includes('聊清楚了'))return {kind:'discussion',text:'这次先告一段落，之后想聊别的可以直接说。',topicPatch:{operation:'complete',topicId:active.id,purposeSourceIds:[current],intentQuote:text}};
   if(text.includes('先商量下周'))return {kind:'discussion',text:'她提出了另一个时间，可以先核对安排；这不是恋爱意愿的证明。',topicPatch:{operation:'update',topicId:active.id,objective:'商量下一次一起玩的时间',direction:'先确认双方方便的时间',stage:'她提出了替代时间',progress:['对方说下周日可以'],purposeSourceIds:[current],intentQuote:text,observationSourceIds:[p.sources.filter(s=>s.type==='qq').at(-1).id]}};
   if(text.includes('现在直接'))return {kind:'discussion',text:'可以直接表达你的真实好感，不用继续维持含蓄。',topicPatch:{operation:'update',topicId:active.id,direction:'直接表达好感',constraints:[],purposeSourceIds:[current],intentQuote:text}};
   if(text.includes('不要连续'))return {kind:'discussion',text:'这次保留邀请意思，不连续追问，也不泛化为你的永久偏好。',topicPatch:{operation:'update',topicId:active.id,constraints:['不连续追问'],purposeSourceIds:[current],intentQuote:text}};
   if(text.includes('先围绕'))return {kind:'discussion',text:'可以围绕合作游戏，含蓄地提一次邀请。',topicPatch:{operation:'create',objective:'邀请她一起玩合作游戏',direction:'先含蓄地提出一起联机',purposeSourceIds:[current],intentQuote:text}};
   if(text.includes('具体一句')||text.includes('选中的这条反馈')){
    if(feedback?.text.includes('删除用的合成失败')||feedback?.text.includes('合成失败')&&!failedOnce){failedOnce=true;throw Error('合成模型暂时不可用');}
    const sources=p.sources||[],purposeIds=(active?.purposeSourceIds||[]).filter(id=>sources.some(s=>s.id===id)),sourceIds=purposeIds.length?purposeIds:[current];
    const correction=active?.constraints?.includes('不连续追问')&&sources.find(s=>s.role==='user'&&s.text.includes('不要连续'));
    return {draftPlan:{quotes:[],intent:'reply',guidance:{objective:{text:'邀请她一起玩合作游戏',sourceIds},allowedApproach:{text:active?.direction||'自然表达邀请',sourceIds},avoidances:correction?[{text:'不连续追问',sourceIds:[correction.id]}]:[],currentStep:{text:'给出一句可编辑表达',sourceIds:[feedback?.id||current]}}}};
   }
   return {kind:'discussion',text:'可以先聊聊你现在的想法，不必先决定一种聊天方式。'};

  }});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 const server=createServer({controller,token:'synthetic-experience-token',uiDir:path.join(root,'ui'),saveSettings(){},modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-experience'}]})})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`http://127.0.0.1:${server.address().port}/#synthetic-experience-token`],{stdio:'ignore'});
 let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Chrome ready');const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();cdp=await CDP.connect(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Page.enable');const ui=actions(cdp);
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:370,height:640,deviceScaleFactor:1,mobile:false});await until(()=>cdp.evaluate("!!document.querySelector('#contact-button')"),'helper loaded');
  await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');await until(()=>cdp.evaluate("!document.querySelector('#assistant-send').disabled"),'scoped helper ready');await ui.composer('direction first view');
  store.setGoal(scope,'PRIVATE_LONG_GOAL_发展双方愿意的恋爱关系');controller.live({scope,messages:[raw('900719925474099901',false,{elements:[{textElement:{content:'周末应该有空，可以玩合作游戏。'}}]})]});
  const send=async text=>{const before=calls.length;await ui.fill('#assistant-input',text);await ui.click('#assistant-send');await until(()=>calls.length>before&&!controller.assistantBusy,'private turn completed');await until(()=>cdp.evaluate("!assistantPending"),'UI turn complete');};
  await send('我对她有好感，但还不知道这次想聊什么。');assert.equal(await cdp.evaluate("document.querySelector('#topic-direction').hidden"),true);
  await send('PRIVATE_MOTIVE_我怕尴尬，这次先围绕合作游戏，含蓄地邀请她一起玩。');
  await until(()=>cdp.evaluate("!document.querySelector('#topic-direction').hidden"),'optional current direction');const topicId=store.topicView(scope).active.id;
  await ui.fill('#assistant-input','UNSENT_THOUGHT_我还想保留这句话');const beforeAdjustment=calls.length;await ui.openDetails('#topic-direction');await ui.click('#topic-adjust');
  assert.ok((await cdp.evaluate("document.querySelector('#assistant-input').value")).startsWith('UNSENT_THOUGHT_'));assert.equal(calls.length,beforeAdjustment,'adjusting never submits');
  await send('这次不要连续追问，但保留单独邀请的意思。');assert.equal(store.topicView(scope).active.id,topicId);assert.ok(store.topicView(scope).active.constraints.includes('不连续追问'));
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:370,height:560,deviceScaleFactor:1,mobile:false});await ui.composer('active direction at minimum viewport');const activeShot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'direction-active.png'),Buffer.from(activeShot.data,'base64'));await ui.openDetails('#topic-direction');await ui.composer('expanded direction leaves composer visible');await ui.closeDetails('#topic-direction');
  checks.push('Unclear intent needs no form; the optional purpose forms naturally, adjusts without losing unsent input or submitting, and preserves the compact composer');

  await send('那给我具体一句。');await until(()=>cdp.evaluate("document.querySelectorAll('.assistant-suggestion').length>0"),'vague followup reaches concrete draft');
  const draftPayload=calls.filter(p=>p.purpose==='draft').at(-1);assert.ok(draftPayload.draftingGuidance.avoidances.some(c=>c.text==='不连续追问'));assert.equal(JSON.stringify(draftPayload).includes('PRIVATE_MOTIVE_'),false);assert.equal(JSON.stringify(draftPayload).includes('PRIVATE_LONG_GOAL_'),false);assert.equal(draftPayload.privateConversation,undefined);
  const answer=store.getCompanion(scope).turns.filter(t=>t.suggestions?.length).at(-1),candidate=answer.suggestions[0];
  await ui.click('.assistant-suggestion button[data-action=adopt]');await ui.fill('#draft','DIRECTION_UNSENT_DRAFT_由我检查并发送');await ui.click('#draft-close');await until(()=>store.experiences.draft(scope)?.text==='DIRECTION_UNSENT_DRAFT_由我检查并发送','draft checkpoint');
  checks.push('A vague follow-up carries the local correction into final draft controls without private motive or global goal disclosure');

  await ui.click('.assistant-suggestion button:not([data-action=adopt])');await ui.fill('#feedback-text','这个方向可以，先记下就好。');let before=calls.length;await ui.click('#feedback-save');await until(()=>store.getCompanion(scope).feedback.length===1,'save-only feedback');assert.equal(calls.length,before);
  await ui.click('.assistant-suggestion button:not([data-action=adopt])');await ui.fill('#feedback-text','合成失败：别只分析，给我具体可发的一句。');await ui.fill('#assistant-input','UNSENT_PRIVATE_THOUGHT_不是这条反馈');
  await ui.click('#feedback-continue');await until(()=>cdp.evaluate("!feedbackPending&&feedbackRetryReady"),'failed continuation remains retryable');
  const firstFeedback=store.getCompanion(scope).feedback.find(f=>f.text.includes('合成失败'));assert.ok(firstFeedback);assert.deepEqual(firstFeedback.targetRef,{kind:'artifact',artifactRef:candidate.artifactRef});assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'UNSENT_PRIVATE_THOUGHT_不是这条反馈');
  const failedTask=await cdp.evaluate('feedbackTaskId'),clientId=await cdp.evaluate('feedbackClientId');
  const probeModule={exports:{}};vm.runInNewContext(`${fs.readFileSync(path.join(root,'plugin/dev-probe.cjs'),'utf8')}\nmodule.exports={captureHelperReload,restoreHelperReload};`,{module:probeModule,require:name=>{assert.ok(['node:fs','node:path'].includes(name));return require(name)}});
  assert.equal((await cdp.evaluate(`(${probeModule.exports.captureHelperReload.toString()})(false)`)).captured,true);before=calls.length;
  await cdp.call('Page.reload');await until(()=>cdp.evaluate("typeof state!=='undefined'&&!!state?.scope&&!loadingHistory"),'reload ready');let restored;await until(async()=>{restored=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);return restored.ready},'failed continuation recovery');
  assert.equal(await cdp.evaluate('feedbackTaskId'),failedTask);assert.equal(await cdp.evaluate('feedbackClientId'),clientId);assert.equal(await cdp.evaluate('feedbackRetryReady'),true);assert.equal(calls.length,before);
  assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'DIRECTION_UNSENT_DRAFT_由我检查并发送');assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'UNSENT_PRIVATE_THOUGHT_不是这条反馈');
  await ui.click('#feedback-continue');await until(()=>cdp.evaluate("!feedbackPending&&document.querySelector('#feedback-form').hidden"),'explicit retry provides response');
  assert.equal(store.getCompanion(scope).feedback.filter(f=>f.id===firstFeedback.id).length,1);assert.equal(store.memorySources(scope).filter(s=>s.text===firstFeedback.text).length,1);assert.notEqual(await cdp.evaluate('feedbackTaskId'),failedTask);assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'UNSENT_PRIVATE_THOUGHT_不是这条反馈');
  const continuationPayload=calls.filter(p=>p.userRequest?.text.includes('选中的这条反馈')).at(-1);assert.equal(continuationPayload.sources.filter(s=>s.text===firstFeedback.text).length,1);assert.ok(continuationPayload.feedbackTargets.some(item=>item.target?.body===candidate.text));
  checks.push('Save-only feedback costs no call; explicit continue targets one canonical feedback, preserves unrelated input, and survives failure/reload/retry with durable target identity');

  await ui.click('.assistant-suggestion button:not([data-action=adopt])',-1);await ui.fill('#feedback-text','删除用的合成失败：给我更具体一句。');await ui.click('#feedback-continue');await until(()=>cdp.evaluate('!feedbackPending&&feedbackRetryReady'),'second failed continuation');
  const deletedFeedback=store.getCompanion(scope).feedback.find(f=>f.text.includes('删除用的合成失败')),feedbackTurn=store.getCompanion(scope).turns.find(t=>t.feedbackId===deletedFeedback.id);assert.ok(feedbackTurn);assert.equal(await cdp.evaluate('feedbackSavedId'),deletedFeedback.id);
  assert.equal((await cdp.evaluate(`(${probeModule.exports.captureHelperReload.toString()})(false)`)).captured,true);
  // Recovery capture deliberately freezes pointer edits. Model another window
  // deleting this source through the real scoped API while its capsule is held.
  assert.equal(await cdp.evaluate('document.body.inert'),true);const deleteResponse=await fetch(`http://127.0.0.1:${server.address().port}/api/turn-delete`,{method:'POST',headers:{Authorization:'Bearer synthetic-experience-token','Content-Type':'application/json'},body:JSON.stringify({...scope,id:feedbackTurn.id})});assert.equal(deleteResponse.status,200);await until(()=>cdp.evaluate("document.querySelector('#feedback-form').hidden&&feedbackSubmittedText===null"),'deleted feedback retry form cleared');
  assert.equal(store.experiences.artifact(scope,deletedFeedback.targetRef.artifactRef).availability,'active','deleting feedback does not delete its evaluated artifact');
  const forgotten=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);assert.equal(forgotten.ready,true);assert.equal(forgotten.forgottenFeedbackCleared,true);assert.equal(await cdp.evaluate("document.querySelector('#feedback-text').value"),'');assert.equal(await cdp.evaluate('feedbackSubmittedText'),null);assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'UNSENT_PRIVATE_THOUGHT_不是这条反馈');
  await ui.click('#feedback-cancel');checks.push('Deleting canonical feedback clears its failed-retry form and recovery copy while preserving the evaluated artifact and unrelated private input');

  await send('我现在直接表达好感，不再保持含蓄，想多认识她。');assert.equal(store.topicView(scope).active.id,topicId);assert.equal(store.topicView(scope).active.direction,'直接表达好感');assert.deepEqual(store.topicView(scope).active.constraints,[]);
  await until(()=>cdp.evaluate("document.querySelector('#topic-direction-label').textContent.includes('直接表达好感')"),'new explicit direction shown');
  await send('那给我具体一句。');assert.equal(calls.filter(p=>p.purpose==='draft').at(-1).draftingGuidance.allowedApproach.text,'直接表达好感');
  assert.deepEqual(calls.filter(p=>p.purpose==='draft').at(-1).draftingGuidance.avoidances,[]);
  controller.live({scope,messages:[raw('900719925474099902',false,{elements:[{textElement:{content:'这周六不行，不过下周日可以一起玩。'}}]})]});assert.equal(store.topicView(scope).active.direction,'直接表达好感');
  await send('她说下周日可以，这次先商量下周一起玩的时间。');assert.equal(store.topicView(scope).active.direction,'先确认双方方便的时间');assert.ok(store.topicView(scope).active.progress.includes('对方说下周日可以'));
  await ui.fill('#assistant-input','这个方向聊清楚了，尚未提交的新想法要保留。');const beforeComplete=calls.length;await ui.openDetails('#topic-direction');await ui.click('#topic-complete');await until(()=>store.topicView(scope).active===null,'direct topic completion');assert.equal(calls.length,beforeComplete,'completion is a local control action and does not call the model');assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),'这个方向聊清楚了，尚未提交的新想法要保留。');
  await until(()=>cdp.evaluate("document.querySelector('#topic-direction').hidden"),'closed purpose no longer imposed');assert.equal(store.topicView(scope).active,null);assert.equal(store.getCompanion(scope).goal.text,'PRIVATE_LONG_GOAL_发展双方愿意的恋爱关系');assert.equal(store.messages(scope).filter(m=>m.direction==='outgoing').length,0);
  checks.push('Explicit new intent replaces local subtlety; topic completion removes the strip without rewriting the romantic goal or treating a draft as sent');

  await ui.composer('completed direction at 370x560');const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'direction-ui.png'),Buffer.from(shot.data,'base64'));
  await ui.click('#contact-button');await ui.fill('#qq-number','2222222222');await ui.click('#contact-form button[type=submit]');await until(()=>controller.scope?.peerUin==='2222222222','switch contact');assert.equal(controller.snapshot().topicContext.active,null);assert.equal(await cdp.evaluate("document.querySelector('#topic-direction').hidden"),true);assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'');
  checks.push('Current direction, private input and drafts remain scoped across contact changes');
  const reportOut={evidence:'synthetic-pointer-browser-execution',nativeQQIntegration:false,realModelCalls:0,result:'PASS',checks,screenshot:path.join(artifacts,'direction-ui.png')};fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(reportOut,null,2));console.log(JSON.stringify({result:'PASS',checks:checks.length,report:path.join(artifacts,'report.json')}));
 }catch(error){if(cdp){try{const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'failure.png'),Buffer.from(shot.data,'base64'));console.error(`Failure screenshot: ${path.join(artifacts,'failure.png')}`)}catch{}}throw error}
 finally{cdp?.close();chrome.kill('SIGTERM'); if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve()})});controller.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
