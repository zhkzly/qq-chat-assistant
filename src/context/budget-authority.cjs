'use strict';
// C4 Budget Authority (greenfield context subsystem, design §3.3 + appendix
// B9): ONE service owning every byte budget with a single
// measure → allocate → degrade → manifest vocabulary, instantiated per
// consumer (answer context, memory batch, compaction call). Bottleneck B6
// ("memory preparation finished but the answer was blocked") is eliminated by
// making the same authority that admits an artifact guarantee it a
// representation tier in the answer path, and by owning the two-cap fits()
// test in exactly one place.
//
// B9 addendum: call-count budgets per purpose (retrieval continuations vs
// delivery attempts vs repairs) are governed as explicitly as byte budgets,
// with the split visible in the manifest. The TaskLedger (request-budget.cjs)
// stays untouched: HTTP cost accounting is a different concern.
const { bytes } = require('./shared.cjs');

const BUDGET_AUTHORITY_VERSION = 'budget-authority-v1';

// Ladder tier ranks shared with the admission compiler (design §3.1 step 4).
const TIER_RANK = Object.freeze({ verbatim: 4, ranged: 3, digest: 2, declarations: 1, marker: 0 });
const rankOf = tier => TIER_RANK[tier];

// ---- Per-purpose call budgets (B9) ----

const CALL_PURPOSES = Object.freeze(['retrieval_continuation', 'delivery_attempt', 'repair']);

// Default split of one task's model-call ceiling. Model-driven continuation
// reads are hard-capped (navigable evidence invites round-trips; the product
// caps model-driven reads at two), one repair is reserved, and delivery
// attempts own the remainder. Shares are EXCLUSIVE: a purpose can never
// borrow another purpose's share, so lookups cannot starve delivery. Exact
// numbers are policy; exclusivity and manifest visibility are the contract.
function defaultCallSplit(total) {
  const limit = Math.max(1, Math.trunc(total));
  const retrieval = limit >= 4 ? 2 : Math.max(0, limit - 2);
  const repair = limit >= 3 ? 1 : 0;
  const delivery = Math.max(limit >= 1 ? 1 : 0, limit - retrieval - repair);
  return { retrieval_continuation: retrieval, delivery_attempt: delivery, repair };
}

class CallBudgets {
  constructor({ total, purposes }) {
    const safeTotal = Math.max(1, Math.trunc(total));
    const split = purposes || defaultCallSplit(safeTotal);
    const names = Object.keys(split);
    for (const name of names) {
      if (!CALL_PURPOSES.includes(name)) throw new Error(`Unknown call purpose: ${name}`);
      if (!Number.isSafeInteger(split[name]) || split[name] < 0) throw new Error(`Invalid call limit for ${name}`);
      if (split[name] > safeTotal) throw new Error(`Call limit for ${name} exceeds the total ceiling`);
    }
    if (names.reduce((sum, name) => sum + split[name], 0) > safeTotal)
      throw new Error('Per-purpose call limits must sum to at most the total ceiling');
    this.total = safeTotal;
    this.limits = Object.freeze({ ...split });
    this.used = Object.freeze({ ...Object.fromEntries(CALL_PURPOSES.map(name => [name, 0])) });
    this._used = Object.fromEntries(CALL_PURPOSES.map(name => [name, 0]));
    this._totalUsed = 0;
  }
  reserve(purpose) {
    if (!CALL_PURPOSES.includes(purpose)) throw new Error(`Unknown call purpose: ${purpose}`);
    if (this._totalUsed >= this.total)
      return { allowed: false, code: 'call_budget_exhausted', message: `总调用预算已用尽 (${this.total})` };
    if (this._used[purpose] >= this.limits[purpose])
      return { allowed: false, code: 'call_purpose_exhausted', message: `本用途 (${purpose}) 的调用份额已用尽 (${this.limits[purpose]})；其他用途不受影响` };
    this._used[purpose]++; this._totalUsed++;
    return { allowed: true, purpose, used: this._used[purpose], limit: this.limits[purpose], remaining: this.limits[purpose] - this._used[purpose] };
  }
  manifest() {
    return Object.freeze({
      version: 'call-budgets-v1', total: this.total, used: this._totalUsed, remaining: Math.max(0, this.total - this._totalUsed),
      purposes: Object.freeze(CALL_PURPOSES.map(purpose => Object.freeze({
        purpose, limit: this.limits[purpose] ?? 0, used: this._used[purpose] ?? 0,
        remaining: Math.max(0, (this.limits[purpose] ?? 0) - (this._used[purpose] ?? 0)),
        ...(this.limits[purpose] === undefined ? { unbounded: false } : {})
      })))
    });
  }
  static fromRequestLimit(limit, purposes = null) { return new CallBudgets({ total: limit, ...(purposes ? { purposes } : {}) }); }
}

