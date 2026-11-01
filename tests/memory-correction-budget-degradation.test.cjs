'use strict';
// Deterministic reproduction of the merged-state live regression: a borderline
// memory batch (initial request just under memoryInputBytes, per-record speaker
// attribution labels included) gets a rejected wire proposal, and the correction
// request — which re-serializes the whole originalInput plus the rejected
// response echo and the fixed correction task — exceeds the same budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { prepareMemoryRequest, consolidateMemory } = require('../src/memory-engine.cjs');
const { scope } = require('./fixtures/native.cjs');

const wireNoop = p => ({ batchId: p.batchId, reviewedAll: true, relationshipPatch: { claims: [], events: [], retire: [] }, episodes: [] });
const ok = content => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function longNote() {
  // A long user hand-note in the frozen coverage-long-single-source shape,
  // carrying per-entry structure and enough bytes to make the batch borderline.
  const item = i => '第' + i + '项是物件' + i + '。我到整理桌时，师傅已经把它放好。我负责照着登记纸核对这件东西的说明，不负责估价。我们把能确认的现象按原话记下来，不补没有来源的往事。';
  return Array.from({ length: 110 }, (_, i) => item(i + 1)).join('\n');
}
function borderlineSettings(store) {
  const batch = store.memoryBatch(scope);
  const probe = prepareMemoryRequest({ model: 'synthetic' }, batch);
  // The undegradable correction wrapper: fixed task plus minimal error metadata.
  const fixedOverhead = probe.correction('', Object.assign(Error('fit measurement'), { code: 'invalid_memory_wire_fields', field: 'items' })).bytes - probe.bytes;
  return { batch, probe, fixedOverhead,
    settings: { baseUrl: 'http://fixture.invalid/v1', model: 'synthetic', anonymous: true,
      memoryInputBytes: probe.bytes + fixedOverhead + 5000 } };
}

test('borderline memory correction degrades its diagnostic echo instead of dying on the budget', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.appendTurn(scope, { role: 'user', kind: 'discussion', text: longNote() });
  const { batch, probe, fixedOverhead, settings } = borderlineSettings(store);
  assert.ok(probe.bytes <= settings.memoryInputBytes, 'fixture: the initial request fits the input budget');
  // A realistic large rejected proposal: a complete wire result plus an invalid
  // extra field and a bulky payload, like a genuine memory model output.
  const rejected = JSON.stringify({ ...wireNoop(JSON.parse(probe.serialized ? JSON.stringify(JSON.parse(probe.serialized).messages ? JSON.parse(probe.serialized).messages[1].content : '{}') : '{}')), padding: 'x'.repeat(9000) });
  const wouldThrowBefore = probe.correction(rejected, Object.assign(Error('items: unsupported fields padding'), { code: 'invalid_memory_wire_fields', field: 'items' })).bytes > settings.memoryInputBytes;
  assert.ok(wouldThrowBefore, 'fixture: the full-echo correction exceeds the budget (the pre-fix dead point)');

  let calls = 0, correctionPayload = null, correctionBytes = 0;
  const result = await consolidateMemory(settings, batch, undefined, async (_url, request) => {
    calls += 1; correctionBytes = Buffer.byteLength(request.body, 'utf8');
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (calls === 1) return ok(rejected);
    correctionPayload = payload;
    return ok(JSON.stringify(wireNoop(payload.originalInput)));
  });
  assert.equal(calls, 2, 'exactly one initial dispatch plus one bounded correction');
  assert.ok(correctionPayload.purpose === 'memory_proposal_correction' || correctionPayload.originalInput, 'the second call is the correction');
  assert.ok(correctionBytes <= settings.memoryInputBytes, 'the degraded correction fits the same input budget');
  const echo = correctionPayload.invalidResponse;
  assert.ok(typeof echo === 'string' && echo.length < rejected.length, 'the rejected-response echo was bounded, not carried whole');
  assert.ok(/\u622a\u65ad|truncated|omitted/.test(echo) || echo.length === 0, 'the echo discloses its truncation explicitly');
  assert.ok(result && (result.items || result.episodes || result.relationshipPatch !== undefined), 'the corrected result decoded against the original batch');
});

test('memory model call timeout follows settings.modelTimeoutMs', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.appendTurn(scope, { role: 'user', kind: 'discussion', text: longNote() });
  const batch = store.memoryBatch(scope);
  const started = Date.now();
  // A well-behaved fetch that never answers but honors the request's abort
  // signal, like the real transport: the configured 1s model timeout must
  // abort the memory call instead of the previous hardcoded 60s.
  const hanging = (_url, request) => new Promise((_resolve, reject) =>
    request.signal.addEventListener('abort', () => reject(request.signal.reason)));
  await assert.rejects(consolidateMemory({ baseUrl: 'http://fixture.invalid/v1', model: 'synthetic', anonymous: true,
    modelTimeoutMs: 1000 }, batch, undefined, hanging),
    error => ['TimeoutError', 'AbortError'].includes(error?.name) || /aborted|timeout/i.test(error?.message || ''));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `the configured timeout fired promptly (${elapsed}ms), not the hardcoded 60s`);
});

test('fitMemoryBatch reserves the undegradable correction overhead for borderline batches', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.appendTurn(scope, { role: 'user', kind: 'discussion', text: longNote() });
  const { probe, fixedOverhead } = borderlineSettings(store);
  // A budget that fits the initial request alone but not initial + correction
  // overhead must still yield a workable (shrunk) batch through the same loop,
  // never a memory_request_budget_exceeded dead end.
  const settings = { baseUrl: 'http://fixture.invalid/v1', model: 'synthetic', anonymous: true,
    memoryInputBytes: probe.bytes + Math.floor(fixedOverhead / 2) };
  const { fitMemoryBatch } = require('../src/memory-engine.cjs');
  const batch = fitMemoryBatch(store, scope, settings, { maxBytes: 200000, batchLimit: 32 });
  assert.ok(batch, 'the fit loop shrinks the batch instead of failing');
  const fitted = prepareMemoryRequest(settings, batch);
  assert.ok(fitted.bytes + (fitted.correction('', Object.assign(Error('m'), { code: 'invalid_memory_wire_fields', field: 'items' })).bytes - fitted.bytes) <= settings.memoryInputBytes,
    'the fitted batch keeps room for one bounded correction');
});
