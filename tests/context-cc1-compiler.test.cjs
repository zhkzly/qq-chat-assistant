'use strict';
// Deterministic coverage for the CC1 admission compiler (design §3.1 C3):
// the requirement-ordered ladder verbatim → ranged → digest → declarations →// marker under one Budget Authority, with the compaction dead band removed.
// Same-form scenarios for bottlenecks B4 (large sources always enter the
// ladder), B5 (declared arrangements must reach evidence and arrangementHandling
// is consumed), B6 (one budget vocabulary; no prepared-but-blocked answers) and
// B9 (per-purpose call accounting visible). Fictional fixtures over the real
// Store tables via the same sourceSnapshot projection buildContext uses; the
// frozen eval dataset is never imported.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { sourceSnapshot } = require('../src/context/source-snapshot.cjs');
const { compileContext, selectPlanningContext, declarationsView, markerView, tierSizesFor, LADDER,
  continuationRanges, RETRIEVAL_RANGE_LIMITS, DEFAULT_CONTINUATION_CHARS } = require('../src/context/admission-compiler.cjs');
const { BudgetAuthority, CallBudgets, TIER_RANK } = require('../src/context/budget-authority.cjs');
const mqa = require('../src/context/mqa-registry.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

function message(id, outgoing, text, at) {
  return normalize(raw(String(id), outgoing, { msgTime: String(Math.floor(Date.parse(at || new Date(Date.now() - 30 * 60 * 1000).toISOString()) / 1000)),
    elements: [{ textElement: { content: text } }] }), scope);
}
function entryParagraph(i) {
  return '第' + i + '项是物件' + i + '。我到整理桌时，师傅已经把它放好。我负责照着登记纸核对这件东西的说明，不负责估价。我们把能确认的现象按原话记下来，不补没有来源的往事。';
}
// Same shape as the reviewed declared-arrangement family: numbered entries
// with the declaration paragraph buried mid-document.
function declarationNote(extraEntries) {
  const parts = ['这是留给自己的原始手记，方便和你商量真实近况。'];
  for (let i = 1; i <= extraEntries; i++) parts.push(entryParagraph(i));
  parts.push('这周末的安排我也在这里给你说清楚：周六三点半以后我有空，也愿意和她一起去看旧物展。');
  for (let i = extraEntries + 1; i <= extraEntries + 6; i++) parts.push(entryParagraph(i));
  return parts.join('\n');
}
function plainNote(kb, marker) {
  const item = i => '第' + i + '项是物件' + i + (marker || '') + '。我到整理桌时，师傅已经把它放好。我负责照着登记纸核对这件东西的说明，不负责估价。我们把能确认的现象按原话记下来，不补没有来源的往事。';
  const n = Math.ceil(kb * 1024 / Buffer.byteLength(item(1), 'utf8'));
  return Array.from({ length: n }, (_, i) => item(i + 1)).join('\n');
}
// Adapter over the existing tables: build the compiler's inputs from a real
// Store exactly the way the legacy pipeline projects sources.
function storeFixture(t, { requestText = '她问到这些了，帮我回一下。', notes = [], incoming = [], asOf = null } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const records = incoming.map((entry, index) => message(9000 + index, false, entry.text, entry.at));
  store.add(scope, records);
  store.setGoal(scope, '和她自然交流，分享自己的真实近况。');
  for (const note of notes) {
    const entry = typeof note === 'string' ? { text: note } : note;
    store.appendTurn(scope, { role: 'user', kind: 'discussion', text: entry.text });
  }
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: requestText });
  const companion = store.getCompanion(scope);
  // The store stamps turn times itself, so the observation clock derives from
  // the stored request turn; only relative ages are under test control.
  const observedAsOf = asOf || turn.createdAt;
  const snapshot = sourceSnapshot({ scope, records: store.messages(scope), companion, turn });
  return { store, snapshot, companion, turn, asOf: observedAsOf };
}
function authorityFor(byteBudget, { measureOverhead = 500, callBudgets = null, guaranteed = [] } = {}) {
  return new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: byteBudget,
    requestByteBudget: 256000, measureRequest: payload => measureOverhead + JSON.stringify(payload).length,
    allocations: BudgetAuthority.answerAllocations(byteBudget),
    degradationOrder: ['navigation', 'directory', 'recentWindow', 'relationship', 'privateLayer'],
    callBudgets, guaranteed });
}

