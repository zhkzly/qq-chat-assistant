'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, app } = require('electron');
const root = path.resolve(__dirname, '..');
async function probe() {
  const electronKeys=Object.keys(require('electron'));
  const globals = Object.keys(globalThis).filter(k=>/qq|node|bridge|native|session|kernel/i.test(k));
  const ipcKeys = [...require('electron').ipcMain.eventNames()].map(String).filter(k=>/IPC|QQ|node|kernel/i.test(k)).slice(0,40);
  const invokeKeys = [...(require('electron').ipcMain._invokeHandlers?.keys()||[])].slice(0,40);
  const modules = Object.values(require.cache).filter(m => /\.node$/.test(m.filename)).map(m => ({
    filename: m.filename, keys: Object.keys(m.exports || {}).slice(0, 70) }));
  const windows = [];
  for (const window of BrowserWindow.getAllWindows()) {
    let document = null;
    try { document = await window.webContents.executeJavaScript(`JSON.stringify({ready:document.readyState,
      toolbar:!!document.querySelector('.chat-func-bar'),entry:!!document.querySelector('#qq-chat-assistant-entry'),
      bridge:!!window.qqChatAssistant,apiKeys:Object.keys(window).filter(k=>/electron|qq|bridge|node/i.test(k)).slice(0,40),electronKeys:window.electron?Object.keys(window.electron).slice(0,40):[],bodyChildren:document.body?.children.length, loginActions:[...document.querySelectorAll('button,[role=button],input')].map(e=>({tag:e.tagName,type:e.type||'',className:e.className,label:(e.innerText||e.getAttribute('aria-label')||e.placeholder||'').slice(0,40),disabled:e.disabled})).filter(e=>/登录|扫码|QQ|帐号|账号|密码/.test(e.label)),quickLoginCandidate:[...document.querySelectorAll('button,[role=button]')].some(e=>/^登录$/.test(e.innerText?.trim())&&!e.disabled)})`); } catch {}
    windows.push({ id: window.id, url: window.webContents.getURL().split('?')[0], document });
  }
  fs.writeFileSync(path.join(root, 'data/native-probe.json'), JSON.stringify({ version: app.getVersion(),
    electron: process.versions.electron, node: process.versions.node, electronKeys, globals, ipcKeys, invokeKeys, modules, windows }, null, 2), { mode: 0o600 });
}
setTimeout(probe, 4000);
setTimeout(probe, 12000);
setTimeout(probe, 25000);
if (process.env.CHAT_ASSISTANT_PROBE_OPEN === '1') setTimeout(async () => {
  const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://'));
  if (window) await window.webContents.executeJavaScript('window.qqChatAssistant.open()');
  await probe();
}, 6000);
module.exports = probe;

if (process.env.CHAT_ASSISTANT_TEST_SAVED_LOGIN === '1') setTimeout(async () => {
  const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('newLogin'));
  if (!window) return;
  const result = await window.webContents.executeJavaScript(`(() => {
    const visible=e=>e && e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
    const password=[...document.querySelectorAll('input[type=password]')].some(visible);
    const avatar=[...document.querySelectorAll('.avatar-item')].some(e=>visible(e)&&!e.classList.contains('add-account-btn'));
    const login=[...document.querySelectorAll('button.login-btn')].find(e=>visible(e)&&!e.disabled);
    if (password || !avatar || !login) return {attempted:false, passwordRequired:password, savedAvatar:avatar};
    login.click(); return {attempted:true, method:'ordinary-saved-account-login-button'};
  })()`);
  fs.writeFileSync(path.join(root,'data/saved-login-test.json'),JSON.stringify(result),{mode:0o600});
  setTimeout(probe, 10000);
}, 7000);

if(process.env.CHAT_ASSISTANT_PROBE_HISTORY==='1') setTimeout(async()=>{
  const windows=BrowserWindow.getAllWindows();
  for(const window of windows) {
    if(!window.webContents.getURL().includes('index.html')) continue;
    const result=await window.webContents.executeJavaScript(`(()=>{
      if(!document.querySelector('.chat-func-bar'))return null;
      const elements=[...document.querySelectorAll('div')].filter(e=>e.scrollHeight>e.clientHeight+100 && e.clientHeight>100);
      const metadata=elements.map(e=>({className:e.className,scrollTop:e.scrollTop,height:e.clientHeight,scrollHeight:e.scrollHeight}));
      const chosen=elements.find(e=>/message|msg|chat/i.test(e.className));
      if(chosen){chosen.scrollTop=0;chosen.dispatchEvent(new Event('scroll',{bubbles:true}));}
      return {metadata,scrolled:!!chosen};
    })()`);
    if(result)fs.writeFileSync(path.join(root,'data/history-scroll-probe.json'),JSON.stringify(result,null,2),{mode:0o600});
  }
},18000);

if(process.env.CHAT_ASSISTANT_PROBE==='1')setTimeout(async()=>{
 for(const window of BrowserWindow.getAllWindows()) {
  if(!window.webContents.getURL().startsWith('app://'))continue;
  const peer=await require('./contact.cjs').activeContact(window.webContents);
  if(peer)fs.writeFileSync(path.join(root,'data/current-contact-probe.json'),JSON.stringify({found:true,privateContact:true}),{mode:0o600});
 }
},21000);

if(process.env.CHAT_ASSISTANT_PROBE==='1')setTimeout(async()=>{
 for(const window of BrowserWindow.getAllWindows()) {
  if(!window.webContents.getURL().startsWith('app://'))continue;
  const result=await window.webContents.executeJavaScript(`(()=>{const e=document.querySelector('.chat-func-bar');if(!e)return null;
    let c=e.__vueParentComponent;const chain=[];for(let n=0;c&&n<8;n++,c=c.parent)chain.push({name:c.type?.name||c.type?.__name,props:Object.keys(c.props||{}),setup:Object.keys(c.setupState||{})});return {vueAvailable:!!e.__vueParentComponent,chain};})()`);
  if(result)fs.writeFileSync(path.join(root,'data/current-contact-shapes.json'),JSON.stringify(result,null,2),{mode:0o600});
 }
},22000);

if(process.env.CHAT_ASSISTANT_PROBE_SELECT==='1')setTimeout(async()=>{
 const uin=fs.readFileSync(path.join(root,'data/probe-target.txt'),'utf8').trim();
 const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html') && !w.webContents.getURL().includes('hidden'));
 if(!window)return;
 const result=await window.webContents.executeJavaScript(`(()=>{
  const candidates=[...document.querySelectorAll('input')].filter(e=>e.getClientRects().length && /搜索/.test(e.placeholder));
  const input=candidates[0];if(!input)return {searchFound:false};
  input.value=${JSON.stringify(uin)};input.dispatchEvent(new Event('input',{bubbles:true}));return {searchFound:true};
 })()`);fs.writeFileSync(path.join(root,'data/native-search-probe.json'),JSON.stringify(result),{mode:0o600});
 setTimeout(async()=>{
  const opened=await window.webContents.executeJavaScript(`(()=>{
   const number=${JSON.stringify(uin)};
   const target=[...document.querySelectorAll('span,div')].find(e=>e.getClientRects().length && e.children.length===0 && e.innerText?.includes(number));
   if(!target)return {found:false};let row=target;
   for(let n=0;row.parentElement && n<7;n++,row=row.parentElement){if(/item|contact|buddy/.test(row.className))break;}
   row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return {found:true,rowClass:String(row.className)};
  })()`);fs.writeFileSync(path.join(root,'data/native-search-open.json'),JSON.stringify(opened),{mode:0o600});
  setTimeout(probe,2500);
 },2500);
},17000);
