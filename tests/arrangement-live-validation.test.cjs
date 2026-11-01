'use strict';
// Deterministic coverage for the sv-001 blind-review Gap-s1 shape: a
// response that claims adoption (arrangementHandling disposition used) of a
// delivered current declared arrangement while its outward candidate text
// drops the declared time window. The live response validation chain must
// trigger one bounded repair round whose guidance quotes the copy-ready
// original sentence (same copy-ready pattern as the lookup repair guides),
// and non-used dispositions must not gain any new blocking. Fictional
// fixtures mirroring the reviewed failure family; no frozen eval import.
const test = require('node:test');
const assert = require('node:assert/strict');
const { timeWindowTokens } = require('../src/context/evidence-digest.cjs');
const { validateArrangementHandling, deliveredDeclarationMaterials, arrangementTimeWindowGap } = require('../src/context/mqa-registry.cjs');
const { assistModel } = require('../src/assistant-model.cjs');

const settings = { baseUrl: 'http://synthetic.invalid/v1', model: 'synthetic', apiKey: 'fixture' };
const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const DECLARATION = '周六三点半以后我有空，也愿意和她一起去看旧物展。';
const DECLARATION_START = 42;

function mandatoryMaterial(overrides = {}) {
  return { materialClass: 'declared_arrangement', sourceId: 's2', revision: 'r1',
    sentence: DECLARATION, start: DECLARATION_START, end: DECLARATION_START + DECLARATION.length,
    current: true,
    lookup: { sourceIds: ['s2'], offset: DECLARATION_START, maxChars: DECLARATION.length },
    ...overrides };
}
function consumptionPayload(extra = {}) {
  return { purpose: 'discussion', asOf: '2026-10-01T18:10:00+08:00',
    userRequest: { sourceId: 's1', text: '她问到这些了，帮我回一下。' },
    intentAuthority: { sourceId: 's1' },
    sources: [{ id: 's1', type: 'request', role: 'user', at: '2026-10-01T18:10:00+08:00',
      revision: 'r1', text: '她问到这些了，帮我回一下。' },
      { id: 's3', type: 'qq', role: 'contact', at: '2026-10-01T18:00:00+08:00',
        direction: 'incoming', messageId: '9001', sequence: '1', text: '周六下午能一起去看看吗？' }],
    consumptionContract: { version: 'mqa-registry-v1', intentClass: 'invitation_arrangement',
      fields: [{ name: 'arrangementHandling', version: 'arrangement-handling-v1', required: true,
        disposition: ['used', 'conflict', 'stale', 'missing'] }] },
    mandatoryMaterials: [mandatoryMaterial()],
    ...extra };
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
    handling: { disposition: 'used', evidenceRefs: ['s2'] },
    outboundTexts: ['周六一起去看看好呀！'] });
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'arrangement_time_window_missing');
  assert.deepEqual(checked.missingTimeWindows, ['三点半']);
  assert.equal(checked.copyReady[0].sentence, DECLARATION);
  assert.deepEqual(checked.copyReady[0].lookup.sourceIds, ['s2']);
});