// ---- The authority ----

class BudgetAuthority {
  constructor({ purpose, payloadByteBudget, requestByteBudget = Number.POSITIVE_INFINITY, measureRequest = null,
    reserveBytes = 0, allocations = [], degradationOrder = [], guaranteed = [], callBudgets = null, fixedOverheadBytes = 0 }) {
    if (!Number.isFinite(payloadByteBudget) || payloadByteBudget <= 0) throw new Error('payloadByteBudget must be positive');
    if (reserveBytes < 0 || fixedOverheadBytes < 0) throw new Error('reserve/overhead bytes must be >= 0');
    this.purpose = String(purpose || 'answer_context');
    this.payloadByteBudget = Math.trunc(payloadByteBudget);
    this.reserveBytes = Math.trunc(reserveBytes);
    this.fixedOverheadBytes = Math.trunc(fixedOverheadBytes);
    this.effectivePayloadBudget = Math.max(0, this.payloadByteBudget - this.reserveBytes);
    this.requestByteBudget = Number.isFinite(requestByteBudget) ? Math.trunc(requestByteBudget) : Number.POSITIVE_INFINITY;
    this._measureRequest = measureRequest || (() => 0);
    this.allocations = Object.freeze(allocations.map((allocation, index) => Object.freeze({
      floor: 0, priority: index, ...allocation
    })));
    const names = this.allocations.map(allocation => allocation.name);
    if (new Set(names).size !== names.length) throw new Error('allocation names must be unique');
    this.degradationOrder = Object.freeze(degradationOrder.filter(name => names.includes(name)));
    this.guaranteed = Object.freeze((guaranteed || []).map(item => Object.freeze({ tier: 'digest', ...item })));
    for (const item of this.guaranteed) if (!(item.tier in TIER_RANK)) throw new Error(`Unknown guaranteed tier: ${item.tier}`);
    this.callBudgets = callBudgets instanceof CallBudgets ? callBudgets
      : callBudgets ? new CallBudgets(typeof callBudgets === 'number' ? { total: callBudgets } : callBudgets)
      : null;
    this.degradation = [];
  }

  // One measure and one two-cap fits for every consumer (B6: the two-cap
  // rule previously lived in three modules with three semantics).
  measure(obj) { return bytes(obj); }
  measureRequest(obj) { return this._measureRequest(obj); }
  fits(obj) {
    return this.measure(obj) <= this.effectivePayloadBudget && this._measureRequest(obj) <= this.requestByteBudget;
  }
  headroom(obj) {
    return { payloadBytes: Math.max(0, this.effectivePayloadBudget - this.measure(obj)),
      requestBytes: Math.max(0, this.requestByteBudget - this._measureRequest(obj)) };
  }

  // Explainable degradation ledger entry; shared vocabulary with the legacy
  // selection manifest ({step, appliedTo, recoveredBytes, remainingNeed,
  // lookupHandle}).
  recordDegradation(step, appliedTo, recoveredBytes, remainingNeed, lookupHandle = undefined) {
    const entry = { step, appliedTo, recoveredBytes: Math.max(0, Math.trunc(recoveredBytes) || 0),
      remainingNeed: Math.max(0, Math.trunc(remainingNeed) || 0), ...(lookupHandle ? { lookupHandle } : {}) };
    this.degradation.push(entry);
    return entry;
  }

  reserveCall(purpose) { return this.callBudgets ? this.callBudgets.reserve(purpose) : { allowed: true, purpose, unbudgeted: true }; }
  callManifest() { return this.callBudgets ? this.callBudgets.manifest() : null; }

