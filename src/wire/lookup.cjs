'use strict';
// Lookup wire facade: the single source of truth is the versioned contract
// JSON (src/contracts/lookup.contract.json). This module compiles it and
// exposes the stable consumer API used by the deep validator
// (assistant-model.cjs), the primary-operation allowlist
// (primary-operation.cjs) and the prompt protocol line (help-behavior.cjs).
// Field bounds, program completions (range-target completion, defaults) and
// the repair vocabulary are declared once in the contract; nothing here may
// restate them.
const { compile } = require('./compile.cjs');
const { domainsFor } = require('./domains.cjs');

const compiled = compile('lookup');
const contract = compiled.contract;

const LIMITS = Object.freeze({
  query: contract.fields.query.maxLength,
  offsetMax: contract.fields.offset.max,
  maxChars: contract.fields.maxChars.max,
  defaultMaxChars: contract.fields.maxChars.default,
  sourceIds: contract.fields.sourceIds.max,
  discussionTurnIds: contract.fields.discussionTurnIds.max,
  methodIds: contract.fields.methodIds.max,
  types: Object.freeze([...contract.fields.types.values]),
  reads: Object.freeze({ max: contract.fields.reads.max, maxChars: contract.fields.reads.entry.maxChars.max, offsetMax: contract.fields.reads.entry.offset.max, defaultMaxChars: contract.fields.reads.entry.maxChars.default })
});

// Selector keys legal on a lookup object; the primary-operation allowlist and
// the tool schema derive from the contract field set.
const lookupFieldNames = Object.freeze([...Object.keys(contract.fields)]);

// Protocol fragment: generated from the same contract the validator uses.
function lookupProtocolLine() { return compiled.promptFragments(); }
const LOOKUP_RULES = lookupProtocolLine();

// Executable repair guidance quoting this payload's actual handles.
function lookupRepairLines(payload) {
  const domains = domainsFor(payload);
  const pseudo = new Error('lookup repair');
  return compiled.repairGuide(pseudo, domains).filter(line => line !== contract.repair.default);
}

// Entry point used by the deep validator. Completes derivable targets and
// defaults, validates fields against the declared domains, applies named
// semantics and returns the canonical lookup the controller executes.
function runLookup(rawLookup, payload, { diagnostics } = {}) {
  const domains = domainsFor(payload);
  const { value, completions } = compiled.validate(rawLookup, { domains });
  const normalized = normalize(value);
  if (completions.length && diagnostics) diagnostics.lookupCompletions = completions;
  return normalized;
}

// Canonical output shape consumed by the controller: single-form reads keep
// the legacy fields; batch reads carry the reads array.
function normalize(value) {
  const single = value.sourceIds?.length || value.discussionTurnIds?.length;
  const out = {
    query: value.query || '',
    before: value.before,
    after: value.after,
    types: value.types ? [...new Set(value.types)] : undefined,
    ...(value.discussionTurnIds ? { discussionTurnIds: [...new Set(value.discussionTurnIds)] } : {}),
    ...(value.sourceIds ? { sourceIds: [...new Set(value.sourceIds)] } : {}),
    ...(single ? { offset: value.offset || 0, maxChars: value.maxChars || LIMITS.defaultMaxChars } : {}),
    ...(value.methodIds ? { methodIds: [...new Set(value.methodIds)] } : {}),
    ...(value.discover ? { discover: true } : {}),
    ...(value.reads?.length ? { reads: value.reads.map(read => ({ sourceIds: [...new Set(read.sourceIds)], offset: read.offset || 0, maxChars: read.maxChars || LIMITS.reads.defaultMaxChars })) } : {})
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

module.exports = { lookupFieldNames, LIMITS, LOOKUP_RULES, runLookup, lookupRepairLines, lookupProtocolLine };