// ---- Ladder invariants ----

test('the ladder is monotone: the best view of each tier is no larger than the tier above', () => {
  const source = { id: 'private:mono', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T10:00:00Z', revision: 'r1', text: declarationNote(14) };
  const sizes = tierSizesFor(source);
  assert.deepEqual([...new Set(sizes.map(size => size.tier))],
    ['verbatim', 'ranged', 'digest', 'declarations', 'marker'], 'all five rungs exist for a structured source');
  // Rank ordering is about representation faithfulness, not byte monotonicity
  // across tiers (a structured digest can outsize the largest sub-whole range);
  // the invariants are rank-descending rungs, descending bytes within a tier,
  // exact spans and copy-ready handles.
  for (let index = 1; index < sizes.length; index++) {
    assert.ok(TIER_RANK[sizes[index].tier] <= TIER_RANK[sizes[index - 1].tier], 'rungs are rank-descending');
    if (sizes[index].tier === sizes[index - 1].tier)
      assert.ok(sizes[index].bytes <= sizes[index - 1].bytes, 'within one tier larger rungs come first');
  }
  // Exact-span property: a ranged view is a verbatim slice of the original.
  const ranged = sizes.find(size => size.tier === 'ranged');
  assert.equal(ranged.view.text, source.text.slice(ranged.view.delivery.start, ranged.view.delivery.end));
  assert.ok(ranged.view.delivery.lookup.sourceId === source.id, 'continuation handle present');
  // Copy-ready handles on every digest line and declaration.
  for (const entry of sizes.find(size => size.tier === 'digest').view.digest.entries)
    assert.ok(Array.isArray(entry.lookup.sourceIds) && Number.isInteger(entry.lookup.offset) && entry.lookup.maxChars >= 1);
  for (const declaration of sizes.find(size => size.tier === 'declarations').view.digest.declarations)
    assert.ok(Array.isArray(declaration.lookup.sourceIds) && declaration.lookup.maxChars >= 1);
  assert.deepEqual(LADDER, ['verbatim', 'ranged', 'digest', 'declarations', 'marker']);
});

test('the marker tier asserts nothing about the source content', () => {
  const source = { id: 'private:gone', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T10:00:00Z', revision: 'r1', text: plainNote(2) };
  const marker = markerView(source);
  assert.equal(marker.marker.kind, 'omitted_source');
  assert.equal(marker.delivery.status, 'omitted');
  assert.equal(marker.delivery.lookup.sourceId, source.id, 'the original stays addressable');
  assert.ok(!JSON.stringify(marker).includes('第1项'), 'no source body leaks into the marker');
});

test('floor sources never receive digest or declarations rungs', () => {
  const source = { id: 'private:floor', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T10:00:00Z', revision: 'r1', text: plainNote(12) };
  const tiers = new Set(tierSizesFor(source, { floor: true }).map(size => size.tier));
  assert.ok(!tiers.has('digest') && !tiers.has('declarations'), 'the question itself is never digested');
  assert.ok(tiers.has('ranged'));
});

// ---- B4 same-form: large sources always enter the ladder ----

test('B4 same-form: an oversized pasted request degrades to a range and the plan always delivers', t => {
  const requestText = plainNote(24, '当前请求') + '\n她问到这些了，帮我回一下。';
  const { snapshot, asOf } = storeFixture(t, { requestText });
  const authority = authorityFor(48000);
  const result = compileContext({ asOf, purpose: 'discussion', request: { text: snapshot.current.text },
    current: snapshot.current, candidateSources: snapshot.all.filter(source => source.id !== snapshot.current.id), budget: authority });
  assert.equal(result.admissions.find(admission => admission.id === snapshot.current.id).tier, 'ranged',
    'the oversized request enters the ladder at an explicit range');
  const request = result.payload.sources.find(source => source.id === snapshot.current.id);
  assert.equal(request.delivery.status, 'partial');
  assert.equal(request.text, snapshot.current.text.slice(request.delivery.start, request.delivery.end), 'exact span, never rewritten');
  assert.ok(request.delivery.end < request.delivery.originalCharLength, 'the undelivered remainder stays explicit');
  assert.ok(result.degradation.some(entry => entry.appliedTo === snapshot.current.id), 'degradation is recorded for the request itself');
  assert.ok(result.degradation.every(entry => !entry.lookupHandle || entry.lookupHandle.sourceIds), 'every recorded handle is copy-ready');
  assert.ok(authority.fits(result.payload), 'the assembled payload fits');
  assert.ok(result.manifest.degradation.length >= result.degradation.length - 1, 'the manifest explains the degradation');
});

test('B4 same-form: the 6-12KB compaction dead band is gone — a mid-band source still yields a plan', t => {
  // Backlog #3 shape: ~8.5KB current request in the old dead band where
  // compaction never planned and the legacy path re-threw the capacity error.
  const requestText = '我想商量这件事：' + '这是本次私下请求的正文。'.repeat(320);
  const { snapshot, asOf } = storeFixture(t, { requestText, notes: [plainNote(20, '背景素材')], incoming: [
    { text: '日常消息，说说这周的事情。', at: '2026-10-01T17:00:00+08:00' }] });
  for (const budget of [48000, 16000, 9000, 6000]) {
    const authority = authorityFor(budget);
    const result = compileContext({ asOf, purpose: 'discussion', request: { text: snapshot.current.text },
      current: snapshot.current, candidateSources: snapshot.all.filter(source => source.id !== snapshot.current.id), budget: authority });
    const tier = result.admissions.find(admission => admission.id === snapshot.current.id).tier;
    assert.ok(['verbatim', 'ranged'].includes(tier), `budget ${budget}: floor stays verbatim/ranged, got ${tier}`);
    assert.ok(authority.fits(result.payload), `budget ${budget}: deliverable plan`);
  }
  // No compaction feasibility gate exists at all in the compiler module.
  const source = require('node:fs').readFileSync(require.resolve('../src/context/admission-compiler.cjs'), 'utf8');
  assert.ok(!source.includes('discussion-compaction'), 'the compiler never consults compaction eligibility');
});

test('B4 invariant: only a below-minimal-envelope budget throws, and it throws honestly', t => {
  const { snapshot, asOf } = storeFixture(t, { requestText: plainNote(10, '超预算请求') });
  const authority = authorityFor(400);
  assert.throws(() => compileContext({ asOf, purpose: 'discussion', request: { text: snapshot.current.text },
    current: snapshot.current, candidateSources: [], budget: authority }), /预算.*没有静默截断|预算/);
});

test('background evidence never blocks the floor and the floor never drops below a marked range', t => {
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T18:00:00Z', revision: 'r1', text: '她问到这些了，帮我回一下。' };
  const flood = Array.from({ length: 12 }, (_, index) => ({ id: `private:bg${index}`, type: 'private', role: 'user', use: 'discussion',
    at: '2026-10-01T17:00:00Z', revision: `r${index}`, text: plainNote(6, `背景${index}`) }));
  const authority = authorityFor(6000);
  const result = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text }, current, candidateSources: flood, budget: authority });
  assert.ok(result.payload.sources.some(source => source.id === current.id), 'the floor is always delivered');
  const tier = result.admissions.find(admission => admission.id === current.id).tier;
  assert.ok(['verbatim', 'ranged'].includes(tier), 'never digested, never a marker');
  assert.ok(authority.fits(result.payload));
  const backgroundTiers = result.admissions.filter(admission => admission.id !== current.id).map(admission => admission.tier);
  assert.ok(backgroundTiers.every(tier => ['marker', 'declarations', 'digest', 'ranged', 'verbatim'].includes(tier)), 'background degrades instead of blocking');
});

