'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext } = require('../src/assistant-context.cjs');
const { assistModel } = require('./fixtures/assistant-protocol.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const { withCurrentDraftControls } = require('./fixtures/draft-controls.cjs');

// Native/persisted consumer shapes, entirely fictional text and image bytes.
// The fake HTTP response deliberately requires a source-bound planning repair.
test('vision planning repair rebudgets the full wrapper without attaching pixels to the null envelope probe', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const settings = { model: 'synthetic', anonymous: true, baseUrl: 'http://fixture.invalid/v1', assistantRequestBytes: 64000 };
  const message = (id, own, text, timestamp, image = false) => normalize(raw(String(id), own, { msgTime: String(timestamp),
    elements: image ? [{ picElement: { sourcePath: '/synthetic/never-read.png' } }] : [{ textElement: { content: text } }] }), scope);
  const old = Array.from({ length: 24 }, (_, i) => message(20000 + i, i % 2 === 0, '旧'.repeat(800), 1700000000 + i));
  const recent = Array.from({ length: 17 }, (_, i) => message(30000 + i, i % 2 === 0, '新'.repeat(170), 1701000000 + i, i === 2));
  store.add(scope, [...old, ...recent]);
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Synthetic image repair.' });
  const images = [{ messageId: '30002', index: 0, bytes: 24, url: 'data:image/png;base64,synthetic' }];
  const relationshipContext = { version: 1, claims: old.map((m, i) => ({ id: `claim-${i}`, text: `past fact ${i}`,
    sourceIds: [`qq:${m.messageId}`], subject: 'contact', assertionKind: 'reported', reviewComplete: true })), events: [], activities: [], coverage: {} };
  const context = buildContext({ scope, records: store.messages(scope), companion: store.getCompanion(scope), turn, settings,
    requestId: 'synthetic-vision-repair', purpose: 'reply', coverage: { status: 'partial' }, images, mediaContext: { mode: 'automatic', omitted: [] }, relationshipContext });
  const beforeSourceCount = context.payload.sources.length, calls = [];
  // Preserve real wrapper pressure without relying on unrelated history to
  // fill every available byte of the ordinary request.
  settings.assistantRequestBytes=context.manifest.serializedTextRequestBytes+200;
  assert.ok(context.manifest.serializedTextRequestBytes<=settings.assistantRequestBytes);
  const result = await assistModel(settings, context, undefined, async (_url, request) => {
    const wire = JSON.parse(request.body), content = wire.messages[1].content;
    const input = JSON.parse(Array.isArray(content) ? content[0].text : content);
    calls.push({ wire, input });
    const response = calls.length === 1
      ? { kind: 'discussion', text: '虚构修复载荷'.repeat(340), draftPlan: { intent: 'reply', quotes: [] } }
      : { kind: 'discussion', text: 'Synthetic repaired plan.', draftPlan: withCurrentDraftControls({ intent: 'reply', quotes: [] }, input.originalInput) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] }) };
  });
  assert.equal(calls.length, 2);
  assert.equal(result.draftPlan.intent, 'reply');
  assert.ok(context.resultContext, 'the actual repaired context must be retained for the next stage');
  assert.ok(context.resultContext.payload.sources.length < beforeSourceCount, 'the full repair wrapper must cause real bounded source repacking');
  for (const call of calls) {
    assert.equal(call.wire.messages[1].content.length, 2, 'one actual image remains attached');
    const sourceInput = call.input.originalInput || call.input;
    assert.ok(sourceInput.sources.some(source => source.id === 'qq:30002'));
    assert.deepEqual(call.input.imageContext.attached.map(image => image.sourceId), ['qq:30002']);
    const textOnly = { ...call.wire, messages: [call.wire.messages[0], { role: 'user', content: JSON.stringify(call.input) }] };
    assert.ok(Buffer.byteLength(JSON.stringify(textOnly)) <= settings.assistantRequestBytes);
  }
});
