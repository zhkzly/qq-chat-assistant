'use strict';
const {inspectComposerInDocument}=require('./contact.cjs');
function checkAccount(account,scope){if(!account || account.uid!==scope.accountUid || account.uin!==scope.accountUin)throw new Error('QQ 账号已改变，不能回填草稿');}
async function matchingComposers({windows,bindings,windowAccounts,account,scope}){
 checkAccount(account,scope);const inspected=[];
 for(const window of windows){
  if(!window.webContents.getURL().startsWith('app://'))continue;
  const visible=window.isVisible();
  const owner=windowAccounts?.get(window.webContents)||bindings.get(window.webContents.id)?.accountUid;
  if(owner!==scope.accountUid){inspected.push({window,state:{},visible,ownerMatches:false,matches:false});continue;}
  const state=await window.webContents.executeJavaScript(`(${inspectComposerInDocument.toString()})()`);
  state.peerUinMatches=state.peer?.peerUin===scope.peerUin;state.peerUidMatches=state.peer?.peerUid===scope.peerUid;state.peerUidIsUin=state.peer?.peerUid===state.peer?.peerUin;
  inspected.push({window,state,visible,ownerMatches:true,matches:state.peer?.peerUid===scope.peerUid && state.composers===1});
 }return inspected;
}
async function inspectQQDraft(args){
 const states=await matchingComposers(args);if(process.env.CHAT_ASSISTANT_PROBE==='1')delete require.cache[require.resolve('./dev-probe.cjs')];const probe=await require('./dev-probe.cjs').runProbe(states);return {probe,matchingWindows:states.filter(s=>s.matches).length,
  windows:states.map(({window,state,matches,visible,ownerMatches})=>({id:window.webContents.id,visible,ownerMatches,matches,
    sourceVersion:state.sourceVersion,composers:state.composers,peerCount:state.peerCount,vueComponents:state.vueComponents,
    nativeEditorEmpty:state.nativeEditorEmpty,draftNonempty:state.draftNonempty,draftCharacters:state.draftCharacters}))};
}
async function fillQQDraft(args){
 const {scope,text,replace=false,preferredWindowId,assertScope=()=>{}}=args;
 const states=(await matchingComposers(args)).filter(s=>s.matches&&(s.visible||s.window.webContents.id===preferredWindowId));
 const target=states.find(s=>s.window.webContents.id===preferredWindowId)?.window||(states.length===1?states[0].window:null);
 if(!target)throw new Error('请在对应好友的 QQ 私聊窗口点击「✦ AI 建议」再试；没有确认唯一输入框，已取消回填');
 assertScope();
 const result=await target.webContents.executeJavaScript(`(()=>{
  const state=(${inspectComposerInDocument.toString()})();
  if(state.peer?.peerUid!==${JSON.stringify(scope.peerUid)} || state.composers!==1)return {error:'QQ 当前会话已改变，已取消回填'};
  const editor=[...document.querySelectorAll('.ck-content[contenteditable=true],.chat-input-area [contenteditable=true]')].find(e=>e.getClientRects().length);
  const text=${JSON.stringify(text)};
  if(state.draftNonempty && !${JSON.stringify(replace)})return {requiresReplace:true};
  editor.focus();const range=document.createRange();range.selectNodeContents(editor);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  const inserted=document.execCommand('insertText',false,text);
  return {inserted:inserted&&editor.innerText.includes(text),sent:false};
 })()`);
 if(result.error)throw new Error(result.error);
 if(!result.requiresReplace && !result.inserted)throw new Error('QQ 编辑器未接受文字，请用复制按钮手动粘贴');
 if(result.inserted){target.show();target.focus()}
 return result;
}
module.exports={fillQQDraft,inspectQQDraft};
