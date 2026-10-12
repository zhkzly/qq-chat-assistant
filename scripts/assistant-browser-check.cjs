'use strict';
// Synthetic browser execution only. Neither a real model nor QQ is contacted.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('../src/server.cjs');
const { Controller } = require('../src/controller.cjs');
const { Store } = require('../src/store.cjs');
const { raw, scope } = require('../tests/fixtures/native.cjs');
const { CDP } = require('./cdp.cjs');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assistant-context-browser-'));
  const profile = path.join(temporary, 'chrome');
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assistant-context-evidence-'));
  const store = new Store(path.join(temporary, 'synthetic.sqlite'));
  const calls = [], checks = [];
  const syntheticGoal = '相互了解，逐渐建立自然的双向关心';
  const privateFear = 'PRIVATE_BROWSER_FEAR_我怕她嫌我烦';
  let selected = scope;
  const controller = new Controller({ store,
    settings: { auto: false, apiKey: 'synthetic-only', model: 'synthetic-assistant', baseUrl: 'http://fixture.invalid/v1',
      realChatConsent: { accountUid: scope.accountUid, peerUin: scope.peerUin, baseUrl: 'http://fixture.invalid/v1', model: 'synthetic-assistant' } },
    read: async (command, args) => {
      if (command === 'bind') { selected = args.uin === scope.peerUin ? scope : { ...scope, peerUid: 'u_other', peerUin: String(args.uin) }; return selected; }
      return { source: 'synthetic', messages: [] };
    },
    model: async () => { throw new Error('This check uses the new private assistant, not automatic legacy suggestions'); },
    assistantModel: async (_, context) => {
      calls.push(structuredClone(context));
      const payload = context.payload;
      if (payload.userRequest?.text.includes('模拟网络失败')) throw new Error('synthetic-offline');
      if (payload.purpose === 'draft_prepare') return { kind: 'draft', text: '', draftPlan: {
        quotes: [{ sourceId: payload.userRequest.sourceId, text: '实验终于成功了' }], style: 'short'
      } };
      if (payload.purpose === 'draft') return { kind: 'draft', text: '可以用你自己的语气分享：',
        suggestions: [{ style: '简短', text: '实验终于成功啦，终于松了口气。' }] };
      return { kind: 'discussion', text: '可以先聊清楚你想分享的心情。<img src=x onerror=alert(1)>' };
    }
  });
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  const server = createServer({ controller, token: 'synthetic-assistant-browser-token', uiDir: path.join(root, 'ui'),
    saveSettings() {}, modelFetch: async () => ({ ok: true, json: async () => ({ data: [{ id: 'synthetic-assistant' }] }) }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn('/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=500,1200', `${base}/#synthetic-assistant-browser-token`], { stdio: 'ignore' });
  let cdp;
  try {
    await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'headless Chrome');
    const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    cdp = await CDP.connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    await until(() => cdp.evaluate("!!document.querySelector('#assistant-form')"), 'assistant form');
    await cdp.evaluate(`document.querySelector('#qq-number').value=${JSON.stringify(scope.peerUin)};document.querySelector('#contact-form').requestSubmit()`);
    await until(() => cdp.evaluate("!document.querySelector('#assistant-send').disabled"), 'private help enabled with no QQ history');
    assert.equal(controller.snapshot().total, 0);
    checks.push('Selected authenticated empty QQ conversation permits private assistance');

    await cdp.evaluate(`document.querySelector('#background-panel').open=true;document.querySelector('#goal-input').value=${JSON.stringify(syntheticGoal)};document.querySelector('#goal-form').requestSubmit()`);
    await until(() => controller.snapshot().companion.goal.text === syntheticGoal, 'goal saved');
    await cdp.evaluate("document.querySelector('#note-text').value='PRIVATE_BROWSER_NOTE_只供自己整理的担忧';document.querySelector('#note-use').value='discussion';document.querySelector('#note-form').requestSubmit()");
    await until(() => controller.snapshot().companion.notes.length === 1, 'private note saved');
    await cdp.evaluate("document.querySelector('#note-text').value='今天去爬山了';document.querySelector('#note-use').value='draft';document.querySelector('#note-form').requestSubmit()");
    await until(() => controller.snapshot().companion.notes.length === 2, 'shareable note saved');
    await until(() => cdp.evaluate("document.querySelectorAll('#draft-materials input[type=checkbox]').length===1"), 'only draft-enabled note is selectable');
    checks.push('Goal and material permissions persist separately and only eligible notes appear for draft selection');

    const firstRequest = `${privateFear}，先帮我理清今天要不要分享近况。`;
    await cdp.evaluate(`document.querySelector('#assistant-input').value=${JSON.stringify(firstRequest)};document.querySelector('#assistant-form').requestSubmit()`);
    await until(() => cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-turn').length===2"), 'first private exchange');
    assert.equal(await cdp.evaluate("document.querySelectorAll('#assistant-thread img').length"), 0);
    assert.equal(controller.snapshot().total, 0);
    assert.equal(calls.length, 1);
    checks.push('Private exchange is rendered as text and never creates an actual QQ record');

    await cdp.call('Page.reload');
    await until(() => cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-turn').length===2"), 'thread restored after page reload');
    await cdp.evaluate("document.querySelector('#assistant-input').value='我主要想分享终于松了口气。';document.querySelector('#assistant-form').requestSubmit()");
    await until(() => cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-turn').length===4"), 'follow-up discussion');
    assert.ok(JSON.stringify(calls.at(-1).payload).includes(firstRequest));
    assert.equal(controller.snapshot().companion.goal.text, syntheticGoal);
    checks.push('Reload restores the ongoing private thread; follow-up context contains prior turns and preserves the goal');

    await cdp.evaluate(`document.querySelector('#assistant-input').value=${JSON.stringify(`${privateFear}，但想告诉她实验终于成功了，帮我写一句。`)};document.querySelector('#assistant-draft').click()`);
    await until(() => cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-suggestion').length===1"), 'one optional draft');
    assert.deepEqual(calls.slice(-2).map(call => call.payload.purpose), ['draft_prepare', 'draft']);
    const outbound = JSON.stringify(calls.at(-1).payload);
    for (const secret of [privateFear, syntheticGoal, 'PRIVATE_BROWSER_NOTE_', '我主要想分享终于松了口气']) {
      assert.equal(outbound.includes(secret), false, secret);
    }
    assert.match(outbound, /实验终于成功了/);
    await cdp.evaluate("document.querySelector('#assistant-thread .assistant-suggestion button').click();document.querySelector('#draft').value='实验成功啦，今天终于松了口气。';document.querySelector('#draft').dispatchEvent(new Event('input'))");
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '实验成功啦，今天终于松了口气。');
    await cdp.evaluate("window.__copied=null;Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}},configurable:true});document.querySelector('#copy').click()");
    await until(() => cdp.evaluate("window.__copied==='实验成功啦，今天终于松了口气。'"), 'manual copy');
    assert.equal(controller.snapshot().total, 0);
    checks.push('Draft generation uses restricted context, offers one editable draft, and copying is not an actual send');

    controller.live({ scope, messages: [raw(undefined, false, { elements: [{ textElement: { content: '今晚有点累，想早点休息。' } }] })] });
    await until(() => cdp.evaluate("document.querySelectorAll('.message').length===1"), 'synthetic incoming event');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '实验成功啦，今天终于松了口气。');
    checks.push('New actual incoming evidence preserves the user-edited draft');

    await cdp.evaluate("document.querySelector('#assistant-input').value='模拟网络失败，保留我这句输入。';document.querySelector('#assistant-form').requestSubmit()");
    await until(() => cdp.evaluate("document.querySelector('#assistant-error').textContent.includes('synthetic-offline')"), 'model failure surfaced');
    assert.ok(controller.snapshot().companion.turns.some(turn => turn.role === 'user' && turn.text === '模拟网络失败，保留我这句输入。'));
    assert.equal(controller.snapshot().assistantBusy, false);
    checks.push('Failed model request exposes an error and retains the private user input');

    await cdp.evaluate("document.querySelector('#qq-number').value='2222222222';document.querySelector('#contact-form').requestSubmit()");
    await until(() => controller.scope?.peerUin === '2222222222', 'second contact binding');
    await until(() => cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-turn').length===0"), 'previous private thread removed from view');
    assert.equal(controller.snapshot().companion.notes.length, 0);
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '');
    assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"), '');
    await cdp.evaluate(`document.querySelector('#qq-number').value=${JSON.stringify(scope.peerUin)};document.querySelector('#contact-form').requestSubmit()`);
    await until(() => cdp.evaluate("document.querySelector('#assistant-thread').textContent.includes('模拟网络失败')"), 'original scoped thread restored');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '实验成功啦，今天终于松了口气。');
    assert.equal(controller.snapshot().companion.goal.text, syntheticGoal);
    checks.push('Contact switches isolate private inputs, thread, notes and draft; returning restores the original scope');

    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 370, height: 890, deviceScaleFactor: 1, mobile: false });
    assert.ok(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'));
    checks.push('Minimum-width assistant window has no horizontal overflow');
    await cdp.evaluate('window.scrollTo(0, 0)');
    await sleep(100);
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(artifacts, 'assistant-synthetic.png'), Buffer.from(screenshot.data, 'base64'));
    const draftSource = controller.snapshot().companion.turns.find(turn => turn.role === 'user' && turn.text.includes('帮我写一句'));
    assert.ok(draftSource);
    await cdp.evaluate(`window.confirm=()=>true;document.querySelector('[data-turn-id="${draftSource.id}"] button[aria-label="删除我的讨论"]').click()`);
    await until(() => cdp.evaluate("document.querySelector('#draft').value===''"), 'draft cleared after source deletion');
    assert.equal(controller.snapshot().total, 1, 'deleting private discussion must not delete actual QQ history');
    await cdp.call('Page.reload');
    await until(() => cdp.evaluate("document.querySelector('#assistant-thread')?.textContent.includes('模拟网络失败')"), 'scoped state loaded after deletion and reload');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '', 'cleared derived draft must remain absent after reload');
    assert.equal(await cdp.evaluate(`localStorage.getItem(${JSON.stringify(`draft:${scope.accountUid}/${scope.peerUid}`)})||''`), '');
    checks.push('Deleting the private source clears its adopted edited draft and persisted browser copy while preserving actual QQ history');
    const report = { evidence: 'synthetic-browser-execution', result: 'PASS', nativeQQIntegration: false,
      realModelCalls: 0, timestamp: new Date().toISOString(), checks, screenshot: path.join(artifacts, 'assistant-synthetic.png') };
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, checks: checks.length, nativeQQIntegration: false, report: path.join(artifacts, 'report.json') }));
  } finally {
    cdp?.close(); chrome.kill('SIGTERM'); controller.close();
    await new Promise(resolve => server.close(resolve)); store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
