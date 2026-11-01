'use strict';
// Deterministic coverage for the CC1 greenfield context components (design
// §3.1-§3.3, §4.1 C1/C2/C4): request analyzer, MQA registry and budget
// authority. Fictional fixtures only; no frozen eval import. Every new
// invariant of the three modules is pinned here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRequest, contextRequest, clearRequestCache, INTENT_CLASSES } = require('../src/context/request-analyzer.cjs');
const mqa = require('../src/context/mqa-registry.cjs');
const { BudgetAuthority, CallBudgets, defaultCallSplit, CALL_PURPOSES, TIER_RANK } = require('../src/context/budget-authority.cjs');
const { bytes } = require('../src/context/shared.cjs');

// ---- C1: request analyzer ----

test('question-type classification covers the five common product shapes', () => {
  clearRequestCache();
  // 邀约: an invitation answer with a concrete arrangement on the table.
  assert.equal(analyzeRequest({ text: '她约我周六下午一起去看旧物展，怎么回？' }).intentClass, 'invitation_arrangement');
  // 更正: correcting a previous assistant output.
  assert.equal(analyzeRequest({ text: '上一版的建议不对，重新组织一下' }).intentClass, 'feedback_continue');
  // 分享: sharing own real near-history.
  assert.equal(analyzeRequest({ text: '想跟她分享我最近的近况' }).intentClass, 'personal_share');
  // 咨询/接话: generic consultation, including reply-continuation phrasing.
  assert.equal(analyzeRequest({ text: '帮我看看接下来怎么办' }).intentClass, 'generic_consultation');
  const continuation = analyzeRequest({ text: '她刚发了这句话，我怎么接话' });
  assert.equal(continuation.intentClass, 'generic_consultation');
  assert.equal(continuation.wants.continueThread, true, '接话-shaped requests carry the continueThread want');
});

test('classification is deterministic, closed and cached by request hash', () => {
  clearRequestCache();
  const input = { text: '她约我周六下午一起去看旧物展，怎么回？', replyFocusTexts: [] };
  const first = analyzeRequest(input);
  const second = analyzeRequest(input);
  assert.strictEqual(first, second, 'same request hash returns the cached frozen object');
  assert.ok(INTENT_CLASSES.includes(first.intentClass), 'classified value is inside the closed enum');
  // Every enum member is classifiable or falls back — the analyzer never
  // returns an unknown class.
  for (const weird of ['', '   ', '???', 'abcd 1234']) {
    const result = analyzeRequest({ text: weird });
    assert.ok(INTENT_CLASSES.includes(result.intentClass));
    assert.equal(result.intentClass, 'generic_consultation', 'unclassifiable input degrades to the fallback, never an error');
  }
});

test('an anchored reply-focus message lifts the fallback classification', () => {
  clearRequestCache();
  const genericText = '怎么回？';
  assert.equal(analyzeRequest({ text: genericText }).intentClass, 'generic_consultation');
  const anchored = analyzeRequest({ text: genericText, replyFocusTexts: ['你周六有空吗？要不要一起去看展？'] });
  assert.equal(anchored.intentClass, 'invitation_arrangement');
  assert.equal(anchored.classification.basis, 'anchor');
});

test('contextRequest enriches MQA evidence requirements for the intent', () => {
  clearRequestCache();
  const request = contextRequest({ text: '她约我周六下午一起去看旧物展，怎么回？' });
  assert.equal(request.version, 'context-request-v1');
  assert.ok(request.requiredEvidenceClasses.includes('declared_arrangement'));
  assert.ok(request.requiredEvidenceClasses.includes('availability_state'));
  assert.ok(request.negativeEvidenceClasses.includes('boundary_control'));
  const generic = contextRequest({ text: '帮我看看接下来怎么办' });
  assert.deepEqual(generic.requiredEvidenceClasses, [], 'generic consultation requires no material class');
});

// ---- C2: MQA registry ----

