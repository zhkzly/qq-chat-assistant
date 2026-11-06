'use strict';
// B12 coverage: arrangementHandling is a consumption contract over actually
// delivered declared arrangements. (a) Non-arrangement contexts never see
// the field on the wire schema and a stray claim never blocks — it is
// stripped. (b) A used claim over exactly one delivered current declaration
// whose outward text already adopts the declared window gets its evidenceRef
// completed at parse time (the wire lookup-completion pattern: no model call
// spent). (c) A used claim citing a non-declaration source still rejects,
// with copy-ready guidance quoting the wire handle so the bounded repair
// round can fix the citation. Fictional fixtures; no frozen eval import.
const test = require('node:test');
const assert = require('node:assert/strict');
const { responseEnvelope } = require('../src/model-response-format.cjs');
const {consumptionContractFor}=require('../src/context/mqa-registry.cjs');
const { assistModel } = require('../src/assistant-model.cjs');
const { SourceHandleOwner } = require('../src/source-handles.cjs');

const settings = { baseUrl: 'http://synthetic.invalid/v1', model: 'gpt-6.1-sol', apiKey: 'fixture' };
const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const DECLARATION = '周六三点半以后我有空，也愿意和她一起去看旧物展。';
const ADOPTING = '周六三点半以后我都有空，可以那时候一起去。';

function basePayload() {
  return { consumptionContract:consumptionContractFor('invitation_arrangement'), purpose: 'discussion', asOf: '2026-10-01T18:10:00+08:00',
    userRequest: { sourceId: 'req:1', text: '她问到这些了，帮我回一下。' },
    intentAuthority: { sourceId: 'req:1' },
    sources: [{ id: 'req:1', type: 'request', role: 'user', at: '2026-10-01T18:10:00+08:00',
      revision: 'r1', text: '她问到这些了，帮我回一下。' },
      { id: 'qq:9001', type: 'qq', role: 'contact', at: '2026-10-01T18:00:00+08:00',
        direction: 'incoming', messageId: '9001', sequence: '1', text: '周六下午能一起去看看吗？' }] };
}
function declarationMaterial(sourceId = 'note:1') {
  return { materialClass: 'declared_arrangement', sourceId, revision: 'r1', sentence: DECLARATION,
    start: 0, end: DECLARATION.length, current: true,
    lookup: { sourceIds: [sourceId], offset: 0, maxChars: DECLARATION.length } };
}
function prepareMessage(handling, text = ADOPTING) {
  return JSON.stringify({ operation: 'prepare_message',
    answer: { suggestions: [{ text }] }, materials: [], ...(handling ? { arrangementHandling: handling } : {}) });
}
function wireOf(body) { return JSON.parse(body.messages[1].content); }
function schemaField(body, field) { return body.tools[0].function.parameters.properties[field]; }
// Wire source ids are handles, so locate the non-declaration source by its
// delivered text and cite the handle it was offered under.
function handleOfInvitation(body) {
  const wire = wireOf(body);
  for (const root of [wire, wire.originalInput]) {
    if (!root || typeof root !== 'object') continue;
    const source = (root.sources || []).find(item => item.text === '周六下午能一起去看看吗？');
    if (source) return source.id;
  }
  return undefined;
}
function declarationHandleOf(body) {
  const wire = wireOf(body);
  for (const root of [wire, wire.originalInput]) {
    if (!root || typeof root !== 'object') continue;
    const material = (root.mandatoryMaterials || [])[0];
    if (material) return material.sourceId;
  }
  return undefined;
}

test('schema: the consumption field is offered only when a declaration was actually delivered', () => {
  const bare = responseEnvelope({ model: 'gpt-6.1-sol' }, 'discussion', basePayload());
  assert.equal(bare.tools[0].function.parameters.properties.arrangementHandling, undefined,
    'a non-arrangement context never sees the field definition');
  const withMaterial = basePayload();
  withMaterial.mandatoryMaterials = [declarationMaterial()];
  const field = responseEnvelope({ model: 'gpt-6.1-sol' }, 'discussion', withMaterial)
    .tools[0].function.parameters.properties.arrangementHandling;
  assert.ok(field, 'the field rides with the delivered mandatory declaration');
  assert.ok(field.description.includes('Copy-ready used form for this request'),
    'the description carries the copy-ready example');
  assert.ok(field.description.includes(JSON.stringify('note:1')), 'the example cites the actual delivered sourceId');
  const riding = basePayload();
  riding.sources.push({ id: 'note:2', type: 'private', role: 'user', at: '2026-09-30T18:00:00+08:00', revision: 'r1',
    text: '', digest: { declarations: [{ sentence: DECLARATION, revision: 'r1', start: 0, end: DECLARATION.length,
      lookup: { sourceIds: ['note:2'], offset: 0, maxChars: DECLARATION.length } }] } });
  const ridingField = responseEnvelope({ model: 'gpt-6.1-sol' }, 'discussion', riding)
    .tools[0].function.parameters.properties.arrangementHandling;
  assert.ok(ridingField, 'declarations riding on delivered digest views expose the field too');
  assert.ok(ridingField.description.includes(JSON.stringify('note:2')));
});

