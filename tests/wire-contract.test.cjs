'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseModelJson } = require('../src/model-json.cjs');
const { parseAssistant } = require('../src/assistant-model.cjs');
const { normalizePrimaryOperation } = require('../src/primary-operation.cjs');
const { compile } = require('../src/wire/compile.cjs');
const { lookupFieldNames, LIMITS, LOOKUP_RULES, runLookup } = require('../src/wire/lookup.cjs');
const { domainsFor } = require('../src/wire/domains.cjs');
const { envelope, MODES, TRUNCATION_MARKER } = require('../src/wire/user-text-envelope.cjs');
const { digestSource } = require('../src/context/evidence-digest.cjs');

const handNote = (entries, topic) => Array.from({ length: entries }, (_, i) => `第${i + 1}项：关于${topic}的第${i + 1}条虚构记录，内容各不相同。`).join('\n');
const digestedSource = (id, revision, text, topic) => digestSource({ id, type: 'private', role: 'user', use: 'discussion', at: new Date().toISOString(), revision, text: text || handNote(12, topic) });
const inputFor = sources => ({ payload: { purpose: 'discussion', sources, methodCards: [], methodSelection: { candidates: [] }, userRequest: { sourceId: 'private:other', text: 'q' } } });

// ---------------------------------------------------------------------------
// Single source of truth: contract -> validator, allowlist, tool schema and
// prompt line must all be derived artifacts (drift is structurally impossible).
// ---------------------------------------------------------------------------

test('primary-operation allowlist equals the compiled contract field set', () => {
  const contract = compile('lookup').contract;
  assert.deepEqual([...lookupFieldNames].sort(), Object.keys(contract.fields).sort());
});

test('the prompt protocol line is the compiled contract fragment, byte-identical', () => {
  const generated = compile('lookup').promptFragments();
  assert.equal(LOOKUP_RULES, generated);
  // Bounds rendered into the text equal the bounds the validator enforces.
  assert.ok(LOOKUP_RULES.includes(`maxChars:1..${LIMITS.maxChars}`));
  assert.ok(LOOKUP_RULES.includes(`query≤${LIMITS.query}`));
  assert.ok(LOOKUP_RULES.includes(`≤${LIMITS.reads.max}`));
  assert.ok(LOOKUP_RULES.includes('reads'));
});

test('the compiled tool schema carries the contract bounds and the reads form', () => {
  const shape = compile('lookup').schema();
  assert.equal(shape.properties.sourceIds.maxItems, LIMITS.sourceIds);
  assert.equal(shape.properties.methodIds.maxItems, LIMITS.methodIds);
  assert.equal(shape.properties.reads.maxItems, LIMITS.reads.max);
  assert.deepEqual(shape.properties.types.items.enum, [...LIMITS.types]);
  // help-behavior.cjs has no private copy of the protocol line.
  const helpBehavior = require('node:fs').readFileSync('src/help-behavior.cjs', 'utf8');
  assert.ok(!/found非已读/.test(helpBehavior), 'the protocol line lives only in the contract');
});

test('boundary behavior matches the declared bounds for every numeric limit', () => {
  const source = digestedSource('private:bounds', 'r1');
  const input = inputFor([source]);
  const at = (lookup, payload = input.payload) => parseAssistant({ kind: 'discussion', text: 'x', lookup }, 'discussion', payload, {});
  assert.equal(at({ sourceIds: ['private:bounds'], offset: LIMITS.offsetMax, maxChars: LIMITS.maxChars }).lookup.maxChars, LIMITS.maxChars);
  assert.throws(() => at({ sourceIds: ['private:bounds'], maxChars: LIMITS.maxChars + 1 }), /invalid bounded source range/);
  assert.throws(() => at({ sourceIds: ['private:bounds'], offset: LIMITS.offsetMax + 1 }), /invalid bounded source range/);
  assert.throws(() => at({ sourceIds: ['private:bounds'], maxChars: 0 }), /invalid bounded source range/);
  assert.throws(() => at({ query: 'x'.repeat(LIMITS.query + 1) }), /历史检索需有明确查询/);
  assert.throws(() => at({ unknownSelector: true }), /unsupported selector/);
});

