'use strict';
const $ = id => document.getElementById(id);
const suppliedToken=location.hash.slice(1);
if(suppliedToken)sessionStorage.setItem('qq-assistant-token',suppliedToken);
const token=suppliedToken||sessionStorage.getItem('qq-assistant-token')||'';
history.replaceState(null,'',location.pathname);
let state=null,scopeKey='',lastAdvice='',polling=false,historyKey='',historyMessages=[],visibleCount=100,historyVersion='',loadingHistory=false,historyEpoch=0,imageSelection=[],imageBlobs=new Map(),localError='',consentKey='',replySelection=[];
let assistantPending=false,assistantLocalError='',assistantThreadKey='',assistantNotesKey='',assistantStateKey='',goalVersion='',goalDirty=false,assistantContextVersion=0,draftMaterialIds=new Set(),draftOrigin=null;
let actionPanelKey='',memorySearchVersion=0,memoryResultsRevision=null,selectedDiscussion=null;
let memoryRetryPending=false;
let helpingMethods=new Map();
let workspace='discussion';
let discussionScroll={top:0,follow:true},qqScroll={top:0,follow:true};
const workspaceNames=['discussion','history','background'];
function showWorkspace(name,focus=false){
 if(!workspaceNames.includes(name))return;
 if(workspace==='discussion'&&!$('panel-discussion').hidden){const pane=$('conversation-scroll');discussionScroll={top:pane.scrollTop,follow:pane.scrollHeight-pane.scrollTop-pane.clientHeight<60};}
 if(workspace==='history'&&!$('panel-history').hidden){const pane=$('history');qqScroll={top:pane.scrollTop,follow:pane.scrollHeight-pane.scrollTop-pane.clientHeight<40};}
 workspace=name;
 for(const item of workspaceNames){$('panel-'+item).hidden=item!==name;$('tab-'+item).setAttribute('aria-selected',String(item===name));$('tab-'+item).tabIndex=item===name?0:-1;}
 if(name==='discussion'){
  $('conversation-scroll').scrollTop=discussionScroll.follow?$('conversation-scroll').scrollHeight:discussionScroll.top;
  if(focus)$('assistant-input').focus();
 }
 if(name==='history')$('history').scrollTop=qqScroll.follow?$('history').scrollHeight:qqScroll.top;
}
for(const name of workspaceNames){
 $('tab-'+name).onclick=()=>showWorkspace(name);
 $('tab-'+name).onkeydown=e=>{
  let index=workspaceNames.indexOf(name);
  if(e.key==='ArrowRight')index=(index+1)%3;else if(e.key==='ArrowLeft')index=(index+2)%3;else if(e.key==='Home')index=0;else if(e.key==='End')index=2;else return;
  e.preventDefault();showWorkspace(workspaceNames[index]);$('tab-'+workspaceNames[index]).focus();
 };
}
function openDraft(){if(!$('draft-dialog').open)$('draft-dialog').showModal();$('draft').focus()}
function attachDiscussionContext(text){const input=$('assistant-input');input.value=input.value.trim()?`${input.value}\n\n${text}`:text;showWorkspace('discussion',true)}
function syncDraftIndicator(){$('draft-indicator').hidden=!$('draft').value.trim()}
$('draft-button').onclick=openDraft;
$('draft-close').onclick=()=>{$('draft-dialog').close();showWorkspace('discussion',true)};
$('contact-button').onclick=()=>{$('contact-dialog').showModal();$('qq-number').focus()};
$('contact-close').onclick=()=>$('contact-dialog').close();
$('history-discuss').onclick=()=>showWorkspace('discussion',true);
$('qq-context-preview').onclick=()=>showWorkspace('history');
async function api(path,args) {
 const response=await fetch(path,{method:args===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(args===undefined?{}:{'Content-Type':'application/json'})},body:args===undefined?undefined:JSON.stringify(args)});
 if(!response.ok){const p=await response.json();throw new Error(p.error||`HTTP ${response.status}`)}return response;
}
function error(message){if(message)localError=message;const shown=state?.error||localError;$('error').textContent=shown;$('error').hidden=!shown;for(const id of ['draft-error','contact-error','settings-notice']){$(id).textContent=shown;$(id).hidden=!shown}}
function keyOf(scope){return scope?`${scope.accountUid}/${scope.peerUid}`:''}
function saveDraft(){syncDraftIndicator();if(scopeKey){localStorage.setItem(`draft:${scopeKey}`,$('draft').value);if(draftOrigin)localStorage.setItem(`draft-origin:${scopeKey}`,draftOrigin);else localStorage.removeItem(`draft-origin:${scopeKey}`)}}
function adopt(text,origin=null){$('draft').value=text;draftOrigin=origin;saveDraft();$('draft-status').textContent='已放入草稿，可修改';openDraft()}
async function copyText(text){if(!text?.trim())return;try{await navigator.clipboard.writeText(text);$('draft-status').textContent='已复制，回 QQ 按 Ctrl+V 粘贴';}catch{adopt(text,text===$('draft').value?draftOrigin:null);$('draft').select();$('draft-status').textContent='请按 Ctrl+C 复制'}}
function renderHistory(keepAnchor=false) {
 if(!state?.scope)return;
 const current=`${scopeKey}:${historyKey}:${visibleCount}:${state.revision}:${replySelection.join(',')}:${JSON.stringify(imageSelection)}`;
 if(current===historyVersion)return;historyVersion=current;
 const pane=$('history'),previousHeight=pane.scrollHeight,previousTop=pane.scrollTop,atEnd=previousHeight-previousTop-pane.clientHeight<40;
 const list=historyMessages.length?historyMessages:state.messages;
 const shown=list.slice(-visibleCount),fragment=document.createDocumentFragment();
 for(const message of shown){
  const wrapper=document.createElement('div');wrapper.className=`message ${message.direction}`;wrapper.dataset.messageId=message.messageId;
  const meta=document.createElement('div');meta.className='meta';meta.textContent=`${message.direction==='outgoing'?'我':'对方'} · ${new Date(message.timestamp).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`;
  const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=message.text;
  for(const media of message.media||[]){
    const id=`${message.messageId}:${media.index}`,row=document.createElement('div');row.className='media-row';
    const image=document.createElement('img');image.className='chat-image';image.alt=media.name||'QQ 图片';image.hidden=!imageBlobs.has(id);if(imageBlobs.has(id))image.src=imageBlobs.get(id);
    const preview=document.createElement('button');preview.className='text-button';preview.textContent='查看图片';preview.onclick=async()=>{try{const response=await api(`/api/media?accountUid=${encodeURIComponent(state.scope.accountUid)}&peerUid=${encodeURIComponent(state.scope.peerUid)}&messageId=${message.messageId}&index=${media.index}`);const url=URL.createObjectURL(await response.blob());imageBlobs.set(id,url);image.src=url;image.hidden=false;preview.hidden=true;}catch(e){error(e.message)}};
    const label=document.createElement('label');label.className='toggle';const check=document.createElement('input');check.type='checkbox';check.checked=imageSelection.some(v=>v.messageId===message.messageId&&v.index===media.index);check.onchange=()=>{imageSelection=imageSelection.filter(v=>!(v.messageId===message.messageId&&v.index===media.index));if(check.checked){if(imageSelection.length>=3){check.checked=false;error('最多选三张图片');return}imageSelection.push({messageId:message.messageId,index:media.index})}saveOptions()};label.append(check,document.createTextNode('本次让 AI 看此图'));
    row.append(preview,label,image);bubble.append(row);
  }
  const focusLabel=document.createElement('label');focusLabel.className='toggle focus-choice';const focusCheck=document.createElement('input');focusCheck.type='checkbox';focusCheck.checked=replySelection.includes(message.messageId);focusCheck.setAttribute('aria-label',`重点回复 ${message.messageId}`);
  wrapper.classList.toggle('focused',focusCheck.checked);focusCheck.onchange=()=>{const next=replySelection.filter(id=>id!==message.messageId);if(focusCheck.checked){if(next.length>=8){focusCheck.checked=false;error('最多选择 8 条回复重点');return}next.push(message.messageId)}replySelection=next;saveOptions()};focusLabel.append(focusCheck,document.createTextNode('重点回复'));
  wrapper.append(meta,bubble,focusLabel);fragment.append(wrapper);
 }
 pane.replaceChildren(fragment);
 if(workspace==='history'){if(keepAnchor)pane.scrollTop=previousTop+pane.scrollHeight-previousHeight;else if(atEnd)pane.scrollTop=pane.scrollHeight;else pane.scrollTop=previousTop;}
 $('history-count').textContent=`${state.total} 条已读取 · 显示 ${shown.length}`;
 $('view-older').hidden=visibleCount>=list.length;
 $('view-older').textContent=`查看更早消息（还有 ${Math.max(0,list.length-shown.length)} 条）`;
 if(!shown.length){const empty=document.createElement('p');empty.className='muted';empty.textContent=state.historyBusy?'正在读取 QQ 消息…':state.coverage?.status==='read_error'?'读取失败，请先在 QQ 打开该好友私聊，再点重试。':'当前没有可读消息。可在 QQ 打开此私聊后重试。';pane.append(empty)}
}
function showEarlier(){if(loadingHistory||visibleCount>=historyMessages.length)return;visibleCount+=100;renderHistory(true)}
async function syncHistory() {
 if(!state?.scope||loadingHistory)return;
 const expected=scopeKey,revision=state.revision,total=state.total,epoch=historyEpoch;
 const nextKey=`${expected}:${revision}:${total}`;if(historyKey===nextKey)return;
 loadingHistory=true;
 try{
  // The local export endpoint already exists in the installed first version.
  // Reusing it lets the browser show all cached rows before a service upgrade.
  const data=await(await api('/api/export?format=json')).json();
  if(epoch!==historyEpoch||keyOf(data.scope)!==expected||scopeKey!==expected)return;
  historyMessages=data.messages;historyKey=nextKey;renderHistory();renderReplyFocus();
 }catch(e){if(epoch===historyEpoch)error(e.message)}finally{loadingHistory=false}
}
function render(next) {
 const key=keyOf(next.scope);if(!state&&next.instruction)$('instruction').value=next.instruction;
 if(key!==scopeKey){saveDraft();scopeKey=key;if(next.scope)$('qq-number').value=next.scope.peerUin;imageSelection=[];for(const url of imageBlobs.values())URL.revokeObjectURL(url);imageBlobs.clear();historyEpoch++;historyKey='';historyMessages=[];historyVersion='';visibleCount=100;
  $('draft').value=key?(localStorage.getItem(`draft:${key}`)||sessionStorage.getItem(`draft:${key}`)||''):'';draftOrigin=key?localStorage.getItem(`draft-origin:${key}`):null;if(key)saveDraft();$('draft-status').textContent='可自由修改';lastAdvice=null;resetCompanion();workspace='';discussionScroll={top:0,follow:true};qqScroll={top:0,follow:true};showWorkspace('discussion');for(const id of ['draft-dialog','contact-dialog'])if($(id).open)$(id).close();syncDraftIndicator();}
 if(state&&(state.model!==next.model||state.modelBaseUrl!==next.modelBaseUrl||state.activeModelProfileId!==next.activeModelProfileId)){imageSelection=[];historyVersion=''}
 replySelection=next.replyFocus?.mode==='selected'?[...next.replyFocus.messageIds]:[];
 imageSelection=[...(next.imageSelection||[])];
 state=next;syncModelPicker();renderReplyFocus();renderCompanion();if(document.activeElement!==$('auto'))$('auto').checked=next.auto;const ready=next.status.phase==='ready';
 $('connection-dot').classList.toggle('ready',ready);$('workspace-dot').classList.toggle('ready',ready);$('workspace-status').textContent=ready?'QQ 已连接':'QQ 未连接';$('workspace-contact').textContent=next.scope?`好友 ${next.scope.peerUin}`:'选择 QQ 好友';$('draft-recipient').textContent=next.scope?`给好友 ${next.scope.peerUin} · 尚未发送`:'请先选择讨论对象';$('draft-button').disabled=!next.scope;
 $('connection-label').textContent=ready?`已连接 QQ ${next.status.account.uin} · 只读监听`:({waiting_qq:'等待 QQ 客户端启动',waiting_login:'请在 QQ 窗口完成登录',initializing:'正在读取 QQ 账号…',offline:'QQ 已离线，请重新登录',integration_error:'QQ 接入未就绪，请查看诊断'}[next.status.phase]||next.status.phase);
 $('session').hidden=!next.scope;
 $('model-label').textContent=next.modelReady?next.model:'尚未配置模型';$('current-model').textContent=next.model||'未配置';$('current-api').textContent=next.modelBaseUrl||'未配置 API';
 $('generate').disabled=!next.scope||next.busy||next.assistantBusy||assistantPending||!next.modelConsent;
 $('model-consent').hidden=!next.scope||(!!next.modelConsent&&(!imageSelection.length||next.imageConsent));
 const nextConsentKey=`${scopeKey}:${next.model}:${next.modelBaseUrl}`;if(nextConsentKey!==consentKey){consentKey=nextConsentKey;$('allow-images').checked=!!next.imageConsent;}else if(next.imageConsent)$('allow-images').checked=true;
 $('fill-qq').disabled=!next.qqDraftFillAvailable;
 $('fill-qq').title=next.qqDraftFillAvailable?'只填入，不发送':'需要重启 QQ 加载新版插件；复制按钮可直接使用';$('consent-destination').textContent=`所选好友：${next.scope?.peerUin||''} · 模型：${next.model} · API：${next.modelBaseUrl}`;
 $('generate').textContent=next.busy?'正在想回复…':'接着 QQ 聊';$('older').disabled=next.historyBusy;$('older').textContent=next.historyBusy?'正在读取…':'从 QQ 读取更早记录';
 $('context-button').disabled=!next.scope;
 if(next.scope){
  if(document.activeElement!==$('qq-number'))$('qq-number').value=next.scope.peerUin;
  $('contact-title').textContent=`和 ${next.scope.peerUin} 的私聊`;renderHistory();syncHistory();
  const label={loading:'正在读取 QQ 历史',partial:'已读取部分记录，可继续从 QQ 加载',accessible_end:'已到 QQ 客户端当前可访问的记录边界',read_error:'读取失败；请在 QQ 打开此私聊后重试',empty:'QQ 未返回记录；可打开此私聊后重试',cached_only:'QQ 暂未返回新记录，显示本机已保存内容',not_loaded:next.historyBusy?'正在读取历史':'尚未成功读取，点重试'}[next.coverage?.status]||'尚未读取';
  $('coverage-label').textContent=label;$('retry-history').hidden=!['read_error','empty','not_loaded','cached_only'].includes(next.coverage?.status||'not_loaded');
 }
 const adviceKey=next.advice?.createdAt||'';
 if(adviceKey!==lastAdvice){lastAdvice=adviceKey;$('suggestions').replaceChildren();$('analysis').textContent=next.advice?.analysis||'连接私聊后，助手结合已发送记录提供参考。';
  for(const item of next.advice?.suggestions||[]){const card=document.createElement('article');card.className='suggestion';const row=document.createElement('div');row.className='row';const style=document.createElement('span');style.textContent=item.style;
   const actions=document.createElement('div');actions.className='suggestion-actions';const use=document.createElement('button');use.className='text-button';use.textContent='采用到草稿';use.onclick=()=>adopt(item.text);
   const copy=document.createElement('button');copy.className='text-button';copy.textContent='复制这条';copy.onclick=()=>copyText(item.text);actions.append(use,copy);row.append(style,actions);const text=document.createElement('p');text.textContent=item.text;card.append(row,text);$('suggestions').append(card)}
 }
 if(next.advice&&next.advice.revision!==next.revision)$('analysis').textContent=next.auto?'有新消息，正在更新建议。你的草稿会保留。':'有新消息，点生成可更新建议。你的草稿会保留。';error(next.error);
}
function resetCompanion(){
 assistantPending=false;assistantLocalError='';assistantThreadKey='';assistantNotesKey='';assistantStateKey='';goalVersion='';goalDirty=false;draftMaterialIds.clear();assistantContextVersion++;
 $('assistant-tools').open=false;$('goal-editor').open=false;$('note-editor').open=false;actionPanelKey='';memorySearchVersion++;memoryResultsRevision=null;selectedDiscussion=null;memoryRetryPending=false;$('memory-retry-panel').hidden=true;$('memory-query').value='';$('memory-results').replaceChildren();$('memory-search-status').textContent='';$('pending-actions').replaceChildren();$('action-receipts').replaceChildren();
 $('assistant-input').value='';$('goal-input').value='';resetNoteForm();$('feedback-form').reset();$('feedback-form').hidden=true;
 $('assistant-thread').replaceChildren();$('notes-list').replaceChildren();$('draft-materials').replaceChildren();$('state-summary').replaceChildren();
 $('assistant-error').hidden=true;$('assistant-context-records').replaceChildren();$('assistant-context-summary').textContent='';
 if($('assistant-context-dialog').open)$('assistant-context-dialog').close();
}
function scopeArgs(){return {accountUid:state?.scope?.accountUid,peerUid:state?.scope?.peerUid}}
function companionError(message=''){assistantLocalError=message;const shown=state?.assistantError||assistantLocalError;$('assistant-error').textContent=shown||'';$('assistant-error').hidden=!shown}
async function companionAction(path,args){
 const scope=scopeArgs(),expected=scopeKey,epoch=historyEpoch;if(!expected){companionError('先选择要讨论的好友。');return null}
 companionError();
 try{const next=await(await api(path,{...args,...scope})).json();if(epoch!==historyEpoch||expected!==scopeKey)return null;
  if(next.scope&&keyOf(next.scope)!==expected)return null;render(next);return next;
 }catch(e){if(epoch===historyEpoch&&expected===scopeKey)companionError(e.message);return null}
}
function button(text,run,className='text-button'){const element=document.createElement('button');element.type='button';element.className=className;element.textContent=text;element.onclick=run;return element}
function paragraph(text,className=''){const p=document.createElement('p');p.textContent=text;p.className=className;return p}
function renderCompanion(){
 const companion=state.companion||{},busy=assistantPending||state.assistantBusy,available=!!state.scope&&!!state.modelConsent;
 if(memoryResultsRevision!==null&&memoryResultsRevision!==companion.revision){memorySearchVersion++;memoryResultsRevision=null;$('memory-results').replaceChildren();$('memory-search-status').textContent='背景已有更新，可重新查找当前内容。'}
 for(const id of ['assistant-send','assistant-draft','assistant-review'])$(id).disabled=!available||busy;
 $('assistant-context-button').disabled=!state.scope;$('assistant-input').disabled=!state.scope;
 $('assistant-status').textContent=!state.scope?'先在上方选择讨论对象':busy?'正在结合上下文思考…':!state.modelConsent?'请先允许当前会话使用模型':'私下讨论 · Ctrl + Enter 提交';$('generate').disabled=!available||busy||state.busy;
 companionError(assistantLocalError);
 renderMemoryStatus();renderActionPanels(companion);
 const turns=companion.turns||[],threadKey=JSON.stringify(turns);
 if(state.companion&&draftOrigin&&!turns.some(turn=>turn.id===draftOrigin)){draftOrigin=null;$('draft').value='';saveDraft();$('draft-status').textContent='原来的参考内容已更新或删除，关联草稿已清除';sessionStorage.removeItem(`draft:${scopeKey}`)}
 if($('feedback-request-id').value&&!turns.some(turn=>turn.requestId===$('feedback-request-id').value)){$('feedback-form').reset();$('feedback-form').hidden=true}
 if(threadKey!==assistantThreadKey){assistantThreadKey=threadKey;const pane=$('assistant-thread'),scroller=$('conversation-scroll'),atEnd=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<60,oldTop=scroller.scrollTop,fragment=document.createDocumentFragment(),expected=scopeKey,epoch=historyEpoch;
  for(const turn of turns){const article=document.createElement('article');article.className=`assistant-turn ${turn.role==='user'?'user':'assistant'}`;article.dataset.turnId=turn.id;
   const head=document.createElement('div');head.className='turn-heading';const who=document.createElement('strong');who.textContent=turn.role==='user'?'我 · 私下讨论':'助手';
   const remove=button('删除',async()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;if(confirm('删除这条私下讨论及依赖它的助手内容？QQ 消息不会删除。'))await companionAction('/api/turn-delete',{id:turn.id})});remove.setAttribute('aria-label',`删除${turn.role==='user'?'我的讨论':'助手回复'}`);head.append(who,remove);article.append(head,paragraph(turn.text||'','turn-text'));
   for(const suggestion of turn.suggestions||[]){const card=document.createElement('div');card.className='assistant-suggestion';card.append(paragraph(suggestion.style||'参考表达','muted'),paragraph(suggestion.text||''));card.append(button('采用到草稿',()=>{if(expected===scopeKey&&epoch===historyEpoch)adopt(suggestion.text,turn.id)}));article.append(card)}
   for(const [index,choice] of (turn.expressionOptions||[]).entries()){
    const card=document.createElement('div');card.className='expression-option';card.append(paragraph(choice.label||choice.intent||'一个可表达的方向'));
    card.append(button('用这个方向写',()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;submitAssistant('draft',{text:$('assistant-input').value.trim()||'按选中的方向组织表达',selectedOption:{turnId:turn.id,index},sourceTurnIds:[turn.id]})},'secondary'));article.append(card);
   }
   if(turn.role==='user')article.append(button('继续聊这段',()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;selectedDiscussion=turn.id;$('assistant-input').placeholder='继续说说这段讨论里你想调整或表达的意思…';$('assistant-input').focus();$('assistant-status').textContent='这次会联系所选讨论继续；不会直接把整段私下内容写给她。'}));
   if(turn.method||turn.methodBasis||turn.methodIds?.length||turn.evidence||turn.sourceIds?.length){const details=document.createElement('details');details.className='method-basis';const title=document.createElement('summary');title.textContent='参考依据与帮助思路';details.append(title);
    for(const id of turn.methodIds||[]){const method=helpingMethods.get(id);if(!method)continue;details.append(paragraph(method.name,'state-heading'),paragraph(method.goalContribution));
     for(const evidence of method.evidence||[]){const row=paragraph(evidence.limit||'','muted');if(/^https?:\/\//.test(evidence.source||'')){const link=document.createElement('a');link.href=evidence.source;link.target='_blank';link.rel='noopener noreferrer';link.textContent='研究来源';row.append(document.createTextNode(' '),link)}details.append(row)}
    }
    if(turn.methodBasis)details.append(paragraph(typeof turn.methodBasis==='string'?turn.methodBasis:JSON.stringify(turn.methodBasis)));
    if(turn.method)details.append(paragraph(`这次采用：${typeof turn.method==='string'?turn.method:turn.method.label||turn.method.id||''}`));
    for(const id of turn.sourceIds||[])details.append(paragraph(sourceDescription(id),'muted'));
    article.append(details);
   }
   if(turn.role==='assistant'&&turn.requestId){const feedback=button('反馈或调整',()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;$('feedback-request-id').value=turn.requestId;$('feedback-text').value='';$('feedback-form').querySelector('[type=submit]').disabled=false;$('feedback-reload-notice')?.remove();$('feedback-form').hidden=false;$('feedback-text').focus()});article.append(feedback)}
   fragment.append(article);
  }
  if(!turns.length)fragment.append(paragraph(state.scope?'不必先想好目的。可以先说说今天发生了什么，或贴着当前 QQ 对话一起理清。':'选择好友后，从你正在犹豫的那件事开始。','assistant-empty'));
  pane.replaceChildren(fragment);if(workspace==='discussion')scroller.scrollTop=atEnd?scroller.scrollHeight:oldTop;
 }
 const currentGoalVersion=`${companion.goal?.version||0}:${companion.goal?.text||''}`;
 if(currentGoalVersion!==goalVersion){goalVersion=currentGoalVersion;if(!goalDirty)$('goal-input').value=companion.goal?.text||''}
 for(const formId of ['goal-form','note-form','memory-search-form'])for(const element of $(formId).elements)element.disabled=!state.scope;
 renderNotes(companion.notes||[]);renderCurrentState(companion.state);
}
function renderMemoryStatus(){
 const status=state.memoryStatus||state.companion?.memoryStatus;
 const issue=status?.error||status?.errors?.[0]?.message||status?.errors?.[0]?.detail;
 $('memory-retry-panel').hidden=!issue||!state.scope;
 $('memory-retry-message').textContent=issue?`记忆整理暂未完成，已保存的原始交流仍可使用。${issue}`:'';
 $('memory-retry').disabled=memoryRetryPending||!!status?.busy||!!state.assistantBusy||!state.modelConsent;
 $('memory-retry').textContent=memoryRetryPending||status?.busy?'正在重新整理…':'重试整理记忆';
 if(!state.scope){$('memory-status').textContent='';return}
 if(!status){$('memory-status').textContent='背景随当前好友分别保存。';return}
 const phase=status.phase||status.status,labels={idle:'已保存的背景可用于继续讨论',running:'正在整理新的交流',pending:'有新的交流等待整理',error:'记忆整理暂未完成',ready:'记忆已更新',complete:'记忆已更新'};
 const pending=status.pendingCount??status.pending,count=Number.isFinite(pending)?` · ${pending} 条待整理`:'';
 $('memory-status').textContent=`${status.message||labels[phase]||(status.busy?'正在整理新的交流':pending?'新的背景已保存，等待整理':'已保存的背景可用于继续讨论')}${count}${issue?' · 上次整理未完成，可在记忆面板重试':''}`;
}
function renderActionPanels(companion){
 const pending=companion.pendingActions||[],receipts=(companion.actionReceipts||[]).slice(-5),key=JSON.stringify([pending,receipts]);if(key===actionPanelKey)return;actionPanelKey=key;
 const expected=scopeKey,epoch=historyEpoch,list=document.createDocumentFragment(),done=document.createDocumentFragment(),receiptCards=[];
 for(const item of pending){const card=document.createElement('article');card.className='pending-action';card.dataset.actionId=item.id;
  card.append(paragraph(item.label||'确认这次记忆调整','state-heading'),paragraph(item.reason||'请确认具体内容。','muted'),paragraph(item.preview||item.action?.text||''));
  if(item.action?.use==='draft')card.append(paragraph('确认后，这条内容可按话题用于写给她的参考表达。','muted'));
  const row=document.createElement('div');row.className='note-actions';for(const [label,decision] of [['确认这一项','confirm'],['不用修改','dismiss']])row.append(button(label,async()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;await companionAction('/api/confirm-action',{id:item.id,decision})},decision==='confirm'?'secondary':'text-button'));
  card.append(row);list.append(card);
 }
 for(const receipt of receipts){const card=document.createElement('div');card.className='action-receipt';card.dataset.receiptId=receipt.id;
  card.append(paragraph(receipt.status==='undone'?'已撤销这次修改':receipt.status==='rejected'?`未修改：${receipt.reason}`:`已按你的意思${receipt.label||'记下'}`,'muted'));
  if(receipt.status==='applied'&&receipt.text)card.append(paragraph(receipt.text));
  if(receipt.evidenceQuote){const details=document.createElement('details'),title=document.createElement('summary');title.textContent='依据你的这句话';details.append(title,paragraph(receipt.evidenceQuote,'muted'));card.append(details)}
  if(receipt.undo&&receipt.status==='applied')card.append(button('撤销这次修改',async()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;await companionAction('/api/undo-action',{id:receipt.id})}));
  receiptCards.push(card);
 }
 if(receiptCards.length)done.append(receiptCards.at(-1));
 if(receiptCards.length>1){const earlier=document.createElement('details');earlier.className='earlier-actions';const title=document.createElement('summary');title.textContent=`更早的记录修改（${receiptCards.length-1}）`;earlier.append(title,...receiptCards.slice(0,-1));done.append(earlier)}
 $('pending-actions').replaceChildren(list);$('action-receipts').replaceChildren(done);
}
function resetNoteForm(){$('note-form').reset();$('note-id').value='';$('note-cancel').hidden=true;$('note-save').textContent='保存近况'}
function renderNotes(notes){
 const available=new Set(notes.filter(note=>note.use==='draft').map(note=>note.id));draftMaterialIds=new Set([...draftMaterialIds].filter(id=>available.has(id)));
 const notesKey=JSON.stringify(notes);if(notesKey===assistantNotesKey)return;assistantNotesKey=notesKey;
 const list=document.createDocumentFragment(),materials=document.createDocumentFragment(),expected=scopeKey,epoch=historyEpoch;
 if(available.size)materials.append(paragraph('已允许分享的内容会按当前话题选取。勾选可指定重点，也可以直接在对话中说明。','muted'));
 for(const note of notes){const card=document.createElement('article');card.className='note-card';card.dataset.noteId=note.id;
  card.append(paragraph(note.text),paragraph(`${note.kind==='preference'?'表达偏好 · ':''}${({discussion:'仅供私下讨论',draft:'允许按本次话题用于参考表达',disabled:'本机保留，暂不提供给模型'})[note.use]||'仅供私下讨论'}`,'muted'));
  const actions=document.createElement('div');actions.className='note-actions';actions.append(button('编辑',()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;$('note-id').value=note.id;$('note-text').value=note.text;$('note-use').value=note.use;$('note-cancel').hidden=false;$('note-save').textContent='保存修改';$('note-editor').open=true;$('note-text').focus()}),button('删除',async()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;if(confirm('删除这条近况及依赖它的助手内容？')){const result=await companionAction('/api/note-delete',{id:note.id});if(result&&$('note-id').value===note.id)resetNoteForm()}}));card.append(actions);list.append(card);
  if(note.use==='draft'){const label=document.createElement('label');label.className='toggle material-choice';const check=document.createElement('input');check.type='checkbox';check.value=note.id;check.checked=draftMaterialIds.has(note.id);check.onchange=()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;if(check.checked)draftMaterialIds.add(note.id);else draftMaterialIds.delete(note.id)};label.append(check,document.createTextNode(note.text));materials.append(label)}
 }
 $('notes-list').replaceChildren(list);$('draft-materials').replaceChildren(materials);$('draft-materials').hidden=!available.size;$('draft-material-panel').hidden=!available.size;
}
function renderCurrentState(current){
 const key=`${historyKey}:${JSON.stringify(current||null)}`;if(key===assistantStateKey)return;assistantStateKey=key;const fragment=document.createDocumentFragment();
 if(current){fragment.append(paragraph('助手目前的理解','state-heading'));
  if(current.possiblyStale)fragment.append(paragraph('有新的信息尚未整理，以下理解可能需要更新。','muted'));
  if(current.focus)fragment.append(paragraph(`当下关注：${current.focus}`));
  for(const [label,items] of [['已记住',(current.items||[])],['未完的话题',(current.openThreads||[]).filter(item=>item.status!=='closed')]])for(const item of items){const row=document.createElement('div');row.className='state-item';row.append(paragraph(`${label}：${item.text}`));if(item.sourceIds?.length){const sources=document.createElement('details'),title=document.createElement('summary');title.textContent='查看参考来源';sources.append(title,...item.sourceIds.map(id=>paragraph(sourceDescription(id),'muted')));row.append(sources)}fragment.append(row)}
  for(const unknown of current.unknowns||[])fragment.append(paragraph(`还不清楚：${typeof unknown==='string'?unknown:unknown.text}`,'muted'));
 }
 $('state-summary').replaceChildren(fragment);
}
function sourceDescription(sourceId){
 const split=sourceId.indexOf(':'),kind=sourceId.slice(0,split),id=sourceId.slice(split+1);let item,label;
 if(kind==='qq'){item=(historyMessages.length?historyMessages:state.messages).find(message=>message.messageId===id);label=item?.direction==='outgoing'?'我在 QQ 说':'对方在 QQ 说'}
 else if(kind==='private'){item=state.companion?.turns.find(turn=>turn.id===id);label='我向助手说明'}
 else if(kind==='note'){item=state.companion?.notes.find(note=>note.id===id);label='我补充的背景'}
 return item?`${label}：${item.text}\n来源：${sourceId}`:`来源 ${sourceId}（当前列表尚未载入原文）`;
}
async function submitAssistant(purpose,options={}){
 if(assistantPending||state?.assistantBusy)return;const input=$('assistant-input'),original=input.value,epoch=historyEpoch;
 const text=options.text||original.trim()||(purpose==='review'?'帮我回顾最近的互动，哪些有依据，哪些还不清楚？':'');
 if(!text){companionError(purpose==='draft'?'请先写下这次愿意向她表达的内容。':'可以先说一点近况或正在犹豫的事。');input.focus();return}
 $('assistant-tools').open=false;showWorkspace('discussion');assistantPending=true;renderCompanion();const result=await companionAction('/api/assistant',{...options,text,purpose,sourceTurnIds:options.sourceTurnIds||(selectedDiscussion?[selectedDiscussion]:[]),materialIds:purpose==='draft'?[...draftMaterialIds]:[]});
 if(epoch!==historyEpoch)return;assistantPending=false;if(result&&input.value===original){input.value='';selectedDiscussion=null;input.placeholder='直接说近况、想法或正在犹豫的事情…'}renderCompanion();
}
function initializeCompanion(){
 $('memory-retry').onclick=async()=>{if(memoryRetryPending||!state.scope)return;const epoch=historyEpoch;memoryRetryPending=true;renderMemoryStatus();await companionAction('/api/memory-maintain',{});if(epoch!==historyEpoch)return;memoryRetryPending=false;renderMemoryStatus()};
 $('assistant-form').onsubmit=e=>{e.preventDefault();submitAssistant('discussion')};$('assistant-draft').onclick=()=>submitAssistant('draft');$('assistant-review').onclick=()=>submitAssistant('review');
 $('assistant-input').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();submitAssistant('discussion')}};
 $('memory-search-form').onsubmit=async e=>{e.preventDefault();const query=$('memory-query').value.trim(),expected=scopeKey,epoch=historyEpoch,version=++memorySearchVersion;if(!query)return;
  $('memory-search-status').textContent='正在查找以前的交流…';
  try{const result=await(await api('/api/memory-search',{query,...scopeArgs()})).json();if(expected!==scopeKey||epoch!==historyEpoch||version!==memorySearchVersion)return;
   const matches=result.results||result.sources||[],fragment=document.createDocumentFragment();
   for(const item of matches){const record=item.source||item,sourceId=record.sourceId||item.sourceId||record.id,text=record.text||item.text||'';const card=document.createElement('article');card.className='memory-result';card.dataset.sourceId=sourceId||'';
    const at=record.occurredAt||record.createdAt||record.at;card.append(paragraph(text),paragraph(`${record.kind||record.type||'来源'}${at?` · ${new Date(at).toLocaleString('zh-CN')}`:''}`,'muted'));
    const actions=document.createElement('div');actions.className='note-actions';actions.append(button('围绕这件事继续',()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;selectedDiscussion=sourceId?.startsWith('private:')?sourceId.slice(8):null;attachDiscussionContext(`结合之前这件事「${text}」，`)}),button('更正或忘记',()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;attachDiscussionContext(`关于这条背景「${text}」，`);$('assistant-status').textContent='直接补充更正后的内容，或说明不再使用这一条。'}));card.append(actions);fragment.append(card);
   }
   $('memory-results').replaceChildren(fragment);memoryResultsRevision=state.companion?.revision;$('memory-search-status').textContent=matches.length?`找到 ${matches.length} 条相关来源；可以直接继续讨论或更正。`:'没有找到相关来源。可以换个描述，或直接告诉助手缺失的背景。';
  }catch(err){if(expected===scopeKey&&epoch===historyEpoch&&version===memorySearchVersion)$('memory-search-status').textContent=err.message}
 };
 $('goal-input').oninput=()=>{goalDirty=true};$('goal-form').onsubmit=async e=>{e.preventDefault();const text=$('goal-input').value,epoch=historyEpoch;const result=await companionAction('/api/goal',{text});if(result&&epoch===historyEpoch&&$('goal-input').value===text){goalDirty=false;$('goal-input').value=result.companion?.goal?.text||''}};
 $('note-cancel').onclick=resetNoteForm;$('note-form').onsubmit=async e=>{e.preventDefault();const values={id:$('note-id').value||undefined,text:$('note-text').value,use:$('note-use').value},epoch=historyEpoch;if(!values.text.trim()){companionError('先写一点想记住的内容。');return}const result=await companionAction('/api/note',values);if(result&&epoch===historyEpoch&&$('note-id').value===(values.id||'')&&$('note-text').value===values.text&&$('note-use').value===values.use)resetNoteForm()};
 $('feedback-cancel').onclick=()=>{$('feedback-form').hidden=true};$('feedback-form').onsubmit=async e=>{e.preventDefault();const requestId=$('feedback-request-id').value,text=$('feedback-text').value,epoch=historyEpoch;if(!text.trim()){companionError('写一点具体感受，方便下次继续讨论。');return}const result=await companionAction('/api/feedback',{requestId,text});if(result&&epoch===historyEpoch&&$('feedback-request-id').value===requestId&&$('feedback-text').value===text){$('feedback-form').reset();$('feedback-form').hidden=true;$('assistant-status').textContent='反馈已记下。你也可以继续讨论想怎样调整。'}};
 $('assistant-context-button').onclick=async()=>{const epoch=historyEpoch,expected=scopeKey,version=++assistantContextVersion;try{const data=await(await api('/api/assistant-context')).json();if(epoch!==historyEpoch||scopeKey!==expected||version!==assistantContextVersion||data.scope&&keyOf(data.scope)!==expected)return;
   $('assistant-context-records').replaceChildren();const run=data.run||data.latestRun||data.manifest&&data||null;
   $('assistant-context-summary').textContent=run?'以下是最近一次助手请求实际使用的参考内容，可核对哪些背景被采用。':'这个好友还没有可查看的助手请求。先开始一次讨论。';
   if(run){const container=$('assistant-context-records'),payload=run.payload||{},sources=payload.sources||[];
    if(payload.goal)container.append(paragraph('关系目标','state-heading'),paragraph(payload.goal));
    if(payload.userRequest?.text)container.append(paragraph('这次想商量的事','state-heading'),paragraph(payload.userRequest.text));
    const sourceGroups=[['QQ 交流',sources.filter(source=>source.type==='qq')],['私下讨论与背景',sources.filter(source=>source.type!=='qq')],['这次用于表达的素材',payload.outboundQuotes||[]]];
    for(const [label,records]of sourceGroups){if(!records.length)continue;const details=document.createElement('details'),summary=document.createElement('summary');details.className='context-sources';summary.textContent=`${label} · ${records.length} 条`;details.append(summary);for(const source of records){const text=paragraph(source.text||'');if(source.speaker)text.prepend(document.createTextNode(`${source.speaker}：`));details.append(text)}container.append(details)}
    const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='技术详情与完整请求';pre.textContent=JSON.stringify(run,null,2);details.append(summary,pre);container.append(details)
   }$('assistant-context-dialog').showModal();
  }catch(e){if(epoch===historyEpoch&&version===assistantContextVersion)companionError(`参考内容：${e.message}`)}};
 $('assistant-context-close').onclick=()=>{$('assistant-context-dialog').close();assistantContextVersion++};
}
initializeCompanion();
api('/api/methods').then(response=>response.json()).then(result=>{helpingMethods=new Map((result.methods||[]).map(method=>[method.id,method]));assistantThreadKey='';if(state)renderCompanion()}).catch(()=>{});
async function action(path,args){localError='';try{render(await(await api(path,args)).json());return true}catch(e){error(e.message);return false}}
$('contact-form').onsubmit=async e=>{e.preventDefault();if(await action('/api/bind',{uin:$('qq-number').value.trim()})){$('contact-dialog').close();showWorkspace('discussion',true)}};
$('generate').onclick=async()=>{$('assistant-tools').open=false;showWorkspace('discussion');if(await saveOptions())await action('/api/suggest',{})};
$('allow-model').onclick=()=>action('/api/consent',{allow:true,accountUid:state.scope?.accountUid,peerUin:state.scope?.peerUin,baseUrl:state.modelBaseUrl,model:state.model,allowImages:$('allow-images').checked});
$('older').onclick=()=>action('/api/older',{});$('retry-history').onclick=()=>action('/api/bind',{uin:state.scope.peerUin});$('view-older').onclick=showEarlier;
function renderReplyFocus(){
 const focus=state.replyFocus||{mode:'recent',messageIds:[]},selected=focus.mode==='selected';
 $('focus-summary').textContent=selected?`已指定 ${focus.messageIds.length} 条回复重点`:focus.messageIds.length?`合并回应最近 ${focus.messageIds.length} 条对方消息`:'当前没有待回应的新消息，可选择旧消息补充回复';
 const latest=(state.messages||[]).filter(message=>!message.recalled).at(-1);const preview=$('qq-context-preview');preview.hidden=!state.scope||!latest;preview.textContent=selected?`已选 ${focus.messageIds.length} 条 QQ 记录作为回复重点 · 查看` : latest?`最近 QQ · ${latest.direction==='outgoing'?'我':'对方'}：${latest.text||'[消息]'} `:'';
 $('clear-focus').hidden=!selected;const list=document.createDocumentFragment(),records=historyMessages.length?historyMessages:state.messages;
 if(selected)for(const id of focus.messageIds){const m=records.find(m=>m.messageId===id),p=document.createElement('p');p.textContent=m?`${m.direction==='outgoing'?'我':'对方'}：${m.text.slice(0,120)}`:`消息 ${id}`;list.append(p)}$('focus-preview').replaceChildren(list);
}
$('clear-focus').onclick=()=>{replySelection=[];saveOptions()};
$('history').onscroll=()=>{if($('history').scrollTop<24)showEarlier()};
const saveOptions=()=>action('/api/options',{instruction:$('instruction').value,auto:$('auto').checked,images:imageSelection,replyMessageIds:replySelection,accountUid:state?.scope?.accountUid,peerUid:state?.scope?.peerUid});$('instruction').onchange=saveOptions;$('auto').onchange=saveOptions;
$('draft').oninput=()=>{if(!$('draft').value.trim())draftOrigin=null;saveDraft();$('draft-status').textContent='你的修改会保留'};$('copy').onclick=()=>copyText($('draft').value);
$('fill-qq').onclick=async()=>{try{
 const requestedScope=scopeKey,args={accountUid:state.scope.accountUid,peerUin:state.scope.peerUin,text:$('draft').value};
 const desktop=await(await api('/api/desktop')).json();
 if(requestedScope!==scopeKey)throw new Error('会话已切换，已取消这次回填');
 if(!desktop.matchingWindows)throw new Error('请在对应好友的 QQ 私聊窗口点击「✦ AI 建议」再试；未确认当前输入框');
 let result=await(await api('/api/draft',args)).json();
 if(result.requiresReplace&&confirm('QQ 输入框已有未发送文字，是否替换？')){
  if(requestedScope!==scopeKey)throw new Error('会话已切换，已取消这次回填');
  result=await(await api('/api/draft',{...args,replace:true})).json();
 }
 if(result.inserted&&requestedScope===scopeKey)$('draft-status').textContent='已填入 QQ，由你检查并发送';
}catch(e){error(e.message)}};
async function exportHistory(format){try{const response=await api(`/api/export?format=${format}`),url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=`QQ-${state.scope.peerUin}.${format}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),2000)}catch(e){error(e.message)}}
$('export-json').onclick=()=>exportHistory('json');$('export-txt').onclick=()=>exportHistory('txt');
let profiles=[],quickModelKey='',quickModelVersion=0,settingsModelVersion=0,settingsOpenVersion=0;
$('settings-advanced').ontoggle=()=>{$('quick-profile').disabled=$('settings-advanced').open;$('quick-model').disabled=$('settings-advanced').open;};
function option(value,label,disabled=false){const item=document.createElement('option');item.value=value;item.textContent=label;item.disabled=disabled;return item}
function fillModels(select,models,current,manual=false){
 const fragment=document.createDocumentFragment();
 if(manual)fragment.append(option('','选择模型，或在下方手动填写'));
 if(current&&!models.some(m=>m.id===current))fragment.append(option(current,current));
 for(const m of models)fragment.append(option(m.id,m.id+(m.imageGeneration?'（图片生成）':''),m.imageGeneration));
 select.replaceChildren(fragment);select.value=current||'';
}
function syncModelPicker(){
 const key=`${state.activeModelProfileId}:${state.modelBaseUrl}`;
 if(key!==quickModelKey){quickModelKey=key;fillModels($('quick-model'),[],state.model);refreshQuickModels()}
 else if([...$('quick-model').options].some(o=>o.value===state.model))$('quick-model').value=state.model;
 else {$('quick-model').append(option(state.model,state.model));$('quick-model').value=state.model;}
}
async function refreshQuickModels(){
 const version=++quickModelVersion,profileId=state?.activeModelProfileId,key=quickModelKey;
 $('model-list-status').textContent='正在读取服务的模型列表…';
 try{
  const metadata=await(await api('/api/model-profiles')).json();
  if(version!==quickModelVersion||key!==quickModelKey)return;
  profiles=metadata.profiles;$('quick-profile').replaceChildren(...profiles.map(p=>option(p.id,p.name)));$('quick-profile').value=metadata.activeProfileId;
  const result=await(await api('/api/models',{profileId})).json();
  if(version!==quickModelVersion||key!==quickModelKey)return;
  fillModels($('quick-model'),result.models,state.model);
  $('model-list-status').textContent=`服务返回 ${result.models.length} 个模型 ID；实际可用性以服务权限为准。`;
 }catch(e){if(version===quickModelVersion&&key===quickModelKey)$('model-list-status').textContent=e.message+'；可到模型设置中手动填写。'}
}
$('refresh-models').onclick=refreshQuickModels;
async function selectQuickModel(args){if(!await action('/api/model-selection',args))return;const version=settingsOpenVersion;try{const metadata=await(await api('/api/model-profiles')).json();if(version!==settingsOpenVersion||!$('settings').open)return;profiles=metadata.profiles;$('settings-profile').replaceChildren(...profiles.map(p=>option(p.id,p.name)),option('new','＋ 新增 API 配置'));populateProfile(metadata.activeProfileId)}catch(e){settingsError(e.message)}}
$('quick-profile').onchange=()=>selectQuickModel({profileId:$('quick-profile').value});
$('quick-model').onchange=()=>selectQuickModel({profileId:state.activeModelProfileId,model:$('quick-model').value});
function settingsError(message=''){$('settings-error').textContent=message;$('settings-error').hidden=!message}
function resetSettingsModels(){settingsModelVersion++;fillModels($('settings-model-list'),[],$('settings-form').elements.model.value,true);$('settings-model-status').textContent='可读取列表，也可手动填写模型 ID。'}
function populateProfile(id){
 const f=$('settings-form').elements,p=profiles.find(p=>p.id===id);
 f.profileId.value=id;f.name.value=p?.name||'';f.baseUrl.value=p?.baseUrl||'';f.model.value=p?.model||'';
 f.apiKey.value='';f.anonymous.checked=!!p?.anonymous;f.apiKey.disabled=!!p?.anonymous;f.visionEnabled.checked=!!p?.visionEnabled;
 f.apiKey.placeholder=p?.hasKey?'原地址留空保留密钥；新地址需重新填写':'请填写此服务的 API Key';
 settingsError();resetSettingsModels();
}
$('settings-button').onclick=async()=>{
 const version=++settingsOpenVersion,f=$('settings-form').elements;
 f.model.value=state?.model||'';f.baseUrl.value=state?.modelBaseUrl||'';f.visionEnabled.checked=!!state?.modelVisionEnabled;f.apiKey.value='';settingsError();
 $('settings').showModal();
 try{const result=await(await api('/api/model-profiles')).json();if(version!==settingsOpenVersion||!$('settings').open)return;
  profiles=result.profiles;$('settings-profile').replaceChildren(...profiles.map(p=>option(p.id,p.name)),option('new','＋ 新增 API 配置'));populateProfile(result.activeProfileId);
 }catch(e){settingsError(e.message)}
};
const closeSettings=()=>{settingsOpenVersion++;settingsModelVersion++;$('settings-form').elements.apiKey.value='';$('settings').close()};$('settings-cancel').onclick=closeSettings;$('settings-close').onclick=closeSettings;$('settings').addEventListener('cancel',closeSettings);
$('settings-profile').onchange=()=>populateProfile($('settings-profile').value);
for(const name of ['baseUrl','apiKey','anonymous'])$('settings-form').elements[name].addEventListener('input',()=>{resetSettingsModels();$('settings-form').elements.apiKey.disabled=$('settings-form').elements.anonymous.checked});
$('settings-form').elements.model.addEventListener('input',()=>{$('settings-form').elements.visionEnabled.checked=false});
$('settings-model-list').onchange=()=>{if($('settings-model-list').value){$('settings-form').elements.model.value=$('settings-model-list').value;$('settings-form').elements.visionEnabled.checked=false}};
$('settings-refresh-models').onclick=async()=>{
 const version=++settingsModelVersion,f=$('settings-form').elements;
 $('settings-model-status').textContent='正在读取…';settingsError();
 try{const result=await(await api('/api/models',{profileId:f.profileId.value,baseUrl:f.baseUrl.value,apiKey:f.apiKey.value,anonymous:f.anonymous.checked})).json();
  if(version!==settingsModelVersion||!$('settings').open)return;fillModels($('settings-model-list'),result.models,f.model.value,true);$('settings-model-status').textContent=`已读取 ${result.models.length} 个模型 ID；图片能力请按服务说明确认。`;
 }catch(e){if(version===settingsModelVersion)settingsError(e.message)}
};
$('settings-form').onsubmit=async e=>{
 e.preventDefault();const f=e.target.elements;settingsError();
 try{const result=await(await api('/api/settings',{...Object.fromEntries(new FormData(e.target)),anonymous:f.anonymous.checked,visionEnabled:f.visionEnabled.checked})).json();
  settingsModelVersion++;f.apiKey.value='';$('settings').close();render(result);refreshQuickModels();
 }catch(err){settingsError(err.message)}
};
$('context-button').onclick=()=> $('assistant-context-button').click();$('context-close').onclick=()=>$('context-dialog').close();
async function poll(){if(polling)return;polling=true;try{render(await(await api('/api/state')).json())}catch(e){error(e.message)}finally{polling=false}}poll();setInterval(poll,1000);
