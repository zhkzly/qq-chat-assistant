'use strict';
const fs=require('node:fs');const path=require('node:path');
// These functions execute only in the helper renderer, never in a QQ composer.
// The temporary recovery capsule stays in same-origin sessionStorage. Probe
// reports contain layout booleans and hashes, never its text or scope values.
function captureHelperReload(resume) {
 const key='qq-assistant-ui-reload-v1',el=id=>document.getElementById(id),current=typeof state==='undefined'?null:state;
 if(el('settings')?.open)return {blocked:true,reason:'settings_open',message:'请先保存或取消并关闭模型设置，再刷新助手；未读取或丢弃 API 表单。'};
 const peer=current?.scope?.peerUin||'',contact=el('qq-number')?.value?.trim()||'';
 if(contact!==peer)return {blocked:true,reason:'pending_contact_input',message:'好友输入框有尚未确认的更改，请先连接该好友或恢复当前号码，再刷新助手。'};
 if(current?.busy||current?.assistantBusy||typeof assistantPending!=='undefined'&&assistantPending||typeof feedbackPending!=='undefined'&&feedbackPending)
  return {blocked:true,reason:'assistant_request_pending',message:'助手请求仍在进行，请等待结束后刷新，避免丢失尚未完成的输入状态。'};
 const prior=sessionStorage.getItem(key);
 if(resume)return prior?{captured:true,resume:true}:{blocked:true,reason:'no_pending_recovery',message:'没有待恢复的助手输入。'};
 if(prior)return {blocked:true,reason:'pending_reload_recovery',message:'上次刷新保留了未恢复输入；请先使用 reload-helper 的 resume:true 恢复，避免覆盖它。'};
 const scope=current?.scope?Object.fromEntries(['accountUid','accountUin','peerUid','peerUin'].map(k=>[k,current.scope[k]])):null;
 if(scope&&Object.values(scope).some(value=>typeof value!=='string'||!value))return {blocked:true,reason:'incomplete_scope',message:'当前会话标识尚未就绪，未刷新助手。'};
 const value=id=>el(id)?.value||'',position=id=>{const node=el(id);return node?{top:node.scrollTop,left:node.scrollLeft,follow:node.scrollHeight-node.scrollTop-node.clientHeight<(id==='history'?40:60)}:null;};
 const noteId=value('note-id'),note=(current?.companion?.notes||[]).find(n=>n.id===noteId);
 const active=document.activeElement,focus=['assistant-input','draft','goal-input','note-text','feedback-text','memory-query','experience-review-text','experience-guidance-text','experience-guidance-when'].includes(active?.id)?{id:active.id,start:active.selectionStart,end:active.selectionEnd}:null;
 const tab=typeof workspace==='string'&&['discussion','history','background'].includes(workspace)?workspace:'discussion';
 const saved={version:1,scope,nextPurpose:typeof nextPurpose==='undefined'?'discussion':nextPurpose,instruction:value('instruction'),draft:value('draft'),draftOrigin:typeof draftOrigin==='undefined'?null:draftOrigin,
  draftArtifactRefs:typeof draftArtifactRefs==='undefined'?[]:draftArtifactRefs,draftRevision:typeof draftRevision==='undefined'?null:draftRevision,
  draftDirty:typeof draftDirty!=='undefined'&&draftDirty,draftEditPending:typeof draftEditPending!=='undefined'&&draftEditPending,
  draftSyncBlocked:typeof draftSyncBlocked!=='undefined'&&draftSyncBlocked,
  privateInput:value('assistant-input'),goalDraft:value('goal-input'),goalDirty:typeof goalDirty!=='undefined'&&goalDirty,
  noteText:value('note-text'),noteId,noteUse:value('note-use')||'discussion',noteVersion:note?.version??null,
  feedbackText:value('feedback-text'),feedbackRequestId:value('feedback-request-id'),feedbackOpen:!!el('feedback-form')&&!el('feedback-form').hidden,
  feedbackTargetRef:typeof feedbackTargetRef==='undefined'?null:feedbackTargetRef,feedbackClientId:typeof feedbackClientId==='undefined'?null:feedbackClientId,
  feedbackTargetPreview:el('feedback-target-preview')?.textContent||'',
  feedbackSavedId:typeof feedbackSavedId==='undefined'?null:feedbackSavedId,feedbackTaskId:typeof feedbackTaskId==='undefined'?null:feedbackTaskId,feedbackRetryReady:typeof feedbackRetryReady!=='undefined'&&feedbackRetryReady,feedbackSubmittedText:typeof feedbackSubmittedText==='undefined'?null:feedbackSubmittedText,
  experienceReview:{caseId:value('experience-review-id'),text:value('experience-review-text'),open:!!el('experience-review-form')&&!el('experience-review-form').hidden,target:typeof experienceReviewTarget==='undefined'?null:experienceReviewTarget,clientEventId:typeof experienceReviewClientId==='undefined'?null:experienceReviewClientId},
  experienceGuidance:{id:value('experience-guidance-id'),text:value('experience-guidance-text'),applicability:value('experience-guidance-when'),open:!!el('experience-guidance-form')&&!el('experience-guidance-form').hidden,expectedVersion:typeof guidanceEditVersion==='undefined'?null:guidanceEditVersion},
  memoryQuery:value('memory-query'),selectedDiscussion:typeof selectedDiscussion==='undefined'?null:selectedDiscussion,
  draftMaterialIds:typeof draftMaterialIds==='undefined'?[]:[...draftMaterialIds],activeTab:tab,
  draftDialogOpen:!!el('draft-dialog')?.open,contactDialogOpen:!!el('contact-dialog')?.open,
  closedReadOnlyInspector:!!(el('context-dialog')?.open||el('assistant-context-dialog')?.open),
  details:Object.fromEntries(['topic-direction','assistant-tools','goal-editor','note-editor','draft-material-panel','experiences-panel','experience-guidance-panel'].map(id=>[id,!!el(id)?.open])),
  visibleCount:typeof visibleCount==='undefined'?100:visibleCount,
  scroll:{window:{x:scrollX,y:scrollY},discussion:position('conversation-scroll')||position('assistant-thread'),history:position('history'),background:position('panel-background'),draft:position('draft'),
   discussionSaved:typeof discussionScroll==='undefined'?null:discussionScroll,historySaved:typeof qqScroll==='undefined'?null:qqScroll},focus};
 sessionStorage.setItem(key,JSON.stringify(saved));
 // Saving an existing draft is local-only. Do not invoke onchange/submit or
 // settings APIs: a visual refresh must not change application configuration.
 if(typeof saveDraft==='function')saveDraft();
 return {captured:true,resume:false,boundScopePresent:!!scope};
}
function restoreHelperReload() {
 const key='qq-assistant-ui-reload-v1',raw=sessionStorage.getItem(key),el=id=>document.getElementById(id);
 if(!raw)return {ready:false,blocked:true,reason:'missing_recovery_capsule'};
 let saved;try{saved=JSON.parse(raw);}catch{return {ready:false,blocked:true,reason:'invalid_recovery_capsule'};}
 if(saved.version!==1)return {ready:false,blocked:true,reason:'incompatible_recovery_capsule'};
 if(typeof state==='undefined'||!state||!el('assistant-input')||!el('draft'))return {ready:false,reason:'loading_helper'};
 const current=state.scope||null,fields=['accountUid','accountUin','peerUid','peerUin'];
 if(!!saved.scope!==!!current||saved.scope&&fields.some(k=>saved.scope[k]!==current[k]))return {ready:false,blocked:true,reason:'scope_changed_input_not_restored'};
 if(el('settings')?.open)return {ready:false,blocked:true,reason:'settings_open_input_not_restored'};
 if((el('qq-number')?.value?.trim()||'')!==(current?.peerUin||''))return {ready:false,blocked:true,reason:'pending_contact_input_not_restored'};
 if(typeof loadingHistory!=='undefined'&&loadingHistory)return {ready:false,reason:'loading_history'};
 const set=(id,value)=>{const node=el(id);if(node)node.value=value;};
 const turns=state.companion?.turns||[],notes=state.companion?.notes||[];
 const savedRefs=saved.draftArtifactRefs||[],resolvedRefs=typeof resolveDraftArtifactRefs==='function'?resolveDraftArtifactRefs(state,saved.draftOrigin,savedRefs):savedRefs;
 const bridgedLegacyOrigin=!savedRefs.length&&!!saved.draftOrigin&&!!resolvedRefs.length;
 const originState=typeof draftOriginState==='function'?draftOriginState(state,saved.draftOrigin,resolvedRefs):(!saved.draftOrigin?'active':'unknown');
 if(originState==='unknown')return {ready:false,blocked:true,reason:'draft_origin_unknown_capsule_quarantined'};
 const originValid=originState!=='redacted',artifactOriginsValid=originValid;
 if(typeof draftOrigin!=='undefined')draftOrigin=originValid?saved.draftOrigin:null;
 if(typeof draftArtifactRefs!=='undefined')draftArtifactRefs=originValid?resolvedRefs:[];
 if(typeof draftRevision!=='undefined'&&Number.isSafeInteger(saved.draftRevision))draftRevision=state.experience?.draft?.revision??saved.draftRevision;
 if(typeof draftDirty!=='undefined')draftDirty=!!saved.draftDirty;
 if(typeof draftEditPending!=='undefined')draftEditPending=originValid&&(!!saved.draftEditPending||bridgedLegacyOrigin&&!!saved.draft.trim());
 if(typeof draftSyncBlocked!=='undefined')draftSyncBlocked=!!saved.draftSyncBlocked;
 set('draft',originValid?saved.draft:'');
 if(!originValid&&current)localStorage.removeItem(`draft-events:${JSON.stringify(fields.map(k=>current[k]))}`);
 if(!originValid&&el('draft-status'))el('draft-status').textContent='原参考来源已删除，未恢复关联草稿。';
 if(typeof syncDraftSafety==='function')syncDraftSafety();
 set('assistant-input',saved.privateInput);set('instruction',saved.instruction);
 if(typeof selectNextPurpose==='function'&&['discussion','draft','review'].includes(saved.nextPurpose))selectNextPurpose(saved.nextPurpose,{focus:false,close:false});
 if(saved.goalDirty){set('goal-input',saved.goalDraft);if(typeof goalDirty!=='undefined')goalDirty=true;}
 const note=notes.find(n=>n.id===saved.noteId),noteCompatible=!saved.noteId||!!note&&note.version===saved.noteVersion;
 set('note-text',saved.noteText);set('note-id',noteCompatible?saved.noteId:'');set('note-use',saved.noteUse);
 if(el('note-cancel'))el('note-cancel').hidden=!noteCompatible||!saved.noteId;
 if(el('note-save'))el('note-save').textContent=noteCompatible&&saved.noteId?'保存修改':'保存近况';
 const feedbackArtifact=saved.feedbackTargetRef?.kind==='artifact'?(state.experience?.artifactStates||[]).find(item=>item.ref.artifactId===saved.feedbackTargetRef.artifactRef?.artifactId&&item.ref.version===saved.feedbackTargetRef.artifactRef?.version):null;
 const feedbackSourceGone=!!saved.feedbackSavedId&&!(state.companion?.feedback||[]).some(item=>item.id===saved.feedbackSavedId);
 const feedbackForgotten=feedbackSourceGone||feedbackArtifact?.availability==='redacted';
 const feedbackCompatible=!feedbackForgotten&&(feedbackArtifact?feedbackArtifact.availability!=='redacted':!saved.feedbackRequestId||turns.some(turn=>turn.requestId===saved.feedbackRequestId));
 if(typeof feedbackTargetRef!=='undefined')feedbackTargetRef=feedbackCompatible?saved.feedbackTargetRef||null:null;
 if(typeof feedbackClientId!=='undefined')feedbackClientId=feedbackCompatible?saved.feedbackClientId||null:null;
 if(typeof feedbackSavedId!=='undefined')feedbackSavedId=feedbackCompatible?saved.feedbackSavedId||null:null;
 if(typeof feedbackTaskId!=='undefined')feedbackTaskId=feedbackCompatible?saved.feedbackTaskId||null:null;
 if(typeof feedbackRetryReady!=='undefined')feedbackRetryReady=feedbackCompatible&&!!saved.feedbackRetryReady;
 if(typeof feedbackSubmittedText!=='undefined')feedbackSubmittedText=feedbackCompatible?saved.feedbackSubmittedText??null:null;
 if(el('feedback-target-preview'))el('feedback-target-preview').textContent=feedbackCompatible?saved.feedbackTargetPreview||'':'';
 if(current&&saved.feedbackTargetRef&&feedbackCompatible){const scoped=JSON.stringify(fields.map(k=>current[k]));sessionStorage.setItem(`feedback-target:${scoped}`,JSON.stringify({targetRef:saved.feedbackTargetRef,requestId:saved.feedbackRequestId,clientEventId:saved.feedbackClientId,taskId:saved.feedbackTaskId,submittedText:saved.feedbackSubmittedText}));}
 const recoveredFeedbackText=feedbackForgotten?'':saved.feedbackText;
 if(feedbackForgotten&&current)sessionStorage.removeItem(`feedback-target:${JSON.stringify(fields.map(k=>current[k]))}`);
 set('feedback-text',recoveredFeedbackText);set('feedback-request-id',feedbackCompatible?saved.feedbackRequestId:'');
 if(el('feedback-form')){
  el('feedback-form').hidden=!saved.feedbackOpen;for(const submit of el('feedback-form').querySelectorAll('[type=submit]'))submit.disabled=!feedbackCompatible;
  el('feedback-reload-notice')?.remove();
  if(!feedbackCompatible){const notice=document.createElement('p');notice.id='feedback-reload-notice';notice.className='muted';notice.textContent=feedbackForgotten?'原反馈对象已删除，相关反馈草稿已清除。':'暂时无法核实原反馈对象。文字已保留，请先核对要反馈的助手内容。';el('feedback-form').prepend(notice);}
 }
 set('memory-query',saved.memoryQuery);
 const experienceReview=saved.experienceReview||{};set('experience-review-id',experienceReview.caseId||'');set('experience-review-text',experienceReview.text||'');if(el('experience-review-form'))el('experience-review-form').hidden=!experienceReview.open;
 if(typeof experienceReviewTarget!=='undefined')experienceReviewTarget=experienceReview.target||null;
 if(typeof experienceReviewClientId!=='undefined')experienceReviewClientId=experienceReview.clientEventId||null;
 const experienceGuidance=saved.experienceGuidance||{};set('experience-guidance-id',experienceGuidance.id||'');set('experience-guidance-text',experienceGuidance.text||'');set('experience-guidance-when',experienceGuidance.applicability||'');if(el('experience-guidance-form'))el('experience-guidance-form').hidden=!experienceGuidance.open;
 if(typeof guidanceEditVersion!=='undefined')guidanceEditVersion=experienceGuidance.expectedVersion??null;
 if(typeof selectedDiscussion!=='undefined')selectedDiscussion=turns.some(turn=>turn.id===saved.selectedDiscussion)?saved.selectedDiscussion:null;
 if(typeof draftMaterialIds!=='undefined'){
  draftMaterialIds.clear();for(const id of saved.draftMaterialIds)if(notes.some(note=>note.id===id&&note.use==='draft'))draftMaterialIds.add(id);
  for(const input of document.querySelectorAll('#draft-materials input[type=checkbox]'))input.checked=draftMaterialIds.has(input.value);
 }
 for(const [id,open]of Object.entries(saved.details))if(el(id))el(id).open=open;
 if(typeof visibleCount!=='undefined'&&Number.isSafeInteger(saved.visibleCount))visibleCount=Math.max(100,Math.min(1000000,saved.visibleCount));
 if(typeof renderHistory==='function')renderHistory();
 if(typeof showWorkspace==='function')showWorkspace(saved.activeTab);
 const position=(id,p)=>{const node=el(id);if(node&&p){node.scrollTop=p.top;node.scrollLeft=p.left;}};
 const discussion=saved.activeTab==='discussion'?saved.scroll.discussion:saved.scroll.discussionSaved;
 if(typeof discussionScroll!=='undefined'&&discussion)discussionScroll={top:discussion.top,follow:discussion.follow??false};
 const history=saved.activeTab==='history'?saved.scroll.history:saved.scroll.historySaved;
 if(typeof qqScroll!=='undefined'&&history)qqScroll={top:history.top,follow:history.follow??false};
 position('conversation-scroll',saved.scroll.discussion);position('history',saved.scroll.history);position('panel-background',saved.scroll.background);position('draft',saved.scroll.draft);
 if(saved.draftDialogOpen&&el('draft-dialog')&&!el('draft-dialog').open)el('draft-dialog').showModal();
 else if(saved.contactDialogOpen&&el('contact-dialog')&&!el('contact-dialog').open)el('contact-dialog').showModal();
 if(saved.focus){const node=el(saved.focus.id);if(node?.getClientRects().length){node.focus({preventScroll:true});if(Number.isInteger(saved.focus.start)&&Number.isInteger(saved.focus.end)&&node.setSelectionRange)node.setSelectionRange(saved.focus.start,saved.focus.end);}}
 window.scrollTo(saved.scroll.window.x,saved.scroll.window.y);
 if(typeof saveDraft==='function')saveDraft();
 if(typeof syncDraftIndicator==='function')syncDraftIndicator();
 const preserved=el('assistant-input').value===saved.privateInput&&(!saved.goalDirty||el('goal-input')?.value===saved.goalDraft)&&el('note-text')?.value===saved.noteText&&el('feedback-text')?.value===recoveredFeedbackText&&el('draft').value===(originValid?saved.draft:'')&&(!el('experience-review-text')||el('experience-review-text').value===(experienceReview.text||''))&&(!el('experience-guidance-text')||el('experience-guidance-text').value===(experienceGuidance.text||''));
 if(!preserved)return {ready:false,blocked:true,reason:'input_verification_failed'};
 // Bind a legacy edited body to its response family without claiming adoption.
 if(originValid&&bridgedLegacyOrigin&&typeof checkpointDraft==='function')checkpointDraft();
 // Successful same-scope recovery migrates the old two-ID browser cache. Do
 // not leave a second copy that a later source-forget cannot invalidate.
 if(current){const legacy=`${current.accountUid}/${current.peerUid}`;localStorage.removeItem(`draft:${legacy}`);localStorage.removeItem(`draft-origin:${legacy}`);sessionStorage.removeItem(`draft:${legacy}`);if(typeof legacyDraftCandidate!=='undefined')legacyDraftCandidate=null;if(el('draft-recover-legacy'))el('draft-recover-legacy').hidden=true;}
 sessionStorage.removeItem(key);
 return {ready:true,scopePreserved:true,unsavedAssistantInputsPreserved:true,draftsPreserved:originValid,draftOriginPreserved:originValid,draftNeedsReview:originState==='stale',artifactOriginsPreserved:artifactOriginsValid,feedbackTargetPreserved:feedbackCompatible,noteEditDetached:!noteCompatible,feedbackTargetDetached:!feedbackCompatible,forgottenFeedbackCleared:feedbackForgotten,closedReadOnlyInspector:saved.closedReadOnlyInspector,
  activeTab:typeof workspace==='string'&&['discussion','history','background'].includes(workspace)?workspace:'legacy'};
}
async function inspectHelperLayout() {
 const el=id=>document.getElementById(id),visible=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden'&&getComputedStyle(node).display!=='none';
 const within=node=>{if(!visible(node))return false;const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;};
 const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');
 const root=document.scrollingElement||document.documentElement,modal=[...document.querySelectorAll('dialog[open]')].some(visible);
 const primary=el('panel-discussion')||el('assistant-form'),history=el('panel-history')||el('session'),background=el('panel-background')||el('background-panel');
 const current=typeof state==='undefined'?null:state,tab=typeof workspace==='string'&&['discussion','history','background'].includes(workspace)?workspace:'legacy';
 return {helperPresent:true,privateDiscussion:!!el('assistant-form'),memorySearch:!!el('memory-search-form'),memoryStatus:!!el('memory-status'),goalEditor:!!el('goal-form'),pendingActions:!!el('pending-actions'),contextInspector:!!el('assistant-context-dialog'),
  privateInputEnabled:!!el('assistant-input')&&!el('assistant-input').disabled,actualRows:document.querySelectorAll('.message').length,qqSendActionExposed:false,activeTab:tab,
  nextPurpose:typeof nextPurpose==='undefined'?null:nextPurpose,modeSelectorsEnabled:['assistant-discussion','assistant-draft','assistant-review'].every(id=>!!el(id)&&!el(id).disabled),
  composerVisibleWithinViewport:!modal&&within(el('assistant-form')),viewport:{width:innerWidth,height:innerHeight},
  pageOverflow:{horizontal:root.scrollWidth>root.clientWidth+1,vertical:root.scrollHeight>root.clientHeight+1,scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight,clientWidth:root.clientWidth,clientHeight:root.clientHeight},
  primaryPanelVisible:visible(primary),secondaryPanelVisible:visible(history)||visible(background),secondaryPanels:{history:visible(history),background:visible(background)},
  draftDialog:{present:!!el('draft-dialog'),open:!!el('draft-dialog')?.open,visible:visible(el('draft-dialog'))},settingsDialogOpen:!!el('settings')?.open,
  pendingContactInput:(el('qq-number')?.value?.trim()||'')!==(current?.scope?.peerUin||''),goalDirty:typeof goalDirty!=='undefined'&&goalDirty,noteEditorOpen:!!el('note-editor')?.open,feedbackOpen:!!el('feedback-form')&&!el('feedback-form').hidden,
  draftOriginPresent:typeof draftOrigin!=='undefined'&&!!draftOrigin,recoveryPending:!!sessionStorage.getItem('qq-assistant-ui-reload-v1'),
  draftHash:await hash(el('draft')?.value||''),privateInputHash:await hash(el('assistant-input')?.value||''),goalDraftHash:await hash(el('goal-input')?.value||''),noteDraftHash:await hash(el('note-text')?.value||''),feedbackDraftHash:await hash(el('feedback-text')?.value||''),
  feedbackTargetHash:await hash(JSON.stringify(typeof feedbackTargetRef==='undefined'?null:feedbackTargetRef)),draftArtifactRefsHash:await hash(JSON.stringify(typeof draftArtifactRefs==='undefined'?[]:draftArtifactRefs)),
  experienceReviewHash:await hash(el('experience-review-text')?.value||''),experienceGuidanceHash:await hash((el('experience-guidance-text')?.value||'')+'\n'+(el('experience-guidance-when')?.value||''))};
}
async function runProbe(states){
 if(process.env.CHAT_ASSISTANT_PROBE!=='1')return null;
 const file=path.resolve(__dirname,'../data/native-probe-action.json');if(!fs.existsSync(file))return null;
 const action=JSON.parse(fs.readFileSync(file,'utf8'));fs.unlinkSync(file);
 if(action.action==='refresh-service') {
  const {webContents,ipcMain}=require('electron');
  const contents=webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:17860/'));
  const openHelper=ipcMain._invokeHandlers?.get('qq-chat-assistant:open');
  if(!contents||typeof openHelper!=='function')throw new Error('Refresh requires the existing helper and its open handler');
  const root=path.resolve(__dirname,'..'),entry=path.join(root,'src/server.cjs');
  const children=fs.readdirSync('/proc').filter(id=>/^\d+$/.test(id)).filter(id=>{
   try{return fs.readFileSync(`/proc/${id}/cmdline`,'utf8').split('\0')[1]===entry && Number(fs.readFileSync(`/proc/${id}/status`,'utf8').match(/^PPid:\s+(\d+)$/m)?.[1])===process.pid;}catch{return false;}
  });
  if(children.length!==1)throw new Error('Cannot identify exactly one owned assistant worker');
  const capture=await contents.executeJavaScript(`(${captureHelperReload.toString()})(false)`);
  if(capture.blocked)return {scheduled:false,qqRestarted:false,serviceRestarted:false,...capture};
  const peer=await contents.executeJavaScript("typeof state==='undefined'?'':state?.scope?.peerUin||''");
  if(!/^\d{5,12}$/.test(peer))throw new Error('Cannot preserve helper conversation; inputs remain in the local recovery capsule');
  const output=path.join(root,'data/service-refresh-result.json');
  const oldURL=fs.readFileSync(path.join(root,'data/assistant-url.txt'),'utf8').trim();
  setTimeout(async()=>{try{
   process.kill(Number(children[0]),'SIGTERM');
   for(let n=0;n<100 && fs.existsSync(`/proc/${children[0]}`);n++)await new Promise(r=>setTimeout(r,100));
   if(fs.existsSync(`/proc/${children[0]}`))throw new Error('Owned assistant worker did not stop');
   await openHelper({sender:contents},peer);
   const url=fs.readFileSync(path.join(root,'data/assistant-url.txt'),'utf8').trim();
   if(!/^http:\/\/127\.0\.0\.1:17860\/#\w+$/.test(url)||url===oldURL)throw new Error('New helper URL is not ready');
   await contents.loadURL(url.replace('/#',`/?refresh=${Date.now()}#`));
   let restored;
   for(let n=0;n<150;n++){
    try{restored=await contents.executeJavaScript(`(${restoreHelperReload.toString()})()`);}
    catch{restored={ready:false,reason:'renderer_not_ready'};}
    if(restored.ready)break;
    // Automatic account/contact rebinding can be slower than renderer load.
    if(restored.blocked&&restored.reason!=='scope_changed_input_not_restored')break;
    await new Promise(r=>setTimeout(r,100));
   }
   if(!restored?.ready)throw new Error(`Helper restarted; scoped inputs remain in the recovery capsule (${restored?.reason||'timeout'})`);
   const layout=await contents.executeJavaScript(`(${inspectHelperLayout.toString()})()`);
   fs.writeFileSync(output,JSON.stringify({ok:true,qqRestarted:false,serviceRestarted:true,...restored,layout}),{mode:0o600});
  }catch(e){fs.writeFileSync(output,JSON.stringify({ok:false,qqRestarted:false,recoveryPending:true,error:e.message}),{mode:0o600});}},250);
  return {scheduled:true,qqRestarted:false};
 }
 if(action.action==='search-contact') {
  if(!/^\d{5,12}$/.test(action.uin))throw new Error('Invalid contact probe');
  const contents=require('electron').webContents.getAllWebContents().find(w=>w.getURL().includes('#/main/message'));
  if(!contents)throw new Error('QQ main window was not found');
  contents.getOwnerBrowserWindow().show();contents.getOwnerBrowserWindow().focus();
  return contents.executeJavaScript(`(()=>{const input=[...document.querySelectorAll('input')].find(e=>e.getClientRects().length&&e.placeholder==='搜索');if(!input)return {searchFound:false};input.focus();const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(action.uin)});input.dispatchEvent(new Event('input',{bubbles:true}));return {searchFound:true}})()`);
 }
 if(action.action==='open-search-contact') {
  if(!/^\d{5,12}$/.test(action.uin))throw new Error('Invalid contact probe');
  const contents=require('electron').webContents.getAllWebContents().find(w=>w.getURL().includes('#/main/message'));
  return contents.executeJavaScript(`(()=>{const matches=[...document.querySelectorAll('span.highlight-text')].filter(e=>e.getClientRects().length&&e.innerText?.includes(${JSON.stringify(action.uin)})).map(e=>e.closest('.search-result-item')).filter(Boolean);const rows=[...new Set(matches)];if(rows.length!==1)return {resultCount:rows.length,opened:false};rows[0].click();rows[0].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return {resultCount:1,opened:true}})()`);
 }
 if(action.action==='search-results') {
  const contents=require('electron').webContents.getAllWebContents().find(w=>w.getURL().includes('#/main/message'));
  return contents.executeJavaScript(`(()=>({leaves:[...document.querySelectorAll('span,div')].filter(e=>e.getClientRects().length&&e.children.length===0&&e.innerText?.includes(${JSON.stringify(action.uin)})).slice(0,8).map(e=>({tag:e.tagName,classes:e.className,parent:e.parentElement.className,ancestors:[...function*(node){for(let n=0;node&&n<5;n++,node=node.parentElement)yield node.className}(e)]})),searchResults:[...document.querySelectorAll('[class*=search]')].filter(e=>e.getClientRects().length).map(e=>e.className).slice(0,35)}))()`);
 }
 if(action.action==='browse-history') {
  const contents=require('electron').webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:17860/'));
  if(!contents)throw new Error('Native helper is not open');
  return contents.executeJavaScript(`(()=>{if(document.querySelector('#qq-number')?.value!=='2046916821')return {wrongScope:true};const before=document.querySelectorAll('.message').length;for(let n=0;n<8;n++)document.querySelector('#view-older')?.click();const pane=document.querySelector('#history');pane.scrollTop=pane.scrollHeight;return {before,after:document.querySelectorAll('.message').length,scrollable:pane.scrollHeight>pane.clientHeight,atLatest:pane.scrollTop+pane.clientHeight>=pane.scrollHeight-2}})()`);
 }
 if(action.action==='reload-helper') {
  const contents=require('electron').webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:17860/'));
  if(!contents)throw new Error('Native helper is not open');
  const capture=await contents.executeJavaScript(`(${captureHelperReload.toString()})(${action.resume===true})`);
  if(capture.blocked)return {reloaded:false,qqRestarted:false,serviceRestarted:false,...capture};
  if(!capture.resume){
   const url=fs.readFileSync(path.resolve(__dirname,'../data/assistant-url.txt'),'utf8').trim();
   if(!/^http:\/\/127\.0\.0\.1:17860\/#\w+$/.test(url))throw new Error('Invalid private helper URL; unsaved inputs remain in the local recovery capsule');
   try{await contents.loadURL(url.replace('/#',`/?refresh=${Date.now()}#`));}
   catch{throw new Error('Helper page reload failed; unsaved inputs remain in the local recovery capsule');}
  }
  let restored;
  for(let n=0;n<100;n++){
   try{restored=await contents.executeJavaScript(`(${restoreHelperReload.toString()})()`);}
   catch{restored={ready:false,reason:'renderer_not_ready'};}
   if(restored.ready||restored.blocked)break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!restored?.ready)return {reloaded:!capture.resume,qqRestarted:false,serviceRestarted:false,restored:false,recoveryPending:true,reason:restored?.reason||'restoration_timeout',message:'未将输入恢复到未经确认的会话。原输入仍保留在本机恢复区，可在当前会话就绪后用 resume:true 重试。'};
  return {reloaded:!capture.resume,qqRestarted:false,serviceRestarted:false,...restored};
 }
 if(action.action==='inspect-context-helper') {
  const contents=require('electron').webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:17860/'));
  if(!contents)return {helperPresent:false};
  return contents.executeJavaScript(`(${inspectHelperLayout.toString()})()`);
 }
 if(action.action==='inspect-helper') {
  const contents=require('electron').webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:17860/'));
  if(!contents)return {helperPresent:false};
  const result=await contents.executeJavaScript(`(()=>({helperPresent:true,contactSelected:/^\\d{5,12}$/.test(document.querySelector('#qq-number')?.value||''),modelSettings:!!document.querySelector('#settings-button'),fillEnabled:!document.querySelector('#fill-qq')?.disabled,auto:document.querySelector('#auto')?.checked,renderedMessages:document.querySelectorAll('.message').length,historyCount:document.querySelector('#history-count')?.textContent,errorVisible:!document.querySelector('#error')?.hidden,modelListStatus:document.querySelector('#model-list-status')?.textContent,uiError:document.querySelector('#error')?.textContent,connection:document.querySelector('#connection-label')?.textContent,modelOptions:document.querySelector('#quick-model')?.options.length||0,profileOptions:document.querySelector('#quick-profile')?.options.length||0,focusControls:document.querySelectorAll('.focus-choice').length,model:document.querySelector('#quick-model')?.value,draft:document.querySelector('#draft')?.value||''}))()`);
  result.draftHash=require('node:crypto').createHash('sha256').update(result.draft).digest('hex');delete result.draft;return result;
 }
 if(action.action==='clear-smoke-draft') {
  const target=states.find(s=>s.window.webContents.id===action.windowId&&s.ownerMatches&&s.matches);
  if(!target)throw new Error('Draft cleanup target is not the current verified private composer');
  return target.window.webContents.executeJavaScript(`(()=>{
    const editor=[...document.querySelectorAll('.ck-content[contenteditable=true],.chat-input-area [contenteditable=true]')].find(e=>e.getClientRects().length);
    const marker='QQ 助手回填验证（未发送）🙂';
    if(!editor || editor.innerText.replace(/[\\u200B\\uFEFF]/g,'').trim()!==marker)return {cleared:false,protectedUserDraft:true};
    editor.focus();const range=document.createRange();range.selectNodeContents(editor);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    document.execCommand('insertText',false,'');
    return {cleared:!editor.innerText.includes(marker),qqMessagesSent:0};
  })()`);
 }
 if(action.action==='show-main') {
  const {webContents}=require('electron');
  const contents=webContents.getAllWebContents().find(w=>w.getURL().includes('#/main/message'));
  if(!contents)throw new Error('QQ main conversation window was not found');
  const window=contents.getOwnerBrowserWindow();window.show();window.focus();
  return contents.executeJavaScript(`(()=>({mainShown:true,inputs:[...document.querySelectorAll('input')].map(e=>({placeholder:e.placeholder,className:e.className,visible:!!e.getClientRects().length})),toolbars:document.querySelectorAll('.chat-func-bar').length,bodyChildren:document.body.children.length}))()`);
 }
 if(action.action==='inspect-surfaces') {
  const {webContents,BrowserWindow}=require('electron');
  const shape=url=>{try{const u=new URL(url);return {path:u.pathname,query:[...u.searchParams.keys()],hash:u.hash.split('?')[0]}}catch{return {path:'unknown'}}};
  return {contents:webContents.getAllWebContents().map(w=>({id:w.id,type:w.getType(),owner:w.getOwnerBrowserWindow?.()?.id||BrowserWindow.fromWebContents(w)?.id,url:shape(w.getURL()),frames:w.mainFrame?.framesInSubtree.map(f=>({routingId:f.routingId,url:shape(f.url)}))}))};
 }
 if(action.action!=='open-entry')throw new Error('Unknown native development probe');
 const target=states.find(s=>s.window.webContents.id===action.windowId&&s.ownerMatches&&s.state.peer?.chatType===1);
 if(!target)throw new Error('Native probe target is not a verified current-account private composer');
 target.window.show();target.window.focus();
 const result=await target.window.webContents.executeJavaScript(`(async()=>{
  const button=document.getElementById('qq-chat-assistant-entry');
  if(!button)return {entryPresent:false};
  const bridge=typeof window.qqChatAssistant?.open==='function';
  if(bridge){await window.qqChatAssistant.open();return {entryPresent:true,entryInvoked:true};}
  return {entryPresent:true,entryInvoked:false};
 })()`);
 return result;
}
module.exports={runProbe};