// ---------------------------------------------------------------------------
// B9: batch continuation reads -- one round trip returns several ranges.
// ---------------------------------------------------------------------------

test('batch reads validate, default and normalize through the compiled contract', () => {
  const a = digestedSource('private:read-a', 'ra'), b = digestedSource('private:read-b', 'rb');
  const input = inputFor([a, b]);
  const result = parseAssistant({ kind: 'discussion', text: '续读。', lookup: { reads: [{ sourceIds: ['private:read-a'], offset: 100 }, { sourceIds: ['private:read-b'] }] } }, 'discussion', input.payload, {});
  assert.deepEqual(result.lookup.reads, [
    { sourceIds: ['private:read-a'], offset: 100, maxChars: LIMITS.reads.defaultMaxChars },
    { sourceIds: ['private:read-b'], offset: 0, maxChars: LIMITS.reads.defaultMaxChars }
  ]);
  assert.throws(() => parseAssistant({ kind: 'discussion', text: 'x', lookup: { reads: [{ sourceIds: ['private:read-a'] }], sourceIds: ['private:read-b'] } }, 'discussion', input.payload, {}),
    /not both/);
  assert.throws(() => parseAssistant({ kind: 'discussion', text: 'x', lookup: { reads: [{ sourceIds: ['private:missing'] }] } }, 'discussion', input.payload, {}),
    /exactly one delivered source handle/);
  assert.throws(() => parseAssistant({ kind: 'discussion', text: 'x', lookup: { reads: [{ sourceIds: ['private:read-a'], offset: LIMITS.reads.offsetMax + 1 }] } }, 'discussion', input.payload, {}),
    /invalid bounded source range/);
  assert.throws(() => parseAssistant({ kind: 'discussion', text: 'x', lookup: { reads: Array.from({ length: LIMITS.reads.max + 1 }, () => ({ sourceIds: ['private:read-a'] })) } }, 'discussion', input.payload, {}),
    /bounded continuation reads/);
});

test('parse-time completions are reported as budget-saving diagnostics', () => {
  const source = digestedSource('private:completion-proof', 'rc');
  const diagnostics = {};
  const result = parseAssistant({ kind: 'discussion', text: '续读。', lookup: { offset: 40, maxChars: 900 } }, 'discussion', inputFor([source]).payload, diagnostics);
  assert.deepEqual(result.lookup.sourceIds, ['private:completion-proof']);
  assert.ok(diagnostics.lookupCompletions?.length, 'the program-derived identifier is recorded, not trusted from the model');
});

test('a lookup continuation under a message obligation is completed as prepare_message', () => {
  // B9: when this request already requires a message artifact, the only legal
  // continuation is prepare_message -- program knowledge, not a model choice.
  const normalized = normalizePrimaryOperation({ operation: 'lookup', lookup: { query: 'x' } },
    { requestDeliveryPolicy: { obligation: { mode: 'editable_message' } } });
  assert.equal(normalized.state.continuation, 'prepare_message');
  // Without the obligation the choice stays with the model and the omission
  // remains an error.
  assert.throws(() => normalizePrimaryOperation({ operation: 'lookup', lookup: { query: 'x' } }, {}),
    error => error.code === 'primary_operation_continuation_invalid');
});

// ---------------------------------------------------------------------------
// B9 repair economy: executable guidance quotes this payload's real handles.
// ---------------------------------------------------------------------------

test('lookup repair guidance quotes copy-ready handles from the request state', () => {
  const a = digestedSource('private:fix-a', 'rf'), b = digestedSource('private:fix-b', 'rg');
  const payload = { ...inputFor([a, b]).payload, methodSelection: { candidates: [] } };
  let error;
  try { runLookup({ offset: 10, maxChars: 100 }, payload, {}); } catch (caught) { error = caught; }
  assert.equal(error.code, 'lookup_range_target_ambiguous');
  assert.deepEqual(error.handles, ['private:fix-a', 'private:fix-b']);
  const { lookupRepairLines } = require('../src/wire/lookup.cjs');
  const lines = lookupRepairLines(payload);
  assert.ok(lines.some(line => line.includes('private:fix-a') && line.includes('reads')), 'repair names a copyable batch read');
});

