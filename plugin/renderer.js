const buttonId = 'qq-chat-assistant-entry';
function installEntry() {
  if (document.getElementById(buttonId)) return;
  const toolbar = document.querySelector('.chat-func-bar') || document.querySelector('.chat-input-area');
  if (!toolbar || !window.qqChatAssistant) return;
  const button = document.createElement('button');
  button.id = buttonId;
  button.textContent = '✦ AI 建议';
  button.title = '打开聊天助手，建议由你复制并手动发送';
  Object.assign(button.style, { padding: '4px 10px', margin: '0 6px', borderRadius: '7px',
    color: 'var(--text_primary, #3678d0)', border: '1px solid #8197b544', background: 'transparent',
    fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' });
  button.onclick = () => window.qqChatAssistant.open().catch(() => { button.textContent = '打开失败，重试'; });
  toolbar.append(button);
}
new MutationObserver(installEntry).observe(document.documentElement, { childList: true, subtree: true });
installEntry();
