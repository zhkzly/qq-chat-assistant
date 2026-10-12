'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qqChatAssistant', Object.freeze({
  open: uin => ipcRenderer.invoke('qq-chat-assistant:open', uin),
  status: () => ipcRenderer.invoke('qq-chat-assistant:status')
}));

// Install only the visible button in the QQ main world; no sending capability is exposed.
contextBridge.executeInMainWorld({ func: () => {
  function install() {
    if (document.getElementById('qq-chat-assistant-entry')) return;
    const toolbar = document.querySelector('.chat-func-bar') || document.querySelector('.chat-input-area');
    const login = location.pathname.includes('newLogin');
    if ((!toolbar && !login) || !window.qqChatAssistant || !document.body) return;
    const button = document.createElement('button'); button.id = 'qq-chat-assistant-entry';
    button.textContent = '✦ AI 建议'; button.title = '建议由你复制并手动发送';
    button.style.cssText = 'padding:4px 10px;margin:0 6px;border-radius:7px;color:#6495df;border:1px solid #8197b544;background:transparent;font-size:12px;cursor:pointer;white-space:nowrap';
    button.onclick = () => window.qqChatAssistant.open();
    if (toolbar) toolbar.append(button);
    else { button.style.cssText += ';position:fixed;right:14px;bottom:14px;z-index:10000;background:#f5f8ff';document.body.append(button); }
  }
  const start = () => { new MutationObserver(install).observe(document.documentElement, {childList:true,subtree:true});install(); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start, {once:true}) : start();
} });