test('the matrix is total: every intent × material pair resolves to a row', () => {
  for (const intent of mqa.INTENT_CLASSES) for (const material of Object.keys(mqa.MATERIAL_CLASSES)) {
    const row = mqa.policyFor(intent, material);
    assert.ok(row && row.policy && row.minTier && row.floor in TIER_RANK, `${intent}×${material} resolves`);
    assert.ok([mqa.POLICY.MANDATORY, mqa.POLICY.SELECTED, mqa.POLICY.NEGATIVE_MANDATORY].includes(row.policy));
  }
  assert.equal(mqa.policyFor('nonsense_class', 'preference').policy, mqa.POLICY.SELECTED, 'unknown pairs fall to the default row, never throw');
});

test('invitation answers carry mandatory arrangement material and negative boundary control', () => {
  const requirements = mqa.requirementsFor('invitation_arrangement');
  const declared = requirements.mandatory.find(row => row.materialClass === 'declared_arrangement');
  assert.ok(declared, 'declared_arrangement is mandatory for invitation answers');
  assert.equal(declared.floor, 'declarations');
  assert.ok(mqa.tierAtLeast(declared.minTier, 'T1_current_permission'));
  assert.ok(requirements.negative.some(row => row.materialClass === 'boundary_control'), 'boundary control is a negative mandate');
  assert.ok(requirements.negative.some(row => row.materialClass === 'closed_topic'), 'ANY-intent closed topics are negative mandates');
});

test('registry versions and enums are frozen per candidate identity', () => {
  assert.equal(mqa.MQA_VERSION, 'mqa-registry-v1');
  assert.equal(mqa.INTENT_CLASSES.length, 13);
  assert.equal(Object.keys(mqa.MATERIAL_CLASSES).length, 11);
  assert.equal(mqa.AUTHORIZATION_TIERS.T4_never_outbound.rank, 4);
  assert.throws(() => { mqa.INTENT_CLASSES.push('extra'); }, TypeError);
});

test('declared arrangement extraction is verbatim, ranged and currency-flagged', () => {
  const text = '开头。周六三点半以后我有空，也愿意一起去。结尾没有时间的句子不打标。';
  const source = { id: 'private:n1', type: 'private', role: 'user', revision: 'r1', text, at: '2026-10-01T10:00:00Z' };
  const materials = mqa.declaredArrangementMaterials([source], { asOf: '2026-10-02T10:00:00Z' });
  assert.equal(materials.length, 1, 'only the near-time availability sentence is extracted');
  assert.equal(text.slice(materials[0].start, materials[0].end), materials[0].sentence, 'exact verbatim range');
  assert.deepEqual(materials[0].lookup.sourceIds, ['private:n1'], 'copy-ready lookup handle');
  assert.equal(materials[0].current, true, 'a one-day-old declaration is current');
  const stale = mqa.declaredArrangementMaterials([source], { asOf: '2026-11-15T10:00:00Z' });
  assert.equal(stale[0].current, false, 'an old declaration is flagged stale, not dropped');
});

test('arrangementHandling consumption: reason is mandatory when a delivered declaration is not used (B5)', () => {
  const delivered = [{ sourceId: 'private:n1', current: true }, { sourceId: 'private:n2', current: true }];
  // used + cited evidence: fine.
  assert.equal(mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered,
    handling: { disposition: 'used', evidenceRefs: ['private:n1'] } }).ok, true);
  // not used WITHOUT a reason over a delivered current declaration: rejected.
  const rejected = mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered,
    handling: { disposition: 'missing', evidenceRefs: [] } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'arrangement_handling_reason_required');
  // not used WITH a concrete reason: the confirmation question stays available.
  assert.equal(mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered,
    handling: { disposition: 'conflict', evidenceRefs: [], reason: '来信约的是周五，声明说的是周六' } }).ok, true);
  // used without any delivered evidence: rejected.
  assert.equal(mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered: [],
    handling: { disposition: 'used', evidenceRefs: ['private:n1'] } }).code, 'arrangement_handling_used_without_evidence');
  // used but citing an undelivered source: rejected.
  assert.equal(mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered,
    handling: { disposition: 'used', evidenceRefs: ['private:other'] } }).code, 'arrangement_handling_evidence_missing');
});