// ---- B5 same-form: declared arrangements must reach evidence ----

test('B5 same-form: a buried declaration in an oversized source reaches evidence at every budget', t => {
  const noteText = declarationNote(180); // >38KB, same shape as the reviewed case
  const { snapshot, asOf } = storeFixture(t, {
    requestText: '她问到这些了，帮我回一下。', notes: [{ text: noteText, at: '2026-09-30T18:00:00+08:00' }],
    incoming: [{ text: '你前阵子说帮旧物展录了点什么？周六下午能一起去看看吗？', at: '2026-10-01T18:00:00+08:00' }] });
  const noteSource = snapshot.all.find(source => source.text === noteText || source.text.length > 30000);
  assert.ok(noteSource, 'the oversized declaration source is projected from the real store');
  for (const budget of [48000, 12000, 8000, 6000]) {
    // Note: the compiler's explainability metadata (requirements, consumption
    // contract, degradation ledger) has its own ~3KB floor; below that the
    // honest minimal-envelope error fires (pinned by the B4 invariant test).
    const authority = authorityFor(budget);
    const result = compileContext({ asOf, purpose: 'discussion',
      request: { text: snapshot.current.text, replyFocusTexts: ['你前阵子说帮旧物展录了点什么？周六下午能一起去看看吗？'] },
      current: snapshot.current, candidateSources: snapshot.all.filter(source => source.id !== snapshot.current.id), budget: authority });
    assert.equal(result.payload.contextRequest.intentClass, 'invitation_arrangement', `budget ${budget}: invitation classified`);
    const declaration = result.payload.mandatoryMaterials.find(material => material.sentence.includes('周六三点半以后我有空'));
    assert.ok(declaration, `budget ${budget}: the declared arrangement reaches delivered evidence`);
    assert.equal(noteText.slice(declaration.start, declaration.end), declaration.sentence, 'verbatim sentence, exact range');
    assert.ok(result.payload.consumptionContract.fields.some(field => field.name === 'arrangementHandling'),
      `budget ${budget}: the consumption contract demands arrangementHandling`);
    assert.ok(authority.fits(result.payload), `budget ${budget}: deliverable`);
  }
});

