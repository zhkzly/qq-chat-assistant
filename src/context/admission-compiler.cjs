'use strict';
// C3 Admission Compiler (greenfield context subsystem, design §3.1 steps
// 1-7): compile one request into a deliverable admission plan using the
// requirement-ordered degradation ladder
//   verbatim → ranged excerpt(+continuation) → structural digest(+handles)
//   → digest declarations(+handles) → directory entry / explicit missing-marker
// ordered by declared material requirement (MQA), under one Budget Authority.
//
// Invariants enforced here (each has a deterministic test):
//   - the compiler ALWAYS returns a deliverable plan; the only hard failure is
//     a current request below the minimal envelope (B4);
//   - every large private source enters the ladder — no whole-admission
//     threshold, no compaction feasibility gate (backlog #3 dead band removed);
//   - MQA-mandatory materials reach at least their registry floor tier, so a
//     declared arrangement can no longer be shadowed out of evidence (B5);
//   - background evidence never blocks the current-interaction floor and the
//     floor never drops below an explicit marked range;
//   - every degradation step is recorded with a copy-ready lookup handle;
//   - speakerBasis entailment rendering stays in this rendering layer (C5):
//     derived fragments get holder labels derived from their evidence closure.
//
// This module is a greenfield sibling of selection.cjs: it exposes a
// selectPlanningContext-compatible shim but existing callers keep their legacy
// wiring until the integration stream swaps them.
const { bytes, pick } = require('./shared.cjs');
const { boundedSource } = require('./source-delivery.cjs');
const { digestSource, DIGEST_VERSION, declarationSentences } = require('./evidence-digest.cjs');
const { contextRequest } = require('./request-analyzer.cjs');
const { requirementsFor, declaredArrangementMaterials, consumptionContractFor, MQA_VERSION } = require('./mqa-registry.cjs');
const { BudgetAuthority, TIER_RANK } = require('./budget-authority.cjs');
const { holderBasis } = require('../speaker-identity.cjs');

const ADMISSION_COMPILER_VERSION = 'admission-compiler-v1';
const LADDER = Object.freeze(['verbatim', 'ranged', 'digest', 'declarations', 'marker']);
// Range shrink steps shared with the legacy floor treatment; the question
// itself is never digested, only explicitly marked ranges.
const FLOOR_RANGE_STEPS = [12000, 6000, 3000, 1600, 800, 400, 200];
const BACKGROUND_RANGE_STEPS = [6000, 3000, 1600, 800, 400];
const DECLARATION_RULE = '已声明安排/可用性为逐字原句加精确范围，仅导航非许可；与来信邀约一致时直接采用并按consumptionContract.arrangementHandling申报处置；未声明、过期或冲突才澄清；外发引用前按lookup取回完整原文';
const ADMISSION_RULE = 'requirement-ordered admission; floor never dropped; every degradation carries a lookup handle; no compaction feasibility gate';

// ---- Ladder tier views (deterministic, exact-span, no model call) ----

// Slim tier: only the verbatim declared-arrangement sentences with per-sentence
// copy-ready lookup handles. This is the tier that makes a declaration hidden
// deep inside a huge source reach evidence even when the structural digest is
// itself too large for the remaining budget.
function declarationsView(source) {
  const text = String(source.text || '');
  const found = declarationSentences(text);
  if (!found.length) return null;
  const declarations = found.map(item => ({
    sentence: item.sentence, revision: source.revision, start: item.start, end: item.end,
    lookup: { sourceIds: [source.id], offset: item.start, maxChars: Math.max(1, item.end - item.start) }
  }));
  return {
    id: source.id, type: source.type, role: source.role, at: source.at, use: source.use,
    ...(source.kind ? { kind: source.kind } : {}), revision: source.revision,
    digest: { version: DIGEST_VERSION, authority: 'derived_digest_needs_lookup', declarations,
      declarationRule: DECLARATION_RULE, originalCharLength: text.length },
    delivery: { version: 'source-delivery-v1', status: 'declarations', start: 0, end: 0,
      originalCharLength: text.length, offsetUnit: 'utf16_redacted_source', lookup: { sourceId: source.id, revision: source.revision, offset: 0 } }
  };
}

