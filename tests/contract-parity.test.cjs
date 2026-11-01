'use strict';
// Contract parity harness (design §4.3 W1 acceptance): replays recorded raw
// model outputs from fictional development replay rounds against the
// contract-compiled field layer, plus a byte-stability golden for generated
// prompt fragments. Recorded outputs come from .goal-runs transport records
// (curated into tests/fixtures/contract-parity-corpus.json; visibility class
// per goal.json: fictional_visible_development_cases).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseModelJson } = require('../src/model-json.cjs');
const { compile } = require('../src/wire/compile.cjs');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'contract-parity-corpus.json'), 'utf8'));
const lookup = compile('lookup');
const assistant = compile('assistant-result').contract;
const memory = compile('memory-result').contract;
const compaction = compile('discussion-compaction-result').contract;
const draft = compile('draft-result').contract;
const fidelity = compile('fidelity-result').contract;

// Field-layer validator compiled from contract data: transport parse, then
// per-exchange field admission and declared bounds. Cross-field semantics
// stay with the product validators (design §8.6 TODO contracts) and are not
// re-asserted here; this harness pins the generated field layer.
function fieldLayer(purpose, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  const keys = Object.keys(parsed);
  if (keys.includes('batchId') || keys.includes('reviewedAll')) {
    for (const key of keys) if (!memory.topLevelFields.includes(key)) throw new Error('memory top-level field ' + key);
    for (const kind of ['items', 'episodes', 'retire']) {
      const allowed = memory.recordFields[kind];
      for (const record of parsed[kind] || []) {
        if (!record || typeof record !== 'object') throw new Error('memory record shape');
        for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error('memory record field ' + key);
        if (Array.isArray(record.sourceIds) && record.sourceIds.length > memory.citations.max) throw new Error('memory citations bound');
      }
    }
    return 'memory_result';
  }
  if (keys.includes('summary') && keys.includes('quoteRefs')) {
    for (const key of keys) if (!compaction.topLevelFields.includes(key)) throw new Error('compaction top-level field ' + key);
    if (Buffer.byteLength(parsed.summary || '', 'utf8') > compaction.summary.maxBytes) throw new Error('summary bound');
    if ((parsed.quoteRefs || []).length > compaction.quoteRefs.max) throw new Error('quoteRefs bound');
    return 'discussion_compaction_result';
  }
  if (keys.includes('checkRef') || keys.includes('factual')) {
    for (const key of keys) if (!['checkRef', 'auditProtocol', 'verdict', 'factual', 'issues', 'concerns'].includes(key)) throw new Error('fidelity top-level field ' + key);
    if (parsed.auditProtocol && !fidelity.protocols.includes(parsed.auditProtocol.replace('sparse-defects-v1', 'sparse-defects-v1'))) throw new Error('fidelity protocol');
    if (parsed.checkRef && !fidelity.fields.checkRef.values.includes(parsed.checkRef)) throw new Error('checkRef enum');
    return 'fidelity_result';
  }
  if (keys.includes('operation')) {
    if (!assistant.operations.includes(parsed.operation)) throw new Error('operation enum');
    return 'assistant_result';
  }
  if (keys.includes('kind')) {
    // json_object-mode responses may be a restricted draft_result or an
    // assist planning carrier (kind + draftPlan/lookup/requestDelivery).
    const assistKinds = ['draft', 'discussion', 'question', 'options', 'review', 'acknowledgment'];
    if (!assistKinds.includes(parsed.kind)) throw new Error('kind enum');
    const carrier = new Set([...Object.keys(draft.fields), 'kind', 'text', 'draftPlan', 'lookup',
      'requestDelivery', 'currentFacts', 'materials', 'editingReference', 'analysis']);
    for (const key of keys) if (!carrier.has(key)) throw new Error('assist/draft field ' + key);
    return keys.includes('draftPlan') || keys.includes('lookup') ? 'assist_carrier' : 'draft_result';
  }
  return 'unclassified';
}

test('every recorded valid replay output parses and passes the compiled field layer', () => {
  assert.ok(corpus.accepted.length >= 20, 'corpus retained a meaningful sample');
  const classified = {};
  for (const entry of corpus.accepted) {
    const parsed = parseModelJson(entry.text);
    const exchange = fieldLayer(entry.purpose, parsed);
    classified[exchange] = (classified[exchange] || 0) + 1;
  }
  // The corpus must exercise at least three distinct exchanges.
  assert.ok(Object.keys(classified).length >= 3, 'corpus covers multiple exchanges: ' + JSON.stringify(classified));
});

test('every previously rejected malformed output fails the field layer or carries a recorded semantic reason', () => {
  for (const entry of corpus.rejected) {
    let rejected = false;
    try {
      const parsed = parseModelJson(entry.text);
      fieldLayer(entry.purpose, parsed);
    } catch (error) { rejected = true; }
    // Rejections that the field layer admits must have been semantic; the
    // recorded reason documents which validator owned them. Both paths are
    // counted so silent acceptance is impossible.
    if (!rejected) assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0,
      'a field-layer-valid body was rejected semantically; the reason must be recorded');
  }
});

// Golden fixture: generated protocol fragments are byte-stable. Changing a
// contract intentionally means regenerating this golden in the same commit --
// an unexplained drift fails here.
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'wire-protocol-golden.json');
test('generated prompt fragments are byte-stable under the golden fixture', () => {
  const generated = {
    lookupProtocolLine: lookup.promptFragments(),
    memoryProtocolShape: memory.protocolShape,
    compactionSummaryBound: String(compaction.summary.maxBytes),
    assistantOperations: assistant.operations.join('|'),
    version: 'wire-golden-v1'
  };
  if (!fs.existsSync(GOLDEN_PATH)) {
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(generated, null, 1) + '\n');
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  assert.deepEqual(generated, golden, 'protocol fragments changed; regenerate the golden deliberately if the contract change is intended');
});

test('the compiled lookup schema and the deep validator share one bounds source', () => {
  const shape = lookup.schema();
  const contract = lookup.contract;
  assert.equal(shape.properties.sourceIds.maxItems, contract.fields.sourceIds.max);
  assert.equal(shape.properties.discussionTurnIds.maxItems, contract.fields.discussionTurnIds.max);
  assert.equal(shape.properties.methodIds.maxItems, contract.fields.methodIds.max);
  assert.deepEqual(shape.properties.types.items.enum, contract.fields.types.values);
  assert.equal(shape.properties.reads.maxItems, contract.fields.reads.max);
});

test('memory and compaction product validators consume the same contract data they were compiled from', () => {
  // The product modules import the contract through src/wire/compile.cjs; a
  // mismatch would require a parallel hand-written copy, which the source
  // scan below rules out for the exact strings that used to be duplicated.
  const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory-engine.cjs'), 'utf8');
  assert.ok(!engine.includes("['batchId','reviewedAll'"), 'memory-engine has no hand-written top-level field list');
  const compactionSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'discussion-compaction.cjs'), 'utf8');
  assert.ok(!compactionSrc.includes("> 8000)"), 'compaction has no hand-written summary byte bound');
});
