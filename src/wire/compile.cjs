'use strict';
// Wire compiler (design §3.5 / component C6): compiles one versioned contract
// JSON into the four artifacts every model exchange consumes --
//   compileSchema(c)        -> tool/response JSON schema (enums injected from
//                              payload handle domains, never hand-duplicated)
//   compileValidator(c)     -> machine validator (shape/bounds/enum/handle
//                              membership, program completions, named
//                              semantic rules)
//   compilePromptFragments(c) -> the protocol text fragment (field-rule lines
//                              generated from the same bounds the validator
//                              enforces; semantic notes ride along verbatim)
//   repairGuide(c, error, payload) -> executable repair lines quoting the
//                              exact allowed values for THIS payload
// Because prompt text and validators are the same artifact, they cannot drift
// apart (bottleneck B3's soil). Constraints the DSL cannot express stay in
// named rules (src/wire/rules.cjs) or in the consuming module with a drift
// test, per design §8.6.
const fs = require('node:fs');
const path = require('node:path');
const { validationError } = require('../validation-issues.cjs');
const { ruleFor } = require('./rules.cjs');

const CONTRACT_DIR = path.join(__dirname, '..', 'contracts');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Field check compilation
// ---------------------------------------------------------------------------

function fieldCheck(name, spec, contract) {
  switch (spec.type) {
    case 'string':
      return (value, ctx) => {
        if (typeof value !== 'string' || value.length > spec.maxLength)
          throw validationError(name, spec.code || 'invalid', spec.message || `${name}: expected text of at most ${spec.maxLength} characters`);
        return value;
      };
    case 'integer':
      return (value, ctx) => {
        if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max)
          throw validationError(name, spec.code || 'invalid', spec.message || `${name}: invalid bounded integer`);
        return value;
      };
    case 'boolean':
      return (value, ctx) => {
        if (typeof value !== 'boolean') throw validationError(name, spec.code || 'invalid', spec.message || `${name}: use a boolean`);
        return value;
      };
    case 'enum':
      return (value, ctx) => {
        const values = typeof spec.values === 'function' ? spec.values(ctx) : spec.values;
        if (!values.includes(value)) throw validationError(name, spec.code || 'invalid', spec.message || `${name}: choose ${values.join('/')}`);
        return value;
      };
    case 'enumArray':
      return (value, ctx) => {
        if (!Array.isArray(value) || value.some(item => !spec.values.includes(item)))
          throw validationError(name, spec.code || 'invalid', spec.message || `${name}: choose ${spec.values.join('/')}`);
        return [...new Set(value)];
      };
    case 'isoDate':
      return (value, ctx) => {
        if (!Number.isFinite(Date.parse(value))) throw validationError(name, spec.code || 'invalid', spec.message || `${name}: use an ISO date or datetime`);
        return value;
      };
    case 'handleArray':
      return (value, ctx) => {
        const ids = ctx?.domains?.[spec.domain];
        if (!ids) throw validationError(name, 'wire_domain_missing', `${name}: handle domain ${spec.domain} is unavailable for this request`);
        if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max || value.some(id => typeof id !== 'string' || !ids.has(id)))
          throw validationError(name, spec.code || 'invalid', spec.message || `${name}: use ${spec.min}..${spec.max} delivered ${spec.domain} handles`);
        return [...new Set(value)];
      };
    case 'stringArray':
      return (value, ctx) => {
        if (!Array.isArray(value) || value.length > spec.max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > (spec.itemMaxLength || 4000)))
          throw validationError(name, spec.code || 'invalid', spec.message || `${name}: expected at most ${spec.max} bounded strings`);
        return value;
      };
    case 'batchReads':
      return (value, ctx) => {
        if (!Array.isArray(value) || !value.length || value.length > spec.max)
          throw validationError(name, spec.code || 'lookup_reads_invalid', spec.message || `${name}: use 1..${spec.max} bounded continuation reads`);
        const ids = ctx?.domains?.[spec.entry.sourceIds.domain];
        for (const [index, read] of value.entries()) {
          const at = `${name}[${index}]`;
          if (!plain(read) || Object.keys(read).some(key => !['sourceIds', 'offset', 'maxChars'].includes(key)))
            throw validationError(at, 'lookup_read_shape_invalid', `${at}: each read is {sourceIds:[单个已示ID],offset,maxChars}`);
          if (!Array.isArray(read.sourceIds) || read.sourceIds.length !== spec.entry.sourceIds.exactly || read.sourceIds.some(id => typeof id !== 'string' || ids && !ids.has(id)))
            throw validationError(`${at}.sourceIds`, 'lookup_read_target_invalid', `${at}.sourceIds: exactly one delivered source handle per read`);
          for (const key of ['offset', 'maxChars']) {
            const bound = spec.entry[key];
            if (read[key] !== undefined && (!Number.isSafeInteger(read[key]) || read[key] < (key === 'offset' ? bound.min : bound.min) || read[key] > bound.max))
              throw validationError(`${at}.${key}`, 'invalid_bounded_source_range', `${at}.${key}: invalid bounded source range`);
          }
        }
        return value;
      };
    default:
      return null; // object/array/contract fields are shape-validated by their owner rules
  }
}

