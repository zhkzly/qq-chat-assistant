'use strict';
// Versioned adapter for the current QQ Assistant. This is optional integration
// diagnostics, not the evaluator's quality contract and not desktop evidence.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');

const ADAPTER_VERSION = 'qq-assistant-runtime-session-v1';
const SCOPE = Object.freeze({ accountUid: 'eval_replay_owner', accountUin: '1111111111',
  peerUid: 'eval_replay_contact', peerUin: '3333333333' });
const clone = value => value === undefined ? undefined : structuredClone(value);
const errorInfo = error => ({ name: error?.name || 'Error', code: error?.code || null, message: String(error?.message || error) });
function timestamp(value, label) {
  const n = typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${label} requires a timezone-aware ISO timestamp`);
  return n;
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
    if (p.batchId) result = { batchId: p.batchId, reviewedAll: true, items: [], episodes: [], retire: [] };
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
    return new Response(JSON.stringify({ model: request.model, choices: [{ finish_reason: 'stop',
      message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
  };
  transport.evidence = 'synthetic_transport_pipeline_only';
  return transport;
}

/** Keep one product instance for one fictional episode; replace only boundaries. */
async function createReplaySession({ sourceRoot, asOf, history = [], goal = '', settings, transport, onTrace,
  maxTimerCallbacks = 1000, settleTimeoutMs = 65000 } = {}) {
  if (!sourceRoot || !settings || !settings.baseUrl || !settings.model || (!settings.apiKey && !settings.anonymous))
    throw new Error('Replay requires sourceRoot and explicit product model settings');
  if (typeof transport !== 'function') throw new Error('Replay requires an explicit fetch-like transport; no default model calls');
  if (!Number.isSafeInteger(maxTimerCallbacks) || maxTimerCallbacks < 1 || maxTimerCallbacks > 10000)
    throw new Error('maxTimerCallbacks must be 1..10000');
  if (!Number.isSafeInteger(settleTimeoutMs) || settleTimeoutMs < 1 || settleTimeoutMs > 180000)
    throw new Error('settleTimeoutMs must be 1..180000');
  const trace = [], pending = new Set(), failures = [], failedErrors = new Set();
  let clock, closed = false, server, store, controller, transportCount = 0;
  const emit = (component, event, details = {}) => {
    const entry = { adapterVersion: ADAPTER_VERSION, sequence: trace.length + 1,
      at: new Date(clock ? clock.now() : timestamp(asOf, 'asOf')).toISOString(), component, event, ...clone(details) };
    trace.push(entry); onTrace?.(entry); return entry;
  };
  clock = virtualClock(asOf, emit);
  const recordFailure = (error, location) => {
    if (!failedErrors.has(error)) { failedErrors.add(error); failures.push({ error, location }); }
  };
  const observePromise = (value, component, method) => {
    const promise = Promise.resolve(value); pending.add(promise);
    promise.then(result => {
      pending.delete(promise);
      // The product intentionally returns a maintenance status for its UI.
      // Preserve that status and also make failed checkpoints observable to a
      // caller whose only awaited operation was a timer advance.
      if (component === 'controller' && method === 'maintainMemory' && ['error', 'rejected'].includes(result?.status)) {
        const error = new Error(`Product memory maintenance ${result.status}`);
        error.code = `memory_maintenance_${result.status}`; recordFailure(error, `${component}.${method}`);
      }
    }, error => { pending.delete(promise); recordFailure(error, `${component}.${method}`); });
    return promise;
  };
  const tracedTransport = async (url, args) => {
    const id = ++transportCount;
    let request; try { request = JSON.parse(args.body); } catch { request = String(args.body || ''); }
    const destination = new URL(url);
    emit('model_transport', 'request', { requestId: id, destination: { origin: destination.origin, path: destination.pathname }, request });
    try {
      const response = await transport(url, args);
      if (!response || typeof response.clone !== 'function') throw new TypeError('Replay transport must return a fetch Response');
      const body = await response.clone().text(); let output; try { output = JSON.parse(body); } catch { output = body; }
      emit('model_transport', 'response', { requestId: id, status: response.status, response: output });
      return response;
    } catch (error) { emit('model_transport', 'error', { requestId: id, error: errorInfo(error) }); throw error; }
  };
  const runtime = loadProduct(sourceRoot, clock, tracedTransport), scope = { ...SCOPE }, introduced = new Map();
  const sourceAliases = {}, privateAliases = {};
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
        elements: [{ elementType: 1, textElement: { content: event.text } }] };
      introduced.set(event.id, { event, native }); sourceAliases[event.id] = `qq:${messageId}`; return native;
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
      try { result = original.apply(this, args); }
      catch (error) { emit(component, 'error', { method, error: errorInfo(error) }); throw error; }
      if (result && typeof result.then === 'function') {
        const reported = result.then(value => { emit(component, 'result', { method, result: value }); return value; }, error => {
          emit(component, 'error', { method, error: errorInfo(error) }); throw error;
        });
        return tracked ? observePromise(reported, component, method) : reported;
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
    for (const method of ['bind', 'loadLatest', 'loadOlder', 'assist', 'suggest', 'maintainMemory']) audit(controller, method, 'controller', true);
    audit(controller, 'ingest', 'controller');
    for (const [method, component] of [['assistantModel', 'assistant_adapter'], ['memoryModel', 'memory_adapter'], ['compactionModel', 'compaction_adapter']])
      audit(controller, method, component, true, args => [{ model: args[0]?.model, baseUrl: args[0]?.baseUrl }, args[1]]);
    const token = randomUUID();
    server = runtime.createServer({ controller, token, uiDir: path.join(runtime.root, 'ui'), saveSettings() {} });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ensureOpen = () => { if (closed) throw new Error('Replay session is closed'); };
    async function settle({ reportErrors = true } = {}) {
      const deadline = Date.now() + settleTimeoutMs;
      for (;;) {
        if (!pending.size) { await new Promise(resolve => setImmediate(resolve)); if (!pending.size) break; }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Replay did not settle within ${settleTimeoutMs}ms`);
        let timer;
        try { await Promise.race([Promise.allSettled([...pending]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Replay did not settle within ${settleTimeoutMs}ms`)), remaining);
        })]); } finally { clearTimeout(timer); }
      }
      if (reportErrors && failures.length) {
        const failure = failures.shift(); failures.length = 0;
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
    const snapshot = () => {
      ensureOpen(); const product = controller.snapshot(), companion = store.getCompanion(scope);
      return clone({ ...product, adapterVersion: ADAPTER_VERSION, evidenceBoundary: 'fictional_qq_boundary_product_integration',
        asOf: new Date(clock.now()).toISOString(), companion, sources: store.memorySources(scope), derivedMemory: store._memoryRecords(scope),
        runs: companion.runs, sourceAliases, privateAliases, controllerTimers: clock.inspect() });
    };
    const session = { adapterVersion: ADAPTER_VERSION, sourceRoot: runtime.root, scope, trace, controller, store, sourceAliases, privateAliases,
      post, snapshot,
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
          clock.set(next.due);
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
          if (!event || typeof event.id !== 'string' || !event.id || seen.has(event.id) || !['user', 'assistant'].includes(event.role) || typeof event.text !== 'string' || !event.text.trim())
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
            emit('private_boundary', 'restore', { provenance: 'authored_archived_private_transcript', event, result: saved });
          }
        } finally { clock.set(current); }
        controller.changedContext(); return snapshot();
      },
      async close() {
        if (closed) return; controller.close(); clock.clear();
        await settle({ reportErrors: false });
        closed = true; server.closeAllConnections?.();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close();
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

module.exports = { ADAPTER_VERSION, createReplaySession, makeSyntheticTransport };
