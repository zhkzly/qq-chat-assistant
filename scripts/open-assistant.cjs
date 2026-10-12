'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const filename = path.resolve(__dirname, '../data/assistant-url.txt');
if (!fs.existsSync(filename)) { console.error('请先通过项目启动器打开 QQ。'); process.exit(1); }
const url = fs.readFileSync(filename, 'utf8').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/#\w+$/.test(url)) throw new Error('Invalid local assistant URL');
spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
