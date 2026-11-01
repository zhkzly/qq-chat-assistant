'use strict';
// M4 stage-4 optional JEV decision adapter (DSH greenfield redesign \u00a72.3,
// build package RT1). JEV (typesafe/jev-1.14, OpenRouter alpha) is usable for
// NARROW TYPED DECISIONS ONLY (candidate relevance, next-read choice) and is
// DISABLED BY DEFAULT. Resource-doc constraints implemented structurally
// (docs/available-resources_CN.md): batched and change-triggered via a
// hash-keyed cache (never per-request full-history repetition), probabilities
// are hints that never act as facts or authorization, decisions never filter
// out counter-evidence or corrections, and workflow/permissions/revisions stay
// program-owned. Like the embedding provider: no network without an injected
// fetchImpl (isolated test hook) plus explicit allowRealNetwork, and the API
// key comes from the environment only and is redacted from every error.
const { createHash } = require('node:crypto');
const { redactSecret } = require('./embedding-provider.cjs');

const JEV_PROVIDER_VERSION = 'jev-decisions-2026-11-01.1';
const DEFAULT_JEV = Object.freeze({
  model: 'typesafe/jev-1.14',
  endpoint: 'https://openrouter.ai/api/alpha/decisions',
  apiKeyEnv: 'OPENROUTER_API_KEY'
});
const DECISION_KINDS = Object.freeze(['candidate_relevance', 'next_read_choice']);
const MAX_CANDIDATES = 64;
const MAX_QUESTION_CHARS = 4000;
const MAX_EXCERPT_CHARS = 400;

function assertDecisionInput({ kind, question, candidates }) {
  if (!DECISION_KINDS.includes(kind)) throw new Error(`Unsupported JEV decision kind: ${kind} (narrow typed decisions only)`);
  if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_CHARS) throw new Error('Invalid JEV question');
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > MAX_CANDIDATES ||
    candidates.some(candidate => !candidate || typeof candidate.id !== 'string' || !candidate.id ||
      typeof candidate.excerpt !== 'string'))
    throw new Error(`Invalid JEV candidates: expected 1..${MAX_CANDIDATES} {id, excerpt} entries`);
  return { kind, question, candidates: candidates.map(candidate => ({ id: candidate.id, excerpt: candidate.excerpt.slice(0, MAX_EXCERPT_CHARS) })) };
}

// The cache key hashes the model, decision kind, question and every candidate
// identity (id + revision + excerpt digest): an unchanged input can never
// trigger a new call (change-triggered invocation).
function hashDecisionInput({ model, kind, question, candidates }) {
  return createHash('sha256').update(JSON.stringify({ model, kind, question,
    candidates: candidates.map(candidate => ({ id: candidate.id, revision: candidate.revision || null,
      excerptDigest: createHash('sha256').update(candidate.excerpt).digest('hex') })) })).digest('hex');
}

// Clamp any provider answer shape into a hint in [-1, 1]. A probability field
// (0..1) is rescaled to [-1, 1]; unknown ids get 0 (no decision recorded).
function parseDecisionHint(row) {
  if (!row || typeof row !== 'object') return { hint: 0, confidence: null };
  const { hint, score, probability, confidence } = row;
  let value = 0;
  if (typeof hint === 'number' && Number.isFinite(hint)) value = hint;
  else if (typeof score === 'number' && Number.isFinite(score)) value = score;
  else if (typeof probability === 'number' && Number.isFinite(probability)) value = (probability - 0.5) * 2;
  const bounded = Math.max(-1, Math.min(1, value));
  const recorded = typeof confidence === 'number' && Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null;
  return { hint: Math.round(bounded * 1e6) / 1e6, confidence: recorded, sourceField: typeof hint === 'number' ? 'hint' : typeof score === 'number' ? 'score' : typeof probability === 'number' ? 'probability' : 'none' };
}