  // Requirement-shaped allocation planning (design §3.1 step 5). Each
  // requirement: { id, kind: floor|mandatory|background|guaranteed, order?,
  // floorTier?, lookupHandle?, tierSizes: [{tier, bytes}] }. The plan is
  // guaranteed deliverable: every non-floor requirement receives at least its
  // floorTier (default marker) — the plan is only undeliverable when the
  // floor itself cannot fit at minimum tier (minimal-envelope condition).
  plan(requirements) {
    const list = (requirements || []).map((requirement, index) => {
      const sizes = (requirement.tierSizes || []).filter(size => size.bytes >= 0 && rankOf(size.tier) !== undefined)
        .sort((a, b) => rankOf(b.tier) - rankOf(a.tier) || b.bytes - a.bytes);
      if (!sizes.length) throw new Error(`Requirement ${requirement.id} has no ladder sizes`);
      const floorTier = requirement.floorTier && rankOf(requirement.floorTier) !== undefined ? requirement.floorTier : 'marker';
      return { kind: 'background', order: index, ...requirement, sizes, floorTier,
        floorSize: sizes.findLast(size => size.tier === floorTier) || sizes[sizes.length - 1] };
    });
    const kindRank = { floor: 0, mandatory: 1, guaranteed: 2, background: 3 };
    list.sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9) || a.order - b.order);
    const budget = this.effectivePayloadBudget - this.fixedOverheadBytes;
    const admissions = [], degradation = [];
    let used = this.fixedOverheadBytes;
    // Pass 1: reserve every floor at its minimum tier. If the floors alone
    // cannot fit, the request itself is below the minimal envelope.
    const floorTotal = list.reduce((sum, requirement) => sum + requirement.floorSize.bytes, 0);
    let deliverable = floorTotal <= budget;
    for (const requirement of list) {
      // Floors are pinned at minimum first; higher tiers are upgraded in pass 2.
      admissions.push({ id: requirement.id, kind: requirement.kind, tier: requirement.floorTier, bytes: requirement.floorSize.bytes, view: requirement.floorSize.view });
      used += requirement.floorSize.bytes;
    }
    // Pass 2: upgrade in priority order to the highest tier that fits.
    if (deliverable) {
      for (const admission of admissions) {
        const requirement = list.find(item => item.id === admission.id);
        for (const size of requirement.sizes) {
          // Same-tier upgrades (progressively smaller ranged excerpts) are as
          // valid as cross-tier upgrades: take the first fitting size in rank
          // order, which is also the largest within the highest fitting tier.
          if (rankOf(size.tier) < rankOf(admission.tier) || size.bytes <= admission.bytes) continue;
          const delta = size.bytes - admission.bytes;
          if (used + delta > budget) continue;
          admission.bytes += delta; admission.tier = size.tier; if (size.view !== undefined) admission.view = size.view;
        }
        const top = requirement.sizes[0];
        if (rankOf(admission.tier) < rankOf(top.tier))
          degradation.push({ step: `degraded_to_${admission.tier}`, appliedTo: requirement.id,
            recoveredBytes: Math.max(0, top.bytes - admission.bytes), remainingNeed: Math.max(0, top.bytes - admission.bytes),
            ...(requirement.lookupHandle ? { lookupHandle: requirement.lookupHandle } : {}) });
        used = admissions.reduce((sum, item) => sum + item.bytes, this.fixedOverheadBytes);
      }
    }
    // B6: a guaranteed artifact that could not hold its guaranteed tier still
    // keeps an explicit marker admission — it is never silently dropped, and
    // the miss is explainable.
    for (const guarantee of this.guaranteed) {
      const admission = admissions.find(item => item.id === guarantee.id);
      if (admission && rankOf(admission.tier) < rankOf(guarantee.tier))
        degradation.push({ step: 'guarantee_degraded_to_marker', appliedTo: guarantee.id,
          recoveredBytes: 0, remainingNeed: 0, note: `guaranteed ${guarantee.tier} unavailable; explicit marker retained` });
    }
    for (const entry of degradation) this.degradation.push(entry);
    return Object.freeze({
      version: BUDGET_AUTHORITY_VERSION, purpose: this.purpose, deliverable,
      ...(deliverable ? {} : { reason: 'minimal_envelope_exceeded' }),
      admissions: Object.freeze(admissions.map(Object.freeze)),
      degradation: Object.freeze(degradation.map(Object.freeze)),
      budget, used: deliverable ? admissions.reduce((sum, item) => sum + item.bytes, this.fixedOverheadBytes) : floorTotal,
      remainingBytes: Math.max(0, budget - (deliverable ? admissions.reduce((sum, item) => sum + item.bytes, this.fixedOverheadBytes) : floorTotal))
    });
  }

  manifest(obj = null) {
    const inputBytes = obj == null ? null : this.measure(obj);
    return Object.freeze({
      version: BUDGET_AUTHORITY_VERSION, purpose: this.purpose,
      inputBytes, byteBudget: this.payloadByteBudget, reserveBytes: this.reserveBytes,
      serializedTextRequestBytes: obj == null ? null : this._measureRequest(obj),
      requestByteBudget: Number.isFinite(this.requestByteBudget) ? this.requestByteBudget : null,
      allocations: this.allocations.map(allocation => Object.freeze({ ...allocation })),
      degradationOrder: this.degradationOrder,
      guaranteed: this.guaranteed,
      degradation: Object.freeze(this.degradation.map(Object.freeze)),
      callBudgets: this.callManifest()
    });
  }

  // Factory: answer-context instantiation. Named allocations mirror today's
  // soft reservations (exchange floor, private layer, relationship evidence,
  // directory, recent window, navigation) with one declared yield order.
  static answerAllocations(budget) {
    return [
      { name: 'exchange', floor: Math.min(12000, Math.floor(budget * 0.65)), note: 'current interaction floor; never yields' },
      { name: 'privateLayer', soft: Math.min(14000, Math.floor(budget * 0.5)) },
      { name: 'relationship', soft: 7000 },
      { name: 'recentWindow', soft: Math.min(8000, Math.floor(budget * 0.2)) },
      { name: 'directory', soft: 3500 },
      { name: 'navigation', soft: 2000 }
    ];
  }
  static forAnswerContext({ byteBudget = 48000, requestByteBudget = 64000, measureRequest = () => 0,
    guaranteed = [], callBudgets = null, reserveBytes = 0 } = {}) {
    const budget = Math.max(4000, Number(byteBudget) || 48000);
    return new BudgetAuthority({
      purpose: 'answer_context', payloadByteBudget: budget, requestByteBudget, measureRequest, reserveBytes,
      allocations: BudgetAuthority.answerAllocations(budget),
      degradationOrder: ['navigation', 'directory', 'recentWindow', 'relationship', 'privateLayer'],
      guaranteed, callBudgets
    });
  }

  // Factory: memory-batch instantiation. The undegradable correction reserve
  // mirrors fitMemoryBatch's rule (initial + correctionOverhead <= budget) in
  // the shared vocabulary instead of a private loop.
  static forMemoryBatch({ requestBytes = 48000, correctionOverheadBytes = 0 } = {}) {
    return new BudgetAuthority({
      purpose: 'memory_batch', payloadByteBudget: Math.max(8000, Number(requestBytes) || 48000),
      reserveBytes: Math.max(0, Number(correctionOverheadBytes) || 0),
      measureRequest: obj => bytes(obj),
      allocations: [
        { name: 'sources', soft: Math.max(4000, Math.min(200000, Number(requestBytes) || 48000) - Math.max(0, Number(correctionOverheadBytes) || 0)) },
        { name: 'correction_reserve', floor: Math.max(0, Number(correctionOverheadBytes) || 0), note: 'undegradable correction wrapper reserve' }
      ],
      degradationOrder: ['sources']
    });
  }

  // Factory: compaction-call instantiation. Compaction is a ladder step, never
  // a feasibility gate: when headroom is absent the plan is skipped, not fatal.
  static forCompaction({ availableBytes = 0, baseBytes = 0 } = {}) {
    const authority = new BudgetAuthority({ purpose: 'compaction', payloadByteBudget: Math.max(1, Number(availableBytes) || 0),
      measureRequest: obj => bytes(obj), allocations: [{ name: 'compaction', soft: Math.max(0, Number(availableBytes) || 0) }] });
    authority.baseBytes = Math.max(0, Number(baseBytes) || 0);
    return authority;
  }
}

BudgetAuthority.prototype.planCompaction = function planCompaction({ candidateBytes = 0 } = {}) {
  const headroom = Math.max(0, this.effectivePayloadBudget - this.baseBytes);
  if (candidateBytes > headroom) return Object.freeze({ skipped: true, reason: 'no_headroom', candidateBytes, headroom });
  return Object.freeze({ skipped: false, candidateBytes, headroom });
};

module.exports = { BudgetAuthority, CallBudgets, CALL_PURPOSES, defaultCallSplit, BUDGET_AUTHORITY_VERSION, TIER_RANK };