test('registry rule: complete adoption and non-used dispositions stay unblocked', () => {
  assert.equal(validateArrangementHandling({ intentClass: 'invitation_arrangement',
    delivered: [mandatoryMaterial()],
    handling: { disposition: 'used', evidenceRefs: ['s2'] },
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
  const cited = mandatoryMaterial({ sourceId: 's2' });
  const other = mandatoryMaterial({ sourceId: 's9', sentence: '周日两点以后有空，愿意一起去。' });
  const gap = arrangementTimeWindowGap([other, cited], ['周六三点半以后都有空，一起去。']);
  assert.equal(gap.sourceId, 's9', 'the uncited declaration with the missing window is reported');
});

test('deliveredDeclarationMaterials reconstructs materials from riding digest declarations', () => {
  const source = { id: 's2', type: 'private', role: 'user', at: '2026-09-30T18:00:00+08:00', revision: 'r1',
    text: '', digest: { declarations: [{ sentence: DECLARATION, revision: 'r1',
      start: DECLARATION_START, end: DECLARATION_START + DECLARATION.length,
      lookup: { sourceIds: ['s2'], offset: DECLARATION_START, maxChars: DECLARATION.length } }] },
    delivery: { version: 'source-delivery-v1', status: 'partial', start: 10000, end: 14000, originalCharLength: 15617 } };
  const materials = deliveredDeclarationMaterials([source], { asOf: '2026-10-01T18:10:00+08:00' });
  assert.equal(materials.length, 1);
  assert.equal(materials[0].sourceId, 's2');
  assert.equal(materials[0].current, true);
  assert.deepEqual(materials[0].lookup.sourceIds, ['s2']);
});

test('live chain: incomplete used adoption triggers one bounded repair quoting the copy-ready sentence', async () => {
  const context = { payload: consumptionPayload(), manifest: {} };
  const calls = [];
  const result = await assistModel(settings, context, undefined, async (_, request) => {
    calls.push(JSON.parse(request.body));
    return response(calls.length === 1
      ? JSON.stringify({ operation: 'prepare_message',
          answer: { suggestions: [{ text: '我主要是帮忙核对录音内容。周六一起去看看好呀！' }] },
          materials: [], arrangementHandling: { disposition: 'used', evidenceRefs: ['s2'] } })
      : JSON.stringify({ operation: 'prepare_message',
          answer: { suggestions: [{ text: '周六三点半以后我都有空，可以那时候一起去。' }] },
          materials: [], arrangementHandling: { disposition: 'used', evidenceRefs: ['s2'] } }));
  });
  assert.equal(calls.length, 2, 'exactly one bounded repair round ran');
  assert.ok(context.manifest.formatRepair && context.manifest.formatRepair.attempts === 1);
  assert.equal(context.manifest.formatRepair.originalFailure.code, 'arrangement_time_window_missing');
  assert.match(context.manifest.formatRepair.reason, /周六三点半以后我有空/, 'the copy-ready original sentence rides in the repair guidance');
  assert.match(context.manifest.formatRepair.reason, /"sourceIds"\s*:\s*\["s2"\]/, 'a copy-ready lookup handle rides in the repair guidance');
  const repairPayload = context.extraRequests[0].payload;
  // The detailed rule and copy-ready guidance reach the repair model through
  // validationIssues (each entry carries its full message).
  const issue = (repairPayload.validationIssues || []).find(entry => entry.code === 'arrangement_time_window_missing');
  assert.ok(issue, 'the arrangement issue reaches the repair round');
  assert.match(issue.message, /周六三点半以后我有空/);
  assert.match(issue.message, /"sourceIds"\s*:\s*\["s2"\]/);
  assert.ok(result.suggestions.some(suggestion => suggestion.text.includes('三点半以后')),
    'the repaired outward candidate carries the declared time window');
  assert.equal(result.arrangementHandling.disposition, 'used');
});

test('live chain: non-used dispositions and complete adoptions pass without any repair', async () => {
  for (const [handling, suggestion] of [
    [{ disposition: 'stale', evidenceRefs: [], reason: '声明是一周前的，需要先核对是否仍有效' }, '这周六方便一起去看吗？'],
    [{ disposition: 'used', evidenceRefs: ['s2'] }, '周六三点半以后我都有空，可以那时候一起去。']]) {
    const context = { payload: consumptionPayload(), manifest: {} };
    const calls = [];
    await assistModel(settings, context, undefined, async (_, request) => {
      calls.push(JSON.parse(request.body));
      return response(JSON.stringify({ operation: 'prepare_message',
        answer: { suggestions: [{ text: suggestion }] }, materials: [], arrangementHandling: handling }));
    });
    assert.equal(calls.length, 1, 'no repair round for ' + handling.disposition);
  }
});

test('live chain: without delivered declarations the validation adds no blocking', async () => {
  const payload = consumptionPayload();
  delete payload.mandatoryMaterials; delete payload.consumptionContract;
  const context = { payload, manifest: {} };
  const calls = [];
  const result = await assistModel(settings, context, undefined, async (_, request) => {
    calls.push(JSON.parse(request.body));
    return response(JSON.stringify({ operation: 'prepare_message',
      answer: { suggestions: [{ text: '周六一起去看看好呀！' }] }, materials: [] }));
  });
  assert.equal(calls.length, 1);
  assert.ok(result.suggestions.length);
});

test('live chain: a used claim is enforced even when only riding digest declarations were delivered', async () => {
  const payload = consumptionPayload();
  delete payload.mandatoryMaterials; delete payload.consumptionContract;
  payload.sources.push({ id: 's2', type: 'private', role: 'user', at: '2026-09-30T18:00:00+08:00', revision: 'r1',
    digest: { declarations: [{ sentence: DECLARATION, revision: 'r1', start: DECLARATION_START,
      end: DECLARATION_START + DECLARATION.length,
      lookup: { sourceIds: ['s2'], offset: DECLARATION_START, maxChars: DECLARATION.length } }] },
    delivery: { version: 'source-delivery-v1', status: 'partial', start: 10000, end: 14000, originalCharLength: 15617,
      lookup: { sourceId: 's2', revision: 'r1', offset: 14000 } } });
  const context = { payload, manifest: {} };
  const calls = [];
  await assistModel(settings, context, undefined, async (_, request) => {
    calls.push(JSON.parse(request.body));
    return response(calls.length === 1
      ? JSON.stringify({ operation: 'prepare_message',
          answer: { suggestions: [{ text: '周六一起去看看好呀！' }] }, materials: [],
          arrangementHandling: { disposition: 'used', evidenceRefs: ['s2'] } })
      : JSON.stringify({ operation: 'prepare_message',
          answer: { suggestions: [{ text: '周六三点半以后我都有空，可以那时候一起去。' }] }, materials: [],
          arrangementHandling: { disposition: 'used', evidenceRefs: ['s2'] } }));
  });
  assert.equal(calls.length, 2, 'the claim-based trigger fired one repair round');
  assert.equal(context.manifest.formatRepair.originalFailure.code, 'arrangement_time_window_missing');
  assert.ok((context.extraRequests[0].payload.validationIssues || [])
    .some(entry => entry.code === 'arrangement_time_window_missing' && entry.message.includes('周六三点半以后我有空')),
    'the copy-ready sentence reaches the repair round through the riding declarations alone');
});
