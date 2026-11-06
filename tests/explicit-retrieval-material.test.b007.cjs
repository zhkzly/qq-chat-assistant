'use strict';
// Deterministic coverage for the sv-001 blind-review Gap-s2 material chain:
// an explicitly retrieved range (model lookup) is user intent — the final
// composed request must deliver an overlapping window of it and mark the
// retrieved key facts available on the MQA material surface, instead of
// recording the read as executed while omitting its content (the observed
// requestStatus:"omitted" that let the model call an already-retrieved fact
// insufficient). Also covers the declarations ride-along that keeps a
// declared arrangement verbatim when a range view replaces its digest.
// Fictional fixtures mirroring the reviewed failure family; no eval import.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext } = require('../src/assistant-context.cjs');
const { compileContext } = require('../src/context/admission-compiler.cjs');
const { boundedSourceView } = require('../src/context/source-delivery.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

function incoming(id, text, at) {
  return normalize(raw(String(id), false, { msgTime: String(Math.floor(Date.parse(at) / 1000)),
    elements: [{ textElement: { content: text } }] }), scope);
}
function entryParagraph(i) {
  return '第' + i + '项是物件' + i + '。我到整理桌时，师傅已经把它放好。我负责照着登记纸核对这件东西的说明，不负责估价。我们把能确认的现象按原话记下来，不补一个没有来源的往事。';
}
function declarationNote(extraEntries) {
  const head = '这是留给自己的原始手记，方便和你商量真实近况。里面有他人的登记信息，不能自动变成对外可说的故事。';
  const middle = '这周末的安排我也在这里给你说清楚：周六三点半以后我有空，也愿意和她一起去看旧物展；之前还有一件自己的事，不需要拿去和她解释。';
  const parts = [head];
  for (let i = 1; i <= (extraEntries || 8); i++) parts.push(entryParagraph(i));
  parts.push(middle);
  for (let i = (extraEntries || 8) + 1; i <= (extraEntries || 8) + 6; i++) parts.push(entryParagraph(i));
  return parts.join('\n');
}
function tailMarkerNote(extraEntries) {
  // The re-record fact sits in the tail region the model range-reads.
  const head = '这是留给自己的原始手记。';
  const parts = [head];
  for (let i = 1; i <= (extraEntries || 40); i++) parts.push(entryParagraph(i));
  parts.push('后来发现一个停顿不自然，又重录过一段。');
  return parts.join('\n');
}
function scenario(t, { noteText, budget = 48000, retrieved }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.add(scope, [incoming(9001, '你前阵子说帮旧物展录了点什么？周六下午能一起去看看吗？', '2026-10-01T18:00:00+08:00')]);
  store.setGoal(scope, '和她自然交流，分享自己的真实近况，也找到双方愿意做的事。');
  const note = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: noteText, createdAt: '2026-09-30T18:00:00+08:00' });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她又问到这些，帮我接一下。', createdAt: '2026-10-01T18:10:00+08:00' });
  return { store, note, args: { scope, records: store.messages(scope), companion: store.getCompanion(scope), turn,
    purpose: 'discussion', coverage: { status: 'partial', pages: 1 }, requestId: 'explicit-retrieval-case',
    byteBudget: budget, asOf: '2026-10-01T18:10:00+08:00', retrievedSources: retrieved || [],
    invocation: { origin: 'user', trigger: 'private_request', requestedPurpose: 'discussion' }, store } };
}
function rangeReadOf(store, noteId, offset, maxChars) {
  const original = store.memorySources(scope).find(source => source.id === 'private:' + noteId);
  assert.ok(original, 'the note source exists in the store');
  const projected = boundedSourceView(original, { offset, maxChars });
  assert.ok(projected, 'the range projects');
  return { ...projected, requestedRange: { offset, maxChars } };
}

