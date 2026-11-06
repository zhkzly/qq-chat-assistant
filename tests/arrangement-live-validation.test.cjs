'use strict';
// Deterministic coverage for the sv-001 blind-review Gap-s1 shape: a
// response that claims adoption (arrangementHandling disposition used) of a
// delivered current declared arrangement while its outward candidate text
// drops the declared time window. The live response validation chain must
// trigger one bounded repair round whose guidance quotes the copy-ready
// original sentence (same copy-ready pattern as the lookup repair guides),
// and non-used dispositions must not gain any new blocking. Fictional
// fixtures mirroring the reviewed failure family; no frozen eval import.
// B12 update: the model only ever sees wire s# handles, so live responses
// cite the handle the request actually offered; handle citations must decode
// back to the canonical declaration sourceId, and the repair guidance quotes
// wire handles so the bounded round can actually act on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { timeWindowTokens } = require('../src/context/evidence-digest.cjs');
const { validateArrangementHandling, deliveredDeclarationMaterials, arrangementTimeWindowGap } = require('../src/context/mqa-registry.cjs');
const { assistModel } = require('../src/assistant-model.cjs');

// A result-tool model so the offered wire schema is inspectable in the
// captured requests (json_object mode carries no tools array).
const settings = { baseUrl: 'http://synthetic.invalid/v1', model: 'gpt-6.1-sol', apiKey: 'fixture' };
const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const DECLARATION = '周六三点半以后我有空，也愿意和她一起去看旧物展。';
const DECLARATION_START = 42;

function mandatoryMaterial(overrides = {}) {
  return { materialClass: 'declared_arrangement', sourceId: 'note:1', revision: 'r1',
    sentence: DECLARATION, start: DECLARATION_START, end: DECLARATION_START + DECLARATION.length,
    current: true,
    lookup: { sourceIds: ['note:1'], offset: DECLARATION_START, maxChars: DECLARATION.length },
    ...overrides };
}
function consumptionPayload(extra = {}) {
  return { purpose: 'discussion', asOf: '2026-10-01T18:10:00+08:00',
    userRequest: { sourceId: 'req:1', text: '她问到这些了，帮我回一下。' },
    intentAuthority: { sourceId: 'req:1' },
    sources: [{ id: 'req:1', type: 'request', role: 'user', at: '2026-10-01T18:10:00+08:00',
      revision: 'r1', text: '她问到这些了，帮我回一下。' },
      { id: 'qq:9001', type: 'qq', role: 'contact', at: '2026-10-01T18:00:00+08:00',
        direction: 'incoming', messageId: '9001', sequence: '1', text: '周六下午能一起去看看吗？' }],
    consumptionContract: { version: 'mqa-registry-v1', intentClass: 'invitation_arrangement',
      fields: [{ name: 'arrangementHandling', version: 'arrangement-handling-v1', required: true,
        disposition: ['used', 'conflict', 'stale', 'missing'] }] },
    mandatoryMaterials: [mandatoryMaterial()],
    ...extra };
}
// The model only ever sees wire s# handles: extract the handle this request
// actually offered for the delivered declaration (mandatory materials or the
// declarations riding on a delivered digest view).
function wireOf(body) { return JSON.parse(body.messages[1].content); }
function declarationHandleOf(body) {
  const wire = wireOf(body);
  for (const root of [wire, wire.originalInput]) {
    if (!root || typeof root !== 'object') continue;
    const material = (root.mandatoryMaterials || [])[0];
    if (material) return material.sourceId;
    const source = (root.sources || []).find(item => item.digest && Array.isArray(item.digest.declarations) && item.digest.declarations.length);
    if (source) return source.id;
  }
  return undefined;
}

test('timeWindowTokens extracts the schedulable day and clock tokens from a declaration', () => {
  const tokens = timeWindowTokens(DECLARATION);
  assert.ok(tokens.includes('周六'), 'the declared day is a constraint token: ' + tokens.join(','));
  assert.ok(tokens.includes('三点半'), 'the declared clock time is a constraint token: ' + tokens.join(','));
  // Daypart-only declarations impose no enumerable clock constraint.
  assert.deepEqual(timeWindowTokens('我愿意一起去，不谈具体时间。'), []);
  // Full-width clock digits normalize to ASCII so containment is comparable.
  assert.ok(timeWindowTokens('周６１０：３０以后有空').includes('10:30'), 'width normalization keeps token forms comparable');
});

test('registry rule: used without the declared time window fails with copy-ready guidance', () => {
  const checked = validateArrangementHandling({ intentClass: 'invitation_arrangement',
    delivered: [mandatoryMaterial()],
    handling: { disposition: 'used', evidenceRefs: ['note:1'] },
    outboundTexts: ['周六一起去看看好呀！'] });
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'arrangement_time_window_missing');
  assert.deepEqual(checked.missingTimeWindows, ['三点半']);
  assert.equal(checked.copyReady[0].sentence, DECLARATION);
  assert.deepEqual(checked.copyReady[0].lookup.sourceIds, ['note:1']);
});