// ---------------------------------------------------------------------------
// Validator compilation
// ---------------------------------------------------------------------------

function compileValidator(contract) {
  const checks = Object.entries(contract.fields || {})
    .map(([name, spec]) => ({ name, spec, check: fieldCheck(name, spec, contract) }))
    .filter(entry => entry.check);
  const completions = (contract.completions || []).map(entry => ruleFor(typeof entry === 'string' ? entry : entry.id));
  const semantics = (contract.semantic || []).map(id => ruleFor(id));
  const fieldNames = Object.keys(contract.fields || {});
  const activeFieldsRule = contract.semantic?.includes('operation-active-fields') ? ruleFor('operation-active-fields') : null;
  return function validate(raw, ctx = {}) {
    if (!plain(raw)) throw validationError('$', `${contract.contract}_shape_invalid`, `${contract.contract}: expected an object`);
    const unknown = Object.keys(raw).filter(key => !fieldNames.includes(key));
    if (unknown.length) throw validationError(unknown[0], `${contract.contract}_field_invalid`, `${contract.contract}.${unknown[0]}: unsupported selector \`${unknown[0]}\``);
    const value = { ...raw };
    const completionsApplied = [];
    for (const completion of completions) {
      const filled = completion.apply(value, ctx);
      if (!filled) continue;
      const applied = [];
      for (const [key, data] of Object.entries(filled)) {
        if (value[key] === undefined && data !== undefined) { value[key] = data; applied.push(key); }
      }
      if (applied.length) completionsApplied.push({ rule: completion.constructor?.name || 'completion', fields: applied });
    }
    if (activeFieldsRule) {
      const active = activeFieldsRule.apply(value, ctx);
      const inactive = Object.keys(value).filter(key => !active.has(key));
      if (inactive.length) throw validationError(inactive[0], 'primary_operation_inactive_payload', `${inactive[0]} is not active for ${value.operation}; return only this operation's payload`);
    }
    const checked = {};
    for (const { name, check } of checks) if (value[name] !== undefined) checked[name] = check(value[name], ctx);
    const merged = { ...value, ...checked };
    for (const semantic of semantics) if (semantic.apply !== activeFieldsRule?.apply) semantic.apply(merged, ctx);
    return { value: merged, completions: completionsApplied };
  };
}

// ---------------------------------------------------------------------------
// Schema compilation
// ---------------------------------------------------------------------------

