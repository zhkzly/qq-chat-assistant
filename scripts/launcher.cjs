'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const recovery = '请先保存 QQ 中未发送的内容，从 QQ 菜单退出，再重新打开「QQ 聊天助手」。启动器不会关闭或重启正在运行的 QQ。';
const reasons = {
  HELPER_URL_MISSING: '没有找到助手启动信息。',
  HELPER_URL_UNREADABLE: '无法读取助手启动信息。',
  HELPER_URL_INVALID: '保存的助手地址无效，已停止连接。',
  HELPER_TIMEOUT: '助手服务在限定时间内没有响应。',
  HELPER_REQUEST_FAILED: '无法连接助手服务。',
  RUNTIME_MISSING: '已验证的本地 QQ 运行环境缺失，请查看项目的 docs/usage_CN.md。'
};
function failure(code) { const error = new Error(code); error.launchCode = code; return error; }

async function activate({ root, timeoutMs = Number(process.env.CHAT_ASSISTANT_ACTIVATION_TIMEOUT_MS) || 8000 }) {
  let saved;
  try { saved = fs.readFileSync(path.join(root, 'data/assistant-url.txt'), 'utf8').trim(); }
  catch (error) { throw failure(error.code === 'ENOENT' ? 'HELPER_URL_MISSING' : 'HELPER_URL_UNREADABLE'); }
  // This file is a private capability. Reject credentials, redirects, paths and non-literal hosts.
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/#(?:[a-f0-9]{64})$/.test(saved)) throw failure('HELPER_URL_INVALID');
  let url;
  try { url = new URL(saved); } catch { throw failure('HELPER_URL_INVALID'); }
  if (!url.port || Number(url.port) < 1) throw failure('HELPER_URL_INVALID');
  const signal = AbortSignal.timeout(Math.max(250, Math.min(15000, Number.isFinite(timeoutMs) ? timeoutMs : 8000)));
  let response;
  try {
    response = await fetch(new URL('/api/open-window', url), {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' }, body: '{}'
    });
  } catch (error) {
    if (signal.aborted) throw failure('HELPER_TIMEOUT');
    const code = error.cause?.code;
    throw failure(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
      ? `HELPER_REQUEST_FAILED_${code}` : 'HELPER_REQUEST_FAILED');
  }
  response.body?.cancel().catch(() => {});
  if (!response.ok) throw failure(`HELPER_HTTP_${response.status}`);
}

function reportFailure(error) {
  // Never display raw fetch errors, response bodies or the capability URL.
  const raw = error?.launchCode;
  const code = Object.hasOwn(reasons, raw) || /^HELPER_HTTP_[1-5][0-9]{2}$/.test(raw || '') ||
    /^HELPER_REQUEST_FAILED_(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH)$/.test(raw || '')
    ? raw : 'HELPER_REQUEST_FAILED';
  const text = `QQ 聊天助手打开失败（${code}）。\n${reasons[code] || '现有助手服务暂时不可用。'}\n\n${recovery}`;
  console.error(text);
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    const notice = spawn('zenity', ['--error', '--title=QQ 聊天助手', '--no-markup', '--width=480', `--text=${text}`],
      { detached: true, stdio: 'ignore' });
    notice.on('error', () => {}); notice.unref();
  }
}
module.exports = { activate, failure, reportFailure };