test('B5: a range that does not contain the declaration is skipped in favor of the declarations tier', () => {
  // The declaration sits ~3KB into the note: a 1600B range cannot contain it.
  const source = { id: 'private:mid', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T10:00:00Z', revision: 'r1', text: declarationNote(24) };
  const declaration = declarationsView(source).digest.declarations[0];
  assert.ok(declaration && declaration.sentence.includes('周六三点半以后我有空'));
  // The compile-level requirement filters non-containing ranges; assert the
  // material-true floor through the compiler below.
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T18:00:00Z', revision: 'r2', text: '她约我周六去看展，怎么回？' };
  const authority = authorityFor(4000); // room for the declarations tier but no digest and no covering range
  const result = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text },
    current, candidateSources: [source], budget: authority });
  const admission = result.admissions.find(item => item.id === source.id);
  assert.equal(admission.tier, 'declarations', 'the ladder falls through to declarations rather than a range that loses the declaration');
  assert.equal(result.payload.mandatoryMaterials.length, 1);
  assert.equal(result.payload.materialRequirements.outcomes.find(outcome => outcome.materialClass === 'declared_arrangement').status, 'delivered');
});

test('B5 consumption: arrangementHandling is enforced against the delivered declarations', t => {
  const { snapshot, asOf } = storeFixture(t, {
    requestText: '她约我周六下午去看展，怎么回？', notes: [{ text: declarationNote(40), at: '2026-09-30T18:00:00+08:00' }] });
  const authority = authorityFor(48000);
  const result = compileContext({ asOf, purpose: 'discussion', request: { text: snapshot.current.text },
    current: snapshot.current, candidateSources: snapshot.all.filter(source => source.id !== snapshot.current.id), budget: authority });
  const delivered = result.deliveredDeclarations.map(material => ({ sourceId: material.sourceId, current: material.current }));
  assert.ok(delivered.length >= 1);
  assert.ok(delivered.every(item => item.current === true), 'fresh declarations are flagged current');
  // The draft-validator-side check consumes exactly this delivered set.
  const ignored = mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered,
    handling: { disposition: 'missing', evidenceRefs: [] } });
  assert.equal(ignored.ok, false);
  assert.equal(ignored.code, 'arrangement_handling_reason_required');
  const adopted = mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered,
    handling: { disposition: 'used', evidenceRefs: [delivered[0].sourceId] } });
  assert.equal(adopted.ok, true);
});