test('live (a): a stray arrangementHandling claim without delivered declarations never blocks', async () => {
  const context = { payload: basePayload(), manifest: {} };
  const calls = [];
  const result = await assistModel(settings, context, undefined, async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    return response(prepareMessage({ disposition: 'used', evidenceRefs: ['whatever'] }));
  });
  assert.equal(calls.length, 1, 'no repair round: the claim is inert without a delivered declaration');
  assert.ok(result.suggestions.length, 'the legitimate response survives');
  assert.equal(result.arrangementHandling, undefined, 'the unverified disposition is stripped from the canonical result');
  assert.equal(schemaField(calls[0], 'arrangementHandling'), undefined,
    'the wire schema never offered the field in this non-arrangement context');
});

test('live (b): used over one current declaration with empty refs and adopted text completes at parse time', async () => {
  const payload = basePayload();
  payload.mandatoryMaterials = [declarationMaterial()];
  const context = { payload, manifest: {} };
  const calls = [];
  const result = await assistModel(settings, context, undefined, async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    return response(prepareMessage({ disposition: 'used', evidenceRefs: [] }));
  });
  assert.equal(calls.length, 1, 'the parse-time completion saved the bounded repair round');
  assert.equal(schemaField(calls[0], 'arrangementHandling') !== undefined, true,
    'the field was offered with the declaration delivered');
  assert.deepEqual(result.arrangementHandling.evidenceRefs, ['note:1'],
    'the only legal evidenceRef was filled programmatically');
  assert.ok((context.manifest.wireCompletions || []).some(entry =>
    entry.rule === 'arrangement-evidence-ref-completion' && entry.sourceIds[0] === 'note:1'),
    'the completion is recorded on the manifest audit lane like the lookup completions');
});

test('live (b2): completion stays conservative without content adoption', async () => {
  const payload = basePayload();
  payload.mandatoryMaterials = [declarationMaterial()];
  const context = { payload, manifest: {} };
  const calls = [];
  await assert.rejects(() => assistModel(settings, context, undefined, async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    // The outward text drops the declared window, so adoption is not proven
    // and the empty ref must NOT be auto-filled into a pass.
    return response(prepareMessage({ disposition: 'used', evidenceRefs: [] }, '周六一起去看看好呀！'));
  }), error => error.code === 'arrangement_handling_evidence_missing' || error.code === 'model_result_invalid'
    && /arrangement_handling/.test(error.message));
  assert.equal(calls.length >= 1, true, 'the request ran; the rejection path was exercised');
});

test('live (c): refs citing a non-declaration source still reject; guidance quotes the wire handle and the repair recovers', async () => {
  const payload = basePayload();
  payload.mandatoryMaterials = [declarationMaterial()];
  const context = { payload, manifest: {} };
  const calls = [];
  const result = await assistModel(settings, context, undefined, async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    const invitationHandle = handleOfInvitation(body);
    const declarationHandle = declarationHandleOf(body);
    return response(calls.length === 1
      ? prepareMessage({ disposition: 'used', evidenceRefs: [invitationHandle] })
      : prepareMessage({ disposition: 'used', evidenceRefs: [declarationHandle] }));
  });
  assert.equal(calls.length, 2, 'the wrong citation still triggers the bounded repair round');
  assert.equal(context.manifest.formatRepair.originalFailure.code, 'arrangement_handling_evidence_missing');
  const reason = context.manifest.formatRepair.reason;
  assert.ok(reason.includes('可照抄的已交付声明来源'), 'the guidance names the citable declaration');
  assert.ok(reason.includes(DECLARATION), 'the guidance quotes the declaration sentence');
  const repairHandle = declarationHandleOf(calls[1]);
  assert.ok(repairHandle && reason.includes(repairHandle),
    'the guidance quotes the wire handle (decodable), not the canonical id');
  assert.ok(!reason.includes('note:1（'), 'no canonical-id-only citation lane that would trap decode');
  assert.deepEqual(result.arrangementHandling.evidenceRefs, ['note:1'],
    'the repaired handle citation decodes back to the canonical declaration sourceId');
});

test('wire: arrangementHandling.evidenceRefs decode like every typed source array', () => {
  const owner = new SourceHandleOwner();
  const source = { id: 'note:1', type: 'private', role: 'user', revision: 'r1', text: DECLARATION };
  const snapshot = owner.preview({ purpose: 'discussion', sources: [source] }, { sources: [source] });
  snapshot.commit();
  const handle = snapshot.receipt.bindings[0].handle;
  const decoded = snapshot.decode({ arrangementHandling: { disposition: 'used', evidenceRefs: [handle] } });
  assert.deepEqual(decoded.arrangementHandling.evidenceRefs, ['note:1'],
    'a correctly copied offered handle maps back to the canonical declaration sourceId');
  assert.throws(() => snapshot.decode({ arrangementHandling: { disposition: 'used', evidenceRefs: ['s999'] } }),
    error => error.code === 'unknown_source_handle' && error.field === '$.arrangementHandling.evidenceRefs[0]',
    'an unoffered handle is rejected with an exact, actionable field path');
});
