'use strict';
// Synthetic browser execution only. Neither a real model nor QQ is contacted.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const { createServer } = require('../src/server.cjs');
const { Controller } = require('../src/controller.cjs');
const { Store } = require('../src/store.cjs');
const { raw, scope } = require('../tests/fixtures/native.cjs');
const { CDP } = require('./cdp.cjs');
const { actions } = require('./browser-actions.cjs');
const { withCurrentDraftControls } = require('../tests/fixtures/draft-controls.cjs');
const { withoutCurrentControl } = require('../tests/fixtures/wording-lanes.cjs');
const { withRequestDelivery } = require('./synthetic-request-delivery.cjs');

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
  const privateNote='PRIVATE_BROWSER_NOTE_只供自己整理的担忧';
  const preference='以后回复简短一些，但不要为了简短忽略她说的事';
  const optionText='今天实验终于成功了，先帮我想想能分享哪个方向。';
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
      const text=payload.userRequest?.text||'';
      if (text.includes('模拟网络失败')) throw new Error('synthetic-offline');
      if (payload.purpose === 'draft_prepare') return { draftPlan: withCurrentDraftControls(payload.selectedOption ?
        {option:payload.selectedOption,style:'short'} : {quotes:[{sourceId:payload.userRequest.sourceId,text:'实验终于成功了'}],style:'short'},payload) };
      if (payload.purpose === 'reply') return {draftPlan:withCurrentDraftControls({quotes:[],intent:'reply',style:'short'},payload)};
      if (payload.purpose === 'draft') return { kind: 'draft', text: '可以用你自己的语气分享：',
        suggestions: [{ style: '简短', text: payload.outboundQuotes.length?'实验终于成功啦，终于松了口气。':'今晚先好好休息，不用急着回我。' }] };
      if(payload.actionReceipts?.length)return {kind:'acknowledgment',text:'已按你本次明确的意思处理，具体记录可以查看和撤销。',methodIds:['correction']};
      let action;
      if(text===`我的长期目标是${syntheticGoal}。`)action={type:'set_goal',text:syntheticGoal,evidenceQuote:text};
      if(text===`记住${privateNote}`)action={type:'save_note',text:privateNote,use:'discussion',evidenceQuote:text};
      if(text==='记住今天去爬山了，这条可以分享给她。')action={type:'save_note',text:'今天去爬山了',use:'draft',evidenceQuote:text};
      if(text===`记住${preference}。`)action={type:'set_preference',text:preference,evidenceQuote:text};
      if(text==='我们也许可以把目标调整一下。')action={type:'set_goal',text:'先多一些自然的双向交流',evidenceQuote:text};
      if(action)return {kind:'discussion',text:'可以核对下面这项具体记录。',actions:[action],methodIds:['correction']};
      if(text===optionText)return {kind:'options',text:'可以分享终于有进展这件事；你不必把自己的担忧也告诉她。',methodIds:['choose_next_step'],
        expressionOptions:[{label:'分享实验终于有进展',quotes:[{sourceId:payload.userRequest.sourceId,text:'实验终于成功了'}],style:'short'}]};
      return { kind: 'discussion', text: '可以先聊清楚你想分享的心情。<img src=x onerror=alert(1)>',methodIds:['clarify'] };
    }
  });
  const syntheticAssistantModel = controller.assistantModel;
  controller.assistantModel = async (...args) => withRequestDelivery(await syntheticAssistantModel(...args), args[1].payload);
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
    const ui=actions(cdp);
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:480,height:900,deviceScaleFactor:1,mobile:false});
    await until(() => cdp.evaluate("!!document.querySelector('#assistant-form')"), 'assistant form');
    await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');
    await until(() => cdp.evaluate("!document.querySelector('#assistant-send').disabled"), 'private help enabled with no QQ history');
    assert.equal(controller.snapshot().total, 0);
    checks.push('Selected authenticated empty QQ conversation permits private assistance');
    await until(()=>cdp.evaluate("!document.querySelector('#contact-dialog').open"),'contact selection closes dialog');
    for(const [width,height] of [[370,560],[370,640],[370,890],[480,900]]){await cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await ui.composer(`initial ${width}x${height} empty conversation`);const shot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,`initial-${width}x${height}.png`),Buffer.from(shot.data,'base64'));}
    checks.push('Initial empty conversation keeps the full composer visible at 370x560, 370x640, 370x890 and 480x900');
    await ui.workspace('discussion');await ui.key('ArrowRight');await ui.assertWorkspace('history');await ui.key('ArrowRight');await ui.assertWorkspace('background');await ui.key('ArrowLeft');await ui.assertWorkspace('history');await ui.key('End');await ui.assertWorkspace('background');await ui.key('Home');await ui.assertWorkspace('discussion');await ui.composer('keyboard return to discussion');
    checks.push('Arrow keys, Home and End operate accessible tabs and return to the composer');

    const submit=async(text,button='assistant-send')=>{
      await until(()=>cdp.evaluate("!document.querySelector('#assistant-send').disabled"),'assistant input ready');
      const before=calls.length;
      await ui.fill('#assistant-input',text);await ui.openDetails('#assistant-tools');await ui.click(button==='assistant-send'?'#assistant-discussion':`#${button}`);assert.equal(calls.length,before,'mode selection does not submit');await ui.click('#assistant-send');
      await until(()=>calls.length>before&&!controller.assistantBusy,'request processed');
      await until(()=>cdp.evaluate("document.querySelector('#assistant-input').value===''&&!document.querySelector('#assistant-send').disabled"),'request rendered');
      if(await cdp.evaluate("document.querySelector('#assistant-tools').open"))await ui.click('#assistant-tools > summary');
    };
    await submit(`我的长期目标是${syntheticGoal}。`);
    assert.equal(controller.snapshot().companion.goal.text,syntheticGoal);
    assert.equal(await cdp.evaluate("document.querySelector('#panel-background').hidden"),true);
    assert.ok(await cdp.evaluate("document.querySelector('#action-receipts').textContent.includes('关系目标')"));
    checks.push('A natural-language goal is persisted with a visible receipt without opening a form');
    await submit(`记住${privateNote}`);
    await submit('记住今天去爬山了，这条可以分享给她。');
    await submit(`记住${preference}。`);
    assert.equal(controller.snapshot().companion.notes.length,3);
    assert.equal(controller.snapshot().companion.notes.find(n=>n.text===privateNote).use,'discussion');
    assert.equal(controller.snapshot().companion.notes.find(n=>n.text===preference).kind,'preference');
    await until(()=>cdp.evaluate("document.querySelectorAll('#draft-materials input[type=checkbox]').length===1"),'only explicitly shareable note available');
    assert.equal(await cdp.evaluate("document.querySelector('#draft-material-panel').open"),false);
    checks.push('Natural notes and negative-style durable preferences save with provenance; shareable material does not require repeated checkboxes');
    store.saveNote(scope,{text:'合成布局素材：这是一条较长的已允许分享的近况，用于检查小窗口里的可选素材列表。'.repeat(12),use:'draft'});controller.changed();
    await until(()=>cdp.evaluate("document.querySelectorAll('#draft-materials input[type=checkbox]').length===2"),'long synthetic material visible');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:370,height:560,deviceScaleFactor:1,mobile:false});
    await ui.openDetails('#draft-material-panel');await ui.composer('370x560 with expanded materials');await ui.closeDetails('#draft-material-panel');
    const priorConsent=controller.settings.realChatConsent;
    controller.settings.realChatConsent=null;controller.error='合成连接提醒，原始输入需要保持可见。'.repeat(20);controller.changed();
    await until(()=>cdp.evaluate("!document.querySelector('#model-consent').hidden&&!document.querySelector('#error').hidden"),'long consent and error notices');
    await ui.composer('370x560 with long consent and error notices',{allowDisabled:true});
    assert.equal(await cdp.evaluate("document.querySelector('#assistant-send').disabled"),true);
    controller.settings.realChatConsent=priorConsent;controller.error='';controller.changed();
    await until(()=>cdp.evaluate("!document.querySelector('#assistant-send').disabled"),'consent fixture restored');
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:480,height:900,deviceScaleFactor:1,mobile:false});
    checks.push('The 370x560 composer stays in view with expanded long material and with long consent/error notices');

    await submit('我们也许可以把目标调整一下。');
    assert.equal(controller.snapshot().companion.goal.text,syntheticGoal);
    await until(()=>cdp.evaluate("document.querySelectorAll('#pending-actions .pending-action').length===1"),'concrete ambiguous action');
    await ui.click('#pending-actions .secondary');
    await until(()=>controller.snapshot().companion.goal.text==='先多一些自然的双向交流','specific action confirmation');
    const changedGoalReceipt=controller.snapshot().companion.actionReceipts.filter(r=>r.type==='set_goal'&&r.status==='applied').at(-1);
    const undoSelector=`[data-receipt-id="${changedGoalReceipt.id}"] button`;
    await until(()=>cdp.evaluate(`!!document.querySelector(${JSON.stringify(undoSelector)})`),'specific goal undo receipt rendered');
    await ui.click(undoSelector);
    await until(()=>controller.snapshot().companion.goal.text===syntheticGoal,'goal undo');
    checks.push('An ambiguous goal change needs confirmation of the concrete text and can be undone');

    const unsentThought='先保留我这个还没想清楚的想法。',beforeHandoffCalls=calls.length;
    await ui.fill('#assistant-input',unsentThought);await ui.workspace('background');await ui.fill('#memory-query','爬山');await ui.click('#memory-search-form button[type=submit]');
    await until(()=>cdp.evaluate("document.querySelector('#memory-results').textContent.includes('今天去爬山了')"),'source search');
    assert.ok(await cdp.evaluate("document.querySelector('#memory-status').textContent.length>0"));
    await ui.click('.memory-result .note-actions button');await ui.assertWorkspace('discussion');await ui.composer('continue memory lookup');
    assert.ok(await cdp.evaluate(`document.querySelector('#assistant-input').value.includes(${JSON.stringify(unsentThought)})`));
    assert.ok(await cdp.evaluate("document.querySelector('#assistant-input').value.includes('爬山')"));
    await ui.workspace('background');await ui.click('.memory-result .note-actions button',1);await ui.assertWorkspace('discussion');await ui.composer('correct memory lookup');
    assert.ok(await cdp.evaluate(`document.querySelector('#assistant-input').value.includes(${JSON.stringify(unsentThought)})`));
    assert.equal(calls.length,beforeHandoffCalls);
    checks.push('Memory search retrieves prior source text and the UI exposes pending consolidation status');
    checks.push('Continue and Correct from memory search preserve an unsent private thought and never submit it automatically');

    const firstRequest = `${privateFear}，先帮我理清今天要不要分享近况。`;
    const countBefore=controller.snapshot().companion.turns.length,callsBefore=calls.length;
    await submit(firstRequest);
    assert.equal(controller.snapshot().companion.turns.length,countBefore+2);
    assert.equal(await cdp.evaluate("document.querySelectorAll('#assistant-thread img').length"), 0);
    assert.equal(controller.snapshot().total, 0);
    assert.equal(calls.length, callsBefore+1);
    checks.push('Private exchange is rendered as text and never creates an actual QQ record');

    await cdp.call('Page.reload');
    await until(() => cdp.evaluate("document.querySelector('#assistant-thread').textContent.includes('PRIVATE_BROWSER_FEAR_')"), 'thread restored after page reload');
    await submit('我主要想分享终于松了口气。');
    assert.ok(JSON.stringify(calls.at(-1).payload).includes(firstRequest));
    assert.equal(controller.snapshot().companion.goal.text, syntheticGoal);
    checks.push('Reload restores the ongoing private thread; follow-up context contains prior turns and preserves the goal');

    await submit(optionText);
    await until(()=>cdp.evaluate("document.querySelectorAll('.expression-option').length===1"),'source-backed expression option');
    await until(()=>cdp.evaluate("document.querySelector('.method-basis')?.textContent.includes('研究来源')"),'method basis metadata');
    const optionCalls=calls.length;
    await ui.click('.expression-option button');
    await until(()=>calls.length===optionCalls+2&&!controller.assistantBusy,'option to fresh draft context');
    assert.equal(calls.at(-2).payload.userRequest.text,'按选中的方向组织表达');
    assert.ok(calls.at(-2).payload.selectedOption);
    assert.deepEqual(calls.at(-1).payload.outboundQuotes.map(q=>q.text),['实验终于成功了']);
    assert.equal(JSON.stringify(calls.at(-1).payload).includes(privateFear),false);
    assert.equal(controller.snapshot().total,0);
    checks.push('Selecting a discussed expression direction creates a restricted draft without retyping the old private material');
    await until(()=>cdp.evaluate("!document.querySelector('#assistant-send').disabled"),'option draft rendered');
    const mixedPrivateRequest=`${privateFear}，但想告诉她实验终于成功了，帮我写一句。`;
    await submit(mixedPrivateRequest,'assistant-draft');
    await until(() => cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-suggestion').length===2"), 'one optional draft');
    assert.deepEqual(calls.slice(-2).map(call => call.payload.purpose), ['draft_prepare', 'draft']);
    const wordingPayload=calls.at(-1).payload;
    const outbound = JSON.stringify(withoutCurrentControl(wordingPayload,mixedPrivateRequest));
    assert.equal(wordingPayload.currentHumanControl.sourceId,calls.at(-2).payload.intentAuthority.sourceId);
    const renderedSuggestions=await cdp.evaluate("Array.from(document.querySelectorAll('#assistant-thread .assistant-suggestion')).map(node=>node.textContent).join('\\n')");
    for (const secret of [privateFear, syntheticGoal, 'PRIVATE_BROWSER_NOTE_', '我主要想分享终于松了口气']) {
      assert.equal(outbound.includes(secret), false, secret);
      assert.equal(renderedSuggestions.includes(secret),false,`rendered suggestion: ${secret}`);
    }
    assert.match(outbound, /实验终于成功了/);
    await ui.click('#assistant-thread .assistant-suggestion button[data-action=adopt]',-1);
    await until(()=>cdp.evaluate("document.querySelector('#draft-dialog').open"),'selected expression opens draft editor');
    assert.equal(await cdp.evaluate("document.activeElement.id"),'draft');
    await ui.fill('#draft','实验成功啦，今天终于松了口气。');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '实验成功啦，今天终于松了口气。');
    await cdp.evaluate("window.__copied=null;Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}},configurable:true});");await ui.click('#copy');
    await until(() => cdp.evaluate("window.__copied==='实验成功啦，今天终于松了口气。'"), 'manual copy');
    assert.equal(controller.snapshot().total, 0);
    checks.push('Draft generation uses restricted context, offers one editable draft, and copying is not an actual send');

    controller.live({ scope, messages: [raw(undefined, false, { elements: [{ textElement: { content: '今晚有点累，想早点休息。' } }] })] });
    await until(() => cdp.evaluate("document.querySelectorAll('.message').length===1"), 'synthetic incoming event');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '实验成功啦，今天终于松了口气。');
    checks.push('New actual incoming evidence preserves the user-edited draft');
    await ui.click('#draft-close');await ui.composer('return from draft editor');await ui.click('#qq-context-preview');await ui.assertWorkspace('history');assert.equal((await ui.inspect('#history')).ok,true);await ui.workspace('discussion');await ui.composer('return from QQ history');
    checks.push('Pointer navigation visits QQ history and closes the adopted draft editor back to the visible conversation composer');

    await ui.fill('#assistant-input','模拟网络失败，保留我这句输入。');await ui.click('#assistant-send');
    await until(() => cdp.evaluate("document.querySelector('#assistant-error').textContent.includes('synthetic-offline')"), 'model failure surfaced');
    assert.ok(controller.snapshot().companion.turns.some(turn => turn.role === 'user' && turn.text === '模拟网络失败，保留我这句输入。'));
    assert.equal(controller.snapshot().assistantBusy, false);
    checks.push('Failed model request exposes an error and retains the private user input');

    await ui.click('#contact-button');await ui.fill('#qq-number','2222222222');await ui.click('#contact-form button[type=submit]');
    await until(() => controller.scope?.peerUin === '2222222222', 'second contact binding');
    await until(() => cdp.evaluate("document.querySelectorAll('#assistant-thread .assistant-turn').length===0"), 'previous private thread removed from view');
    assert.equal(controller.snapshot().companion.notes.length, 0);
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '');
    assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"), '');
    await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');
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
    await cdp.evaluate('window.confirm=()=>true');await ui.click(`[data-turn-id="${draftSource.id}"] button[aria-label="删除我的讨论"]`);
    await until(() => cdp.evaluate("document.querySelector('#draft').value===''"), 'draft cleared after source deletion');
    assert.equal(controller.snapshot().total, 1, 'deleting private discussion must not delete actual QQ history');
    await cdp.call('Page.reload');
    await until(() => cdp.evaluate("document.querySelector('#assistant-thread')?.textContent.includes('模拟网络失败')"), 'scoped state loaded after deletion and reload');
    assert.equal(await cdp.evaluate("document.querySelector('#draft').value"), '', 'cleared derived draft must remain absent after reload');
    assert.equal(await cdp.evaluate(`localStorage.getItem(${JSON.stringify(`draft:${scope.accountUid}/${scope.peerUid}`)})||''`), '');
    checks.push('Deleting the private source clears its adopted edited draft and persisted browser copy while preserving actual QQ history');
    let memoryCalls=0;
    controller.memoryModel=async(_settings,batch)=>{memoryCalls++;return {reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[]}};
    store.recordMemoryError(scope,{code:'synthetic_transient',message:'synthetic-memory-maintenance-unavailable'});controller.changed();
    await ui.workspace('background');
    await until(()=>cdp.evaluate("!document.querySelector('#memory-retry-panel').hidden&&!document.querySelector('#memory-retry').disabled"),'memory failure retry available');
    await ui.click('#memory-retry');
    await until(()=>memoryCalls>0&&store.memoryStatus(scope).pending===0,'explicit memory retry completed');
    await until(()=>cdp.evaluate("document.querySelector('#memory-retry-panel').hidden"),'retry control hidden after successful consolidation');
    assert.equal(store.memoryStatus(scope).errors.length,0);
    checks.push('A failed consolidation exposes a scoped retry only while failed, and a successful source-complete retry clears it');
    await ui.workspace('discussion');await ui.composer('final conversation');
    const probeModule={exports:{}};
    vm.runInNewContext(`${fs.readFileSync(path.join(root,'plugin/dev-probe.cjs'),'utf8')}\nmodule.exports={captureHelperReload,restoreHelperReload,inspectHelperLayout};`,{
      module:probeModule,require:name=>{assert.ok(['node:fs','node:path'].includes(name),'Reload-helper extraction cannot load Electron or perform native actions');return require(name);}
    },{filename:'synthetic-reload-helper-extraction.cjs'});
    const {captureHelperReload,restoreHelperReload,inspectHelperLayout}=probeModule.exports;
    await ui.click('#settings-button');
    const refusal=await cdp.evaluate(`(${captureHelperReload.toString()})(false)`);
    assert.equal(refusal.blocked,true);assert.equal(refusal.reason,'settings_open');
    assert.equal(await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')"),null);
    await ui.click('#settings-close');
    const feedbackTarget=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'合成刷新恢复检查的反馈对象。',requestId:'synthetic-reload-feedback'});controller.changed();
    await until(()=>cdp.evaluate(`!!document.querySelector('[data-turn-id="${feedbackTarget.id}"]')`),'reload feedback source rendered');
    await ui.fill('#assistant-input','RELOAD_PRIVATE_还没有说完的念头');
    await ui.click(`[data-turn-id="${feedbackTarget.id}"] > button`);await ui.fill('#feedback-text','RELOAD_FEEDBACK_尚未提交的反馈');
    await ui.workspace('background');await ui.openDetails('#goal-editor');await ui.fill('#goal-input','RELOAD_GOAL_尚未保存的新目标');
    await ui.openDetails('#note-editor');await ui.fill('#note-text','RELOAD_NOTE_尚未保存的近况');await ui.select('#note-use','disabled');
    await ui.fill('#memory-query','RELOAD_QUERY_还没执行的查找');
    await ui.workspace('discussion');await ui.openDetails('#draft-material-panel');await ui.click('#draft-materials input[type=checkbox]');await ui.closeDetails('#draft-material-panel');
    const selectedMaterial=await cdp.evaluate("[...document.querySelectorAll('#draft-materials input:checked')].map(el=>el.value)");assert.equal(selectedMaterial.length,1);
    await ui.click('#draft-button');await ui.fill('#draft','RELOAD_DRAFT_尚未发送的回复草稿');
    const legacyCurrent=`${scope.accountUid}/${scope.peerUid}`,legacyOther=`${scope.accountUid}/synthetic-other-contact`;
    await cdp.evaluate(`for(const storage of [localStorage,sessionStorage]){storage.setItem(${JSON.stringify(`draft:${legacyCurrent}`)},'RELOAD_DRAFT_尚未发送的回复草稿');storage.setItem(${JSON.stringify(`draft:${legacyOther}`)},'OTHER_SCOPE_UNSENT_KEEP')}localStorage.setItem(${JSON.stringify(`draft-origin:${legacyCurrent}`)},'legacy-current-origin');localStorage.setItem(${JSON.stringify(`draft-origin:${legacyOther}`)},'OTHER_SCOPE_ORIGIN_KEEP')`);
    const beforeReload=await cdp.evaluate(`(${inspectHelperLayout.toString()})()`),callsBeforeReload=calls.length,actualBeforeReload=store.messages(scope).length,settingsBeforeReload=JSON.stringify(controller.settings);
    const captured=await cdp.evaluate(`(${captureHelperReload.toString()})(false)`);assert.equal(captured.captured,true);
    const capsule=await cdp.evaluate("sessionStorage.getItem('qq-assistant-ui-reload-v1')");
    await cdp.evaluate(`(()=>{const saved=JSON.parse(${JSON.stringify(capsule)});saved.scope.peerUid='synthetic-other-contact';sessionStorage.setItem('qq-assistant-ui-reload-v1',JSON.stringify(saved))})()`);
    const rejectedRestore=await cdp.evaluate(`(${restoreHelperReload.toString()})()`);assert.equal(rejectedRestore.blocked,true);assert.equal(rejectedRestore.reason,'scope_changed_input_not_restored');
    assert.equal(await cdp.evaluate(`localStorage.getItem(${JSON.stringify(`draft:${legacyCurrent}`)})`),'RELOAD_DRAFT_尚未发送的回复草稿');
    assert.equal(await cdp.evaluate(`localStorage.getItem(${JSON.stringify(`draft:${legacyOther}`)})`),'OTHER_SCOPE_UNSENT_KEEP');
    await cdp.evaluate(`sessionStorage.setItem('qq-assistant-ui-reload-v1',${JSON.stringify(capsule)})`);
    await cdp.call('Page.reload');
    await until(()=>cdp.evaluate("typeof state!=='undefined'&&!!state?.scope&&typeof loadingHistory!=='undefined'&&!loadingHistory"),'new helper document and history ready for restoration');
    let restored;
    await until(async()=>{restored=await cdp.evaluate(`(${restoreHelperReload.toString()})()`);return restored.ready;},'scoped unsaved-input restoration');
    assert.equal(restored.scopePreserved,true);assert.equal(restored.unsavedAssistantInputsPreserved,true);assert.equal(restored.draftsPreserved,true);
    await sleep(1200);
    const afterReload=await cdp.evaluate(`(${inspectHelperLayout.toString()})()`);
    for(const key of ['draftHash','privateInputHash','goalDraftHash','noteDraftHash','feedbackDraftHash'])assert.equal(afterReload[key],beforeReload[key],`${key} preserved across actual browser reload and another state poll`);
    assert.deepEqual(await cdp.evaluate('state.scope'),scope);assert.equal(afterReload.goalDirty,true);assert.equal(afterReload.feedbackOpen,true);assert.equal(afterReload.noteEditorOpen,true);assert.equal(afterReload.draftDialog.open,true);assert.equal(afterReload.recoveryPending,false);
    assert.equal(await cdp.evaluate("document.querySelector('#note-use').value"),'disabled');
    assert.deepEqual(await cdp.evaluate("[...document.querySelectorAll('#draft-materials input:checked')].map(el=>el.value)"),selectedMaterial);
    assert.equal(await cdp.evaluate("document.querySelector('#memory-query').value"),'RELOAD_QUERY_还没执行的查找');
    for(const storage of ['localStorage','sessionStorage']){assert.equal(await cdp.evaluate(`${storage}.getItem(${JSON.stringify(`draft:${legacyCurrent}`)})`),null);assert.equal(await cdp.evaluate(`${storage}.getItem(${JSON.stringify(`draft:${legacyOther}`)})`),'OTHER_SCOPE_UNSENT_KEEP');}
    assert.equal(await cdp.evaluate(`localStorage.getItem(${JSON.stringify(`draft-origin:${legacyCurrent}`)})`),null);assert.equal(await cdp.evaluate(`localStorage.getItem(${JSON.stringify(`draft-origin:${legacyOther}`)})`),'OTHER_SCOPE_ORIGIN_KEEP');
    assert.equal(controller.snapshot().companion.goal.text,syntheticGoal);assert.equal(calls.length,callsBeforeReload);assert.equal(store.messages(scope).length,actualBeforeReload);assert.equal(JSON.stringify(controller.settings),settingsBeforeReload);
    await ui.click('#draft-close');await ui.composer('composer after helper reload restoration');
    checks.push('The actual helper reload functions refuse open settings and preserve scoped unsent inputs, material selection and draft across reload without model calls or sends');
    checks.push('A mismatched-scope recovery deletes no legacy cache; successful recovery clears only its own obsolete two-ID draft aliases');
    const report = { evidence: 'synthetic-browser-execution', result: 'PASS', nativeQQIntegration: false,
      realModelCalls: 0, timestamp: new Date().toISOString(), checks, screenshot: path.join(artifacts, 'assistant-synthetic.png'), initialScreenshots:[[370,560],[370,640],[370,890],[480,900]].map(([width,height])=>path.join(artifacts,`initial-${width}x${height}.png`)) };
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, checks: checks.length, nativeQQIntegration: false, report: path.join(artifacts, 'report.json') }));
  } finally {
    cdp?.close(); chrome.kill('SIGTERM'); if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve()})}); controller.close();
    await new Promise(resolve => server.close(resolve)); store.close();
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
