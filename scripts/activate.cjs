'use strict';
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const url = new URL(fs.readFileSync(path.join(root, 'data/assistant-url.txt'), 'utf8').trim());
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Invalid local helper URL');
  const response = await fetch(new URL('/api/open-window', url), { method: 'POST',
    headers: { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error(`Helper HTTP ${response.status}`);
})().catch(() => { console.error('请先退出普通 QQ，再通过 QQ 聊天助手启动。原来的 QQ 程序不需要重新安装。'); process.exitCode = 2; });