function jsonSchemaFor(spec, ctx) {
  if (!spec) return {};
  switch (spec.type) {
    case 'string': return { type: 'string' };
    case 'integer': return { type: 'integer' };
    case 'boolean': return { type: 'boolean' };
    case 'enum': return { type: 'string', enum: typeof spec.values === 'function' ? spec.values(ctx) : [...spec.values] };
    case 'enumArray': return { type: 'array', items: { type: 'string', enum: [...spec.values] } };
    case 'isoDate': return { type: 'string' };
    case 'handleArray': {
      const ids = ctx?.domains?.[spec.domain];
      return { type: 'array', items: { type: 'string', ...(ids ? { enum: [...ids] } : {}) }, minItems: spec.min, maxItems: spec.max };
    }
    case 'stringArray': return { type: 'array', items: { type: 'string' }, maxItems: spec.max };
    case 'batchReads': return { type: 'array', maxItems: spec.max, items: { type: 'object', properties: { sourceIds: { type: 'array', items: { type: 'string' } }, offset: { type: 'integer' }, maxChars: { type: 'integer' } }, required: ['sourceIds'], additionalProperties: false } };
    default: return {};
  }
}

function compileSchema(contract) {
  return function schema(ctx = {}) {
    const properties = {};
    for (const [name, spec] of Object.entries(contract.fields || {})) {
      const rendered = jsonSchemaFor(spec, ctx);
      if (Object.keys(rendered).length) properties[name] = rendered;
      else if (spec.type === 'object' || spec.type === 'array' || spec.type === 'contract') properties[name] = { type: spec.type === 'array' ? 'array' : 'object' };
    }
    return { type: 'object', properties, additionalProperties: false, ...(contract.fields?.operation?.required ? { required: ['operation'] } : {}) };
  };
}

// ---------------------------------------------------------------------------
// Prompt fragment compilation
// ---------------------------------------------------------------------------

function compilePromptFragments(contract) {
  const bound = [];
  return function fragments() {
    if (contract.protocol) {
      bound.length = 0;
      bound.push(contract.protocol.intro || '');
      bound.push(contract.protocol.syntax || '');
      bound.push(contract.protocol.outro || '');
      return bound.filter(Boolean).join('');
    }
    if (contract.protocolShape) return contract.protocolShape;
    return '';
  };
}

// ---------------------------------------------------------------------------
// Repair guide compilation
// ---------------------------------------------------------------------------

function compileRepairGuide(contract) {
  return function repairGuide(error, domains) {
    const lines = [];
    const code = error?.code || '';
    if (contract.repair && contract.repair[code]) lines.push(contract.repair[code]);
    else if (contract.repair && contract.repair.default) lines.push(contract.repair.default);
    if (contract.contract === 'lookup') {
      const ranges = domains ? [...(domains.rangedLookupTargets?.keys?.() || [])] : [];
      if (ranges.length) lines.push(`可照抄范围续读：lookup:{reads:[${ranges.slice(0, 4).map(id => `{sourceIds:["${id}"],offset:0,maxChars:4000}`).join(',')}]}`);
      const methods = domains ? [...(domains.methodCandidates || [])] : [];
      if (methods.length) lines.push(`可用方法卡：lookup:{methodIds:[${methods.slice(0, 2).map(id => `"${id}"`).join(',')}]}`);
      lines.push('或改用检索式 lookup:{query:"…"}，无需范围参数');
    }
    if (error?.handles?.length) lines.push(`可照抄句柄：${error.handles.join('、')}`);
    return lines;
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function loadContract(name) {
  const file = path.join(CONTRACT_DIR, `${name}.contract.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const compiled = new Map();
function compile(name) {
  if (!compiled.has(name)) {
    const contract = typeof name === 'string' ? loadContract(name) : name;
    compiled.set(name, {
      contract,
      validate: compileValidator(contract),
      schema: compileSchema(contract),
      promptFragments: compilePromptFragments(contract),
      repairGuide: compileRepairGuide(contract)
    });
  }
  return compiled.get(name);
}

module.exports = { compile, loadContract, compileValidator, compileSchema, compilePromptFragments, compileRepairGuide, CONTRACT_DIR };