test('stale declarations no longer force a reason; other intents are not applicable', () => {
  const stale = [{ sourceId: 'private:n1', current: false }];
  assert.equal(mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered: stale,
    handling: { disposition: 'missing', evidenceRefs: [] } }).ok, true, 'stale declaration → asking is legitimate');
  assert.equal(mqa.validateArrangementHandling({ intentClass: 'generic_consultation', delivered: stale,
    handling: null }).ok, true, 'non-arrangement intents have no arrangementHandling requirement');
  assert.equal(mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered: [],
    handling: null }).code, 'arrangement_handling_missing');
  assert.equal(mqa.validateArrangementHandling({ intentClass: 'invitation_arrangement', delivered: [],
    handling: { disposition: 'maybe', evidenceRefs: [] } }).code, 'arrangement_handling_disposition_invalid');
});

test('authorization tier codes interoperate with the trunk RT1 tier vocabulary', () => {
  // Cross-checked against the dsh-goal trunk retrieval service
  // (src/memory/retrieval-service.cjs AUTHORIZATION_TIERS: T0 public_qq ...
  // T4 never_outbound). Compiler-side tiers and retrieval-side tier filters
  // must speak the same five semantics so MQA minTier rows compose with
  // retrieval tiers at integration without string surgery.
  const expected = { T0: 'public_qq', T1: 'current_permission', T2: 'declared_shareable', T3: 'private_planning', T4: 'never_outbound' };
  assert.equal(Object.keys(mqa.AUTHORIZATION_TIERS).length, 5);
  for (const [name, tier] of Object.entries(mqa.AUTHORIZATION_TIERS)) {
    assert.equal(tier.semantic, expected[tier.code], `${name} matches the retrieval-service semantic for ${tier.code}`);
    assert.equal(mqa.tierFromCode(tier.code), name, 'codes round-trip to registry keys');
  }
  assert.equal(mqa.tierFromCode('T9'), null, 'unknown codes resolve to null, never a guess');
});

// ---- C4: budget authority ----

test('one authority owns the two-cap fits and reports both caps in the manifest (B6)', () => {
  const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 1000, requestByteBudget: 800,
    measureRequest: obj => bytes(obj) * 2 });
  const small = { a: 'x'.repeat(100) };
  assert.equal(authority.fits(small), true);
  const big = { a: 'x'.repeat(2000) };
  assert.equal(authority.fits(big), false, 'payload cap owned here');
  const requestHeavy = { a: 'x'.repeat(450) };
  assert.equal(authority.fits(requestHeavy), false, 'serialized request cap owned in the same place');
  const manifest = authority.manifest(big);
  assert.equal(manifest.byteBudget, 1000);
  assert.equal(manifest.requestByteBudget, 800);
  assert.equal(manifest.serializedTextRequestBytes, bytes(big) * 2);
  assert.equal(manifest.version, 'budget-authority-v1');
  assert.deepEqual(manifest.degradationOrder, []);
});

test('answer-context allocations are named with a declared yield order', () => {
  const authority = BudgetAuthority.forAnswerContext({ byteBudget: 48000, measureRequest: () => 0 });
  const names = authority.allocations.map(allocation => allocation.name);
  assert.deepEqual(names, ['exchange', 'privateLayer', 'relationship', 'recentWindow', 'directory', 'navigation']);
  assert.ok(authority.allocations[0].floor > 0, 'the exchange floor is reserved, never yields');
  assert.deepEqual(authority.degradationOrder, ['navigation', 'directory', 'recentWindow', 'relationship', 'privateLayer']);
});

