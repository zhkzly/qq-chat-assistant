'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const scripts = path.resolve(__dirname, '../scripts');
const token = 'a'.repeat(64);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-launcher-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'data/runtime/qq'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  for (const name of ['launch.sh', 'activate.cjs', 'launcher.cjs']) {
    if (fs.existsSync(path.join(scripts, name))) fs.copyFileSync(path.join(scripts, name), path.join(root, 'scripts', name));
  }
  return root;
}
function executable(root, name, text) {
  fs.writeFileSync(path.join(root, name), '#!/usr/bin/env bash\n' + text + '\n', { mode: 0o700 });
}
function run(root, file, { env = {}, args = [], deadline = 1800 } = {}) {
  return new Promise(resolve => {
    const child = spawn(file.endsWith('.sh') ? '/bin/bash' : process.execPath, [path.join(root, 'scripts', file), ...args], {
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', PATH: path.join(root, 'bin') + ':' + process.env.PATH,
        CHAT_ASSISTANT_NODE: process.execPath, CHAT_ASSISTANT_ACTIVATION_TIMEOUT_MS: '250', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', expired = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, deadline);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, expired }); });
  });
}
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return instance;
}
function url(root, port) { fs.writeFileSync(path.join(root, 'data/assistant-url.txt'), `http://127.0.0.1:${port}/#${token}`); }

test('activation uses the existing loopback helper without opening another QQ', async t => {
  const root = fixture(t); let received;
  const service = await server(t, (request, response) => {
    received = { method: request.method, url: request.url, authorization: request.headers.authorization };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  url(root, service.address().port);
  executable(root, 'data/runtime/qq/qq', 'printf started > "$0.started"');
  executable(root, 'bin/pgrep', 'exit 0');
  const result = await run(root, 'launch.sh');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(received, { method: 'POST', url: '/api/open-window', authorization: `Bearer ${token}` });
  assert.equal(fs.existsSync(path.join(root, 'data/runtime/qq/qq.started')), false);
  assert.equal(result.stderr.includes(token), false);
});

test('unavailable helper reports a visible safe error for a desktop launch', async t => {
  const root = fixture(t), notification = path.join(root, 'notification.json');
  // The server closes before activation, reproducing a stale saved helper URL.
  const service = await server(t, () => {}); const port = service.address().port;
  await new Promise(resolve => service.close(resolve)); url(root, port);
  executable(root, 'bin/zenity', '"' + process.execPath + '" -e \'require("node:fs").writeFileSync(process.env.TEST_NOTIFICATION, JSON.stringify(process.argv.slice(1)))\' -- "$@"');
  const result = await run(root, 'activate.cjs', { env: { DISPLAY: ':synthetic', TEST_NOTIFICATION: notification } });
  assert.equal(result.code, 2);
  for (let attempt = 0; attempt < 20 && !fs.existsSync(notification); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(notification), true, 'Terminal=false must still show a GUI error');
  assert.match(result.stderr, /ECONNREFUSED/);
  assert.match(result.stderr, /保存.*未发送.*QQ.*菜单.*退出/);
  const args = JSON.parse(fs.readFileSync(notification, 'utf8'));
  assert.ok(args.includes('--error')); assert.ok(args.includes('--no-markup'));
  assert.equal(JSON.stringify(args).includes(token), false);
  assert.equal(result.stderr.includes(token), false);
});

test('activation times out instead of leaving startup hanging', async t => {
  const root = fixture(t), service = await server(t, () => {});
  url(root, service.address().port);
  const result = await run(root, 'activate.cjs');
  assert.equal(result.expired, false, 'activation must finish before the outer test deadline');
  assert.equal(result.code, 2); assert.match(result.stderr, /HELPER_TIMEOUT/);
});

test('HTTP failures retain a safe distinguishable status without response text or tokens', async t => {
  const root = fixture(t), service = await server(t, (_, response) => {
    response.writeHead(401); response.end('private-token=' + token);
  });
  url(root, service.address().port);
  const result = await run(root, 'activate.cjs');
  assert.equal(result.code, 2); assert.match(result.stderr, /HELPER_HTTP_401/);
  assert.equal(result.stderr.includes(token), false);
});

test('activation refuses redirects before contacting another destination', async t => {
  const root = fixture(t); let redirected = 0;
  const destination = await server(t, (_, response) => { redirected++; response.end('{}'); });
  const service = await server(t, (_, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/capture` }); response.end();
  });
  url(root, service.address().port);
  const result = await run(root, 'activate.cjs');
  assert.equal(result.code, 2); assert.match(result.stderr, /HELPER_REQUEST_FAILED/);
  assert.equal(redirected, 0); assert.equal(result.stderr.includes(token), false);
});

test('ordinary QQ remains untouched when no helper is available', async t => {
  const root = fixture(t), changed = path.join(root, 'qq-was-touched');
  executable(root, 'bin/pgrep', 'exit 0');
  for (const name of ['data/runtime/qq/qq', 'bin/kill', 'bin/pkill', 'bin/killall']) {
    executable(root, name, 'printf touched > "$TEST_QQ_CHANGED"');
  }
  const result = await run(root, 'launch.sh', { env: { TEST_QQ_CHANGED: changed } });
  assert.equal(result.code, 2); assert.match(result.stderr, /HELPER_URL_MISSING/);
  assert.match(result.stderr, /保存.*未发送.*QQ.*菜单.*退出/);
  assert.equal(fs.existsSync(changed), false, 'do not close, restart or launch a second QQ');
});

test('invalid saved endpoints are rejected before any network request', async t => {
  const root = fixture(t); let hits = 0;
  const service = await server(t, (_, response) => { hits++; response.end('{}'); });
  for (const value of [
    `http://localhost:${service.address().port}/#${token}`,
    `http://127.0.0.1:${service.address().port}/unexpected#${token}`,
    `http://127.0.0.1:${service.address().port}/?forward=external#${token}`,
    `http://user:secret@127.0.0.1:${service.address().port}/#${token}`,
    `https://127.0.0.1:${service.address().port}/#${token}`
  ]) {
    fs.writeFileSync(path.join(root, 'data/assistant-url.txt'), value);
    const result = await run(root, 'activate.cjs');
    assert.equal(result.code, 2); assert.match(result.stderr, /HELPER_URL_INVALID/);
    assert.equal(result.stderr.includes(token), false);
  }
  assert.equal(hits, 0);
});

test('fresh runtime launch explicitly requests its assistant window and preserves arguments', async t => {
  const root = fixture(t), output = path.join(root, 'runtime.json');
  executable(root, 'bin/pgrep', 'exit 1');
  executable(root, 'data/runtime/qq/qq', '"' + process.execPath + '" -e \'require("node:fs").writeFileSync(process.env.TEST_RUNTIME, JSON.stringify({open:process.env.CHAT_ASSISTANT_OPEN_ON_START,args:process.argv.slice(1)}))\' -- "$@"');
  const result = await run(root, 'launch.sh', { env: { TEST_RUNTIME: output }, args: ['--synthetic-arg', 'two words'] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { open: '1', args: ['--synthetic-arg', 'two words'] });
});