test('registry rule: complete adoption and non-used dispositions stay unblocked', () => {
  assert.equal(validateArrangementHandling({ intentClass: 'invitation_arrangement',
    delivered: [mandatoryMaterial()],
    handling: { disposition: 'used', evidenceRefs: ['note:1'] },
    outboundTexts: ['周六三点半以后我都有空，可以那时候一起去。'] }).ok, true);
  for (const disposition of ['conflict', 'stale', 'missing']) {
    const checked = validateArrangementHandling({ intentClass: 'invitation_arrangement',
      delivered: [mandatoryMaterial()],
      handling: { disposition, evidenceRefs: [], reason: '声明与来信时间冲突，需要先核对' },
      outboundTexts: ['这周先不约，等下次再说。'] });
    assert.equal(checked.ok, true, disposition + ' with a reason gains no new blocking');
  }
});

test('registry rule: the gap check cites only declarations the response claimed', () => {
  const cited = mandatoryMaterial({ sourceId: 'note:1' });
  const other = mandatoryMaterial({ sourceId: 'note:9', sentence: '周日两点以后有空，愿意一起去。' });
  const gap = arrangementTimeWindowGap([other, cited], ['周六三点半以后都有空，一起去。']);
  assert.equal(gap.sourceId, 'note:9', 'the uncited declaration with the missing window is reported');
});

test('deliveredDeclarationMaterials reconstructs materials from riding digest declarations', () => {
  const source = { id: 'note:2', type: 'private', role: 'user', at: '2026-09-30T18:00:00+08:00', revision: 'r1',
    text: '', digest: { declarations: [{ sentence: DECLARATION, revision: 'r1',
      start: DECLARATION_START, end: DECLARATION_START + DECLARATION.length,
      lookup: { sourceIds: ['note:2'], offset: DECLARATION_START, maxChars: DECLARATION.length } }] },
    delivery: { version: 'source-delivery-v1', status: 'partial', start: 10000, end: 14000, originalCharLength: 15617 } };
  const materials = deliveredDeclarationMaterials([source], { asOf: '2026-10-01T18:10:00+08:00' });
  assert.equal(materials.length, 1);
  assert.equal(materials[0].sourceId, 'note:2');
  assert.equal(materials[0].current, true);
  assert.deepEqual(materials[0].lookup.sourceIds, ['note:2']);
});

test('live chain: incomplete used adoption triggers one bounded repair quoting the copy-ready sentence', async () => {
  const context = { payload: consumptionPayload(), manifest: {} };
  const calls = [];
  const result = await assistModel(settings, context, undefined, async (_, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    const declarationHandle = declarationHandleOf(body);
    return response(calls.length === 1
      ? JSON.stringify({ operation: 'prepare_message',
          answer: { suggestions: [{ text: '我主要是帮忙核对录音内容。周六一起去看看好呀！' }] },
          materials: [], arrangementHandling: { disposition: 'used', evidenceRefs: [declarationHandle] } })
      : JSON.stringify({ operation: 'prepare_message',
          answer: { suggestions: [{ text: '周六三点半以后我都有空，可以那时候一起去。' }] },
          materials: [], arrangementHandling: { disposition: 'used', evidenceRefs: [declarationHandle] } }));
  });
  assert.equal(calls.length, 2, 'exactly one bounded repair round ran');
  assert.ok(context.manifest.formatRepair && context.manifest.formatRepair.attempts === 1);
  assert.equal(context.manifest.formatRepair.originalFailure.code, 'arrangement_time_window_missing');
  assert.match(context.manifest.formatRepair.reason, /周六三点半以后我有空/, 'the copy-ready original sentence rides in the repair guidance');
  const quotedHandle = declarationHandleOf(calls[0]);
  assert.ok(quotedHandle, 'the declaration was offered as a wire handle');
  assert.ok(context.manifest.formatRepair.reason.includes('"sourceIds":["' + quotedHandle + '"]'),
    'a copy-ready lookup handle in wire form (decodable) rides in the repair guidance');
  const repairPayload = context.extraRequests[0].payload;
  // The detailed rule and copy-ready guidance reach the repair model through
  // validationIssues (each entry carries its full message).
  const issue = (repairPayload.validationIssues || []).find(entry => entry.code === 'arrangement_time_window_missing');
  assert.ok(issue, 'the arrangement issue reaches the repair round');
  assert.match(issue.message, /周六三点半以后我有空/);
  assert.ok(issue.message.includes('"sourceIds":["' + quotedHandle + '"]'),
    'the copy-ready lookup quotes the wire handle');
  assert.equal(repairPayload.originalInput.mandatoryMaterials ? 'canonical' : 'wire', 'canonical');
  assert.equal(bodyField(calls[1], 'arrangementHandling') !== undefined, true,
    'the repair schema still offers the consumption field with the declaration delivered');
  assert.ok(result.suggestions.some(suggestion => suggestion.text.includes('三点半以后')),
    'the repaired outward candidate carries the declared time window');
  assert.equal(result.arrangementHandling.disposition, 'used');
  assert.deepEqual(result.arrangementHandling.evidenceRefs, ['note:1'],
    'the handle citation decodes back to the canonical declaration sourceId');
});

