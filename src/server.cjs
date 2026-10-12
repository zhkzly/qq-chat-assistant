'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./store.cjs');
const { Controller } = require('./controller.cjs');
const { consolidateMemory, MEMORY_VERSION } = require('./memory-engine.cjs');
const { PROMPT_VERSION } = require('./assistant-context.cjs');
const { listMethods } = require('./help-methods.cjs');
const {readImage}=require('./media.cjs');
const { ensureProfiles, publicProfiles, saveProfile, selectModel, discoverModels } = require('./providers.cjs');
function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function body(request) {
  const parts = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('Request too large'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString() || '{}');
}
function createServer({ controller, token, uiDir, saveSettings, fillDraft, inspectDraft, modelFetch }) {
  ensureProfiles(controller.settings);
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    if (request.headers.host !== `127.0.0.1:${request.socket.localPort}` ||
        (request.headers.origin && request.headers.origin !== origin)) return json(response, 403, { error: 'Local origin required' });
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && files[url.pathname]) {
      const [filename, mime] = files[url.pathname];
      response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      return response.end(fs.readFileSync(path.join(uiDir, filename)));
    }
    const auth = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) return json(response, 401, { error: 'Local access token required' });
    try {
      if(request.method==='GET' && url.pathname==='/api/desktop') {
        if(!controller.scope || !inspectDraft)throw new Error('QQ 输入框检查尚未启用');
        return json(response,200,await inspectDraft({scope:controller.scope}));
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, controller.snapshot());
      if (request.method === 'GET' && url.pathname === '/api/assistant-context') return json(response, 200, controller.assistantContext());
      if (request.method === 'GET' && url.pathname === '/api/methods') return json(response, 200, {methods:listMethods()});
      if (request.method === 'GET' && url.pathname === '/api/model-profiles') return json(response, 200, publicProfiles(controller.settings));
      if(request.method==='GET' && url.pathname==='/api/media') {
        if(!controller.scope || url.searchParams.get('accountUid')!==controller.scope.accountUid || url.searchParams.get('peerUid')!==controller.scope.peerUid)throw new Error('会话已改变，请重新查看图片');
        const message=controller.store.messages(controller.scope).find(m=>m.messageId===url.searchParams.get('messageId'));
        if(!message)throw new Error('图片不属于当前会话');const image=readImage(message,url.searchParams.get('index'));
        response.writeHead(200,{'Content-Type':image.type,'Cache-Control':'no-store'});return response.end(image.data);
      }
      if (request.method === 'GET' && url.pathname === '/api/history') {
        if(!controller.scope)throw new Error('请先选择会话');
        if(url.searchParams.get('accountUid')!==controller.scope.accountUid || url.searchParams.get('peerUid')!==controller.scope.peerUid)throw new Error('会话已改变，请重新读取');
        return json(response,200,controller.store.historyPage(controller.scope,{before:url.searchParams.get('before')||undefined,limit:url.searchParams.get('limit')}));
      }
      if (request.method === 'GET' && url.pathname === '/api/context') return json(response,200,controller.assistantContext());
      if (request.method === 'GET' && url.pathname === '/api/health') return json(response,200,{
        version:'relationship-context-complete-2026-10-12',unifiedContext:true,persistentMemory:true,
        promptVersion:PROMPT_VERSION,memoryVersion:MEMORY_VERSION,
        authenticated:controller.status.phase==='ready',selected:!!controller.scope,
        memoryConfigured:!!controller.memoryModel,qqMessagesSentByAssistant:0});
      if (request.method === 'GET' && url.pathname === '/api/export') {
        const exported = controller.store.export(controller.scope, url.searchParams.get('format') || 'json');
        response.writeHead(200, { 'Content-Type': exported.mime, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="qq-${controller.scope.peerUin}.${exported.extension}"` });
        return response.end(exported.data);
      }
      if (request.method !== 'POST') return json(response, 404, { error: 'Unknown read-only assistant route' });
      const args = await body(request);
      if (['/api/assistant', '/api/goal', '/api/note', '/api/note-delete', '/api/turn-delete', '/api/feedback','/api/confirm-action','/api/undo-action','/api/memory-search','/api/memory-maintain'].includes(url.pathname) &&
          (!controller.scope || args.accountUid !== controller.scope.accountUid || args.peerUid !== controller.scope.peerUid))
        throw new Error('会话已改变，请回到当前联系人后重试');
      switch (url.pathname) {
        case '/api/assistant': await controller.assist({text:args.text,purpose:args.purpose,materialIds:args.materialIds,sourceTurnIds:args.sourceTurnIds,selectedOption:args.selectedOption}); break;
        case '/api/goal': controller.setGoal(args.text); break;
        case '/api/note': controller.saveNote({ id: args.id, text: args.text, use: args.use }); break;
        case '/api/note-delete': controller.deleteNote(args.id); break;
        case '/api/turn-delete': controller.deleteTurn(args.id); break;
        case '/api/feedback': controller.addFeedback({ requestId: args.requestId, text: args.text, kind: args.kind }); break;
        case '/api/confirm-action': controller.confirmAction(args.id,args.decision); break;
        case '/api/undo-action': controller.undoAction(args.id); break;
        case '/api/memory-search': return json(response,200,{scope:controller.scope,...controller.searchMemory(args.query||'',{limit:24,before:args.before,after:args.after,types:args.types})});
        case '/api/memory-maintain': await controller.maintainMemory({maxBatches:2,force:true}); break;
        case '/api/models': return json(response, 200, await discoverModels(controller.settings, args, modelFetch));
        case '/api/model-selection': {
          if (!saveSettings) throw new Error('Settings unavailable');
          selectModel(controller.settings, args);
          saveSettings(controller.settings); controller.modelChanged(); break;
        }
        case '/api/bind':
          await controller.bind(args.uin);
          if (controller.scope && saveSettings) { controller.settings.lastPeerByAccountUid ||= {};controller.settings.lastPeerByAccountUid[controller.scope.accountUid]=controller.scope.peerUin;saveSettings(controller.settings); }
          break;
        case '/api/draft':
          if(!fillDraft || !controller.features.qqDraftFill)throw new Error('QQ 插件尚未启用输入框回填，请先重启 QQ；复制按钮现在即可使用');
          if(args.accountUid!==controller.scope?.accountUid || args.peerUin!==controller.scope?.peerUin || typeof args.text!=='string' || !args.text.trim() || args.text.length>5000)throw new Error('会话已改变或草稿不合法');
          return json(response,200,await fillDraft({...args,scope:controller.scope}));
        case '/api/suggest': await controller.suggest(); break;
        case '/api/options':
          if (args.replyMessageIds !== undefined && (args.accountUid !== controller.scope?.accountUid || args.peerUid !== controller.scope?.peerUid)) throw new Error('会话已改变，请重新选择回复重点');
          controller.configure(args);if(saveSettings)saveSettings(controller.settings);break;
        case '/api/older': await controller.loadOlder(200); break;
        case '/api/consent': {
          if(args.allow!==true || !controller.scope || !saveSettings)throw new Error('请明确允许当前会话使用当前模型');
          if(args.accountUid!==controller.scope.accountUid || args.peerUin!==controller.scope.peerUin || args.baseUrl!==controller.settings.baseUrl || args.model!==controller.settings.model)throw new Error('会话或模型已改变，请重新确认授权');
          controller.settings.realChatConsent={accountUid:controller.scope.accountUid,peerUin:controller.scope.peerUin,baseUrl:controller.settings.baseUrl,model:controller.settings.model,allowImages:args.allowImages===true,grantedAt:new Date().toISOString()};
          saveSettings(controller.settings);controller.error='';controller.changed();controller.scheduleMemory();break;
        }
        case '/api/settings': {
          if (!saveSettings) throw new Error('Settings unavailable');
          saveProfile(controller.settings, args);
          saveSettings(controller.settings); controller.modelChanged(); break;
        }
        case '/api/open-window': if(process.send) process.send({type:'open-helper'});else throw new Error('QQ desktop helper is not connected');break;
        default: return json(response, 404, { error: 'Unknown read-only assistant route' });
      }
      return json(response, 200, controller.snapshot());
    } catch (error) { return json(response, 400, { error: error.message }); }
  });
}
function run() {
  const root = process.env.CHAT_ASSISTANT_ROOT || path.resolve(__dirname, '..');
  const data = path.join(root, 'data'); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const settingsFile = path.join(data, 'settings.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {
    baseUrl: process.env.MODEL_BASE_URL || 'http://127.0.0.1:8317/v1',
    apiKey: process.env.MODEL_API_KEY || '', model: process.env.MODEL_NAME || 'gpt-6.1-sol' };
  const pending = new Map(); let next = 0;
  function read(command, args) {
    if (!process.send) return Promise.reject(new Error('请用项目启动器打开 QQ，助手才能读取当前客户端'));
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`QQ 读取超时：${command}`)); }, 25000);
      pending.set(id, { resolve, reject, timer });
      process.send({ type: 'read', id, command, args });
    });
  }
  const store = new Store(path.join(data, 'messages.sqlite'));
  const controller = new Controller({ store, read, settings, memoryModel: consolidateMemory });
  if(process.send)controller.setVisible(false);
  process.on('message', message => {
    if (message.type === 'reply') { const task = pending.get(message.id); if (!task) return;
      clearTimeout(task.timer); pending.delete(message.id);
      message.error ? task.reject(new Error(message.error)) : task.resolve(message.result); }
    if (message.type === 'status') {
      controller.updateStatus(message.status);
      const remembered=settings.lastPeerByAccountUid?.[message.status.account?.uid];
      if(message.status.phase==='ready' && !controller.scope && remembered) {
        const accountUid=message.status.account.uid;
        const restore=async(attempt=0)=>{
          if(controller.scope || controller.status.account?.uid!==accountUid || controller.status.phase!=='ready')return;
          try{await controller.bind(remembered);}catch(error){
            if(attempt<5)setTimeout(()=>restore(attempt+1),500*2**attempt);
            else {controller.error=error.message;controller.changed();}
          }
        };setTimeout(()=>restore(),500);
      }
    }
    if(message.type==='features'){controller.features=message.features;controller.changed();}
    if (message.type === 'visibility') controller.setVisible(!!message.visible);
    if (message.type === 'messages') controller.live(message);
    if (message.type === 'open-contact' && message.uin && message.uin !== controller.scope?.peerUin)
      controller.bind(message.uin).catch(error => { controller.error = error.message; controller.changed(); });
  });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(data, 'web-token.txt'), token, { mode: 0o600 });
  const server = createServer({ controller, token, uiDir: path.join(root, 'ui'), inspectDraft(args) {return new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('QQ 窗口检查响应超时'))},10000);pending.set(id,{resolve,reject,timer});process.send({type:'inspect-draft',id,args});});}, fillDraft(args) {return new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('QQ 回填响应超时'))},10000);pending.set(id,{resolve,reject,timer});process.send({type:'fill-draft',id,args});});}, saveSettings(value) {
    fs.writeFileSync(settingsFile, JSON.stringify(value, null, 2), { mode: 0o600 });
  } });
  server.listen(Number(process.env.CHAT_ASSISTANT_PORT || 17860), '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/#${token}`;
    fs.writeFileSync(path.join(data, 'assistant-url.txt'), url, { mode: 0o600 });
    if (process.send) process.send({ type: 'ready', url });
    console.log('QQ chat assistant is listening on loopback. Private launch URL: data/assistant-url.txt');
  });
  server.on('error', error => { console.error(`Assistant server: ${error.code || error.message}`); process.exitCode = 1; controller.close(); store.close(); });
  const close = () => { controller.close(); server.close(() => { store.close(); process.exit(0); }); };
  process.on('SIGTERM', close); process.on('SIGINT', close); process.on('disconnect', close);
}
if (require.main === module) run();
module.exports = { createServer };
