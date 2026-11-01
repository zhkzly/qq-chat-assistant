'use strict';
// Named program rules referenced by contract JSON files. Contracts are data;
// executable behavior (deterministic completions and cross-field semantics
// that JSON cannot express) lives here and is bound by rule id at compile
// time. Adding a rule id to a contract without implementing it here is a
// compile-time error, so the registry can never silently skip a rule.
const { validationError } = require('../validation-issues.cjs');

const RANGE_DEFAULTS_MAXCHARS = 4000;

// -- lookup rules ---------------------------------------------------------------

function isRangeRead({ offset, maxChars, query, discover, methodIds }) {
  return offset !== undefined || maxChars !== undefined && !query && !discover && !methodIds?.length;
}

// Range-target completion: a ranged lookup that omits its target IDs is a
// program decision whenever exactly one candidate range is delivered or
// exactly one covers the requested offset. Only genuine ambiguity raises,
// quoting the copy-ready candidate handles in the error.
function rangeTargetCompletion(value, ctx) {
  if (!isRangeRead(value) || value.sourceIds?.length || value.discussionTurnIds?.length) return undefined;
  const candidates = ctx.domains.rangedLookupTargets;
  if (!candidates.size) throw rangeTargetError(candidates);
  const at = Number.isSafeInteger(value.offset) ? value.offset : undefined;
  const covering = [...candidates].filter(([, range]) => at === undefined || value.offset >= range.start && value.offset < range.end);
  let resolved;
  if (candidates.size === 1) resolved = [...candidates.keys()];
  else if (covering.length === 1) resolved = covering.map(([id]) => id);
  if (!resolved?.length) throw rangeTargetError(candidates);
  return { sourceIds: resolved };
}

function rangeTargetError(candidates) {
  const error = validationError('lookup.sourceIds', 'lookup_range_target_ambiguous',
    `lookup ranges require explicit sourceIds or discussionTurnIds${candidates.size ? `；可照抄已交付范围的来源句柄：${[...candidates.keys()].join('、')}` : ''}；或改用带query的检索，无需范围参数`);
  error.handles = [...candidates.keys()];
  return error;
}

function rangeDefaults(value) {
  if (!value.sourceIds?.length && !value.discussionTurnIds?.length) return undefined;
  const out = {};
  if (value.offset === undefined) out.offset = 0;
  if (value.maxChars === undefined) out.maxChars = RANGE_DEFAULTS_MAXCHARS;
  return Object.keys(out).length ? out : undefined;
}

function readDefaults(value) {
  if (!Array.isArray(value.reads)) return undefined;
  let filled = false;
  const reads = value.reads.map(read => {
    if (!read || typeof read !== 'object') return read;
    const next = { ...read };
    if (next.offset === undefined) { next.offset = 0; filled = true; }
    if (next.maxChars === undefined) { next.maxChars = RANGE_DEFAULTS_MAXCHARS; filled = true; }
    return next;
  });
  return filled ? { reads } : undefined;
}

function requireSelector(value) {
  const { query, sourceIds, discussionTurnIds, methodIds, discover, reads } = value;
  if (!discussionTurnIds?.length && !sourceIds?.length && !methodIds?.length && !discover && !reads?.length &&
      (typeof query !== 'string' || !query.trim()))
    throw validationError('lookup.query', 'lookup_selector_missing', '历史检索需有明确查询、已提供的讨论／来源／方法ID，或请求发现谈资');
}

function rangeReadNeedsTargets(value) {
  if (isRangeRead(value) && !value.sourceIds?.length && !value.discussionTurnIds?.length && !value.reads?.length)
    throw validationError('lookup.sourceIds', 'lookup_range_target_ambiguous', 'lookup ranges require explicit sourceIds or discussionTurnIds');
}

function readFormExclusivity(value) {
  if (!value.reads?.length) return;
  if (value.sourceIds !== undefined || value.offset !== undefined || value.maxChars !== undefined)
    throw validationError('lookup.reads', 'lookup_read_form_conflict', 'lookup.reads: use the batch form or the single {sourceIds,offset,maxChars} form, not both');
}

// -- assistant operation rules ---------------------------------------------------

function operationActiveFields(value) {
  const operation = value.operation;
  const active = new Set(['operation']);
  if (operation === 'advise' || operation === 'lookup') active.add('text');
  for (const key of ['methodIds', 'actions', 'stateReview', 'statePatch', 'topicPatch', 'relationshipPatch', 'experienceProposals', 'expressionOptions']) active.add(key);
  if (operation === 'prepare_message') active.add('answer');
  if (operation === 'advise' || operation === 'prepare_message') { active.add('materials'); active.add('currentFacts'); }
  if (operation === 'prepare_message') active.add('editingReference');
  if (operation === 'lookup') { active.add('lookup'); active.add('continuation'); }
  if (operation === 'clarify') active.add('blocker');
  return active;
}

// Deterministic continuation completion: when this request already requires a
// message artifact, a lookup's continuation is not a model choice -- the only
// legal continuation is prepare_message. Completing it here removes a whole
// invalid-delivery class from the shared call budget (B9).
function continuationCompletion(value, ctx) {
  if (value.operation !== 'lookup' || value.continuation !== undefined) return undefined;
  if (!ctx?.requestState?.requiredArtifact) return undefined;
  return { continuation: 'prepare_message' };
}

const RULES = {
  'range-target-completion': { kind: 'completion', apply: rangeTargetCompletion },
  'range-defaults': { kind: 'completion', apply: rangeDefaults },
  'read-defaults': { kind: 'completion', apply: readDefaults },
  'require-selector': { kind: 'semantic', apply: requireSelector },
  'range-read-needs-targets': { kind: 'semantic', apply: rangeReadNeedsTargets },
  'read-form-exclusivity': { kind: 'semantic', apply: readFormExclusivity },
  'operation-active-fields': { kind: 'semantic', apply: operationActiveFields },
  'continuation-completion': { kind: 'completion', apply: continuationCompletion }
};

function ruleFor(id) {
  const rule = RULES[id];
  if (!rule) throw new Error(`wire contract references unknown rule '${id}'; implement it in src/wire/rules.cjs`);
  return rule;
}

module.exports = { RULES, ruleFor, isRangeRead, RANGE_DEFAULTS_MAXCHARS };
