'use strict';
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext, buildDraftContext, PROMPT_VERSION } = require('../src/assistant-context.cjs');
const { prepareAssistantRequest, assistModel, imageContextFor } = require('../src/assistant-model.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const settings = { baseUrl: 'http://synthetic.invalid/v1', model: 'synthetic-vision', anonymous: true };
const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  // Use the normalized native QQ consumer shape, with exact string IDs and
  // incoming/outgoing image records rather than invented model-only captions.
  const records = [true, false, true].map((outgoing, index) => normalize(raw(String(900719925474300000n + BigInt(index)), outgoing,
    { msgTime: String(1791888000 + index), elements: [{ picElement: { sourcePath: '/synthetic/never-read.png' } }] }), scope));
  store.add(scope, records); store.setGoal(scope, '与她发展双方愿意的恋爱关系');
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '图片里有什么？自然接她的话，不推断她的心情。' });
  const args = { scope, records, turn, companion: store.getCompanion(scope), settings, requestId: 'synthetic-vision-context', coverage: { status: 'partial' },
    imageMessageIds: records.map(record => record.messageId) };
  const images = [records[1], records[0]].map((record, index) => ({ messageId: record.messageId, index: 0, bytes: 24,
    // Fake input attribution must not override the actual QQ source metadata.
    speaker: 'fake speaker', at: '2099-01-01T00:00:00Z', url: `data:image/png;base64,synthetic${index}` }));
  const prepared = buildContext(args); prepared.images = images;
  prepared.mediaContext = { mode: 'automatic', omitted: [{ sourceId: `qq:${records[2].messageId}`, index: 0, reason: 'cache_missing', path: '/private/cache.png' }] };
  return { store, args, images, prepared };
}
function userPayload(body) { const content = JSON.parse(body).messages[1].content; return JSON.parse(Array.isArray(content) ? content[0].text : content); }
test('image order, source attribution and missing-cache boundaries are model visible before budgeting', t => {
  const { prepared, images, args } = fixture(t);
  const request = prepareAssistantRequest(settings, { ...prepared.payload, mediaContext: prepared.mediaContext }, images);
  const payload = userPayload(request.serialized), packet = request.request;
  assert.equal(payload.imageContext.version, 1); assert.equal(payload.imageContext.mode, 'automatic');
  assert.deepEqual(payload.imageContext.attached, images.map((image, index) => ({ ordinal: index + 1, sourceId: `qq:${image.messageId}`, index: 0,
    speaker: args.records.find(record => record.messageId === image.messageId).direction === 'outgoing' ? '我' : '对方',
    at: new Date(args.records.find(record => record.messageId === image.messageId).timestamp).toISOString() })));
  assert.deepEqual(payload.imageContext.omitted, [{ sourceId: `qq:${args.records[2].messageId}`, index: 0, reason: 'cache_missing' }]);
  assert.equal(payload.mediaContext, undefined); assert.ok(!JSON.stringify(payload).includes('data:image/')); assert.ok(!JSON.stringify(payload).includes('/private/cache'));
  assert.deepEqual(packet.messages[1].content.slice(1).map(part => part.image_url), images.map(image => ({ url: image.url, detail: 'auto' })));
  const textPacket = { ...packet, messages: [packet.messages[0], { role: 'user', content: JSON.stringify(payload) }] };
  assert.equal(request.requestBytes, Buffer.byteLength(JSON.stringify(textPacket)));
  assert.ok(packet.messages[0].content.includes('imageContext.attached')); assert.ok(packet.messages[0].content.includes('心情'));
  assert.ok(request.requestBytes > prepareAssistantRequest(settings, prepared.payload).requestBytes);
  assert.deepEqual(request.payload, payload);
});
test('metadata cannot refer to foreign, excluded or private sources and cannot carry paths', t => {
  const { prepared, images, args } = fixture(t);
  assert.equal(typeof imageContextFor, 'function');
  assert.throws(() => imageContextFor(prepared.payload, [{ ...images[0], messageId: '900719925474399999' }], {}), /图片.*来源/);
  assert.throws(() => imageContextFor({ ...prepared.payload, sources: prepared.payload.sources.map(source => source.id === `qq:${images[0].messageId}` ? { ...source, excluded: true } : source) }, images, {}), /图片.*来源/);
  const context = imageContextFor(prepared.payload, images, { mode: 'automatic', omitted: [
    { sourceId: 'qq:900719925474399999', index: 0, reason: 'cache_missing' },
    { sourceId: `private:${args.turn.id}`, index: 0, reason: 'cache_missing' },
    { sourceId: `qq:${args.records[2].messageId}`, index: 0, reason: 'PRIVATE_CONTENT_路径', url: 'data:image/png;base64,secret' }] });
  assert.deepEqual(context.omitted, [{ sourceId: `qq:${args.records[2].messageId}`, index: 0, reason: 'unavailable' }]);
  assert.ok(!JSON.stringify(context).includes('PRIVATE_CONTENT')); assert.ok(!JSON.stringify(context).includes('data:image/'));
});
test('assembler budgets the source-bound image map and preserves older selected image sources for drafts', t => {
  const { args, images, prepared } = fixture(t);
  const context = buildContext({ ...args, imageMessageIds: [], images, mediaContext: prepared.mediaContext });
  assert.deepEqual(context.payload.imageContext.attached.map(image => image.sourceId), images.map(image => `qq:${image.messageId}`));
  assert.equal(context.manifest.inputBytes, Buffer.byteLength(JSON.stringify(context.payload)));
  assert.equal(context.manifest.serializedTextRequestBytes, prepareAssistantRequest(settings, context.payload, images).requestBytes);
  assert.deepEqual(context.images, images);
  const draft = buildDraftContext(context, withCurrentDraftControls({ intent: 'reply', quotes: [] },context.payload), args);
  assert.deepEqual(draft.payload.imageContext.attached, context.payload.imageContext.attached);
  assert.equal(draft.manifest.inputBytes, Buffer.byteLength(JSON.stringify(draft.payload)));
  assert.equal(draft.manifest.serializedTextRequestBytes, prepareAssistantRequest(settings, draft.payload, images).requestBytes);
  assert.ok(!JSON.stringify(context.manifest).includes('data:image/'));
});
test('vision attribution and grounding instructions cannot bypass the request budget or silently discard an image', async t => {
  const { prepared, images } = fixture(t);
  // Fill the same native-shaped source text until the text-only request is
  // above the minimum configured limit, then place the limit between paths.
  prepared.payload.sources[0].text += '合成预算边界。'.repeat(400);
  const textOnly = prepareAssistantRequest(settings, prepared.payload).requestBytes;
  const withImages = prepareAssistantRequest(settings, { ...prepared.payload, mediaContext: prepared.mediaContext }, images).requestBytes;
  const limited = { ...settings, assistantRequestBytes: Math.floor((textOnly + withImages) / 2) };
  assert.ok(prepareAssistantRequest(limited, prepared.payload).requestBytes <= limited.assistantRequestBytes);
  let calls = 0;
  await assert.rejects(assistModel(limited, prepared, undefined, async () => { calls++; return response('never reached'); }), /完整文字请求超出预算/);
  assert.equal(calls, 0); assert.deepEqual(prepared.images, images);
});
test('private help and its bounded natural-language recovery retain the same image attribution', async t => {
  const { prepared, images } = fixture(t), calls = [];
  prepared.payload.mediaContext = prepared.mediaContext;
  await assistModel(settings, prepared, undefined, async (_, request) => { calls.push(request.body); return response(calls.length === 1 ? 'invalid response' : '图片是表情包，不能仅凭它判断她的心情。'); });
  assert.equal(calls.length, 2);
  const first = userPayload(calls[0]), recovery = userPayload(calls[1]);
  assert.deepEqual(recovery.imageContext.attached, first.imageContext.attached);
  assert.deepEqual(recovery.originalInput.imageContext.attached, first.imageContext.attached);
  assert.deepEqual(prepared.payload.imageContext, first.imageContext);
  assert.ok(calls.every(body => JSON.parse(body).messages[1].content.length === images.length + 1));
  assert.ok(!JSON.stringify(prepared.extraRequests).includes('data:image/'));
});
test('draft projection and text-only structural repair preserve sources without pretending that pixels were resent', async t => {
  const { prepared, args, images } = fixture(t), calls = [];
  prepared.payload.purpose = 'draft_prepare'; prepared.payload.mediaContext = prepared.mediaContext;
  const planned = await assistModel(settings, prepared, undefined, async (_, request) => { calls.push(request.body); return response(calls.length === 1 ? 'invalid response' : JSON.stringify({ draftPlan: withCurrentDraftControls({ intent: 'reply', quotes: [] },prepared.payload) })); });
  const first = userPayload(calls[0]), repair = userPayload(calls[1]);
  assert.equal(typeof JSON.parse(calls[1]).messages[1].content, 'string');
  assert.deepEqual(repair.imageContext.attached, []); assert.deepEqual(repair.originalInput.imageContext.attached, []);
  assert.equal(prepared.extraRequests[0].manifest.imageCount, 0); assert.deepEqual(prepared.extraRequests[0].manifest.imageContext.attached, []);
  assert.deepEqual(prepared.payload.imageContext.attached, first.imageContext.attached);
  const draft = buildDraftContext(prepared.resultContext || prepared, planned.draftPlan, args);
  assert.deepEqual(draft.images, images); assert.deepEqual(draft.payload.imageContext.attached, first.imageContext.attached);
  for (const key of ['goal', 'userRequest', 'privateConversation']) assert.equal(draft.payload[key], undefined);
  await assistModel(settings, draft, undefined, async (_, request) => { calls.push(request.body); return response(JSON.stringify({ kind: 'draft', text: '参考表达', suggestions: [{ style: '自然', text: '哈哈，这张还挺逗的' }] })); });
  assert.deepEqual(userPayload(calls[2]).imageContext.attached, first.imageContext.attached);
  assert.equal(draft.payload.promptVersion, PROMPT_VERSION);
});