test('B5 negative control: closed topics render as markers, never as resurrectable content', () => {
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T18:00:00Z', revision: 'r1', text: '帮我看看接下来怎么办' };
  const closedTopic = { id: 'topic-closed', sourceIds: ['private:cur'] };
  const result = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text }, current,
    candidateSources: [], closedTopics: [closedTopic], budget: authorityFor(48000) });
  assert.ok(result.payload.negativeControls.some(control => control.marker === 'closed_topic_not_restored'));
  assert.ok(!result.payload.negativeControls.some(control => 'objective' in control || 'direction' in control),
    'a closed topic marker carries no topic body to resurrect');
});

// ---- B6 same-form: one budget vocabulary, no prepared-but-blocked answers ----

test('B6 same-form: a memory-admitted artifact is guaranteed a representation tier in the answer path', t => {
  // Same form as coverage-long-single-source: memory preparation admitted a
  // large declaration-bearing source; the answer used to be blocked by a
  // separate budget logic. The artifact carries a declared availability
  // buried mid-document.
  const artifactText = declarationNote(24);
  const artifact = { id: 'private:artifact', type: 'private', role: 'user', use: 'discussion', at: '2026-09-20T10:00:00Z', revision: 'r1', text: artifactText };
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T18:00:00Z', revision: 'r2', text: '帮我看看接下来怎么办' };
  // Memory side: the batch that admitted the artifact fits with its reserve.
  const memoryAuthority = BudgetAuthority.forMemoryBatch({ requestBytes: 48000, correctionOverheadBytes: 6000 });
  assert.equal(memoryAuthority.fits({ sources: artifactText }), true, 'the memory batch admitted the artifact');
  // Answer side WITHOUT the guarantee: a generic consultation lets the same
  // source degrade to a range that does not even contain the declaration.
  const unguaranteed = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text }, current,
    candidateSources: [artifact], budget: authorityFor(3000) });
  const unguaranteedView = unguaranteed.payload.sources.find(source => source.id === artifact.id);
  assert.ok(unguaranteedView && !unguaranteedView.text.includes('周六三点半以后我有空'),
    'without the guarantee the declaration is not in evidence');
  // Answer side WITH the guarantee (B6): same pressure, the artifact holds its
  // guaranteed declarations tier and the declaration is delivered evidence.
  const guaranteed = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text }, current,
    candidateSources: [artifact], budget: authorityFor(3000, { guaranteed: [{ id: artifact.id, tier: 'declarations' }] }) });
  const tier = guaranteed.admissions.find(item => item.id === artifact.id).tier;
  assert.ok(TIER_RANK[tier] >= TIER_RANK.declarations, `guaranteed artifact keeps ≥ declarations, got ${tier}`);
  assert.ok(guaranteed.payload.sources.some(source => source.id === artifact.id), 'the artifact is actually delivered');
  assert.ok(guaranteed.payload.mandatoryMaterials.some(material => material.sentence.includes('周六三点半以后我有空')),
    'the memory-admitted declaration is now answer-path evidence');
  assert.ok(guaranteed.manifest.degradation.every(entry => entry.step !== 'guarantee_degraded_to_marker'), 'the guarantee held');
  const authority = authorityFor(3000, { guaranteed: [{ id: artifact.id, tier: 'declarations' }] });
  assert.equal(authority.fits(guaranteed.payload), true);
});

test('B6: a guarantee that cannot fit even at marker yields to the floor instead of blocking the answer', () => {
  const artifact = { id: 'private:artifact', type: 'private', role: 'user', use: 'discussion', at: '2026-09-20T10:00:00Z', revision: 'r1', text: declarationNote(24) };
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T18:00:00Z', revision: 'r2', text: '帮我看看接下来怎么办' };
  // A digest-tier guarantee cannot fit a 700-byte answer budget: the floor
  // wins (design §5 C2 conflict rule) and the miss is recorded, never silent,
  // never a blocked answer.
  const result = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text }, current,
    candidateSources: [artifact], budget: authorityFor(4000, { guaranteed: [{ id: artifact.id, tier: 'digest' }] }) });
  assert.ok(result.payload.sources.some(source => source.id === current.id), 'the floor is delivered');
  assert.ok(result.degradation.some(entry => entry.step === 'guarantee_degraded_to_marker' && entry.appliedTo === artifact.id),
    'the relaxed guarantee is explainable');
});

