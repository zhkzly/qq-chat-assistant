'use strict';
const $ = id => document.getElementById(id);
const suppliedToken=location.hash.slice(1);
if(suppliedToken)sessionStorage.setItem('qq-assistant-token',suppliedToken);
const token=suppliedToken||sessionStorage.getItem('qq-assistant-token')||'';
history.replaceState(null,'',location.pathname);
let state=null,scopeKey='',lastAdvice='',polling=false,historyKey='',historyMessages=[],visibleCount=100,historyVersion='',loadingHistory=false,historyEpoch=0,imageSelection=[],imageBlobs=new Map(),localError='',consentKey='',replySelection=[];
let assistantPending=false,assistantLocalError='',assistantThreadKey='',assistantNotesKey='',assistantStateKey='',goalVersion='',goalDirty=false,assistantContextVersion=0,draftMaterialIds=new Set(),draftOrigin=null;
async function api(path,args) {
 const response=await fetch(path,{method:args===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(args===undefined?{}:{'Content-Type':'application/json'})},body:args===undefined?undefined:JSON.stringify(args)});
 if(!response.ok){const p=await response.json();throw new Error(p.error||`HTTP ${response.status}`)}return response;
}
function error(message){if(message)localError=message;const shown=state?.error||localError;$('error').textContent=shown;$('error').hidden=!shown}
function keyOf(scope){return scope?`${scope.accountUid}/${scope.peerUid}`:''}
function saveDraft(){if(scopeKey){localStorage.setItem(`draft:${scopeKey}`,$('draft').value);if(draftOrigin)localStorage.setItem(`draft-origin:${scopeKey}`,draftOrigin);else localStorage.removeItem(`draft-origin:${scopeKey}`)}}
function adopt(text,origin=null){$('draft').value=text;draftOrigin=origin;saveDraft();$('draft-status').textContent='已放入草稿，可修改';$('draft').focus()}
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
 if(keepAnchor)pane.scrollTop=previousTop+pane.scrollHeight-previousHeight;else if(atEnd)pane.scrollTop=pane.scrollHeight;else pane.scrollTop=previousTop;
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
  $('draft').value=key?(localStorage.getItem(`draft:${key}`)||sessionStorage.getItem(`draft:${key}`)||''):'';draftOrigin=key?localStorage.getItem(`draft-origin:${key}`):null;if(key)saveDraft();$('draft-status').textContent='可自由修改';lastAdvice=null;resetCompanion();}
 if(state&&(state.model!==next.model||state.modelBaseUrl!==next.modelBaseUrl||state.activeModelProfileId!==next.activeModelProfileId)){imageSelection=[];historyVersion=''}
 replySelection=next.replyFocus?.mode==='selected'?[...next.replyFocus.messageIds]:[];
 imageSelection=[...(next.imageSelection||[])];
 state=next;syncModelPicker();renderReplyFocus();renderCompanion();if(document.activeElement!==$('auto'))$('auto').checked=next.auto;const ready=next.status.phase==='ready';
 $('connection-dot').classList.toggle('ready',ready);
 $('connection-label').textContent=ready?`已连接 QQ ${next.status.account.uin} · 只读监听`:({waiting_qq:'等待 QQ 客户端启动',waiting_login:'请在 QQ 窗口完成登录',initializing:'正在读取 QQ 账号…',offline:'QQ 已离线，请重新登录',integration_error:'QQ 接入未就绪，请查看诊断'}[next.status.phase]||next.status.phase);
 $('session').hidden=!next.scope;
 $('model-label').textContent=next.modelReady?next.model:'尚未配置模型';$('current-model').textContent=next.model||'未配置';$('current-api').textContent=next.modelBaseUrl||'未配置 API';
 $('generate').disabled=!next.scope||next.busy||!next.modelConsent;
 $('model-consent').hidden=!next.scope||(!!next.modelConsent&&(!imageSelection.length||next.imageConsent));
 const nextConsentKey=`${scopeKey}:${next.model}:${next.modelBaseUrl}`;if(nextConsentKey!==consentKey){consentKey=nextConsentKey;$('allow-images').checked=!!next.imageConsent;}else if(next.imageConsent)$('allow-images').checked=true;
 $('fill-qq').disabled=!next.qqDraftFillAvailable;
 $('fill-qq').title=next.qqDraftFillAvailable?'只填入，不发送':'需要重启 QQ 加载新版插件；复制按钮可直接使用';$('consent-destination').textContent=`所选好友：${next.scope?.peerUin||''} · 模型：${next.model} · API：${next.modelBaseUrl}`;
 $('generate').textContent=next.busy?'正在想回复…':'生成建议 ↗';$('older').disabled=next.historyBusy;$('older').textContent=next.historyBusy?'正在读取…':'从 QQ 读取更早记录';
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
 for(const id of ['assistant-send','assistant-draft','assistant-review'])$(id).disabled=!available||busy;
 $('assistant-context-button').disabled=!state.scope;$('assistant-input').disabled=!state.scope;
 $('assistant-status').textContent=!state.scope?'先连接一个私聊，这里的讨论会跟随当前好友保存。':busy?'正在结合你提供的内容一起想…':!state.modelConsent?'先在上方允许当前会话使用所选模型，之后就可以开始讨论。':'讨论会在本机保留；草稿、复制和填入输入框都不算已经发送。';
 companionError(assistantLocalError);
 const turns=companion.turns||[],threadKey=JSON.stringify(turns);
 if(state.companion&&draftOrigin&&!turns.some(turn=>turn.id===draftOrigin)){draftOrigin=null;$('draft').value='';saveDraft();$('draft-status').textContent='原来的参考内容已更新或删除，关联草稿已清除';sessionStorage.removeItem(`draft:${scopeKey}`)}
 if($('feedback-request-id').value&&!turns.some(turn=>turn.requestId===$('feedback-request-id').value)){$('feedback-form').reset();$('feedback-form').hidden=true}
 if(threadKey!==assistantThreadKey){assistantThreadKey=threadKey;const pane=$('assistant-thread'),atEnd=pane.scrollHeight-pane.scrollTop-pane.clientHeight<60,oldTop=pane.scrollTop,fragment=document.createDocumentFragment(),expected=scopeKey,epoch=historyEpoch;
  for(const turn of turns){const article=document.createElement('article');article.className=`assistant-turn ${turn.role==='user'?'user':'assistant'}`;article.dataset.turnId=turn.id;
   const head=document.createElement('div');head.className='turn-heading';const who=document.createElement('strong');who.textContent=turn.role==='user'?'我 · 私下讨论':'助手';
   const remove=button('删除',async()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;if(confirm('删除这条私下讨论及依赖它的助手内容？QQ 消息不会删除。'))await companionAction('/api/turn-delete',{id:turn.id})});remove.setAttribute('aria-label',`删除${turn.role==='user'?'我的讨论':'助手回复'}`);head.append(who,remove);article.append(head,paragraph(turn.text||'','turn-text'));
   for(const suggestion of turn.suggestions||[]){const card=document.createElement('div');card.className='assistant-suggestion';card.append(paragraph(suggestion.style||'参考表达','muted'),paragraph(suggestion.text||''));card.append(button('采用到草稿',()=>{if(expected===scopeKey&&epoch===historyEpoch)adopt(suggestion.text,turn.id)}));article.append(card)}
   if(turn.role==='assistant'&&turn.requestId){const feedback=button('告诉助手哪儿有帮助或不合适',()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;$('feedback-request-id').value=turn.requestId;$('feedback-text').value='';$('feedback-form').hidden=false;$('feedback-text').focus()});article.append(feedback)}
   fragment.append(article);
  }
  if(!turns.length)fragment.append(paragraph(state.scope?'不必先想好目的。可以先说说今天发生了什么，或贴着当前 QQ 对话一起理清。':'选择好友后，从你正在犹豫的那件事开始。','assistant-empty'));
  pane.replaceChildren(fragment);pane.scrollTop=atEnd?pane.scrollHeight:oldTop;
 }
 const currentGoalVersion=`${companion.goal?.version||0}:${companion.goal?.text||''}`;
 if(currentGoalVersion!==goalVersion){goalVersion=currentGoalVersion;if(!goalDirty)$('goal-input').value=companion.goal?.text||''}
 for(const formId of ['goal-form','note-form'])for(const element of $(formId).elements)element.disabled=!state.scope;
 renderNotes(companion.notes||[]);renderCurrentState(companion.state);
}
function resetNoteForm(){$('note-form').reset();$('note-id').value='';$('note-cancel').hidden=true;$('note-save').textContent='保存近况'}
function renderNotes(notes){
 const available=new Set(notes.filter(note=>note.use==='draft').map(note=>note.id));draftMaterialIds=new Set([...draftMaterialIds].filter(id=>available.has(id)));
 const notesKey=JSON.stringify(notes);if(notesKey===assistantNotesKey)return;assistantNotesKey=notesKey;
 const list=document.createDocumentFragment(),materials=document.createDocumentFragment(),expected=scopeKey,epoch=historyEpoch;
 if(available.size)materials.append(paragraph('这次写给她时，可以使用哪些近况？未勾选的内容只留作背景。','muted'));
 for(const note of notes){const card=document.createElement('article');card.className='note-card';card.dataset.noteId=note.id;
  card.append(paragraph(note.text),paragraph(({discussion:'仅供私下讨论',draft:'允许用于参考表达；每次需勾选',disabled:'本机保留，暂不提供给模型'})[note.use]||'仅供私下讨论','muted'));
  const actions=document.createElement('div');actions.className='note-actions';actions.append(button('编辑',()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;$('note-id').value=note.id;$('note-text').value=note.text;$('note-use').value=note.use;$('note-cancel').hidden=false;$('note-save').textContent='保存修改';$('note-text').focus()}),button('删除',async()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;if(confirm('删除这条近况及依赖它的助手内容？')){const result=await companionAction('/api/note-delete',{id:note.id});if(result&&$('note-id').value===note.id)resetNoteForm()}}));card.append(actions);list.append(card);
  if(note.use==='draft'){const label=document.createElement('label');label.className='toggle material-choice';const check=document.createElement('input');check.type='checkbox';check.value=note.id;check.checked=draftMaterialIds.has(note.id);check.onchange=()=>{if(expected!==scopeKey||epoch!==historyEpoch)return;if(check.checked)draftMaterialIds.add(note.id);else draftMaterialIds.delete(note.id)};label.append(check,document.createTextNode(note.text));materials.append(label)}
 }
 $('notes-list').replaceChildren(list);$('draft-materials').replaceChildren(materials);$('draft-materials').hidden=!available.size;
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
async function submitAssistant(purpose){
 if(assistantPending||state?.assistantBusy)return;const input=$('assistant-input'),original=input.value,epoch=historyEpoch;
 const text=original.trim()||(purpose==='review'?'帮我回顾最近的互动，哪些有依据，哪些还不清楚？':'');
 if(!text){companionError(purpose==='draft'?'请先写下这次愿意向她表达的内容。':'可以先说一点近况或正在犹豫的事。');input.focus();return}
 assistantPending=true;renderCompanion();const result=await companionAction('/api/assistant',{text,purpose,materialIds:purpose==='draft'?[...draftMaterialIds]:[]});
 if(epoch!==historyEpoch)return;assistantPending=false;if(result&&input.value===original)input.value='';renderCompanion();
}
function initializeCompanion(){
 $('assistant-form').onsubmit=e=>{e.preventDefault();submitAssistant('discussion')};$('assistant-draft').onclick=()=>submitAssistant('draft');$('assistant-review').onclick=()=>submitAssistant('review');
 $('assistant-input').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();submitAssistant('discussion')}};
 $('goal-input').oninput=()=>{goalDirty=true};$('goal-form').onsubmit=async e=>{e.preventDefault();const text=$('goal-input').value,epoch=historyEpoch;const result=await companionAction('/api/goal',{text});if(result&&epoch===historyEpoch&&$('goal-input').value===text){goalDirty=false;$('goal-input').value=result.companion?.goal?.text||''}};
 $('note-cancel').onclick=resetNoteForm;$('note-form').onsubmit=async e=>{e.preventDefault();const values={id:$('note-id').value||undefined,text:$('note-text').value,use:$('note-use').value},epoch=historyEpoch;if(!values.text.trim()){companionError('先写一点想记住的内容。');return}const result=await companionAction('/api/note',values);if(result&&epoch===historyEpoch&&$('note-id').value===(values.id||'')&&$('note-text').value===values.text&&$('note-use').value===values.use)resetNoteForm()};
 $('feedback-cancel').onclick=()=>{$('feedback-form').hidden=true};$('feedback-form').onsubmit=async e=>{e.preventDefault();const requestId=$('feedback-request-id').value,text=$('feedback-text').value,epoch=historyEpoch;if(!text.trim()){companionError('写一点具体感受，方便下次继续讨论。');return}const result=await companionAction('/api/feedback',{requestId,text});if(result&&epoch===historyEpoch&&$('feedback-request-id').value===requestId&&$('feedback-text').value===text){$('feedback-form').reset();$('feedback-form').hidden=true;$('assistant-status').textContent='反馈已记下。你也可以继续讨论想怎样调整。'}};
 $('assistant-context-button').onclick=async()=>{const epoch=historyEpoch,expected=scopeKey,version=++assistantContextVersion;try{const data=await(await api('/api/assistant-context')).json();if(epoch!==historyEpoch||scopeKey!==expected||version!==assistantContextVersion||data.scope&&keyOf(data.scope)!==expected)return;
   $('assistant-context-records').replaceChildren();const run=data.run||data.latestRun||data.manifest&&data||null;
   $('assistant-context-summary').textContent=run?'以下是最近一次助手请求实际使用的参考内容，可核对哪些背景被采用。':'这个好友还没有可查看的助手请求。先开始一次讨论。';
   if(run){const pre=document.createElement('pre');pre.textContent=JSON.stringify(run,null,2);$('assistant-context-records').append(pre)}$('assistant-context-dialog').showModal();
  }catch(e){if(epoch===historyEpoch&&version===assistantContextVersion)companionError(`参考内容：${e.message}`)}};
 $('assistant-context-close').onclick=()=>{$('assistant-context-dialog').close();assistantContextVersion++};
}
initializeCompanion();
async function action(path,args){localError='';try{render(await(await api(path,args)).json());return true}catch(e){error(e.message);return false}}
$('contact-form').onsubmit=e=>{e.preventDefault();action('/api/bind',{uin:$('qq-number').value.trim()})};
$('generate').onclick=async()=>{if(await saveOptions())await action('/api/suggest',{})};
$('allow-model').onclick=()=>action('/api/consent',{allow:true,accountUid:state.scope?.accountUid,peerUin:state.scope?.peerUin,baseUrl:state.modelBaseUrl,model:state.model,allowImages:$('allow-images').checked});
$('older').onclick=()=>action('/api/older',{});$('retry-history').onclick=()=>action('/api/bind',{uin:state.scope.peerUin});$('view-older').onclick=showEarlier;
function renderReplyFocus(){
 const focus=state.replyFocus||{mode:'recent',messageIds:[]},selected=focus.mode==='selected';
 $('focus-summary').textContent=selected?`已指定 ${focus.messageIds.length} 条回复重点`:focus.messageIds.length?`合并回应最近 ${focus.messageIds.length} 条对方消息`:'当前没有待回应的新消息，可选择旧消息补充回复';
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
$('quick-profile').onchange=()=>action('/api/model-selection',{profileId:$('quick-profile').value});
$('quick-model').onchange=()=>action('/api/model-selection',{profileId:state.activeModelProfileId,model:$('quick-model').value});
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
$('settings-cancel').onclick=()=>{settingsOpenVersion++;settingsModelVersion++;$('settings-form').elements.apiKey.value='';$('settings').close()};
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
$('context-button').onclick=async()=>{try{await saveOptions();const data=await(await api('/api/context')).json();$('context-summary').textContent=`本机 ${data.total} 条，本次选取 ${data.selected} 条、${data.selectedCharacters} 字符。最近最多 60 条，相关旧记录最多 12 条；手动选中的最多 8 条优先保留，总上限 18000 字符。当前没有长期摘要或向量检索；选中图片 ${data.selectedImages?.length||0} 张，图片授权${data.imagesAllowed?'已允许':'未允许'}。`;
 const list=document.createDocumentFragment();for(const m of data.conversation){const p=document.createElement('p');p.textContent=`${m.speaker} · ${m.at}\n${m.text}`;list.append(p)}$('context-records').replaceChildren(list);$('context-dialog').showModal()}catch(e){error(`上下文预览：${e.message}`)}};$('context-close').onclick=()=>$('context-dialog').close();
async function poll(){if(polling)return;polling=true;try{render(await(await api('/api/state')).json())}catch(e){error(e.message)}finally{polling=false}}poll();setInterval(poll,1000);
