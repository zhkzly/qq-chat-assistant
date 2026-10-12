'use strict';
function inspectComposerInDocument() {
 const toolbar=document.querySelector('.chat-func-bar')||document.querySelector('.chat-input-area');
 const peers=new Map(),seen=new Set(),components=new Set(),emptyFlags=new Set();
 const visit=(value,depth=0)=>{
  if(!value||typeof value!=='object'||depth>5||seen.has(value))return;
  seen.add(value);const chatType=Number(value.chatType??value.type);
  if(typeof value.peerUid==='string' && value.peerUid.length>0 && [1,2,3].includes(chatType)) {
   const uin=String(value.chatUin||value.uin||'');
   peers.set(`${chatType}:${value.peerUid}`,{peerUid:value.peerUid,chatType,peerUin:/^\d{5,12}$/.test(uin)?uin:null});
  }
  for(const key of Object.keys(value).filter(k=>/current|^cur|peer|contact|chatInfo|^value$/i.test(k)))visit(value[key],depth+1);
 };
 const inspectComponent=component=>{
  for(let n=0;component&&n<8;n++,component=component.parent){
   if(components.has(component))break;components.add(component);visit(component.props);visit(component.setupState);
  }
 };
 for(let element=toolbar,n=0;element&&n<12;n++,element=element.parentElement){
  inspectComponent(element.__vueParentComponent);
  for(const component of element.__VUE__||[])inspectComponent(component);
 }
 // Only inspect already-created current-peer services, never conversation maps or message arrays.
 const bindingsMaps=new Set([...components].map(c=>c.setupState?.qq_container__vue?.container?._bindingDictionary?._map).filter(v=>v instanceof Map));
 for(const map of bindingsMaps)for(const bindings of map.values())for(const binding of bindings){
  const cached=binding.cache;if(!cached||typeof cached!=='object')continue;
  if(cached.peer)visit(cached.peer);
  if(cached.curAioData)visit(cached.curAioData);
  if(typeof cached.isEditorEmpty==='boolean')emptyFlags.add(cached.isEditorEmpty);
 }
 const editors=[...document.querySelectorAll('.ck-content[contenteditable=true],.chat-input-area [contenteditable=true]')].filter(e=>e.getClientRects().length);
 const nativeEditorEmpty=emptyFlags.size===1?[...emptyFlags][0]:null;
 const richDraft=editors.length===1&&!!editors[0].querySelector?.('img,video,audio,[data-mention],[data-uin]');
 return {sourceVersion:'2026-10-12.3',peer:peers.size===1&&[...peers.values()][0].chatType===1?[...peers.values()][0]:null,
  peerCount:peers.size,vueComponents:components.size,composers:editors.length,nativeEditorEmpty,
  draftNonempty:editors.length===1&&(!!editors[0].innerText.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g,'').trim()||nativeEditorEmpty===false||(nativeEditorEmpty===null&&richDraft)),
  draftCharacters:editors.length===1?editors[0].innerText.length:null};
}
async function activeContact(webContents) {
 return webContents.executeJavaScript(`(${inspectComposerInDocument.toString()})().peer`);
}
module.exports={activeContact,inspectComposerInDocument};
