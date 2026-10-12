'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, sameScope } = require('../src/messages.cjs');
const { Store } = require('../src/store.cjs');
const { parseAdvice, generate, contextFor } = require('../src/model.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
test('normalization preserves large IDs, both directions and selected account/contact', () => {
  const incoming = normalize(raw(), scope), outgoing = normalize(raw('72057594037927938', true), scope);
  assert.equal(incoming.messageId, '72057594037927937'); assert.equal(incoming.direction, 'incoming');
  assert.equal(outgoing.direction, 'outgoing'); assert.equal(incoming.source, 'desktop-qq-native');
  for (const invalid of [{ chatType: 2 }, { peerUid: 'u_other' }, { peerUin: '2222222222' },
    { senderUid: 'u_fake' }, { senderUin: '2222222222' }, { msgId: 72057594037927940 }, { msgSeq: 2 }, { msgTime: 'invalid' }])
    assert.equal(normalize(raw(undefined, false, invalid), scope), null, JSON.stringify(invalid));
  assert.equal(sameScope(scope, { ...scope, accountUin: '2222222222' }), false);
});
test('outgoing is actual only after confirmed success; clipboard and drafts are not QQ records', () => {
  for (const sendStatus of [0, 1, 3]) assert.equal(normalize(raw(undefined, true, { sendStatus }), scope), null);
  assert.equal(normalize(raw(undefined, true, { msgSeq: '0' }), scope), null);
  assert.equal(normalize({ kind: 'draft', text: 'copied' }, scope), null);
});
test('recalled content is hidden and media types do not claim OCR/transcription', () => {
  assert.equal(normalize(raw(undefined, false, { recallTime: '1' }), scope).text, '[已撤回]');
  assert.equal(normalize(raw(undefined, false, { elements: [{ picElement: { sourcePath: '/private/file' } },
    { pttElement: { secret: 'ignored' } }, { textElement: { content: '<script>hello</script>' } }] }), scope).text,
    '[图片][语音]<script>hello</script>');
});
test('SQLite deduplicates IDs within each scope and rolls back an invalid batch', () => {
  const store = new Store(':memory:');
  const message = normalize(raw(), scope);
  assert.equal(store.add(scope, [message]), 1); assert.equal(store.add(scope, [message]), 0);
  const second = { ...scope, accountUid: 'u_second', accountUin: '2222222222' };
  store.add(second, [{ ...message, ...second, text: 'Second account' }]);
  assert.equal(store.messages(scope)[0].text, message.text); assert.equal(store.messages(second)[0].text, 'Second account');
  assert.throws(() => store.add(scope, [normalize(raw('72057594037927939'), scope), { ...message, kind: 'draft' }]), /provenance/);
  assert.equal(store.messages(scope).length, 1); store.close();
});
test('exports contain scope, stable IDs and explicit coverage; never include drafts', () => {
  const store = new Store(':memory:'); store.add(scope, [normalize(raw(), scope)]);
  store.setCoverage(scope, { status: 'partial', pages: 2 });
  const out = JSON.parse(store.export(scope, 'json').data);
  assert.equal(out.messages[0].messageId, '72057594037927937'); assert.equal(out.coverage.status, 'partial');
  assert.equal(out.scope.peerUin, scope.peerUin); assert.equal(out.drafts, undefined);
  assert.match(store.export(scope, 'txt').data, /不保证.*全部历史/); store.close();
});
test('advice parser validates all three alternatives rather than trusting raw model JSON', () => {
  const value = { analysis: '接住她的疲惫', suggestions: [1, 2, 3].map(i => ({ style: `风格${i}`, text: `辛苦啦${i}` })) };
  assert.equal(parseAdvice(JSON.stringify(value)).suggestions.length, 3);
  for (const invalid of [{ ...value, suggestions: [] }, { ...value, analysis: 5 },
    { ...value, suggestions: [value.suggestions[0], value.suggestions[1], { style: 'a', text: '' }] }])
    assert.throws(() => parseAdvice(JSON.stringify(invalid)), /格式/);
});
test('model projection marks quoted data, includes both directions and bounds old context', async () => {
  const records = [normalize(raw(), scope), normalize(raw('72057594037927938', true), scope)];
  let payload;
  const value = { analysis: '接住她的疲惫', suggestions: [1, 2, 3].map(i => ({ style: `风格${i}`, text: `辛苦啦${i}` })) };
  const result = await generate({ baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'fixture-only', model: 'fixture' },
    records, '简短自然', undefined, async (url, request) => {
      assert.equal(String(url), 'http://127.0.0.1:8317/v1/chat/completions'); payload = JSON.parse(request.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) };
    });
  const quoted = JSON.parse(payload.messages[1].content).quotedConversation;
  assert.deepEqual(quoted.map(x => x.speaker), ['对方', '我']); assert.equal(result.suggestions.length, 3);
  assert.equal(payload.tools, undefined); assert.match(payload.messages[0].content, /不可信/);
  const many = Array.from({ length: 100 }, (_, i) => ({ ...records[0], messageId: String(i + 1), text: '长'.repeat(9000) }));
  assert.ok(contextFor(many, '自然').reduce((n, x) => n + x.text.length, 0) <= 18000);
});