// ---------------------------------------------------------------------------
// B7: UserTextEnvelope -- the three delivery modes.
// ---------------------------------------------------------------------------

test('user text envelope delivers whole, truncates loudly or rejects -- never silently clamps', () => {
  assert.deepEqual(MODES, ['whole', 'truncated', 'rejected']);
  const whole = envelope('短指令', { limit: 2000 });
  assert.equal(whole.mode, 'whole'); assert.equal(whole.delivered, '短指令'); assert.equal(whole.totalChars, 3);
  const long = 'x'.repeat(2500);
  const truncated = envelope(long, { limit: 2000 });
  assert.equal(truncated.mode, 'truncated');
  assert.equal(truncated.totalChars, 2500);
  assert.ok(truncated.delivered.length <= 2000, 'the delivered text respects the wire limit');
  assert.ok(truncated.delivered.endsWith(TRUNCATION_MARKER), 'truncation is explicit, never silent');
  assert.ok(truncated.delivered.startsWith('x'));
  assert.ok(truncated.overflow.handle);
  const rejected = envelope('   ', { limit: 2000 });
  assert.equal(rejected.mode, 'rejected'); assert.equal(rejected.error.code, 'user_text_empty');
});

test('controller instruction clamping surfaces through the envelope state', () => {
  // B7: the standing instruction is stored whole, delivered bounded with an
  // explicit marker, and the state exposes instructionTruncated for the UI.
  const { Controller } = require('./fixtures/assistant-protocol.cjs');
  const { Store } = require('../src/store.cjs');
  const { scope } = require('./fixtures/native.cjs');
  const store = new Store(':memory:');
  const controller = new Controller({ store, settings: { anonymous: true, baseUrl: 'http://fixture.invalid/v1', model: 'fixture' },
    read: async command => command === 'bind' ? scope : { messages: [] }, assistantModel: null, compactionModel: null });
  try {
    controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
    const longInstruction = '保持口语。'.repeat(600);
    controller.configure({ instruction: longInstruction });
    const snapshot = controller.snapshot();
    assert.equal(snapshot.instructionTruncated, true);
    assert.ok(snapshot.instruction.includes('截断'), 'the delivered instruction carries the marker');
    assert.equal(controller.settings.instructionFull, longInstruction, 'the full text is retained, not discarded');
    // Idempotent reconfigure of the identical delivered text keeps the state.
    controller.configure({ instruction: snapshot.instruction });
    assert.equal(controller.snapshot().instructionTruncated, true);
  } finally { controller.close(); store.close(); }
});

// ---------------------------------------------------------------------------
// Registry invariants: every contract compiles and every named rule resolves.
// ---------------------------------------------------------------------------

test('every exchange contract compiles with resolvable rules and a version', () => {
  for (const name of ['lookup', 'assistant-result', 'draft-result', 'fidelity-result', 'memory-result', 'discussion-compaction-result']) {
    const compiled = compile(name);
    assert.equal(typeof compiled.validate, 'function', name);
    assert.equal(typeof compiled.promptFragments(), 'string', name);
    assert.ok(compiled.contract.version, name + ' is versioned');
  }
  assert.throws(() => require('../src/wire/rules.cjs').ruleFor('nonexistent-rule'), /unknown rule/);
});

test('memory wire admission and repair vocabulary come from the memory contract', () => {
  const contract = compile('memory-result').contract;
  const engine = require('../src/memory-engine.cjs');
  assert.equal(typeof engine.MEMORY_SYSTEM, 'string');
  assert.ok(engine.MEMORY_SYSTEM.includes(contract.protocolShape.slice(0, 40)), 'the receipt shape line is generated from the contract');
  assert.deepEqual(contract.topLevelFields, ['batchId', 'reviewedAll', 'items', 'episodes', 'retire', 'relationshipPatch']);
});

test('compaction bounds come from the compaction contract', () => {
  const contract = compile('discussion-compaction-result').contract;
  assert.equal(contract.summary.maxBytes, 8000);
  assert.equal(contract.quoteRefs.max, 12);
  assert.equal(contract.quoteRefs.maxBytes, 6000);
  assert.deepEqual(contract.quoteRefs.fields.slice(0, 4), ['turnId', 'role', 'field', 'index']);
});