test('plan is guaranteed deliverable: non-floor content never nulls the plan', () => {
  // Raw constructor: factories clamp small budgets to the product minimum
  // (mirroring legacy byteBudget bounds); the guarantee must hold at any size.
  const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 2000, measureRequest: () => 0 });
  const plan = authority.plan([
    { id: 'floor', kind: 'floor', floorTier: 'ranged', tierSizes: [{ tier: 'verbatim', bytes: 1500 }, { tier: 'ranged', bytes: 300 }] },
    { id: 'bg', kind: 'background', floorTier: 'marker', tierSizes: [{ tier: 'verbatim', bytes: 9000 }, { tier: 'digest', bytes: 800 }, { tier: 'marker', bytes: 60 }] }
  ]);
  assert.equal(plan.deliverable, true);
  const background = plan.admissions.find(admission => admission.id === 'bg');
  assert.equal(background.tier, 'marker', 'oversized background degrades to an explicit marker instead of failing the plan');
  assert.ok(plan.degradation.some(entry => entry.appliedTo === 'bg' && entry.step === 'degraded_to_marker'));
});

test('a floor below the minimal envelope is the only undeliverable plan', () => {
  const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 1000, measureRequest: () => 0 });
  const plan = authority.plan([
    { id: 'floor', kind: 'floor', floorTier: 'ranged', tierSizes: [{ tier: 'verbatim', bytes: 5000 }, { tier: 'ranged', bytes: 2000 }] }
  ]);
  assert.equal(plan.deliverable, false);
  assert.equal(plan.reason, 'minimal_envelope_exceeded');
});

test('memory-batch instantiation reproduces the correction-reserve fit rule', () => {
  const authority = BudgetAuthority.forMemoryBatch({ requestBytes: 48000, correctionOverheadBytes: 6000 });
  assert.equal(authority.effectivePayloadBudget, 42000, 'the undegradable correction reserve is subtracted, not borrowed');
  const batch = { sources: 'x'.repeat(41000) };
  assert.equal(authority.fits(batch), true);
  const overBatch = { sources: 'x'.repeat(43000) };
  assert.equal(authority.fits(overBatch), false, 'a batch that would starve its own correction round is rejected by the same vocabulary');
  assert.equal(authority.manifest(null).purpose, 'memory_batch');
});

test('compaction budgets skip without failing when headroom is absent', () => {
  const authority = BudgetAuthority.forCompaction({ availableBytes: 10000, baseBytes: 8000 });
  assert.deepEqual(authority.planCompaction({ candidateBytes: 1500 }), { skipped: false, candidateBytes: 1500, headroom: 2000 });
  const skipped = authority.planCompaction({ candidateBytes: 3000 });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'no_headroom', 'compaction is a ladder step, never a feasibility gate');
});

test('guaranteed artifacts keep their tier or an explainable marker, never a silent drop (B6)', () => {
  const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 3000, measureRequest: () => 0,
    guaranteed: [{ id: 'artifact', tier: 'digest' }] });
  const roomy = authority.plan([
    { id: 'artifact', kind: 'guaranteed', floorTier: 'marker', tierSizes: [{ tier: 'digest', bytes: 1200 }, { tier: 'marker', bytes: 80 }] },
    { id: 'floor', kind: 'floor', floorTier: 'ranged', tierSizes: [{ tier: 'verbatim', bytes: 800 }, { tier: 'ranged', bytes: 200 }] }
  ]);
  assert.equal(roomy.admissions.find(admission => admission.id === 'artifact').tier, 'digest', 'guarantee holds when it fits');
  const tight = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 400, measureRequest: () => 0,
    guaranteed: [{ id: 'artifact', tier: 'digest' }] })
    .plan([{ id: 'artifact', kind: 'guaranteed', floorTier: 'marker', tierSizes: [{ tier: 'digest', bytes: 1200 }, { tier: 'marker', bytes: 80 }] },
      { id: 'floor', kind: 'floor', floorTier: 'ranged', tierSizes: [{ tier: 'verbatim', bytes: 150 }, { tier: 'ranged', bytes: 150 }] }]);
  const marker = tight.admissions.find(admission => admission.id === 'artifact');
  assert.equal(marker.tier, 'marker', 'an impossible guarantee degrades to an explicit marker');
  assert.ok(tight.degradation.some(entry => entry.step === 'guarantee_degraded_to_marker' && entry.appliedTo === 'artifact'), 'the miss is recorded, never silent');
  assert.equal(tight.deliverable, true, 'the answer plan itself still delivers');
});