// Remote JEV adapter. Alpha API, contract unverified: request/response shapes
// here are integration-time candidates, never trusted blindly.
function createJevDecisionProvider(options = {}) {
  const config = { ...DEFAULT_JEV, ...options };
  const { model, endpoint, apiKeyEnv, timeoutMs = 10000 } = config;
  const enabled = config.enabled === true;
  const allowRealNetwork = config.allowRealNetwork === true;
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : null;
  const apiKey = () => process.env[apiKeyEnv] || '';
  const identity = { name: 'jev', model, providerVersion: JEV_PROVIDER_VERSION };
  return {
    ...identity,
    kind: 'jev-decisions',
    remote: true,
    contractUnverified: true,
    enabled,
    decisionKinds: [...DECISION_KINDS],
    availability() {
      return { ...identity, enabled, hasApiKey: !!apiKey(), allowRealNetwork,
        isolatedTestHook: !!fetchImpl,
        reason: enabled ? (apiKey() ? 'enabled' : 'missing_env_api_key') : 'disabled_by_default' };
    },
    async decide(input) {
      const checked = assertDecisionInput(input);
      if (!enabled) throw new Error('JEV decision provider disabled by default (design \u00a72.3 stage 4; adopt only after a measured narrow-decision gap)');
      const key = apiKey();
      if (!key) throw new Error(`JEV decision provider api key missing: set ${apiKeyEnv} in the environment (keys are never persisted)`);
      let response;
      try {
        const body = JSON.stringify({ model, kind: checked.kind, question: checked.question,
          decisions: checked.candidates.map(candidate => ({ id: candidate.id, question: checked.question, context: candidate.excerpt })) });
        if (fetchImpl) {
          response = await fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body });
        } else {
          if (!allowRealNetwork) throw new Error('Real network disabled: isolated test hooks only (inject fetchImpl, or pass allowRealNetwork after integration verification)');
          if (typeof fetch !== 'function') throw new Error('fetch unavailable');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body });
          } finally { clearTimeout(timer); }
        }
        const payload = await response.json();
        if (!response.ok) throw new Error(`JEV decision request failed with status ${response.status}`);
        const rows = Array.isArray(payload?.decisions) ? payload.decisions : [];
        const byId = new Map(rows.map(row => [row?.id, parseDecisionHint(row)]));
        return { model, kind: checked.kind,
          decisions: checked.candidates.map(candidate => ({ id: candidate.id, ...(byId.get(candidate.id) || { hint: 0, confidence: null, sourceField: 'missing' }) })),
          unanswered: checked.candidates.filter(candidate => !byId.has(candidate.id)).map(candidate => candidate.id) };
      } catch (error) {
        throw new Error(redactSecret(error && error.message ? error.message : 'jev decision request failed', key));
      }
    }
  };
}

// Deterministic offline provider for isolated tests ONLY: fixed judgments
// (read live at decision time so a test can retune them) and a call counter
// so tests can prove batching and change-triggered caching.
function createLocalTestJevProvider(judgments = {}) {
  const provider = {
    name: 'local-test-jev', model: 'local-fixed-judgments', providerVersion: JEV_PROVIDER_VERSION,
    kind: 'jev-decisions', remote: false, enabled: true, decisionKinds: [...DECISION_KINDS], calls: 0, judgments,
    async decide(input) {
      const checked = assertDecisionInput(input);
      provider.calls++;
      const map = new Map(Object.entries(provider.judgments || {}).map(([id, hint]) => [id, Math.max(-1, Math.min(1, Number(hint) || 0))]));
      return { model: provider.model, kind: checked.kind,
        decisions: checked.candidates.map(candidate => ({ id: candidate.id, hint: map.get(candidate.id) || 0, confidence: 0.9, sourceField: 'hint' })),
        unanswered: [] };
    }
  };
  return provider;
}

// Persistent hash-keyed cache (change-triggered invocation). Value is stored
// as JSON in the caller-provided database; keys are content hashes only.
function createHashCache(db, table = 'retrieval_jev_cache') {
  if (!db || typeof db.prepare !== 'function') throw new Error('A sqlite database is required for the decision cache');
  db.exec(`CREATE TABLE IF NOT EXISTS ${table}(cache_key TEXT PRIMARY KEY, model TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL)`);
  return {
    get(key) {
      const row = db.prepare('SELECT decision FROM ' + table + ' WHERE cache_key=?').get(key);
      return row ? JSON.parse(row.decision) : null;
    },
    set(key, model, decision) {
      db.prepare('INSERT OR REPLACE INTO ' + table + ' VALUES(?,?,?,?)').run(key, model, JSON.stringify(decision), new Date().toISOString());
    },
    size() { return db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n; }
  };
}

module.exports = { JEV_PROVIDER_VERSION, DEFAULT_JEV, DECISION_KINDS, hashDecisionInput, createJevDecisionProvider, createLocalTestJevProvider, createHashCache };