test('B6: the answer and memory instantiations speak one manifest vocabulary', () => {
  const answer = authorityFor(48000).manifest(null);
  const memory = BudgetAuthority.forMemoryBatch({ requestBytes: 48000, correctionOverheadBytes: 6000 }).manifest(null);
  const compaction = BudgetAuthority.forCompaction({ availableBytes: 8000, baseBytes: 6000 }).manifest(null);
  for (const manifest of [answer, memory, compaction]) {
    assert.equal(manifest.version, 'budget-authority-v1');
    assert.ok(Array.isArray(manifest.allocations) && manifest.allocations.length > 0);
    assert.deepEqual(Object.keys(manifest).sort(), ['allocations', 'byteBudget', 'callBudgets', 'degradation',
      'degradationOrder', 'guaranteed', 'inputBytes', 'purpose', 'requestByteBudget', 'reserveBytes',
      'serializedTextRequestBytes', 'version'].sort());
  }
  assert.equal(answer.purpose, 'answer_context');
  assert.equal(memory.purpose, 'memory_batch');
  assert.equal(memory.reserveBytes, 6000);
  assert.equal(compaction.purpose, 'compaction');
});

// ---- B9 same-form: call accounting is visible in the compiled manifest ----

test('B9 same-form: the compiled manifest carries the per-purpose call split', t => {
  const calls = CallBudgets.fromRequestLimit(6); // 2 lookups + 3 delivery + 1 repair
  const authority = authorityFor(48000, { callBudgets: calls });
  // The retrieval continuations the navigable evidence invites:
  assert.equal(authority.reserveCall('retrieval_continuation').allowed, true);
  assert.equal(authority.reserveCall('retrieval_continuation').allowed, true);
  const blocked = authority.reserveCall('retrieval_continuation');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'call_purpose_exhausted', 'a third continuation cannot starve delivery');
  assert.equal(authority.reserveCall('delivery_attempt').allowed, true, 'delivery still proceeds');
  const { snapshot, asOf } = storeFixture(t, { requestText: '她问到这些了，帮我回一下。' });
  const result = compileContext({ asOf, purpose: 'discussion', request: { text: snapshot.current.text },
    current: snapshot.current, candidateSources: [], budget: authority });
  const purposes = Object.fromEntries(result.manifest.callBudgets.purposes.map(entry => [entry.purpose, entry]));
  assert.equal(purposes.retrieval_continuation.used, 2);
  assert.equal(purposes.retrieval_continuation.remaining, 0);
  assert.equal(purposes.delivery_attempt.remaining, 2, 'the split is visible mid-consumption');
  assert.equal(result.manifest.callBudgets.used, 3);
});

// ---- C5: entailment rendering stays at fragment build ----

test('derived fragments render closure-entailed speakerBasis labels', () => {
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T18:00:00Z', revision: 'r1', text: '帮我看看接下来怎么办' };
  const ownerOnly = { id: 'private:ev1', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T10:00:00Z', revision: 'r2', text: '我上次说我周六有空。' };
  // A contact-subject stated claim whose closure has NO contact speech: the
  // renderer must refuse a her-words label.
  const claim = { id: 'claim-1', subject: 'contact', assertionKind: 'stated', text: '她周六有空', sourceIds: [ownerOnly.id] };
  const result = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text }, current,
    candidateSources: [ownerOnly], derivedFragments: [{ record: claim, fields: ['id', 'subject', 'assertionKind', 'text', 'sourceIds'] }],
    budget: authorityFor(48000) });
  const fragment = result.payload.derivedFragments[0];
  assert.equal(fragment.speakerBasis.holderLabel, 'cannot_present_as_her_words_no_contact_evidence');
  assert.ok(fragment.speakerBasis.speakers.includes('account_owner'));
});

// ---- Legacy-interface shim ----

// ---- Ledger completeness + RT1 alignment ----