test('admission compiler marks explicitly retrieved ranges as available materials', () => {
  const text = tailMarkerNote(40);
  const tailStart = text.indexOf('后来发现一个停顿不自然');
  const current = { id: 's1', type: 'request', role: 'user', at: '2026-10-01T18:10:00+08:00', revision: 'r1',
    text: '她又问到这些，帮我接一下。' };
  const note = { id: 's2', type: 'private', role: 'user', at: '2026-09-30T18:00:00+08:00', revision: 'r1', text };
  const compiled = compileContext({ asOf: '2026-10-01T18:10:00+08:00', purpose: 'discussion',
    byteBudget: 6000,
    current, intentSource: current, candidateSources: [note],
    explicitLookups: [{ id: 's2', offset: tailStart, maxChars: 2000 }] });
  const retrieved = compiled.payload.materialRequirements.retrievedMaterials || [];
  assert.equal(retrieved.length, 1, 'the explicit read is on the MQA material surface');
  assert.equal(retrieved[0].sourceId, 's2');
  assert.equal(retrieved[0].available, true);
  assert.equal(retrieved[0].tier, 'ranged');
  assert.equal(retrieved[0].start, tailStart);
  assert.deepEqual(retrieved[0].lookup.sourceIds, ['s2']);
  const delivered = compiled.payload.sources.find(source => source.id === 's2');
  assert.ok(delivered && delivered.text.includes('又重录过一段'),
    'the admitted view actually spans the retrieved verbatim fact');
});

test('selection delivers the explicitly retrieved tail range instead of omitting it', t => {
  const noteText = tailMarkerNote(40);
  const tailStart = noteText.indexOf('后来发现一个停顿不自然');
  const { store, note, args } = scenario(t, { noteText,
    retrieved: null });
  args.retrievedSources = [rangeReadOf(store, note.id, tailStart, 2000)];
  const context = buildContext(args);
  const delivered = context.payload.sources.find(source => source.id === 'private:' + note.id);
  assert.ok(delivered, 'the note stays in delivered evidence');
  const range = delivered.delivery || {};
  const overlaps = range.start !== undefined && range.start < tailStart + 2000 && range.end > tailStart;
  assert.ok(overlaps, 'the delivered window overlaps the requested range: ' + JSON.stringify({ start: range.start, end: range.end, tailStart }));
  const explicit = (context.payload.evidenceDelivery && context.payload.evidenceDelivery.explicitLookups || []).find(entry => entry.sourceId === 'private:' + note.id);
  assert.ok(explicit, 'the explicit lookup is manifest');
  assert.notEqual(explicit.requestStatus, 'omitted',
    'a requested range is delivered or partial, never silently omitted');
  assert.ok(String(delivered.text || '').includes('又重录过一段'),
    'the retrieved verbatim fact reaches the model');
});

test('selection keeps declared arrangements riding when a range view replaces the digest', t => {
  const noteText = declarationNote(180);
  const { store, note, args } = scenario(t, { noteText });
  // Read a head region that does NOT contain the mid-document declaration:
  // the observed failure shape (the model range-read regions around it).
  args.retrievedSources = [rangeReadOf(store, note.id, 0, 2000)];
  const context = buildContext(args);
  const delivered = context.payload.sources.find(source => source.id === 'private:' + note.id);
  assert.ok(delivered, 'the note stays in delivered evidence');
  const declarations = (delivered.digest && delivered.digest.declarations) || [];
  assert.ok(declarations.some(item => item.sentence.includes('周六三点半以后我有空')),
    'the declared arrangement rides on the ranged view instead of disappearing');
  assert.ok(String(delivered.digest.declarationRule || '').includes('arrangementHandling'),
    'the riding rule names the consumption duty');
});

test('under a tight budget the retrieved range still cannot silently vanish', t => {
  const noteText = tailMarkerNote(40) + declarationNote(6).slice(60);
  const tailStart = noteText.indexOf('后来发现一个停顿不自然');
  const { store, note, args } = scenario(t, { noteText, budget: 15000 });
  args.retrievedSources = [rangeReadOf(store, note.id, tailStart, 2000)];
  const context = buildContext(args);
  const delivered = context.payload.sources.find(source => source.id === 'private:' + note.id);
  const explicit = (context.payload.evidenceDelivery && context.payload.evidenceDelivery.explicitLookups || []).find(entry => entry.sourceId === 'private:' + note.id);
  if (delivered && delivered.text && delivered.delivery && delivered.delivery.start < tailStart + 2000 && delivered.delivery.end > tailStart) {
    assert.ok(true, 'an overlapping window survived the budget pressure');
  } else if (delivered && delivered.digest && Array.isArray(delivered.digest.declarations) && delivered.digest.declarations.length) {
    assert.ok(true, 'the declarations rode when the range could not fit');
  } else {
    assert.fail('neither the requested range nor riding declarations survived: ' +
      JSON.stringify({ delivery: delivered && delivered.delivery, declarations: delivered && delivered.digest && delivered.digest.declarations, requestStatus: explicit && explicit.requestStatus }));
  }
});