test('live chain: non-used dispositions and complete adoptions pass without any repair', async () => {
  for (const [handling, suggestion] of [
    [{ disposition: 'stale', evidenceRefs: [], reason: '声明是一周前的，需要先核对是否仍有效' }, '这周六方便一起去看吗？'],
    [{ disposition: 'used', evidenceRefs: null }, '周六三点半以后我都有空，可以那时候一起去。']]) {
    const context = { payload: consumptionPayload(), manifest: {} };
    const calls = [];
    await assistModel(settings, context, undefined, async (_, request) => {
      const body = JSON.parse(request.body);
      calls.push(body);
      // The used claim cites the offered wire handle; the completion path is
      // covered separately in arrangement-b12-gating.test.cjs.
      const claim = handling.disposition === 'used'
        ? { ...handling, evidenceRefs: [declarationHandleOf(body)] } : handling;
      return response(JSON.stringify({ operation: 'prepare_message',
        answer: { suggestions: [{ text: suggestion }] }, materials: [], arrangementHandling: claim }));
    });
    assert.equal(calls.length, 1, 'no repair round for ' + handling.disposition);
  }
});

test('live chain: without delivered declarations the validation adds no blocking', async () => {
  const payload = consumptionPayload();
  delete payload.mandatoryMaterials; // The explicit active request contract remains; declarations alone are navigation.
  const context = { payload, manifest: {} };
  const calls = [];
  const result = await assistModel(settings, context, undefined, async (_, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    return response(JSON.stringify({ operation: 'prepare_message',
      answer: { suggestions: [{ text: '周六一起去看看好呀！' }] }, materials: [] }));
  });
  assert.equal(calls.length, 1);
  assert.ok(result.suggestions.length);
  assert.equal(bodyField(calls[0], 'arrangementHandling'), undefined,
    'the wire schema never offered the consumption field without delivered declarations');
});

test('live chain: a used claim is enforced even when only riding digest declarations were delivered', async () => {
  const payload = consumptionPayload();
  delete payload.mandatoryMaterials; // The explicit active request contract remains; declarations alone are navigation.
  payload.sources.push({ id: 'note:2', type: 'private', role: 'user', at: '2026-09-30T18:00:00+08:00', revision: 'r1',
    digest: { declarations: [{ sentence: DECLARATION, revision: 'r1', start: DECLARATION_START,
      end: DECLARATION_START + DECLARATION.length,
      lookup: { sourceIds: ['note:2'], offset: DECLARATION_START, maxChars: DECLARATION.length } }] },
    delivery: { version: 'source-delivery-v1', status: 'partial', start: 10000, end: 14000, originalCharLength: 15617,
      lookup: { sourceId: 'note:2', revision: 'r1', offset: 14000 } } });
  const context = { payload, manifest: {} };
  const calls = [];
  await assistModel(settings, context, undefined, async (_, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    const declarationHandle = declarationHandleOf(body);
    return response(calls.length === 1
      ? JSON.stringify({ operation: 'prepare_message',
          answer: { suggestions: [{ text: '周六一起去看看好呀！' }] }, materials: [],
          arrangementHandling: { disposition: 'used', evidenceRefs: [declarationHandle] } })
      : JSON.stringify({ operation: 'prepare_message',
          answer: { suggestions: [{ text: '周六三点半以后我都有空，可以那时候一起去。' }] }, materials: [],
          arrangementHandling: { disposition: 'used', evidenceRefs: [declarationHandle] } }));
  });
  assert.equal(calls.length, 2, 'the claim-based trigger fired one repair round');
  assert.equal(context.manifest.formatRepair.originalFailure.code, 'arrangement_time_window_missing');
  assert.ok((context.extraRequests[0].payload.validationIssues || [])
    .some(entry => entry.code === 'arrangement_time_window_missing' && entry.message.includes('周六三点半以后我有空')),
    'the copy-ready sentence reaches the repair round through the riding declarations alone');
});

// The tool schema offered to the model for this body (assistant_result only).
function bodyField(body, field) {
  return body.tools[0].function.parameters.properties[field];
}