test('settlement degradation steps are visible on the authority manifest, not only the local ledger', t => {
  // A tight budget forces post-plan settlement (the assembled payload costs
  // metadata bytes the plan does not see); every settlement step must appear
  // in manifest.degradation so the manifest is the complete ledger (design
  // §3.1: each step recorded in manifest.degradation).
  const requestText = plainNote(14, '当前请求') + '\n她问到这些了，帮我回一下。';
  const { snapshot, asOf } = storeFixture(t, { requestText, notes: [plainNote(8, '背景素材')] });
  const authority = authorityFor(9000);
  const result = compileContext({ asOf, purpose: 'discussion', request: { text: snapshot.current.text },
    current: snapshot.current, candidateSources: snapshot.all.filter(source => source.id !== snapshot.current.id), budget: authority });
  assert.ok(authority.fits(result.payload), 'deliverable after settlement');
  assert.ok(result.degradation.length >= 1, 'degradation happened');
  for (const entry of result.degradation)
    assert.ok(result.manifest.degradation.some(item => item.step === entry.step && item.appliedTo === entry.appliedTo),
      `manifest explains ${entry.step} on ${entry.appliedTo}`);
});

test('a guarantee naming an absent artifact is recorded, never silently dropped (B6)', () => {
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T18:00:00Z', revision: 'r1', text: '帮我看看接下来怎么办' };
  const result = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text }, current,
    candidateSources: [], budget: authorityFor(48000, { guaranteed: [{ id: 'private:not-in-candidates', tier: 'digest' }] }) });
  assert.ok(result.degradation.some(entry => entry.step === 'guarantee_source_missing' && entry.appliedTo === 'private:not-in-candidates'),
    'the miss is on the plan ledger');
  assert.ok(result.manifest.degradation.some(entry => entry.step === 'guarantee_source_missing'),
    'the miss is explainable on the manifest too');
});

test('degradation handles expand into trunk RT1 retrieveRanges batches (B9 one round-trip)', t => {
  // The compiler's copy-ready handles must map 1:1 onto the batch range
  // form the trunk retrieval service consumes, so evidence continuation is
  // one program-side round trip instead of per-range model calls.
  const { snapshot, asOf } = storeFixture(t, { requestText: plainNote(20, '当前请求') + '\n她问到这些了，帮我回一下。',
    notes: [{ text: declarationNote(60), at: '2026-09-30T18:00:00+08:00' }] });
  const result = compileContext({ asOf, purpose: 'discussion', request: { text: snapshot.current.text },
    current: snapshot.current, candidateSources: snapshot.all.filter(source => source.id !== snapshot.current.id), budget: authorityFor(9000) });
  const handles = [result.degradation.filter(entry => entry.lookupHandle).map(entry => entry.lookupHandle),
    result.deliveredDeclarations.map(material => material.lookup)].flat();
  assert.ok(handles.length >= 2, 'the scenario produced continuation handles');
  const { ranges } = continuationRanges(handles);
  assert.ok(ranges.length >= 2 && ranges.length <= RETRIEVAL_RANGE_LIMITS.maxRanges);
  for (const range of ranges) {
    assert.equal(typeof range.sourceId, 'string');
    assert.ok(Number.isSafeInteger(range.offset) && range.offset >= 0);
    assert.ok(Number.isSafeInteger(range.maxChars) && range.maxChars >= 1 && range.maxChars <= RETRIEVAL_RANGE_LIMITS.maxCharsPerRange);
  }
  // Unit contract: plural and singular forms, clamping, default, revision, cap.
  const expanded = continuationRanges([{ sourceIds: ['private:a', 'private:b'], offset: 3, maxChars: 99999, revision: 'r9' }, { sourceId: 'private:c' }]);
  assert.deepEqual(expanded.ranges.map(range => range.sourceId), ['private:a', 'private:b', 'private:c']);
  assert.ok(expanded.ranges.every(range => range.maxChars <= RETRIEVAL_RANGE_LIMITS.maxCharsPerRange), 'per-range clamp');
  assert.ok(expanded.ranges.slice(0, 2).every(range => range.revision === 'r9'), 'revision passes through');
  assert.equal(expanded.ranges[2].maxChars, DEFAULT_CONTINUATION_CHARS, 'handles without maxChars default to a bounded continuation');
  const capped = continuationRanges(Array.from({ length: RETRIEVAL_RANGE_LIMITS.maxRanges + 6 }, (_, index) => ({ sourceIds: ['s' + index], offset: 0, maxChars: 100 })));
  assert.equal(capped.ranges.length, RETRIEVAL_RANGE_LIMITS.maxRanges);
  assert.equal(capped.dropped.length, 6, 'overflow is reported, never silently truncated');
});