// Explicit missing/directory marker: the source stays addressable through its
// lookup handle; nothing about its content is asserted.
function markerView(source, note = 'source not deliverable in this request; available via lookup') {
  const text = String(source.text || '');
  return {
    id: source.id, type: source.type, role: source.role, at: source.at, use: source.use,
    ...(source.kind ? { kind: source.kind } : {}), revision: source.revision,
    marker: { version: 'admission-marker-v1', kind: 'omitted_source', note },
    delivery: { version: 'source-delivery-v1', status: 'omitted', start: 0, end: 0,
      originalCharLength: text.length, offsetUnit: 'utf16_redacted_source', lookup: { sourceId: source.id, revision: source.revision, offset: 0 } }
  };
}

// Build the ordered tier sizes for one source. Floor sources never receive
// digest/declarations tiers (their minimum is an explicit range); background
// sources walk the full ladder.
function tierSizesFor(source, { floor = false, rangeSteps = BACKGROUND_RANGE_STEPS, start = 0 } = {}) {
  const sizes = [];
  if (source && typeof source.text === 'string' && source.text) {
    const whole = bytes(source);
    sizes.push({ tier: 'verbatim', bytes: whole, view: source });
    for (const maxBytes of rangeSteps) {
      const projected = boundedSource(source, { maxBytes, start });
      // A "range" that returns the whole source is the verbatim tier, not a
      // ranged view; keeping both would mislabel whole admissions as degraded.
      if (projected && projected.text && bytes(projected) < whole) sizes.push({ tier: 'ranged', bytes: bytes(projected), view: projected });
    }
    if (!floor) {
      const digested = digestSource(source);
      if (digested) sizes.push({ tier: 'digest', bytes: bytes(digested), view: digested });
      const declarations = declarationsView(source);
      if (declarations) sizes.push({ tier: 'declarations', bytes: bytes(declarations), view: declarations });
    }
  }
  sizes.push({ tier: 'marker', bytes: bytes(markerView(source)), view: markerView(source) });
  const seen = new Set();
  return sizes.filter(size => { const key = `${size.tier}:${size.bytes}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

// ---- Continuation-handle expansion (B9 / RT1 alignment) ----

// Limits cross-checked with the trunk retrieval service (dsh-goal
// src/memory/retrieval-service.cjs RANGE_LIMITS): one program-side
// retrieveRanges call resolves up to 64 {sourceId, offset?, maxChars<=16384,
// revision?} ranges in a single round trip. Expanding the compiler's
// universal {sourceIds, offset, maxChars} handles into that batch shape is
// what lets evidence continuation stop spending per-range model calls
// (appendix B9: prefer batched program-side retrieval).
const RETRIEVAL_RANGE_LIMITS = Object.freeze({ maxRanges: 64, maxCharsPerRange: 16384 });
const DEFAULT_CONTINUATION_CHARS = 800;

// Expand ladder/digest/declaration lookup handles into retrieval-service
// range entries. Accepts both the universal plural form ({sourceIds, offset,
// maxChars?}) and the legacy singular delivery form ({sourceId, offset,
// maxChars?}); revision passes through when present. Handles without
// maxChars default to a bounded continuation read. Pure; no retrieval here.
function continuationRanges(handles, { maxRanges = RETRIEVAL_RANGE_LIMITS.maxRanges,
  maxCharsPerRange = RETRIEVAL_RANGE_LIMITS.maxCharsPerRange } = {}) {
  const ranges = [], dropped = [];
  for (const handle of handles || []) {
    if (!handle || typeof handle !== 'object') continue;
    const ids = Array.isArray(handle.sourceIds) ? handle.sourceIds : handle.sourceId ? [handle.sourceId] : [];
    for (const sourceId of ids) {
      if (ranges.length >= maxRanges) { dropped.push({ sourceId, reason: 'max_ranges' }); continue; }
      const wanted = Number.isSafeInteger(handle.maxChars) && handle.maxChars >= 1 ? handle.maxChars : DEFAULT_CONTINUATION_CHARS;
      ranges.push(Object.freeze({ sourceId,
        offset: Number.isSafeInteger(handle.offset) && handle.offset >= 0 ? handle.offset : 0,
        maxChars: Math.min(maxCharsPerRange, wanted),
        ...(handle.revision ? { revision: handle.revision } : {}) }));
    }
  }
  return Object.freeze({ ranges: Object.freeze(ranges), ...(dropped.length ? { dropped: Object.freeze(dropped) } : {}) });
}

// ---- The compiler ----

const KIND_RANK = { floor: 0, mandatory: 1, guaranteed: 2, background: 3 };

function compileContext(options = {}) {
  const {
    asOf = new Date().toISOString(), purpose = 'discussion', scope = null,
    request = {}, current, intentSource = null, candidateSources = [],
    explicitLookups = [], derivedFragments = [], boundaryRecords = [], closedTopics = [],
    budget = null, byteBudget = 48000, callBudgets = null, guaranteed = []
  } = options;
  if (!current || typeof current !== 'object' || !current.id) throw new Error('当前请求来源缺失，无法编译上下文');
  const intent = intentSource && intentSource.id !== current.id ? intentSource : current;
  const sourceOrder = [current, ...candidateSources, intent].filter(Boolean);
  const byId = new Map(sourceOrder.map(source => [source.id, source]));

  // (1) ContextRequest — question type, anchors, wants (C1).
  const context = contextRequest({ ...request, asOf });
  // (2) MQA requirements (C2).
  const requirements = requirementsFor(context.intentClass);

  // (5) Budget authority: default answer-context instantiation when the caller
  // did not pass one (integration will pass the shared instance). An explicit
  // `guaranteed` option is honored even with a passed authority: the authority
  // is re-instantiated with the guarantee list before anything is recorded.
  let authority = budget instanceof BudgetAuthority ? budget
    : BudgetAuthority.forAnswerContext({ byteBudget, measureRequest: () => 0, callBudgets, guaranteed });
  if (guaranteed.length && !authority.guaranteed.length) {
    const manifestSeed = authority.manifest(null);
    authority = new BudgetAuthority({ purpose: authority.purpose, payloadByteBudget: authority.payloadByteBudget,
      requestByteBudget: authority.requestByteBudget, measureRequest: value => authority.measureRequest(value),
      reserveBytes: manifestSeed.reserveBytes, allocations: authority.allocations, degradationOrder: authority.degradationOrder,
      guaranteed, callBudgets: authority.callBudgets });
  }
  const guaranteedIds = new Set(authority.guaranteed.map(guarantee => guarantee.id));

  // ---- Requirement list: floor → MQA-mandatory materials → explicit lookups
  // → guaranteed artifacts → background. The planner re-enforces kind order.
  const degradation = [];
  // Single writer with two ledgers: every step lands on BOTH the plan-local
  // ledger and the authority ledger, so manifest.degradation explains plan-time
  // AND settlement-time degradation alike (design §3.1: each step recorded in
  // manifest.degradation — a manifest that only knew half the steps would not
  // be explainable).
  const record = (step, appliedTo, recovered, remainingNeed, lookupHandle) => {
    const entry = { step, appliedTo, recoveredBytes: Math.max(0, Math.trunc(recovered) || 0),
      remainingNeed: Math.max(0, Math.trunc(remainingNeed) || 0), ...(lookupHandle ? { lookupHandle } : {}) };
    degradation.push(entry);
    authority.recordDegradation(step, appliedTo, entry.recoveredBytes, entry.remainingNeed, lookupHandle);
    return entry;
  };

  const required = new Map();
  const addRequirement = (id, requirement) => {
    const existing = required.get(id);
    if (!existing) required.set(id, requirement);
    else if ((KIND_RANK[requirement.kind] ?? 9) < (KIND_RANK[existing.kind] ?? 9))
      required.set(id, { ...requirement, tierSizes: existing.tierSizes });
  };
  // A ranged floor is only meaningful when an actual sub-whole range rung
  // exists; a source small enough that every range equals the whole body uses
  // verbatim as its floor (it can never be squeezed, only delivered or not).
  const rangedFloor = sizes => sizes.some(size => size.tier === 'ranged') ? 'ranged' : 'verbatim';

  // Floor members: current request + bound intent. Never below an explicit
  // marked range; the question is never digested or dropped.
  for (const member of [current, intent]) {
    if (!member || required.has(member.id)) continue;
    const sizes = tierSizesFor(member, { floor: true, rangeSteps: FLOOR_RANGE_STEPS });
    addRequirement(member.id, { id: member.id, kind: 'floor', floorTier: rangedFloor(sizes),
      note: member === current ? 'current request' : 'intent source',
      lookupHandle: { sourceIds: [member.id], revision: member.revision, offset: 0 },
      tierSizes: sizes });
  }

  // MQA-mandatory materials. declared_arrangement / availability_state extract
  // from sources via the declaration extractor; each bearing source joins the
  // plan at the strictest applicable floor (declarations tier), so a declaration
  // buried in an oversized source still reaches evidence (B5).
  const materialSources = [];
  const declarationMaterials = [];
  const wantsDeclarations = requirements.mandatory.some(row => ['declared_arrangement', 'availability_state'].includes(row.materialClass))
    || authority.guaranteed.some(guarantee => guaranteedIds.has(guarantee.id) && byId.has(guarantee.id));
  if (wantsDeclarations) for (const source of [...candidateSources, current, intent].filter(Boolean)) {
    const materials = declaredArrangementMaterials([source], { asOf });
    if (!materials.length) continue;
    declarationMaterials.push(...materials);
    if (!materialSources.some(item => item.id === source.id)) materialSources.push(source);
  }
  for (const source of materialSources) {
    if (required.has(source.id)) continue;
    // Material-true floor (B5): a rung only satisfies the declared_arrangement
    // floor when it actually carries the declaration sentences. Ranged views
    // must span them; DIGEST views must contain them — a digest line is only
    // the paragraph-leading sentence, so a mid-paragraph declaration can be
    // absent from an otherwise-fine digest, and that rung is dropped instead of
    // silently losing the declaration. The declarations tier is built from the
    // same extractor and carries the sentences by construction.
    const sentences = declarationMaterials.filter(material => material.sourceId === source.id).map(material => material.sentence);
    const carries = size => {
      if (size.tier === 'ranged') return sentences.every(sentence => String(size.view.text || '').includes(sentence));
      if (size.tier === 'digest') return sentences.every(sentence => JSON.stringify(size.view).includes(sentence));
      return true;
    };
    addRequirement(source.id, { id: source.id, kind: 'mandatory', floorTier: 'declarations', note: 'declared_arrangement material',
      lookupHandle: { sourceIds: [source.id], revision: source.revision, offset: 0 },
      tierSizes: tierSizesFor(source).filter(carries) });
  }
  // contact_statement (emotional_support / repair): anchored reply-focus sources.
  const contactSources = requirements.mandatory.some(row => row.materialClass === 'contact_statement')
    ? (Array.isArray(request.replyFocus) ? request.replyFocus : []).map(id => byId.get(id)).filter(Boolean)
    : [];
  for (const source of contactSources) {
    if (required.has(source.id)) continue;
    const sizes = tierSizesFor(source, { rangeSteps: BACKGROUND_RANGE_STEPS });
    addRequirement(source.id, { id: source.id, kind: 'mandatory', floorTier: rangedFloor(sizes), note: 'contact_statement material',
      lookupHandle: { sourceIds: [source.id], revision: source.revision, offset: 0 },
      tierSizes: sizes });
  }
  // feedback_target (feedback_continue): selected feedback sources.
  if (requirements.mandatory.some(row => row.materialClass === 'feedback_target'))
    for (const target of request.feedbackTargets || []) {
      const source = byId.get(target.sourceId || target.id);
      if (source && !required.has(source.id)) {
        const sizes = tierSizesFor(source);
        addRequirement(source.id, { id: source.id, kind: 'mandatory', floorTier: rangedFloor(sizes), note: 'feedback_target material',
          lookupHandle: { sourceIds: [source.id], revision: source.revision, offset: 0 }, tierSizes: sizes });
      }
    }

  // Explicit range reads are user intent: mandatory at ranged floor.
  for (const read of explicitLookups || []) {
    const source = byId.get(read.id || read);
    if (!source || required.has(source.id)) continue;
    const start = read.offset ?? read.delivery?.start ?? 0;
    const sizes = tierSizesFor(source, { start });
    addRequirement(source.id, { id: source.id, kind: 'mandatory', floorTier: rangedFloor(sizes), note: 'explicit lookup read',
      lookupHandle: { sourceIds: [source.id], revision: source.revision, offset: start },
      tierSizes: sizes });
  }

  // B6 guarantees: memory-admitted artifacts keep at least their guaranteed
  // tier in the answer path. The guaranteed tier becomes the requirement floor
  // (pinning it in the plan); if the floor itself cannot fit, the plan-retry
  // below relaxes guarantees to explicit markers — the current-interaction
  // floor outranks background guarantees (design §5 C2 conflict rule).
  const guaranteedFloor = (source, tier) => {
    const sizes = tierSizesFor(source);
    const reachable = sizes.filter(size => TIER_RANK[size.tier] >= TIER_RANK[tier]);
    return { sizes, floorTier: reachable.length ? reachable[reachable.length - 1].tier : 'marker' };
  };
  for (const guarantee of authority.guaranteed) {
    const source = byId.get(guarantee.id);
    if (source && !required.has(source.id)) {
      const { sizes, floorTier } = guaranteedFloor(source, guarantee.tier);
      addRequirement(source.id, { id: source.id, kind: 'guaranteed', floorTier, note: `guaranteed ≥${guarantee.tier}`,
        lookupHandle: { sourceIds: [source.id], revision: source.revision, offset: 0 }, tierSizes: sizes });
    }
    // B6 never-silent-drop: a guarantee naming an artifact that is not in the
    // candidate set is an explainable miss, not a void.
    if (!source) record('guarantee_source_missing', guarantee.id, 0, 0, null);
  }

  // Background candidates: everything else, full ladder down to marker.
  for (const source of candidateSources) {
    if (required.has(source.id)) continue;
    addRequirement(source.id, { id: source.id, kind: 'background', floorTier: 'marker', note: 'background candidate',
      lookupHandle: { sourceIds: [source.id], revision: source.revision, offset: 0 }, tierSizes: tierSizesFor(source) });
  }

  // Plan under the authority. Admissions are copied mutable: settlement below
  // may degrade them further once metadata bytes are measured. If the floor
  // cannot fit with guarantees/mandatory materials pinned, relax their floors
  // to explicit markers — the current-interaction floor outranks everything
  // (design §5 C2 conflict rule) and the answer proceeds instead of blocking.
  let planned = authority.plan([...required.values()]);
  if (!planned.deliverable) {
    const relaxed = [...required.values()].map(requirement => requirement.kind === 'floor' || requirement.floorTier === 'marker'
      ? requirement : { ...requirement, floorTier: 'marker', guaranteeRelaxed: requirement.kind !== 'background' });
    const retry = authority.plan(relaxed);
    if (retry.deliverable) {
      planned = retry;
      required.clear();
      for (const requirement of relaxed) required.set(requirement.id, requirement);
      for (const requirement of relaxed.filter(item => item.guaranteeRelaxed))
        record('requirement_floor_relaxed_to_marker', requirement.id, 0, 0, requirement.lookupHandle);
      for (const guarantee of authority.guaranteed)
        if (required.get(guarantee.id)?.floorTier === 'marker')
          record('guarantee_degraded_to_marker', guarantee.id, 0, 0, { sourceIds: [guarantee.id], revision: byId.get(guarantee.id)?.revision, offset: 0 });
    }
  }
  if (!planned.deliverable) throw new Error('即使按最小显式范围交付当前问题并降级其余内容，本次上下文预算仍不足以组成有效请求；请提高本次预算或缩短当前问题；没有静默截断');
  const plan = { ...planned, admissions: planned.admissions.map(admission => ({ ...admission })) };

  // (7) Identity-entailed rendering stays at fragment-build time: each derived
  // fragment carries a mechanically derived speakerBasis (C5).
  const renderedFragments = (derivedFragments || []).map(({ record, fields = [] }) =>
    ({ ...pick(record, fields), speakerBasis: holderBasis(record, byId), fragmentKind: record.fragmentKind || 'derived' }));

  // Negative controls render as markers, never as resurrected content.
  const negativeControls = requirements.negative.flatMap(row => {
    const rendered = row.materialClass === 'closed_topic'
      ? closedTopics.map(topic => ({ id: topic.id, marker: 'closed_topic_not_restored', sourceIds: topic.sourceIds || [] }))
      : row.materialClass === 'boundary_control'
        ? boundaryRecords.map(item => ({ sourceId: item.sourceId, marker: 'boundary_control_never_violate', text: item.text }))
        : [];
    return rendered.map(item => ({ ...item, materialClass: row.materialClass, policy: row.policy }));
  });

  // ---- Materialize + settle. The payload is assembled by a closure so the
  // settlement loop always measures the COMPLETE deliverable (the request-body
  // mirror and the material metadata cost bytes too) and every degradation
  // step is reflected before the next fit test.
  const order = new Map(sourceOrder.map((source, index) => [source.id, index]));
  const assemble = () => {
    const admissionById = new Map(plan.admissions.map(admission => [admission.id, admission]));
    const delivered = plan.admissions.filter(admission => admission.tier !== 'marker').map(admission => admission.view);
    delivered.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.id.localeCompare(b.id));

    const floorView = admissionById.get(current.id)?.view || current;
    const userRequest = { sourceId: current.id, text: floorView.text,
      ...(floorView.digest ? { digest: floorView.digest } : {}),
      ...(floorView.delivery && floorView.delivery.status !== 'delivered' ? { delivery: floorView.delivery,
        requestDeliveryRule: 'range_delivered_request_body; undelivered parts are unknown, continue via delivery.lookup, never fabricate them' } : {}) };

    // Material requirement outcomes (B5 explainability): what was mandatory,
    // from which source, at which tier — or honestly missing.
    const tierOf = item => {
      const admission = admissionById.get(item.id || item.sourceId);
      return !admission || admission.tier === 'marker' ? 'marker' : admission.tier;
    };
    // A declaration material is delivered only when its verbatim sentence is
    // actually present in the admitted view: verbatim always, a range only if
    // it spans the sentence, a digest only if the sentence survives its lines,
    // the declarations tier carries it by construction.
    const declarationDelivered = material => {
      const admission = admissionById.get(material.sourceId);
      if (!admission || admission.tier === 'marker') return false;
      if (admission.tier === 'verbatim') return true;
      if (admission.tier === 'ranged') return String(admission.view.text || '').includes(material.sentence);
      if (admission.tier === 'digest') return JSON.stringify(admission.view).includes(material.sentence);
      return TIER_RANK[admission.tier] >= TIER_RANK.declarations;
    };
    const deliveredDeclarations = declarationMaterials.filter(declarationDelivered);
    const materialRequirements = requirements.mandatory.map(row => {
      const isDeclarationRow = row.materialClass === 'declared_arrangement' || row.materialClass === 'availability_state';
      const sources = isDeclarationRow
        ? materialSources.map(source => ({ sourceId: source.id, tier: tierOf(source) }))
        : row.materialClass === 'contact_statement'
          ? contactSources.map(source => ({ sourceId: source.id, tier: tierOf(source) }))
          : [];
      const status = isDeclarationRow
        ? (declarationMaterials.length ? (deliveredDeclarations.length ? 'delivered' : 'degraded') : 'missing')
        : sources.some(item => TIER_RANK[item.tier] >= TIER_RANK[row.floor]) ? 'delivered' : sources.length ? 'degraded' : 'missing';
      return { materialClass: row.materialClass, policy: row.policy, floor: row.floor, minTier: row.minTier,
        status,
        ...(sources.length ? { sources } : { note: 'no material of this class exists in the current candidate set' }) };
    });

    return {
      version: ADMISSION_COMPILER_VERSION, asOf, purpose,
      userRequest, intentAuthority: { sourceId: intent.id }, sources: delivered,
      contextRequest: { version: context.version, intentClass: context.intentClass, classification: context.classification,
        wants: context.wants, anchors: context.anchors },
      materialRequirements: { version: MQA_VERSION, intentClass: context.intentClass, outcomes: materialRequirements },
      mandatoryMaterials: deliveredDeclarations.map(material => ({ materialClass: material.materialClass, sourceId: material.sourceId,
        revision: material.revision, sentence: material.sentence, start: material.start, end: material.end,
        current: material.current, lookup: material.lookup })),
      consumptionContract: consumptionContractFor(context.intentClass),
      negativeControls, derivedFragments: renderedFragments,
      degradation,
      admissionPolicy: { version: ADMISSION_COMPILER_VERSION, ladder: LADDER, rule: ADMISSION_RULE } };
  };

  // Mirror plan-level steps into the plan-local ledger only — plan() has
  // already recorded them on the authority ledger, so re-recording here would
  // duplicate the manifest entries.
  for (const entry of planned.degradation) degradation.push({ ...entry });

  // Settlement: degrade admissions (never a floor below its explicit range)
  // until the assembled payload fits. Each step shrinks real bytes, so the
  // loop always makes progress; exhaustion means the minimal envelope itself
  // cannot fit, which is the single honest hard failure.
  const ladderDown = admission => {
    const requirement = required.get(admission.id);
    const next = requirement.tierSizes
      .filter(size => size.bytes < admission.bytes && TIER_RANK[size.tier] >= TIER_RANK[requirement.floorTier])
      .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.bytes - a.bytes)[0];
    if (!next) return null;
    const recovered = admission.bytes - next.bytes;
    admission.bytes = next.bytes; admission.tier = next.tier; admission.view = next.view;
    return recovered;
  };
  let payload = assemble();
  let guard = 0;
  while (!authority.fits(payload) && guard++ < 512) {
    const canDegrade = admission => {
      const requirement = required.get(admission.id);
      return requirement.tierSizes.some(size => size.bytes < admission.bytes && TIER_RANK[size.tier] >= TIER_RANK[requirement.floorTier]);
    };
    const target = plan.admissions.filter(canDegrade)
      .sort((a, b) => (KIND_RANK[b.kind] ?? 9) - (KIND_RANK[a.kind] ?? 9) || b.bytes - a.bytes)[0];
    if (!target) {
      if (authority.measure(payload) <= authority.effectivePayloadBudget)
        throw new Error('配置的请求预算低于最小请求信封，任何问题都无法完整交付；请提高本次预算；没有静默截断');
      throw new Error('即使按最小显式范围交付当前问题并降级其余内容，本次上下文预算仍不足以组成有效请求；请提高本次预算或缩短当前问题；没有静默截断');
    }
    const recovered = ladderDown(target);
    record(`degraded_to_${target.tier}`, target.id, recovered || 0, 0, required.get(target.id)?.lookupHandle);
    payload = assemble();
  }

  const admissionById = new Map(plan.admissions.map(admission => [admission.id, admission]));
  const manifest = authority.manifest(payload);
  return { payload, plan, manifest, degradation, contextRequest: context,
    deliveredDeclarations: payload.mandatoryMaterials,
    admissions: plan.admissions.map(admission => ({ id: admission.id, kind: admission.kind, tier: admission.tier })),
    ...(admissionById.has(intent.id) && intent.id !== current.id ? {} : {}) };
}

// ---- Legacy-interface shim ----

// selectPlanningContext-compatible entry (same dependency shape as
// src/context/selection.cjs) so the integration stream can swap the compiler
// without touching buildContext's gathering. The shim compiles the
// requirement-driven core (floor, MQA materials, explicit lookups, ladder,
// settlement) and returns the legacy result surface; it does not replicate
// every legacy optional layer — those remain owned by the legacy compiler
// until integration parity is proven.
function selectPlanningContext({ options, snapshot, candidates }) {
  const { all, byId, current } = snapshot;
  const intentSource = candidates?.intentSource || current;
  const explicitLookups = [
    ...(options.retrievedSources || []).map(source => ({ id: source.id.startsWith('private:') ? source.id : `private:${source.id}`, offset: source.offset, maxChars: source.maxChars })),
    ...(options.sourceLookupIds || []).map(id => ({ id: id.startsWith('private:') ? id : `private:${id}` }))
  ];
  const explicitIds = new Set(explicitLookups.map(read => read.id));
  const candidateSources = [...explicitIds].map(id => byId.get(id)).filter(Boolean)
    .concat(all.filter(source => source.id !== current.id && source.id !== intentSource.id && !explicitIds.has(source.id)));
  const authority = new BudgetAuthority({ purpose: 'answer_context',
    payloadByteBudget: options.byteBudget || 48000,
    requestByteBudget: options.budget?.requestByteBudget ?? Number.POSITIVE_INFINITY,
    measureRequest: options.budget?.measure || (() => 0) });
  const replyFocus = (options.replyMessageIds || []).map(id => `qq:${id}`).filter(id => byId.has(id));
  const compiled = compileContext({
    asOf: options.asOf, purpose: options.purpose, scope: options.scope,
    request: { text: current.text, replyFocusTexts: replyFocus.map(id => byId.get(id).text), replyFocus,
      feedbackTargets: options.feedbackTargets || [], goalText: options.goalText || '' },
    current, intentSource, candidateSources, explicitLookups,
    budget: authority
  });
  return { payload: compiled.payload, coreItems: [], optionalRawLimit: 0, optionalRawIds: new Set(), optionalRetrieved: [],
    recentContextPlan: null, recentPriorityIds: new Set(), recentInitialAdditionalBytes: 0,
    degradation: compiled.degradation, consultationSupport: [],
    admission: { version: ADMISSION_COMPILER_VERSION, plan: compiled.plan, admissions: compiled.admissions,
      materialRequirements: compiled.payload.materialRequirements } };
}

module.exports = { ADMISSION_COMPILER_VERSION, LADDER, compileContext, selectPlanningContext, declarationsView, markerView, tierSizesFor,
  continuationRanges, RETRIEVAL_RANGE_LIMITS, DEFAULT_CONTINUATION_CHARS };
