'use strict';
// Real browser execution with synthetic native records and an injected model.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs');const {Controller}=require('../src/controller.cjs');const {createServer}=require('../src/server.cjs');
const {raw,scope}=require('../tests/fixtures/native.cjs');const {CDP}=require('./cdp.cjs');const {actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){for(let n=0;n<120;n++){if(await check())return;await sleep(100)}throw Error(`Timed out: ${label}`)}
(async()=>{
 const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-experience-ui-')),profile=path.join(temporary,'chrome'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'qq-experience-evidence-'));
 const store=new Store(path.join(temporary,'synthetic.sqlite')),calls=[],checks=[];
 const controller=new Controller({store,settings:{apiKey:'synthetic-only',baseUrl:'http://fixture.invalid/v1',model:'synthetic-experience',auto:false,realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,baseUrl:'http://fixture.invalid/v1',model:'synthetic-experience'}},
  read:async(command,args)=>command==='bind'?{...scope,...(args.uin!==scope.peerUin?{peerUid:'other',peerUin:args.uin}:{})}:{messages:[],source:'synthetic'},
  assistantModel:async(_settings,context)=>{calls.push(structuredClone(context));const p=context.payload;
   if(p.purpose==='draft_prepare')return {draftPlan:{quotes:[{sourceId:p.userRequest.sourceId,text:'周末一起玩'}],style:'natural'},methodIds:['express_interest','compose']};
   if(p.purpose==='draft')return {kind:'draft',text:'可以按你的真实意思邀请：',suggestions:[{style:'自然',text:'周末要不要一起玩会儿？'}]};
   return {kind:'discussion',text:'可以一起看看哪种表达更像你。',methodIds:['clarify']};
  }});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 const server=createServer({controller,token:'synthetic-experience-token',uiDir:path.join(root,'ui'),saveSettings(){},modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-experience'}]})})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`http://127.0.0.1:${server.address().port}/#synthetic-experience-token`],{stdio:'ignore'});
 let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Chrome ready');const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();cdp=await CDP.connect(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Page.enable');const ui=actions(cdp);
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:370,height:640,deviceScaleFactor:1,mobile:false});await until(()=>cdp.evaluate("!!document.querySelector('#contact-button')"),'helper loaded');
  await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');await until(()=>cdp.evaluate("!document.querySelector('#assistant-send').disabled"),'scoped helper ready');await ui.composer('experience first view');
  await ui.fill('#assistant-input','我想邀请她周末一起玩，帮我自然地说出来。');await ui.openDetails('#assistant-tools');await ui.click('#assistant-draft');assert.equal(calls.length,0);await ui.click('#assistant-send');await until(()=>cdp.evaluate("document.querySelectorAll('.assistant-suggestion').length===1"),'versioned draft received');
  const answer=store.getCompanion(scope).turns.filter(t=>t.role==='assistant').at(-1),candidate=answer.suggestions[0];assert.ok(candidate.artifactRef);assert.notDeepEqual(candidate.artifactRef,answer.artifactRef);
  await ui.closeDetails('#assistant-tools');await ui.click('.assistant-suggestion button[data-action=adopt]');await ui.fill('#draft','RELOAD_ARTIFACT_尚未发送的修改');await ui.click('#draft-close');
  await until(()=>store.experiences.draft(scope)?.text==='RELOAD_ARTIFACT_尚未发送的修改','draft checkpoint before reload');
  await ui.click('.assistant-suggestion button:not([data-action=adopt])');await ui.fill('#feedback-text','意思对，但这一句有点客套。');
  assert.deepEqual(await cdp.evaluate('feedbackTargetRef'),{kind:'artifact',artifactRef:candidate.artifactRef});
  const probeModule={exports:{}};vm.runInNewContext(`${fs.readFileSync(path.join(root,'plugin/dev-probe.cjs'),'utf8')}\nmodule.exports={captureHelperReload,restoreHelperReload};`,{module:probeModule,require:name=>{assert.ok(['node:fs','node:path'].includes(name));return require(name)}});
  const captured=await cdp.evaluate(`(${probeModule.exports.captureHelperReload.toString()})(false)`);assert.equal(captured.captured,true);const beforeReloadCalls=calls.length;
  await cdp.call('Page.reload');await until(()=>cdp.evaluate("typeof state!=='undefined'&&!!state?.scope&&!loadingHistory"),'reload scope');let restored;
  await until(async()=>{restored=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);return restored.ready},'exact feedback target restored');
  assert.deepEqual(await cdp.evaluate('feedbackTargetRef'),{kind:'artifact',artifactRef:candidate.artifactRef});assert.equal(await cdp.evaluate("document.querySelector('#feedback-text').value"),'意思对，但这一句有点客套。');assert.equal(calls.length,beforeReloadCalls);
  assert.deepEqual(await cdp.evaluate('draftArtifactRefs'),[candidate.artifactRef]);assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'RELOAD_ARTIFACT_尚未发送的修改');assert.equal(restored.artifactOriginsPreserved,true);
  await ui.click('#feedback-form button[type=submit]');await until(()=>store.getCompanion(scope).feedback.length===1,'canonical feedback saved');
  const feedback=store.getCompanion(scope).feedback[0];assert.deepEqual(feedback.targetRef,{kind:'artifact',artifactRef:candidate.artifactRef});assert.equal(store.memorySources(scope).filter(s=>s.text==='意思对，但这一句有点客套。').length,1);
  for(let n=0;n<15;n++)store.saveRun(scope,{id:`later-${n}`,requestId:`later-${n}`,payload:{synthetic:true}});
  assert.equal(store.experiences.hydrateFeedback(scope,feedback.id).target.body,candidate.text);
  checks.push('Exact candidate feedback target and unsent feedback survive native helper reload; one canonical source persists beyond 12 runs');

  await ui.click('.assistant-suggestion button[data-action=adopt]');await ui.fill('#draft','周末有空一起玩会儿吗？');
  await cdp.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}},configurable:true})");await ui.click('#copy');
  await until(()=>store.experiences._all(scope,'event').some(e=>e.type==='clipboard_write'&&e.outcome==='succeeded'),'copy event receipt');
  const event=store.experiences._all(scope,'event').find(e=>e.type==='clipboard_write'&&e.outcome==='succeeded');assert.equal(event.sent,false);assert.deepEqual(event.artifactRefs,[candidate.artifactRef]);assert.equal(event.text,'周末有空一起玩会儿吗？');assert.equal(store.messages(scope).length,0);
  const outgoingId='900719925474099801';controller.live({scope,messages:[raw(outgoingId,true,{msgTime:String(Math.floor(Date.now()/1000)),elements:[{textElement:{content:event.text}}]})]});
  await until(()=>store.experiences.list(scope).cases.some(c=>c.id===`qq:${outgoingId}`),'actual outgoing case');let actualCase=store.experiences.list(scope).cases.find(c=>c.id===`qq:${outgoingId}`);assert.equal(actualCase.links[0].status,'candidate');
  await ui.click('#draft-close');await ui.workspace('background');await ui.openDetails('#experiences-panel');await until(()=>cdp.evaluate(`!!document.querySelector('[data-experience-id="qq:${outgoingId}"]')`),'experience card');await ui.openDetails(`[data-experience-id="qq:${outgoingId}"]`);
  await ui.click(`[data-experience-id="qq:${outgoingId}"] .experience-link button`);await until(()=>store.experiences.list(scope).cases.find(c=>c.id===`qq:${outgoingId}`).links[0].status==='user_confirmed','explicit usage association');
  assert.equal(store.experiences.list(scope).adaptations.length,0);
  checks.push('Adopt/edit/copy retains exact artifact checkpoint; actual matching QQ is only a candidate until the user confirms, never a success reward');

  await ui.click('#experience-add-review');await ui.fill('#experience-review-text','后来我们一起玩了，我觉得更自在，但没有谈到恋爱。');await ui.click('#experience-review-form button[type=submit]');
  await until(()=>store.experiences.list(scope).cases.some(c=>c.attribution==='independent_user_report'),'independent experience report');const report=store.experiences.list(scope).cases.find(c=>c.attribution==='independent_user_report');
  assert.equal(report.actualActions.length,0);assert.equal(report.reviews.length,1);assert.equal(report.reviews[0].targetRef.kind,'experience');
  await ui.openDetails(`[data-experience-id="${report.id}"]`);const correction=await cdp.evaluate(`(()=>{const el=document.querySelector('[data-experience-id="${report.id}"]');return [...el.querySelectorAll('button')].findIndex(b=>b.textContent==='更正这段回顾')})()`);await ui.click(`[data-experience-id="${report.id}"] button`,correction);await ui.fill('#experience-review-text','更准确地说，活动还没发生，我们只是约好了。');await ui.click('#experience-review-form button[type=submit]');await until(()=>store.experiences.listFeedback(scope).find(f=>f.id===report.reviews[0].id).revision===2,'review correction');
  checks.push('Independent activity/feeling report can be added and corrected under one feedback identity without inventing a sent AI draft');

  const proposed=store.experiences.proposeFromModel(scope,{text:'回应近况时少一点客套，先说具体内容。',applicability:'回应具体近况时',methodId:'respond',sourceIds:[feedback.sourceId],caseIds:[`qq:${outgoingId}`]},{allowedSourceIds:[feedback.sourceId],allowedCaseIds:[`qq:${outgoingId}`],deliveredMethods:[{id:'respond',version:'synthetic-v1'}]});controller.changed();
  await ui.openDetails('#experience-guidance-panel');await until(()=>cdp.evaluate(`!!document.querySelector('[data-adaptation-id="${proposed.id}"]')`),'candidate guidance');await ui.click(`[data-adaptation-id="${proposed.id}"] button`);await until(()=>store.experiences.list(scope).adaptations[0].status==='active','user-approved scoped guidance');
  assert.equal(store.experiences.context(scope,{query:''}).adaptations[0].claim,'assistance_fit_not_romantic_causality');
  await until(()=>cdp.evaluate(`document.querySelector('[data-adaptation-id="${proposed.id}"]').textContent.includes('你已同意')`),'active guidance rendered');await ui.click(`[data-adaptation-id="${proposed.id}"] button`,1);await until(()=>store.experiences.list(scope).adaptations[0].status==='retired','retired guidance');
  assert.equal(store.experiences.context(scope,{query:''}).adaptations.length,0);
  checks.push('Grounded model guidance starts inactive, requires a concrete user activation, and can be retired without claiming romantic effectiveness');

  const incomingId='900719925474099802';controller.live({scope,messages:[raw(incomingId,false,{msgTime:String(Math.floor(Date.now()/1000)),elements:[{textElement:{content:'我这周准备考试'}}]})]});const source=store.memorySources(scope).find(s=>s.id===`qq:${incomingId}`);
  const result=store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',text:'她说这周在准备考试',assertionKind:'stated',epistemicStatus:'supported',sourceIds:[source.id]}]},{baseRevision:store.getCompanion(scope).revision,sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}});assert.equal(result.applied,true);controller.changed();
  await ui.openDetails('#relationship-view-panel');await ui.openDetails('[data-subject=contact]');await until(()=>cdp.evaluate("document.querySelector('#relationship-view').textContent.includes('这周在准备考试')"),'contact view');const claim=store.relationshipView(scope).contact[0];
  await sleep(1200);assert.equal(await cdp.evaluate("document.querySelector('[data-subject=contact]').open"),true,'polling preserves opened relation view');await ui.click(`[data-claim-id="${claim.id}"] button`,2);await until(()=>store.relationshipView(scope).contact.find(c=>c.id===claim.id)?.lifecycle==='withdrawn','withdraw wrong or unwanted interpretation');
  checks.push('Me/her/us views expose sourced claims, stay open across polling, and let the user withdraw an interpretation without changing raw QQ');

  await ui.workspace('discussion');await ui.click('#draft-button');await ui.fill('#draft','SOURCE_CORRECTION_用户亲自改好的草稿');await ui.click('#draft-close');
  await until(()=>store.experiences.draft(scope)?.text==='SOURCE_CORRECTION_用户亲自改好的草稿','edited body checkpoint');
  const sourceTurn=store.getCompanion(scope).turns.find(t=>t.role==='user'&&t.requestId===answer.requestId);assert.ok(sourceTurn);
  const capturedStale=await cdp.evaluate(`(${probeModule.exports.captureHelperReload.toString()})(false)`);assert.equal(capturedStale.captured,true);
  store.updateTurn(scope,sourceTurn.id,'更正：我是想先聊聊周末安排，活动尚未约定。');controller.changed();
  assert.equal(store.experiences.artifact(scope,candidate.artifactRef).availability,'stale');
  await until(()=>cdp.evaluate("state.experience?.artifactStates?.some(a=>a.availability==='stale')"),'authoritative stale origin state');
  assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'SOURCE_CORRECTION_用户亲自改好的草稿','polling must preserve an edited stale draft');
  await cdp.call('Page.reload');await until(()=>cdp.evaluate("typeof state!=='undefined'&&!!state?.scope&&!loadingHistory"),'stale reload ready');
  let staleRestored;await until(async()=>{staleRestored=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);return staleRestored.ready},'stale draft restored for review');
  assert.equal(staleRestored.draftNeedsReview,true);assert.equal(staleRestored.draftsPreserved,true);assert.deepEqual(await cdp.evaluate('draftArtifactRefs'),[candidate.artifactRef]);
  await ui.click('#draft-button');assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'SOURCE_CORRECTION_用户亲自改好的草稿');assert.equal(await cdp.evaluate("document.querySelector('#copy').disabled"),true);
  await ui.click('#draft-review');await until(()=>store.experiences.draft(scope)?.reviewStatus==='reviewed','review witness stored');await until(()=>cdp.evaluate("!document.querySelector('#copy').disabled"),'review permits current edited body');
  await cdp.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}},configurable:true})");
  await ui.click('#copy');await until(()=>store.experiences._all(scope,'event').some(e=>e.type==='clipboard_write'&&e.text==='SOURCE_CORRECTION_用户亲自改好的草稿'&&e.outcome==='succeeded'),'reviewed copy retains provenance');
  await ui.fill('#draft','SOURCE_CORRECTION_核对后继续修改');await ui.click('#draft-close');await until(()=>store.experiences.draft(scope)?.text==='SOURCE_CORRECTION_核对后继续修改','reviewed edit checkpoint');assert.deepEqual(store.experiences.draft(scope).artifactRefs,[candidate.artifactRef]);
  const unknownCaptured=await cdp.evaluate(`(${probeModule.exports.captureHelperReload.toString()})(false)`);assert.equal(unknownCaptured.captured,true);
  const safeCapsule=await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')");
  await cdp.evaluate("(()=>{const value=JSON.parse(sessionStorage.getItem('qq-assistant-ui-reload-v1'));value.draftArtifactRefs=[{artifactId:'unproven-origin',version:1}];sessionStorage.setItem('qq-assistant-ui-reload-v1',JSON.stringify(value));})()");
  const unknownCapsule=await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')");
  const unknownRestore=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);assert.equal(unknownRestore.blocked,true);assert.equal(unknownRestore.reason,'draft_origin_unknown_capsule_quarantined');assert.equal(await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')"),unknownCapsule);assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'SOURCE_CORRECTION_核对后继续修改');
  await cdp.evaluate(`sessionStorage.setItem('qq-assistant-ui-reload-v1',${JSON.stringify(safeCapsule)})`);assert.equal((await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`)).ready,true);
  assert.equal((await cdp.evaluate(`(${probeModule.exports.captureHelperReload.toString()})(false)`)).captured,true);
  store.deleteTurn(scope,sourceTurn.id);controller.changed();await until(()=>cdp.evaluate("document.querySelector('#draft').value===''") ,'forget clears reviewed dependent draft');
  await cdp.evaluate("localStorage.setItem(`draft-events:${scopeKey}`,JSON.stringify([{text:'SOURCE_CORRECTION_obsolete_local_checkpoint'}]))");
  const forgottenRestore=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);assert.equal(forgottenRestore.ready,true);assert.equal(forgottenRestore.draftsPreserved,false);assert.equal(await cdp.evaluate("localStorage.getItem(`draft-events:${scopeKey}`)"),null);assert.equal(await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')"),null);
  assert.equal(store.experiences.draft(scope).text,'');assert.equal(store.experiences.artifact(scope,candidate.artifactRef).availability,'redacted');assert.equal(store.messages(scope).some(m=>m.messageId===outgoingId),true);
  checks.push('Corrected sources preserve the edited draft through polling and helper reload; explicit review retains lineage, unknown origins stay quarantined, and later forget clears derived copies without deleting actual QQ');

  await ui.workspace('discussion');await ui.composer('return from experiences');await cdp.call('Emulation.setDeviceMetricsOverride',{width:370,height:560,deviceScaleFactor:1,mobile:false});await ui.composer('full experience UI at minimum size');const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'experience-ui.png'),Buffer.from(shot.data,'base64'));
  const beforeSwitchCount=store.messages(scope).length;await ui.click('#contact-button');await ui.fill('#qq-number','2222222222');await ui.click('#contact-form button[type=submit]');await until(()=>controller.scope?.peerUin==='2222222222','other contact');assert.equal(controller.snapshot().experience.cases.length,0);assert.equal(controller.snapshot().experience.adaptations.length,0);assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'');assert.equal(store.messages(scope).length,beforeSwitchCount);
  checks.push('Experience and guidance views remain scoped across contact switches and no test action sends a QQ message');

  // Reproduce the persisted pre-artifact schema and two-ID browser draft cache.
  const legacyScope={...controller.scope},legacyCalls=calls.length,legacySource=store.appendTurn(legacyScope,{role:'user',kind:'discussion',text:'旧版里讨论的周末安排'});
  const legacyTurn={id:'legacy-browser-answer',role:'assistant',kind:'draft',requestId:'legacy-browser-request',text:'旧版助手回复',createdAt:'2026-10-01T00:00:00Z',sourceIds:[`private:${legacySource.id}`],suggestions:[{style:'自然',text:'旧版候选表达'}],expressionOptions:[{label:'旧版行动方向'}]};
  const legacyRecord=store.getCompanion(legacyScope);legacyRecord.turns.push(legacyTurn);
  store.db.prepare('UPDATE companion SET record=? WHERE scope_key=?').run(JSON.stringify(legacyRecord),store.scopeKey(legacyScope));
  const legacyKey=JSON.stringify(['accountUid','accountUin','peerUid','peerUin'].map(k=>legacyScope[k])),oldKey=`${legacyScope.accountUid}/${legacyScope.peerUid}`,legacyBody='LEGACY_ORIGIN_用户在旧版亲自修改的草稿',legacyRef={artifactId:`turn:${legacyTurn.id}`,version:1};
  await cdp.evaluate(`(()=>{for(const prefix of ['draft:','draft-origin:','draft-artifacts:','draft-events:'])localStorage.removeItem(prefix+${JSON.stringify(legacyKey)});localStorage.setItem(${JSON.stringify(`draft:${oldKey}`)},${JSON.stringify(legacyBody)});localStorage.setItem(${JSON.stringify(`draft-origin:${oldKey}`)},${JSON.stringify(legacyTurn.id)});})()`);
  await cdp.call('Page.reload');await until(()=>cdp.evaluate("typeof state!=='undefined'&&!!state?.scope&&!loadingHistory"),'legacy cache reloaded');
  await until(()=>store.experiences.draft(legacyScope)?.originStatus==='legacy_origin_recovered','legacy origin checkpoint');
  const legacyDraft=store.experiences.draft(legacyScope);assert.equal(legacyDraft.text,legacyBody);assert.deepEqual(legacyDraft.artifactRefs,[legacyRef]);assert.equal(legacyDraft.reviewStatus,'required');
  assert.deepEqual(await cdp.evaluate('draftArtifactRefs'),[legacyRef]);assert.equal(await cdp.evaluate(`localStorage.getItem(${JSON.stringify(`draft:${oldKey}`)})`),null);
  assert.equal(store.experiences._all(legacyScope,'event').some(e=>['draft_independent','draft_adopted'].includes(e.type)),false);
  const migratedLegacy=store.getCompanion(legacyScope).turns.find(t=>t.id===legacyTurn.id);assert.ok(migratedLegacy.suggestions[0].artifactRef);assert.ok(migratedLegacy.expressionOptions[0].artifactRef);
  await ui.click('.assistant-suggestion button[data-action=adopt]');assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),legacyBody,'unreviewed legacy candidate cannot replace an edited draft');
  await ui.click('#draft-button');assert.equal(await cdp.evaluate("document.querySelector('#copy').disabled"),true);await ui.click('#draft-close');

  assert.equal((await cdp.evaluate(`(${probeModule.exports.captureHelperReload.toString()})(false)`)).captured,true);
  await cdp.evaluate("(()=>{const saved=JSON.parse(sessionStorage.getItem('qq-assistant-ui-reload-v1'));saved.draftArtifactRefs=[];sessionStorage.setItem('qq-assistant-ui-reload-v1',JSON.stringify(saved));})()");
  const legacyCapsule=await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')");
  await cdp.evaluate("(()=>{const saved=JSON.parse(sessionStorage.getItem('qq-assistant-ui-reload-v1'));saved.draftOrigin='legacy-origin-not-in-evidence';sessionStorage.setItem('qq-assistant-ui-reload-v1',JSON.stringify(saved));})()");
  const unresolvedLegacyCapsule=await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')"),unresolvedLegacyRestore=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);
  assert.equal(unresolvedLegacyRestore.reason,'draft_origin_unknown_capsule_quarantined');assert.equal(await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')"),unresolvedLegacyCapsule);
  await cdp.evaluate(`sessionStorage.setItem('qq-assistant-ui-reload-v1',${JSON.stringify(legacyCapsule)})`);
  store.updateTurn(legacyScope,legacySource.id,'更正旧讨论：只是想谈周末，还没有约定。');controller.changed();
  await cdp.call('Page.reload');await until(()=>cdp.evaluate("typeof state!=='undefined'&&!!state?.scope&&!loadingHistory"),'legacy corrected reload ready');
  const correctedLegacyRestore=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);assert.equal(correctedLegacyRestore.ready,true);assert.equal(correctedLegacyRestore.draftNeedsReview,true);assert.equal(correctedLegacyRestore.draftsPreserved,true);
  assert.deepEqual(await cdp.evaluate('draftArtifactRefs'),[legacyRef]);assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),legacyBody);
  await until(()=>cdp.evaluate('!draftSyncBusy&&!draftDirty'),'legacy restore checkpoint confirmed');
  await ui.click('#draft-button');await ui.click('#draft-review');await until(()=>store.experiences.draft(legacyScope)?.reviewStatus==='reviewed','legacy response family explicitly reviewed');await until(()=>cdp.evaluate("!document.querySelector('#copy').disabled"),'reviewed legacy copy enabled');
  await cdp.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}},configurable:true})");await ui.click('#copy');
  await until(()=>store.experiences._all(legacyScope,'event').some(e=>e.type==='clipboard_write'&&e.text===legacyBody),'legacy copied with response lineage');await ui.click('#draft-close');
  assert.equal((await cdp.evaluate(`(${probeModule.exports.captureHelperReload.toString()})(false)`)).captured,true);
  await cdp.evaluate("(()=>{const saved=JSON.parse(sessionStorage.getItem('qq-assistant-ui-reload-v1'));saved.draftArtifactRefs=[];sessionStorage.setItem('qq-assistant-ui-reload-v1',JSON.stringify(saved));})()");
  store.deleteTurn(legacyScope,legacySource.id);controller.changed();await until(()=>cdp.evaluate("document.querySelector('#draft').value===''") ,'legacy source forget clears draft');
  const forgottenLegacyRestore=await cdp.evaluate(`(${probeModule.exports.restoreHelperReload.toString()})()`);assert.equal(forgottenLegacyRestore.ready,true);assert.equal(forgottenLegacyRestore.draftsPreserved,false);
  assert.equal(await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')"),null);assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'');assert.equal(store.experiences.draft(legacyScope).text,'');
  assert.ok(store.experiences._all(legacyScope,'event').every(e=>e.text===''));assert.ok(store.experiences._all(legacyScope,'artifact').every(a=>a.availability==='redacted'&&a.body===''));assert.equal(calls.length,legacyCalls);
  checks.push('Persisted legacy replies materialize full artifact families; old local drafts and no-ref reload capsules retain response lineage through correction and explicit review, quarantine unknown origins, and clear after source forget without new model calls');
  const reportOut={evidence:'synthetic-pointer-browser-execution',nativeQQIntegration:false,realModelCalls:0,result:'PASS',checks,screenshot:path.join(artifacts,'experience-ui.png')};fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(reportOut,null,2));console.log(JSON.stringify({result:'PASS',checks:checks.length,report:path.join(artifacts,'report.json')}));
 }catch(error){if(cdp){try{const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'failure.png'),Buffer.from(shot.data,'base64'));console.error(`Failure screenshot: ${path.join(artifacts,'failure.png')}`)}catch{}}throw error}
 finally{cdp?.close();chrome.kill('SIGTERM'); if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve()})});controller.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
