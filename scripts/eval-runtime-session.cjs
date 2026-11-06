'use strict';
const {factualReview}=require('../tests/fixtures/factual-assessment.cjs');
// Versioned adapter for the current QQ Assistant. This is optional integration
// diagnostics, not the evaluator's quality contract and not desktop evidence.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const ADAPTER_VERSION = 'qq-assistant-runtime-session-v5';
const OBSERVATION_CONDITION='scheduled_idle_public_memory_observation_v1';
const SCOPE = Object.freeze({ accountUid: 'eval_replay_owner', accountUin: '1111111111',
  peerUid: 'eval_replay_contact', peerUin: '3333333333' });
const clone = value => value === undefined ? undefined : structuredClone(value);
const errorInfo = error => ({ name: error?.name || 'Error', code: error?.code || null, message: String(error?.message || error) });
function timestamp(value, label) {
  const n = typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${label} requires a timezone-aware ISO timestamp`);
  return n;
}

// A read-model capture, not rendered DOM. Keep only the relationship branch
// actually selected by renderRelationship; other background panels come from
// their public state inputs, without inventing or reconciling understandings.
function projectPublicMemory(state){
  const view=state.relationship||{},relationship={branch_by_subject:{}},companion=state.companion||{};
  for(const subject of ['self','contact','dyad']){
    if(view.understanding?.[subject]){
      relationship.branch_by_subject[subject]='person_understanding';
      relationship.understanding||={version:view.understanding.version};
      relationship.understanding[subject]=Object.fromEntries(['knownFacts','recentCircumstances','uncertainties','boundaries'].map(key=>[key,view.understanding[subject][key]||[]]));
    }else{relationship.branch_by_subject[subject]='legacy_flat';relationship[subject]=view[subject]||[];}
  }
  relationship.activities=(view.activities||[]).map(activity=>({...activity,text:(view.events||[]).filter(event=>event.activityKey===activity.activityKey).at(-1)?.text||'已有相关记录'}));
  const current=companion.state;
  const currentState=current?{focus:current.focus,possiblyStale:current.possiblyStale,items:current.items||[],openThreads:(current.openThreads||[]).filter(item=>item.status!=='closed'),unknowns:current.unknowns||[]}:null;
  const notes=companion.notes||[];
  return clone({scope:state.scope,capture_scope:'public_read_model_ui_selected_branch_not_rendered_dom',relationship,
    companion:{goal:companion.goal,state:currentState,notes,preference_note_ids:notes.filter(note=>note.kind==='preference').map(note=>note.id),
      pendingActions:companion.pendingActions||[],actionReceipts:(companion.actionReceipts||[]).slice(-5)},
    experience:{cases:state.experience?.cases||[],adaptations:state.experience?.adaptations||[]},
    memory_status:state.memoryStatus,maintenance_schedule:state.maintenanceSchedule});
}

function virtualClock(asOf, emit) {
  let current = timestamp(asOf, 'asOf'), nextId = 0;
  const timers = new Map();
  class ProductDate extends Date {
    constructor(...args) { super(...(args.length ? args : [current])); }
    static now() { return current; }
  }
  const schedule = (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('Controller timers require a function');
    const id = ++nextId, wait = Math.max(1, Math.min(2147483647, Number(delay) || 1));
    const timer = { id, due: current + wait, callback, args, unref() { return this; }, ref() { return this; } };
    timers.set(id, timer);
    emit('controller_timer', 'scheduled', { timerId: id, due: new Date(timer.due).toISOString(), delay: wait });
    return timer;
  };
  const cancel = timer => {
    const id = typeof timer === 'object' ? timer?.id : timer;
    if (timers.delete(id)) emit('controller_timer', 'cancelled', { timerId: id });
  };
  return { Date: ProductDate, now: () => current, set: value => { current = value; },
    setTimeout: schedule, clearTimeout: cancel, clear: () => timers.clear(),
    next: () => [...timers.values()].sort((a, b) => a.due - b.due || a.id - b.id)[0],
    fire(timer) { timers.delete(timer.id); emit('controller_timer', 'fired', { timerId: timer.id }); return timer.callback(...timer.args); },
    inspect: () => [...timers.values()].map(({ id, due }) => ({ id, due: new Date(due).toISOString() })) };
}

function loadProduct(sourceRoot, clock, transport) {
  const root = fs.realpathSync(sourceRoot), srcRoot = path.join(root, 'src') + path.sep, cache = new Map();
  function load(filename) {
    filename = fs.realpathSync(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const local = createRequire(filename), mod = { exports: {}, filename, id: filename };
    cache.set(filename, mod);
    const requireProduct = request => {
      const resolved = local.resolve(request);
      return resolved.startsWith(srcRoot) && resolved.endsWith('.cjs') ? load(resolved) : local(request);
    };
    // Provider deadlines and transport backoff retain native timers. Only the
    // Controller's own event/maintenance scheduling uses the replay clock.
    const controllerTimers = filename === path.join(srcRoot, 'controller.cjs');
    vm.compileFunction(fs.readFileSync(filename, 'utf8'),
      ['exports', 'require', 'module', '__filename', '__dirname', 'Date', 'fetch', 'setTimeout', 'clearTimeout'], { filename })(
      mod.exports, requireProduct, mod, filename, path.dirname(filename), clock.Date, transport,
      controllerTimers ? clock.setTimeout : setTimeout, controllerTimers ? clock.clearTimeout : clearTimeout);
    return mod.exports;
  }
  return { root, Store: load(path.join(srcRoot, 'store.cjs')).Store,
    Controller: load(path.join(srcRoot, 'controller.cjs')).Controller,
    createServer: load(path.join(srcRoot, 'server.cjs')).createServer,
    consolidateMemory: load(path.join(srcRoot, 'memory-engine.cjs')).consolidateMemory };
}

/** Explicit transport-only fixture. It never supplies case answers or ratings. */
function makeSyntheticTransport() {
  const transport = async (_url, args) => {
    const request = JSON.parse(args.body), content = request.messages?.[1]?.content;
    if (typeof content !== 'string') throw new Error('Synthetic replay transport supports text-only requests');
    const wrapper = JSON.parse(content), p = wrapper.originalInput || wrapper;
    let result;
    if (p.purpose === 'fidelity_check') result = {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
    else if (p.batchId) result = { batchId: p.batchId, reviewedAll: true, relationshipPatch:{claims:[],events:[],retire:[]},episodes:[] };
    else if (p.purpose === 'discussion_compaction') result = { summary: 'Synthetic transport summary; no semantic quality evidence.',
      reviewedTurnIds: p.turns.map(turn => turn.id), quoteRefs: [] };
    else if (p.purpose === 'draft') result = { kind: 'draft', text: 'Synthetic transport output; no semantic quality evidence.',
      suggestions: [{ style: '自然', text: '合成传输占位，仅用于验证流程。' }] };
    else if (wrapper.purpose === 'plain_help_recovery') result = 'Synthetic transport private help; no semantic quality evidence.';
    else if (wrapper.purpose === 'plain_draft_recovery') result = '合成传输占位，仅用于验证流程。';
    else {
      result = { kind: 'discussion', text: 'Synthetic transport private help; no semantic quality evidence.' };
      if (['reply', 'draft_prepare'].includes(p.purpose)) {
        const id = p.intentAuthority?.sourceId || p.userRequest?.sourceId, control = text => ({ text, sourceIds: [id] });
        result.draftPlan = { quotes: [], intent: 'reply', guidance: {
          objective: control('回应当前提供的实际交流内容'), allowedApproach: control('遵守当前有效的用户选择'), avoidances: [] } };
      }
    }
    if(p.operationProtocol&&result&&typeof result==='object'){
      const {kind,replyDisposition,draftPlan,text,...fields}=result;
      result=draftPlan?{operation:'prepare_message',...fields,answer:{suggestions:[{style:'自然',text:'合成传输占位，仅用于验证流程。'}]}}
        :{operation:'advise',...fields,text};
    }
    if(p.requestDeliveryPolicy&&result&&typeof result==='object'&&p.purpose!=='draft'){
      const sourceId=p.intentAuthority?.sourceId||p.userRequest?.sourceId,source=p.sources.find(item=>item.id===sourceId);
      const mode=result.draftPlan?'editable_message':'private_help';
      result.requestDelivery=p.primaryReferenceProtocol?{mode}:{mode,sourceId,quote:source.text.slice(0,1000)};
    }
    return new Response(JSON.stringify({ model: request.model, choices: [{ finish_reason: 'stop',
      message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
  };
  transport.evidence = 'synthetic_transport_pipeline_only';
  return transport;
}

/** Keep one product instance for one fictional episode; replace only boundaries. */
async function createReplaySession({ sourceRoot, asOf, history = [], goal = '', settings, transport, onTrace,
  maxTimerCallbacks = 1000, settleTimeoutMs = 65000, condition } = {}) {
  if (!sourceRoot || !settings || !settings.baseUrl || !settings.model || (!settings.apiKey && !settings.anonymous))
    throw new Error('Replay requires sourceRoot and explicit product model settings');
  if (typeof transport !== 'function') throw new Error('Replay requires an explicit fetch-like transport; no default model calls');
  if (!Number.isSafeInteger(maxTimerCallbacks) || maxTimerCallbacks < 1 || maxTimerCallbacks > 10000)
    throw new Error('maxTimerCallbacks must be 1..10000');
  if (!Number.isSafeInteger(settleTimeoutMs) || settleTimeoutMs < 1 || settleTimeoutMs > 180000)
    throw new Error('settleTimeoutMs must be 1..180000');
  if(condition!==undefined&&condition!==OBSERVATION_CONDITION)throw new Error('Unknown supplemental runtime condition');
  const supplemental=condition===OBSERVATION_CONDITION;
  const trace = [], pending = new Map(), failures = [], taskFailures=[], failedErrors = new Set(),ownership=new AsyncLocalStorage();
  let taskSequence=0;
  let clock, closed = false, server, store, controller, transportCount = 0;
  const emit = (component, event, details = {}) => {
    const entry = { adapterVersion: ADAPTER_VERSION, sequence: trace.length + 1,
      at: new Date(clock ? clock.now() : timestamp(asOf, 'asOf')).toISOString(), component, event, ...clone(details) };
    trace.push(entry); onTrace?.(entry); return entry;
  };
  clock = virtualClock(asOf, emit);
  const recordFailure = (error, location,owner='foreground') => {
    if (!failedErrors.has(error)) { failedErrors.add(error); failures.push({ error, location,owner });taskFailures.push({error:errorInfo(error),location,owner}); }
  };
  const observePromise = (value, component, method,owner='foreground',terminalFailure=true) => {
    const promise = Promise.resolve(value),task={taskId:++taskSequence,component,method,owner};pending.set(promise,task);
    if(supplemental)emit('runtime_task','started',task);
    promise.then(result => {
      pending.delete(promise);
      // The product intentionally returns a maintenance status for its UI.
      // Preserve that status and also make failed checkpoints observable to a
      // caller whose only awaited operation was a timer advance.
      if (component === 'controller' && method === 'maintainMemory' && ['error', 'rejected'].includes(result?.status)) {
        const error = new Error(`Product memory maintenance ${result.status}`);
        error.code = `memory_maintenance_${result.status}`; recordFailure(error, `${component}.${method}`,owner);
      }
      if(supplemental)emit('runtime_task','finished',{...task,status:result?.status||'fulfilled'});
    }, error => {
      pending.delete(promise);
      if(terminalFailure)recordFailure(error, `${component}.${method}`,owner);
      else emit('runtime_task','nested_rejection',{...task,error:errorInfo(error),outcome_owner:'controller',terminal_failure:false});
      if(supplemental)emit('runtime_task','finished',{...task,status:'rejected',terminal_failure:terminalFailure,error:errorInfo(error)});
    });
    return promise;
  };
  const tracedTransport = async (url, args) => {
    const id = ++transportCount,started=Date.now(),owner=ownership.getStore()||'foreground';
    let request; try { request = JSON.parse(args.body); } catch { request = String(args.body || ''); }
    const destination = new URL(url);
    emit('model_transport', 'request', { requestId: id, ...(supplemental?{owner}:{}),wall_started_at:new Date(started).toISOString(),destination: { origin: destination.origin, path: destination.pathname }, request });
    const aborted=()=>emit('model_transport','abort_signal',{requestId:id,owner,wall_elapsed_ms:Date.now()-started,reason:errorInfo(args.signal.reason)});
    if(supplemental&&args.signal){args.signal.addEventListener('abort',aborted,{once:true});if(args.signal.aborted)aborted();}
    try {
      const response = await transport(url, args);
      if (!response || typeof response.clone !== 'function') throw new TypeError('Replay transport must return a fetch Response');
      const body = await response.clone().text(); let output; try { output = JSON.parse(body); } catch { output = body; }
      emit('model_transport', 'response', { requestId: id, ...(supplemental?{owner}:{}),wall_elapsed_ms:Date.now()-started,status: response.status, response: output });
      return response;
    } catch (error) { emit('model_transport', 'error', { requestId: id, ...(supplemental?{owner}:{}),wall_elapsed_ms:Date.now()-started,error: errorInfo(error) }); throw error; }
    finally{if(supplemental&&args.signal)args.signal.removeEventListener('abort',aborted);}
  };
  const runtime = loadProduct(sourceRoot, clock, tracedTransport), scope = { ...SCOPE }, introduced = new Map();
  const sourceAliases = Object.create(null), privateAliases = Object.create(null), noteAliases = Object.create(null), sourceDates = new Map();
  let messageSequence = 0n;
  function introduce(events) {
    if (!Array.isArray(events)) throw new Error('QQ events must be an array');
    const staged = [];
    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !event.id || !['self', 'contact'].includes(event.speaker) || typeof event.text !== 'string')
        throw new Error('QQ events require string id, at, speaker and text');
      const at = timestamp(event.at, `QQ event ${event.id}`);
      if (at > clock.now()) throw new Error(`QQ event ${event.id} is in the future`);
      const old = introduced.get(event.id) || staged.find(item => item.event.id === event.id);
      if (old) { if (JSON.stringify(old.event) !== JSON.stringify(event)) throw new Error(`QQ event ${event.id} changed`); continue; }
      staged.push({ event: clone(event), at });
    }
    staged.sort((a, b) => a.at - b.at);
    return staged.map(({ event, at }) => {
      const index = ++messageSequence, messageId = String(72057594049927937000n + index), own = event.speaker === 'self';
      // Field shape and successful-send status match tests/fixtures/native.cjs.
      const native = { chatType: 1, peerUid: scope.peerUid, peerUin: scope.peerUin,
        senderUid: own ? scope.accountUid : scope.peerUid, senderUin: own ? scope.accountUin : scope.peerUin,
        msgId: messageId, msgSeq: String(index), msgTime: String(Math.floor(at / 1000)), sendStatus: 2, recallTime: '0',
        elements: [{ elementType: 1, textElement: { content: event.text } },...(event.attachments||[]).map(attachment=>{
          if(attachment.kind!=='image'||attachment.availability!=='unavailable')throw new Error('Replay supports only explicitly unavailable image attachments');
          return {elementType:2,picElement:{fileName:`unavailable-${attachment.id}.png`}};
        })] };
      introduced.set(event.id, { event, native }); sourceAliases[event.id] = `qq:${messageId}`; sourceDates.set(event.id, at); return native;
    });
  }
  introduce(history);
  const read = async (method, args) => {
    emit('qq_read', 'request', { method, args });
    let result;
    if (method === 'bind') {
      if (args.accountUid !== scope.accountUid || args.uin !== scope.peerUin) throw new Error('Replay can bind only its declared fictional contact');
      result = { ...scope };
    } else if (['latest', 'older'].includes(method)) {
      if (['accountUid', 'accountUin', 'peerUid', 'peerUin'].some(key => args.scope?.[key] !== scope[key])) throw new Error('Replay read scope mismatch');
      const all = [...introduced.values()].filter(item => timestamp(item.event.at, 'event') <= clock.now())
        .map(item => item.native).sort((a, b) => BigInt(a.msgId) < BigInt(b.msgId) ? -1 : 1);
      result = { source: 'fictional-native-boundary-replay', messages: clone((method === 'latest' ? all : all.filter(m => BigInt(m.msgId) < BigInt(args.cursor))).slice(-50)) };
    } else throw new Error(`Unsupported QQ replay read ${method}`);
    emit('qq_read', 'result', { method, result }); return result;
  };
  function audit(object, method, component, tracked = false, project = args => args) {
    const original = object[method]; if (typeof original !== 'function') return;
    object[method] = function (...args) {
      emit(component, 'call', { method, args: project(args) });
      let result;
      const assistantWork=component==='assistant_adapter'||component==='compaction_adapter'||component==='controller'&&['assist','suggest'].includes(method);
      const owner=assistantWork?'foreground':ownership.getStore()||(supplemental&&component==='controller'&&method==='maintainMemory'&&!args[0]?.force?'background_memory':'foreground');
      try { result = ownership.run(owner,()=>original.apply(this,args)); }
      catch (error) { emit(component, 'error', { method, error: errorInfo(error) }); throw error; }
      if (result && typeof result.then === 'function') {
        const reported = result.then(value => { emit(component, 'result', { method, result: value }); return value; }, error => {
          emit(component, 'error', { method, error: errorInfo(error) }); throw error;
        });
        // Compaction is awaited, but its controller owns the optional fallback.
        // Keep this rejection observable and let the outer controller report a
        // terminal failure if deterministic context or answering also fails.
        return tracked ? observePromise(reported, component, method,owner,component!=='compaction_adapter') : reported;
      }
      emit(component, 'result', { method, result }); return result;
    };
  }
  try {
    store = new runtime.Store(':memory:');
    for (const method of ['add', 'appendTurn', 'searchMemory', 'memoryBatch', 'applyMemoryBatch', 'applyState', 'applyTopicPatch',
      'applyRelationshipPatch', 'saveDiscussionCompaction', 'saveRun']) audit(store, method, 'store');
    // Match server.cjs construction: the real assistance and compaction defaults
    // stay active; the actual memory adapter is explicitly connected by server.
    controller = new runtime.Controller({ store, read, settings: clone(settings), now: clock.now,
      viewerTimeZone: 'Asia/Shanghai', memoryModel: runtime.consolidateMemory });
    for (const method of ['bind', 'loadLatest', 'loadOlder', 'assist', 'suggest', 'maintainMemory','saveNote']) audit(controller, method, 'controller', true);
    audit(controller, 'ingest', 'controller');
    for (const [method, component] of [['assistantModel', 'assistant_adapter'], ['memoryModel', 'memory_adapter'], ['compactionModel', 'compaction_adapter']])
      audit(controller, method, component, true, args => [{ model: args[0]?.model, baseUrl: args[0]?.baseUrl }, args[1]]);
    const token = randomUUID();
    server = runtime.createServer({ controller, token, uiDir: path.join(runtime.root, 'ui'), saveSettings() {} });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ensureOpen = () => { if (closed) throw new Error('Replay session is closed'); };
    async function settle({ reportErrors = true,includeBackground=!supplemental,timeoutMs=settleTimeoutMs } = {}) {
      const deadline = Date.now() + timeoutMs;
      const waited=()=>[...pending].filter(([,task])=>includeBackground||task.owner!=='background_memory').map(([promise])=>promise);
      for (;;) {
        if (!waited().length) { await new Promise(resolve => setImmediate(resolve)); if (!waited().length) break; }
        const remaining = deadline - Date.now();
        if (remaining <= 0){const error=new Error(`Replay did not settle within ${timeoutMs}ms`);error.code='runtime_settle_timeout';throw error;}
        let timer;
        try { await Promise.race([Promise.allSettled(waited()), new Promise((_, reject) => {
          timer = setTimeout(() => {const error=new Error(`Replay did not settle within ${timeoutMs}ms`);error.code='runtime_settle_timeout';reject(error);}, remaining);
        })]); } finally { clearTimeout(timer); }
      }
      const failureIndex=failures.findIndex(failure=>includeBackground||failure.owner!=='background_memory');
      if (reportErrors && failureIndex!==-1) {
        const [failure]=failures.splice(failureIndex,1);if(!supplemental)failures.length=0;
        const error = new Error(`Replay task failed at ${failure.location}: ${failure.error.message}`, { cause: failure.error });
        error.code = failure.error.code || 'replay_task_failed'; throw error;
      }
    }
    async function post(route, args = {}) {
      ensureOpen();
      if (typeof route !== 'string' || !/^\/api\/[a-z-]+$/.test(route)) throw new Error('Replay requires a local /api route');
      const body = { ...scope, ...clone(args) }; emit('product_http', 'request', { method: 'POST', route, args: body });
      const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); emit('product_http', 'response', { method: 'POST', route, status: response.status, result });
      await settle();
      if (!response.ok) throw new Error(`Product ${route} HTTP ${response.status}: ${result.error}`);
      return result;
    }
    // Observe the same public state consumed by the assistant window. This
    // performs no maintenance, source restoration or semantic reconstruction.
    async function publicMemoryView() {
      ensureOpen();
      emit('product_http', 'request', { method: 'GET', route: '/api/state' });
      const response = await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
      const result = await response.json();
      emit('product_http', 'response', { method: 'GET', route: '/api/state', status: response.status, result });
      if (!response.ok) throw new Error(`Product /api/state HTTP ${response.status}: ${result.error}`);
      return {...projectPublicMemory(result),as_of:new Date(clock.now()).toISOString()};
    }
    const snapshot = () => {
      ensureOpen(); const product = controller.snapshot(), companion = store.getCompanion(scope);
      return clone({ ...product, adapterVersion: ADAPTER_VERSION, evidenceBoundary: 'fictional_qq_boundary_product_integration',
        asOf: new Date(clock.now()).toISOString(), companion, sources: store.memorySources(scope), derivedMemory: store._memoryRecords(scope),
        runs: companion.runs, sourceAliases, privateAliases, noteAliases, controllerTimers: clock.inspect(),
        ...(supplemental?{runtime:{condition,event_clock:new Date(clock.now()).toISOString(),pending_tasks:[...pending.values()],failures:taskFailures,model_transport_invocations:transportCount},
          attribution:{source_identities:store._rawMemorySources(scope).map(({id,revision,type,role,at})=>({source_id:id,revision,type,role,at})),source_aliases:{...sourceAliases,...privateAliases,...noteAliases}}}:{}) });
    };
    async function idleUntil(iso,{wallTimeoutMs=65000}={}){
      ensureOpen();if(!supplemental)throw new Error('Declared idle checkpoints require the supplemental observation condition');
      if(!Number.isSafeInteger(wallTimeoutMs)||wallTimeoutMs<1||wallTimeoutMs>65000)throw new Error('Idle native deadline must be 1..65000ms');
      const target=timestamp(iso,'idleUntil');if(target<clock.now())throw new Error('Replay clock cannot move backward');
      const started=Date.now(),deadline=started+wallTimeoutMs,failureStart=taskFailures.length;let fired=0,reason=null;
      const wait=async()=>{const remaining=deadline-Date.now();if(remaining<=0){const error=new Error('Idle native deadline elapsed');error.code='runtime_settle_timeout';throw error;}await settle({includeBackground:true,reportErrors:false,timeoutMs:remaining});};
      try{
        await wait();
        for(let next;(next=clock.next())&&next.due<=target;){
          if(++fired>maxTimerCallbacks)throw new Error(`Replay timer advance exceeded ${maxTimerCallbacks} callbacks`);
          clock.set(Math.max(clock.now(),next.due));
          try{const work=clock.fire(next);if(work&&typeof work.then==='function')observePromise(work,'controller_timer','callback','background_memory');}catch(error){recordFailure(error,'controller_timer','background_memory');}
          await wait();
        }
      }catch(error){reason=error.code==='runtime_settle_timeout'?'native_deadline':'checkpoint_error';if(reason==='checkpoint_error')recordFailure(error,'idle_checkpoint','background_memory');}
      // User questions retain their authored event time even when a provider is
      // still pending. The Controller, not the observer, decides cancellation.
      clock.set(target);
      const current=controller.snapshot(),status=current.memoryStatus,coverage=current.relationship?.understanding?.coverage||current.relationship?.coverage,newFailures=taskFailures.slice(failureStart);
      if(!reason)reason=newFailures.length?'task_failure':pending.size?'pending_task':status?.pending?'pending_source_review':status?.error||Array.isArray(status?.errors)&&status.errors.length?'memory_error':status?.semanticPending||coverage?.semanticPending?'partial_semantic_review':status?.pendingProposals?'pending_proposals':coverage?.bootstrapPending?'pending_bootstrap':null;
      const receipt=clone({condition,status:reason?'incomplete':'complete',reason,as_of:new Date(target).toISOString(),wall_elapsed_ms:Date.now()-started,wall_timeout_ms:wallTimeoutMs,
        completion_scope:'scheduled_work_and_product_review_coverage_not_semantic_quality',timer_callbacks:fired,pending_tasks:[...pending.values()],failures:newFailures,memory_status:status,product_coverage:coverage});
      emit('memory_checkpoint','observed',receipt);return receipt;
    }
    const resolveAlias=id=>sourceAliases[id]||privateAliases[id]||noteAliases[id];
    async function saveObservedNotes(events,{historical=false}={}){
      ensureOpen();await settle();
      if(historical&&transportCount)throw new Error('Restore archived notes before live model outputs');
      if(!Array.isArray(events))throw new Error('Authored user notes must be an array');
      const current=clock.now(),available=new Set(store._rawMemorySources(scope).map(source=>source.id));
      const aliases={...sourceAliases,...privateAliases,...noteAliases},dates=new Map(sourceDates),prepared=[];
      let previous=-Infinity;
      for(const event of events){
        if(!event||typeof event.id!=='string'||!event.id||Object.hasOwn(aliases,event.id)||!['user',undefined].includes(event.role)||typeof event.text!=='string'||!event.text.trim())
          throw new Error('Authored notes require distinct IDs without source collisions, user role and nonempty text');
        const at=timestamp(event.at,`Note ${event.id}`);
        if(at>current||at<previous||!historical&&at!==current)throw new Error('Authored note is future, not chronological, or outside the current observation time');
        previous=at;
        const use=event.declared_use||'discussion',kind=event.note_kind||'material',references=event.evidence_source_ids||[];
        if(!['discussion','draft'].includes(use)||!['material','preference'].includes(kind)||!Array.isArray(references)||new Set(references).size!==references.length)
          throw new Error('Authored note requires valid declared use, kind and distinct evidence references');
        if(!historical&&(kind!=='material'||references.length))throw new Error('Normal note API does not expose preference-kind or evidence-lineage authoring; use a supported actual user action');
        const evidenceSourceIds=references.map(id=>{
          if(typeof id!=='string'||!Object.hasOwn(aliases,id)||!available.has(aliases[id]))throw new Error(`Unknown or unavailable note evidence: ${id}`);
          if(dates.get(id)>at)throw new Error(`Note evidence is later than the note: ${id}`);
          return aliases[id];
        });
        prepared.push({event,at,note:{id:event.id,text:event.text,use,kind,...(references.length?{evidenceSourceIds}:{})}});
        aliases[event.id]=`note:${event.id}`;dates.set(event.id,at);available.add(aliases[event.id]);
      }
      // Only this explicit archive boundary supplies source dates. Normal /api/note
      // continues to assign the product clock's current date.
      try{
        for(const {event,at,note}of prepared){
          if(historical)clock.set(at);
          let saved;
          if(historical)saved=store.saveNote(scope,note);
          else{
            const result=await post('/api/note',{id:note.id,text:note.text,use:note.use});
            saved=result.companion?.notes?.find(item=>item.id===note.id);
            if(!saved||saved.text!==note.text||saved.use!==note.use)throw new Error('Normal note API did not persist the observed note');
          }
          noteAliases[event.id]=`note:${saved.id}`;sourceDates.set(event.id,at);
          emit('private_boundary',historical?'restore_note':'note',{provenance:historical?'authored_archived_user_note':'authored_user_note',input_event:event,result:saved});
        }
      }finally{clock.set(current);}
      if(historical)controller.changedContext();return snapshot();
    }
    const session = { adapterVersion: ADAPTER_VERSION, sourceRoot: runtime.root, scope, trace, controller, store, sourceAliases, privateAliases, noteAliases,
      post, snapshot, publicMemoryView,idleUntil,
      registerPrivateInput(event,turn){
        if(!turn||typeof event.id!=='string'||resolveAlias(event.id))throw new Error('Cannot map an unavailable or duplicate private input');
        privateAliases[event.id]=`private:${turn.id}`;sourceDates.set(event.id,timestamp(event.at,'private input'));
      },
      async restoreNotes(events){return saveObservedNotes(events,{historical:true});},
      async addNote(event){return saveObservedNotes([event]);},
      async recallSource(id){
        ensureOpen();await settle();const original=introduced.get(id);
        if(!original)throw new Error(`Unknown QQ source: ${id}`);
        original.native.recallTime=String(Math.max(1,Math.floor(clock.now()/1000)));
        emit('qq_boundary','recall',{id,raw:original.native});
        controller.live({scope,messages:[clone(original.native)]});await settle();return snapshot();
      },
      async withdrawSources(events){
        for(const event of events){
          const id=resolveAlias(event.id);
          if(!id||!id.startsWith(`${event.channel}:`))throw new Error(`Unknown withdrawal source or channel: ${event.id}`);
          if(timestamp(event.at,'withdrawal')!==clock.now())throw new Error('Source withdrawal must occur at the current replay time');
          if(event.channel==='qq'&&event.operation==='recall')await this.recallSource(event.id);
          else if(event.operation==='delete'&&event.channel==='private')await post('/api/turn-delete',{id:id.slice(8)});
          else if(event.operation==='delete'&&event.channel==='note')await post('/api/note-delete',{id:id.slice(5)});
          else if(event.operation==='exclude'){
            let applied;
            if(event.channel==='private')applied=store.markTurnControl(scope,id.slice(8));
            else if(event.channel==='note'){
              const note=store.getCompanion(scope).notes.find(note=>note.id===id.slice(5));
              applied=note&&store.saveNote(scope,{...note,use:'disabled'});
            }else applied=store.forgetSource(scope,id);
            if(!applied)throw new Error(`Withdrawal source is no longer available: ${event.id}`);
            controller.changedContext();
          }else throw new Error(`Unsupported source withdrawal: ${event.channel}/${event.operation}`);
          emit('external_action','source_withdrawn',{input_event:event,sourceId:id});
        }
        return snapshot();
      },
      async deliver(events) {
        ensureOpen(); await settle(); const raw = introduce(events);
        emit('qq_boundary', 'live', { provenance: 'authored_external_qq_observation', events, raw });
        controller.live({ scope, messages: raw }); await settle(); return snapshot();
      },
      async advanceTo(iso) {
        ensureOpen(); const target = timestamp(iso, 'advanceTo');
        if (target < clock.now()) throw new Error('Replay clock cannot move backward');
        await settle(); let fired = 0;
        for (let next; (next = clock.next()) && next.due <= target;) {
          if (++fired > maxTimerCallbacks) throw new Error(`Replay timer advance exceeded ${maxTimerCallbacks} callbacks`);
          clock.set(supplemental?Math.max(clock.now(),next.due):next.due);
          try { await clock.fire(next); } catch (error) { recordFailure(error, 'controller_timer'); }
          await settle();
        }
        clock.set(target); emit('clock', 'advanced', { callbacks: fired }); return snapshot();
      },
      async restorePrivate(events) {
        ensureOpen(); await settle();
        if (transportCount) throw new Error('Restore archived private transcript before live model outputs');
        if (!Array.isArray(events)) throw new Error('Archived private transcript must be an array');
        let previous = -Infinity; const current = clock.now(), seen = new Set(store.getCompanion(scope).turns.map(turn => turn.id));
        for (const event of events) {
          if (!event || typeof event.id !== 'string' || !event.id || seen.has(event.id) || resolveAlias(event.id) || !['user', 'assistant'].includes(event.role) || typeof event.text !== 'string' || !event.text.trim())
            throw new Error('Archived private events require distinct id, at, role and nonempty text');
          const at = timestamp(event.at, `Private event ${event.id}`);
          if (at > current || at < previous) throw new Error('Archived private transcript is future or not chronological');
          previous = at; seen.add(event.id);
        }
        try {
          for (const event of events) {
            clock.set(timestamp(event.at, 'private event'));
            const saved = store.appendTurn(scope, { id: event.id, role: event.role, kind: 'discussion', text: event.text });
            privateAliases[event.id] = `private:${saved.id}`;
            sourceDates.set(event.id,timestamp(event.at,'private event'));
            emit('private_boundary', 'restore', { provenance: 'authored_archived_private_transcript', input_event:event, result: saved });
          }
        } finally { clock.set(current); }
        controller.changedContext(); return snapshot();
      },
      async close() {
        if (closed) return; controller.close(); clock.clear();
        let cleanupError;
        try{await settle({reportErrors:false,includeBackground:true,timeoutMs:supplemental?Math.min(4000,settleTimeoutMs):settleTimeoutMs});}
        catch(error){cleanupError=errorInfo(error);if(!supplemental)throw error;}
        finally{if(supplemental||!cleanupError){closed=true;server.closeAllConnections?.();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close();}}
        return clone({status:cleanupError?'closed_pending_tasks':'closed',pending_tasks:[...pending.values()],...(cleanupError?{error:cleanupError}:{})});
      } };
    controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
    await post('/api/bind', { uin: scope.peerUin });
    if (goal) await post('/api/goal', { text: goal });
    await post('/api/consent', { allow: true, baseUrl: settings.baseUrl, model: settings.model });
    emit('session', 'ready', { scope, sourceRoot: runtime.root, evidence: 'fictional_qq_boundary_product_integration' });
    return session;
  } catch (error) {
    controller?.close(); clock.clear();
    if (server?.listening) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    store?.close(); throw error;
  }
}

module.exports = { ADAPTER_VERSION, OBSERVATION_CONDITION, createReplaySession, makeSyntheticTransport,projectPublicMemory };