// ---- C4/B9: per-purpose call budgets ----

test('call splits are exclusive: exhausted lookups can never starve delivery attempts (B9)', () => {
  const split = defaultCallSplit(6);
  assert.deepEqual(split, { retrieval_continuation: 2, delivery_attempt: 3, repair: 1 });
  for (const total of [1, 2, 4, 6, 12]) {
    const shares = defaultCallSplit(total);
    const sum = Object.values(shares).reduce((a, b) => a + b, 0);
    assert.ok(sum <= total, `shares sum to at most the ceiling (total=${total})`);
    assert.ok(shares.delivery_attempt >= 1, 'delivery always keeps at least one attempt');
  }
});

test('same-form B9 scenario: lookups exhaust their share while delivery proceeds', () => {
  // The observed failure: 2 lookup continuations + 3 delivery attempts drew
  // from ONE 4-call pool and the delivery died. With per-purpose splits the
  // second lookup cannot take the delivery share.
  const calls = CallBudgets.fromRequestLimit(6);
  assert.equal(calls.reserve('retrieval_continuation').allowed, true);
  assert.equal(calls.reserve('retrieval_continuation').allowed, true);
  const third = calls.reserve('retrieval_continuation');
  assert.equal(third.allowed, false);
  assert.equal(third.code, 'call_purpose_exhausted');
  for (let index = 0; index < 3; index++) assert.equal(calls.reserve('delivery_attempt').allowed, true, `delivery attempt ${index + 1} proceeds`);
  assert.equal(calls.reserve('delivery_attempt').code, 'call_purpose_exhausted', 'the delivery share is also bounded');
  assert.equal(calls.reserve('repair').allowed, true);
  assert.equal(calls.reserve('delivery_attempt').code, 'call_budget_exhausted', 'the total ceiling still holds');
});

test('the call split is visible in the manifest per purpose', () => {
  const calls = CallBudgets.fromRequestLimit(6);
  calls.reserve('retrieval_continuation');
  const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 1000, measureRequest: () => 0, callBudgets: calls });
  const manifest = authority.manifest(null);
  assert.equal(manifest.callBudgets.version, 'call-budgets-v1');
  assert.equal(manifest.callBudgets.total, 6);
  const purposes = Object.fromEntries(manifest.callBudgets.purposes.map(entry => [entry.purpose, entry]));
  assert.deepEqual(Object.keys(purposes).sort(), [...CALL_PURPOSES].sort());
  assert.equal(purposes.retrieval_continuation.used, 1);
  assert.equal(purposes.retrieval_continuation.limit, 2);
  assert.equal(purposes.delivery_attempt.remaining, 3);
  assert.equal(authority.reserveCall('delivery_attempt').allowed, true, 'the authority exposes the same ledger it manifests');
});

test('invalid call-budget configurations are rejected loudly', () => {
  assert.throws(() => new CallBudgets({ total: 2, purposes: { retrieval_continuation: 2, delivery_attempt: 2 } }), /at most the total/);
  assert.throws(() => new CallBudgets({ total: 4, purposes: { unknown_purpose: 1 } }), /Unknown call purpose/);
  assert.throws(() => new CallBudgets({ total: 4, purposes: { delivery_attempt: 9 } }), /exceeds the total/);
});