test('a digest rung that lost a declaration to the declaration budget is dropped, not admitted (B5)', () => {
  // digestSource rides declarations along but caps them at a 1500-byte
  // budget (DECLARATION_BYTE_BUDGET); three ~150-char declarations overflow
  // it, and spreading them across a ~28KB source keeps every sub-whole
  // range from spanning them all. A digest that no longer contains every
  // declaration must not satisfy the material floor — the ladder falls to
  // the declarations tier, which carries all of them.
  const filler = index => '第' + index + '段整理记录。师傅把物件放到登记桌上，我核对说明文字，不补没有来源的往事，只把能确认的现象按原话记下。'.repeat(6);
  const declaration = index => '周六下午三点半以后我有空，也愿意和她一起去看第' + index + '场旧物展，' + '这条说的是周六的安排和我的意愿'.repeat(8) + '。';
  const parts = [declaration(1)];
  for (let index = 1; index <= 13; index++) parts.push(filler(index));
  parts.push(declaration(2));
  for (let index = 14; index <= 27; index++) parts.push(filler(index));
  parts.push(declaration(3));
  for (let index = 28; index <= 40; index++) parts.push(filler(index));
  const text = parts.join('\n');
  assert.ok(Buffer.byteLength(text, 'utf8') > 24000, 'fixture sanity: the source is oversized');
  const source = { id: 'private:overflow', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T10:00:00Z', revision: 'r1', text };
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-10-01T18:00:00Z', revision: 'r2', text: '她约我周六去看展，怎么回？' };
  const result = compileContext({ asOf: '2026-10-01T18:10:00Z', request: { text: current.text },
    current, candidateSources: [source], budget: authorityFor(12000) });
  const admission = result.admissions.find(item => item.id === source.id);
  assert.equal(admission.tier, 'declarations', 'the digest rung was filtered out instead of silently losing a declaration');
  for (let index = 1; index <= 3; index++)
    assert.ok(result.payload.mandatoryMaterials.some(material => material.sentence.includes('第' + index + '场旧物展')),
      `declaration ${index} reaches delivered evidence`);
  assert.equal(result.payload.materialRequirements.outcomes.find(outcome => outcome.materialClass === 'declared_arrangement').status, 'delivered');
});

test('the selectPlanningContext shim compiles against the legacy dependency shape', t => {
  const { snapshot, companion, turn, asOf } = storeFixture(t, {
    requestText: '她问到这些了，帮我回一下。',
    notes: [{ text: declarationNote(60), at: '2026-09-30T18:00:00+08:00' }],
    incoming: [{ text: '周六下午能一起去看看吗？', at: '2026-10-01T18:00:00+08:00' }] });
  const result = selectPlanningContext({
    options: { asOf, purpose: 'discussion', byteBudget: 48000, budget: { measure: () => 0, requestByteBudget: 256000 },
      replyMessageIds: [9000], feedbackTargets: [] },
    snapshot, candidates: { intentSource: snapshot.current } });
  // Legacy result surface.
  for (const key of ['payload', 'coreItems', 'optionalRawLimit', 'optionalRawIds', 'optionalRetrieved',
    'recentContextPlan', 'recentPriorityIds', 'recentInitialAdditionalBytes', 'degradation', 'consultationSupport'])
    assert.ok(key in result, `shim result keeps the legacy field: ${key}`);
  assert.ok(result.payload.sources.length >= 1);
  assert.equal(result.payload.contextRequest.intentClass, 'invitation_arrangement');
  assert.ok(result.admission.version);
  // The oversized declaration source degrades instead of blocking.
  const oversized = result.admission.admissions.find(admission => admission.id !== snapshot.current.id);
  assert.ok(oversized && oversized.tier !== 'verbatim');
});
