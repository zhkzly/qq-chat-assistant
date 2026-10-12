'use strict';
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
const { actions } = require('./browser-actions.cjs');
const FETCH_FAULT_SCRIPT=`window.__testFetchFailures=window.__testFetchFailures||{};(()=>{const original=window.fetch.bind(window);window.fetch=(resource,options)=>{const key=new URL(typeof resource==='string'?resource:resource.url,location.href).pathname,reason=window.__testFetchFailures[key];return reason?Promise.resolve(new Response(JSON.stringify({error:reason}),{status:503,headers:{'Content-Type':'application/json'}})):original(resource,options);};})();`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(test, label) { for (let i = 0; i < 80; i++) { if (await test()) return; await sleep(100); } throw new Error(`Timed out: ${label}`); }
(async () => {
  const root = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assistant-ui-'));
  const store = new Store(':memory:'); let selected = scope;
  const controller = new Controller({ store, settings: { apiKey: 'synthetic', model: 'synthetic-ui-model', baseUrl:'http://fixture.invalid/v1',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,baseUrl:'http://fixture.invalid/v1',model:'synthetic-ui-model'} },
    read: async (command, args) => {
      if (command === 'bind') { selected = args.uin === scope.peerUin ? scope : { ...scope, peerUid: 'u_other', peerUin: args.uin }; return selected; }
      if (command === 'latest') return { source: 'synthetic', messages: [{ ...raw(), peerUid: selected.peerUid, peerUin: selected.peerUin,
        senderUid: selected.peerUid, senderUin: selected.peerUin }, { ...raw('72057594037927938', true), peerUid: selected.peerUid, peerUin: selected.peerUin }] };
      return { source: 'synthetic', messages: [] };
    }, model: async () => { throw new Error('The legacy model path must remain unreachable'); },
    assistantModel: async (_,context) => context.payload.purpose==='reply' ? {draftPlan:{quotes:[],intent:'reply',style:'natural'}} : ({ kind:'draft', text: '先接住她的疲惫，留一点轻松的空间。', suggestions: [
      { style: '自然', text: '辛苦啦，终于能歇会儿了。今晚想怎么放松？' },
      { style: '轻松', text: '今日电量告急😂 先给自己充个电吧' },
      { style: '温柔', text: '辛苦啦，今晚好好休息，不用急着回我。' }] }) });
  controller.auto = false; controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  let resolveDesktop,fillCalls=0,resolveModels;
  const server = createServer({ controller, token: 'synthetic-ui-token', uiDir: path.join(root, 'ui'),saveSettings(){},modelFetch:async url=>{if(String(url).includes('held.invalid'))return new Promise(r=>{resolveModels=r});return {ok:true,json:async()=>({data:[{id:'synthetic-ui-model'},{id:'model-b'},{id:'gpt-image-example'}]})}},inspectDraft:()=>new Promise(r=>{resolveDesktop=r}),fillDraft:async()=>{fillCalls++;return {inserted:true,sent:false}} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const chrome = spawn('/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=500,1200', `http://127.0.0.1:${port}/#synthetic-ui-token`], { stdio: 'ignore' });
  let cdp; const checks = [];
  try {
    await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'headless Chrome');
    const debugPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    cdp = await CDP.connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    const ui=actions(cdp);
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:480,height:900,deviceScaleFactor:1,mobile:false});
    await until(() => cdp.evaluate("document.querySelector('#connection-label')?.textContent.includes('只读监听')"), 'connection');
    checks.push('authenticated loopback UI shows read-only QQ connection');
    await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');
    await until(() => cdp.evaluate("document.querySelectorAll('.message').length===2"), 'automatic history');
    await until(()=>cdp.evaluate("!document.querySelector('#contact-dialog').open"),'contact dialog closes after binding');
    await ui.composer('initial 480px conversation');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:370,height:890,deviceScaleFactor:1,mobile:false});
    await ui.composer('initial 370px conversation');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:480,height:900,deviceScaleFactor:1,mobile:false});
    assert.equal((await ui.inspect('#memory-query')).ok,false);assert.equal((await ui.inspect('#quick-profile')).ok,false);
    await ui.workspace('history');assert.equal((await ui.inspect('#history')).ok,true);await ui.workspace('discussion');
    checks.push('binding automatically renders both synthetic history directions');
    checks.push('initial 370px and 480px conversation shows the entire composer without scrolling; secondary forms stay hidden');
    await ui.click('#generate');
    await until(() => cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-suggestion').length===3"), 'fixture alternatives through the unified assistant');
    await ui.click('#assistant-thread .assistant-suggestion button');
    await until(()=>cdp.evaluate("document.querySelector('#draft-dialog').open"),'adoption opens draft editor');
    assert.equal(await cdp.evaluate("document.activeElement.id"),'draft');
    await ui.fill('#draft','我自己的改写');
    const draft = await cdp.evaluate("document.querySelector('#draft').value"); assert.equal(draft, '我自己的改写');
    checks.push('adoption produces an editable draft');
    controller.live({ scope, messages: [raw('72057594037927939', false, { elements: [{ textElement: { content: '<img src=x onerror=alert(1)> 最近想看电影' } }] })] });
    await until(() => cdp.evaluate("document.querySelectorAll('.message').length===3"), 'live incoming');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '我自己的改写');
    assert.equal(await cdp.evaluate("document.querySelectorAll('.bubble img').length"), 0);
    checks.push('live updates preserve draft and treat message HTML as text');
    await cdp.evaluate("window.__copied=null;Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}},configurable:true});");await ui.click('#copy');
    await until(() => cdp.evaluate("window.__copied==='我自己的改写'"), 'copy');
    assert.equal(controller.snapshot().total, 3);
    checks.push('copy handler writes the edited draft and never creates a sent record');
    await ui.click('#draft-close');await ui.composer('after closing editable draft');await ui.workspace('history');
    // Add older source-shaped rows to reproduce the user's 739-row viewport.
    store.add(scope,Array.from({length:736},(_,n)=>require('../src/messages.cjs').normalize(raw(String(72057594037927000n+BigInt(n))),scope)));
    controller.revision++;controller.changed();
    await until(()=>cdp.evaluate("document.querySelector('#history-count').textContent.includes('739')"),'739 local rows');
    await until(()=>cdp.evaluate("!document.querySelector('#view-older').hidden"),'local older-row control');
    while(!await cdp.evaluate("document.querySelector('#view-older').hidden"))await ui.click('#view-older');
    assert.equal(await cdp.evaluate("document.querySelectorAll('.message').length"),739);
    await cdp.evaluate("document.querySelector('#history').scrollTop=40;window.__firstHistoryNode=document.querySelector('.message')");
    await sleep(1300);assert.equal(await cdp.evaluate("window.__firstHistoryNode===document.querySelector('.message')"),true);
    checks.push('all 739 cached rows are browseable and polling preserves DOM/scroll');
    const fresh=await cdp.call('Target.createTarget',{url:`http://127.0.0.1:${port}/#synthetic-ui-token`});
    let freshCDP;
    try {
      const all=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      freshCDP=await CDP.connect(all.find(t=>t.id===fresh.targetId).webSocketDebuggerUrl);
      await freshCDP.call('Page.enable');
      await freshCDP.call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__testFetchFailures={'/api/model-profiles':'synthetic-profile-load-unavailable'};${FETCH_FAULT_SCRIPT}`});
      await freshCDP.call('Page.reload');
      await until(()=>freshCDP.evaluate("window.__testFetchFailures?.['/api/model-profiles']==='synthetic-profile-load-unavailable'"),'fresh document fault fixture installed');
      await until(()=>freshCDP.evaluate("document.querySelector('#draft')?.value==='我自己的改写'"),'draft in a fresh helper window');
      checks.push('a fresh helper window restores the edited draft from local storage');
      const freshUI=actions(freshCDP);await freshUI.click('#settings-button');
      await until(()=>freshCDP.evaluate("document.querySelector('#settings-error').textContent.includes('synthetic-profile-load-unavailable')"),'initial profile failure reported in settings');
      assert.equal(await freshCDP.evaluate("document.querySelector('#settings-advanced').open"),false);
      const failure=await freshUI.inspect('#settings-error');assert.ok(failure.ok&&failure.full,'profile-loading error must be visible above the closed advanced editor');
      checks.push('An initial profile-fetch failure is visible inside settings while the advanced editor stays closed');
    } finally {freshCDP?.close();await cdp.call('Target.closeTarget',{targetId:fresh.targetId});}
    await ui.click('#settings-button');
    assert.equal(await cdp.evaluate("document.querySelector('#settings-form').elements.baseUrl.value"),'http://fixture.invalid/v1');
    await until(()=>cdp.evaluate("document.querySelector('#settings-profile').options.length===2"),'saved profile metadata');
    await ui.openDetails('#settings-advanced');await ui.click('#settings-refresh-models');
    await until(()=>cdp.evaluate("document.querySelector('#settings-model-list').options.length===4"),'provider model dropdown');
    assert.equal(await cdp.evaluate("document.querySelector('#settings-form').elements.apiKey.value"),'');
    await ui.select('#settings-profile','new');await ui.fill('#settings-form [name=name]','第二个 API');await ui.fill('#settings-form [name=baseUrl]','http://fixture-b.invalid/v1');await ui.fill('#settings-form [name=apiKey]','profile-b-key');await ui.fill('#settings-form [name=model]','model-b');await ui.click('#settings-form button[type=submit]');
    await until(()=>controller.settings.apiKey==='profile-b-key','separate saved credentials');
    await until(()=>cdp.evaluate("document.querySelector('#quick-profile').options.length===2"),'quick profile selector');
    await ui.click('#settings-button');await ui.closeDetails('#settings-advanced');await ui.select('#quick-profile','default');
    await until(()=>controller.settings.apiKey==='synthetic','restored original profile key');
    await until(()=>cdp.evaluate("document.querySelector('#quick-model').value==='synthetic-ui-model'"),'restored original model');
    await cdp.evaluate(FETCH_FAULT_SCRIPT);await cdp.evaluate("window.__testFetchFailures['/api/model-selection']='synthetic-model-selection-unavailable'");
    await ui.select('#quick-model','model-b');
    await until(()=>cdp.evaluate("document.querySelector('#settings-notice').textContent.includes('synthetic-model-selection-unavailable')"),'model selection failure reported inside modal');
    assert.equal(controller.settings.model,'synthetic-ui-model');
    assert.equal(await cdp.evaluate("document.querySelector('#settings-advanced').open"),false);
    const selectionFailure=await ui.inspect('#settings-notice');assert.ok(selectionFailure.ok&&selectionFailure.full,'selection failure must be visible without opening advanced settings');
    checks.push('A failed quick model selection is visibly reported in the current settings modal and preserves the active model');
    await cdp.evaluate("delete window.__testFetchFailures['/api/model-selection']");
    await ui.select('#quick-model','model-b');
    await until(()=>controller.settings.model==='model-b'&&!controller.hasModelConsent(),'quick model switch and consent');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),'我自己的改写');
    checks.push('model list, separate API profiles and quick model switches preserve drafts and require matching consent');
    await ui.click('#settings-close');await ui.click('#settings-button');
    await until(()=>cdp.evaluate("document.querySelector('#settings').open&&document.querySelector('#settings-form').elements.model.value==='model-b'"),'settings current model');
    await ui.openDetails('#settings-advanced');await ui.fill('#settings-form [name=baseUrl]','http://held.invalid/v1');await ui.fill('#settings-form [name=apiKey]','synthetic-held');await ui.click('#settings-refresh-models');
    await until(()=>!!resolveModels,'held model list');
    await ui.fill('#settings-form [name=baseUrl]','http://edited.invalid/v1');
    resolveModels({ok:true,json:async()=>({data:[{id:'stale-wrong-model'}]})});await sleep(100);
    assert.equal(await cdp.evaluate("[...document.querySelector('#settings-model-list').options].some(o=>o.value==='stale-wrong-model')"),false);
    checks.push('editing an endpoint discards its pending model-list response');
    await ui.click('#settings-cancel');await ui.workspace('history');await ui.click('.focus-choice input');
    await until(()=>controller.replyMessageIds.length===1,'reply selection');
    assert.equal(controller.replyMessageIds[0],(await cdp.evaluate("document.querySelector('.message').dataset.messageId")));
    await ui.workspace('discussion');await ui.click('#assistant-context-button');
    await until(()=>cdp.evaluate("document.querySelector('#assistant-context-dialog').open"),'actual assistant context');
    assert.equal(await cdp.evaluate("document.querySelector('#assistant-context-summary').textContent.includes('实际使用')"),true);
    await ui.click('#assistant-context-close');await ui.workspace('history');await ui.click('#clear-focus');
    await until(()=>controller.replyMessageIds.length===0,'return to recent burst');
    checks.push('an old message can be selected for AI context and reset to the latest burst');
    await ui.workspace('discussion');await ui.click('#assistant-context-button');

    await until(()=>cdp.evaluate("document.querySelector('#assistant-context-dialog').open"),'context preview');
    assert.equal(await cdp.evaluate("document.querySelector('#assistant-context-records').textContent.includes('requestId')"),true);
    await ui.click('#assistant-context-close');checks.push('prominent model settings and actual unified assistant request evidence open');
    fs.mkdirSync(path.join(root, 'design'), { recursive: true });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 480, height: 1320, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate('window.scrollTo(0,0)');
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(root, 'design/assistant-tested-synthetic.png'), Buffer.from(screenshot.data, 'base64'));
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 370, height: 890, deviceScaleFactor: 1, mobile: false });
    assert.ok(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'));
    checks.push('minimum window width has no horizontal overflow');
    await ui.click('#contact-button');await ui.fill('#qq-number','2222222222');
    await sleep(1300);
    assert.equal(await cdp.evaluate("document.querySelector('#qq-number').value"), '2222222222');
    await ui.click('#contact-close');
    controller.features.qqDraftFill=true;controller.changed();await ui.click('#draft-button');
    await until(()=>cdp.evaluate("!document.querySelector('#fill-qq').disabled"),'scoped fill capability');
    await ui.click('#fill-qq');
    await until(()=>!!resolveDesktop,'held desktop preflight');
    await ui.click('#draft-close');await ui.click('#contact-button');await ui.fill('#qq-number','9999999999');
    await controller.bind('2222222222');
    await until(()=>cdp.evaluate("document.querySelector('#qq-number').value==='2222222222'"),'native contact switch overrides unrelated typed selector');
    checks.push('source contact changes set the QQ selector even when it retains focus');
    if(await cdp.evaluate("document.querySelector('#contact-dialog').open"))await ui.click('#contact-close');
    await ui.click('#draft-button');await ui.fill('#draft','新好友自己的草稿');
    resolveDesktop({matchingWindows:1});
    await until(()=>cdp.evaluate("document.querySelector('#error').textContent.includes('取消这次回填')"),'old fill request is canceled');
    assert.equal(fillCalls,0);checks.push('a pending fill cannot be redirected to a newly selected contact');
    await ui.fill('#draft','');await ui.click('#draft-close');
    await until(() => cdp.evaluate("document.querySelector('#contact-title').textContent.includes('2222222222')"), 'switch contact');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '');
    assert.equal(await cdp.evaluate("document.querySelectorAll('.suggestion').length"), 0);
    checks.push('contact switch clears previous suggestions/draft and does not overwrite typed selector');
    const out = JSON.parse(store.export(controller.scope, 'json').data);
    assert.equal(out.messages.every(m => m.peerUin === '2222222222'), true);
    checks.push('export stays bound to newly selected contact');
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assistant-legacy-evidence-'));
    fs.writeFileSync(path.join(evidenceDir, 'browser-evidence.json'), JSON.stringify({ type: 'synthetic-browser-execution',
      timestamp: new Date().toISOString(), checks, nativeQQIntegration: false, result: 'PASS' }, null, 2));
    console.log(JSON.stringify({ result: 'PASS', checks: checks.length, nativeQQIntegration: false, evidenceDir }));
  } finally {
    cdp?.close(); chrome.kill('SIGTERM'); controller.close(); await new Promise(r => server.close(r)); store.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
