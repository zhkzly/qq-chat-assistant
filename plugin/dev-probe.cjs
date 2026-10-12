'use strict';
const fs=require('node:fs');const path=require('node:path');
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
  const saved=await contents.executeJavaScript(`(()=>{document.querySelector('#draft')?.dispatchEvent(new Event('input'));const bound=typeof state!=='undefined'?state?.scope:null;return {instruction:document.querySelector('#instruction')?.value||'',peer:bound?.peerUin||document.querySelector('#qq-number')?.value||'',accountUid:bound?.accountUid||'',draft:document.querySelector('#draft')?.value||'',privateInput:document.querySelector('#assistant-input')?.value||'',goalDraft:document.querySelector('#goal-input')?.value||'',goalDirty:typeof goalDirty!=='undefined'&&goalDirty,noteText:document.querySelector('#note-text')?.value||'',noteId:document.querySelector('#note-id')?.value||'',noteUse:document.querySelector('#note-use')?.value||'discussion'}})()`);
  if(!/^\d{5,12}$/.test(saved.peer))throw new Error('Cannot preserve helper conversation');
  const settingsPath=path.join(root,'data/settings.json'),settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
  settings.instruction=saved.instruction;fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2),{mode:0o600});
  const output=path.join(root,'data/service-refresh-result.json');
  const oldURL=fs.readFileSync(path.join(root,'data/assistant-url.txt'),'utf8').trim();
  setTimeout(async()=>{try{
   process.kill(Number(children[0]),'SIGTERM');
   for(let n=0;n<100 && fs.existsSync(`/proc/${children[0]}`);n++)await new Promise(r=>setTimeout(r,100));
   if(fs.existsSync(`/proc/${children[0]}`))throw new Error('Owned assistant worker did not stop');
   await openHelper({sender:contents},saved.peer);
   const url=fs.readFileSync(path.join(root,'data/assistant-url.txt'),'utf8').trim();
   if(!/^http:\/\/127\.0\.0\.1:17860\/#\w+$/.test(url)||url===oldURL)throw new Error('New helper URL is not ready');
   await contents.loadURL(url.replace('/#',`/?refresh=${Date.now()}#`));
   let restored=false;
   for(let n=0;n<100&&!restored;n++){
    restored=await contents.executeJavaScript(`(()=>{const bound=typeof state!=='undefined'?state?.scope:null;if(!bound||bound.peerUin!==${JSON.stringify(saved.peer)}||${JSON.stringify(saved.accountUid)}&&bound.accountUid!==${JSON.stringify(saved.accountUid)})return false;const input=document.querySelector('#assistant-input');if(input)input.value=${JSON.stringify(saved.privateInput)};if(${JSON.stringify(saved.goalDirty)}){const goal=document.querySelector('#goal-input');if(goal){goal.value=${JSON.stringify(saved.goalDraft)};goal.dispatchEvent(new Event('input'))}}if(${JSON.stringify(!!saved.noteText)}){for(const [id,value]of [['note-text',${JSON.stringify(saved.noteText)}],['note-id',${JSON.stringify(saved.noteId)}],['note-use',${JSON.stringify(saved.noteUse)}]]){const el=document.getElementById(id);if(el)el.value=value}const cancel=document.getElementById('note-cancel');if(cancel)cancel.hidden=!${JSON.stringify(!!saved.noteId)}}return true})()`);
    if(!restored)await new Promise(r=>setTimeout(r,100));
   }
   if(!restored)throw new Error('Helper restarted but scoped unsaved input restoration needs attention');
   const hash=require('node:crypto').createHash('sha256').update(saved.draft).digest('hex');
   fs.writeFileSync(output,JSON.stringify({ok:true,qqRestarted:false,draftHash:hash,peer:saved.peer,unsavedAssistantInputsPreserved:restored}),{mode:0o600});
  }catch(e){fs.writeFileSync(output,JSON.stringify({ok:false,error:e.message}),{mode:0o600});}},250);
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
  await contents.executeJavaScript(`(async()=>{document.querySelector('#draft')?.dispatchEvent(new Event('input'));await document.querySelector('#instruction')?.onchange?.()})()`);
  const url=fs.readFileSync(path.resolve(__dirname,'../data/assistant-url.txt'),'utf8').trim();
  if(!/^http:\/\/127\.0\.0\.1:17860\/#\w+$/.test(url))throw new Error('Invalid private helper URL');
  await contents.loadURL(url.replace('/#',`/?refresh=${Date.now()}#`));return {reloaded:true,qqRestarted:false,draftsPreserved:true};
 }
 if(action.action==='inspect-context-helper') {
  const contents=require('electron').webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:17860/'));
  if(!contents)return {helperPresent:false};
  const state=await contents.executeJavaScript(`(()=>({helperPresent:true,privateDiscussion:!!document.querySelector('#assistant-form'),memorySearch:!!document.querySelector('#memory-search-form'),memoryStatus:!!document.querySelector('#memory-status'),goalEditor:!!document.querySelector('#goal-form'),pendingActions:!!document.querySelector('#pending-actions'),contextInspector:!!document.querySelector('#assistant-context-dialog'),privateInputEnabled:!document.querySelector('#assistant-input')?.disabled,actualRows:document.querySelectorAll('.message').length,draft:document.querySelector('#draft')?.value||'',qqSendActionExposed:false}))()`);
  state.draftHash=require('node:crypto').createHash('sha256').update(state.draft).digest('hex');delete state.draft;return state;
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
