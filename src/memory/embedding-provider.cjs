'use strict';
// M4 stage-3 embedding provider interface (DSH greenfield redesign \u00a72.3,
// build package RT1). Providers are DISABLED BY DEFAULT: remote encoding is a
// new external data flow and stays fictional-isolated until the resource-doc
// gate is met (docs/available-resources_CN.md: gap-driven adoption, same-input
// baseline retained, model versions recorded, deletion and stale-index
// recovery tested). This module never calls the network on its own:
//   - enabled defaults to false and must be passed explicitly;
//   - without an injected fetchImpl (isolated test hook) a real call also
//     requires allowRealNetwork: true (double opt-in for a later verified
//     integration trial);
//   - API keys are read from environment variables only, at call time, and are
//     redacted from every error path; keys are never persisted or logged.
const { createHash } = require('node:crypto');
const { terms } = require('../memory-search.cjs');

const EMBEDDING_PROVIDER_VERSION = 'embedding-provider-2026-11-01.1';
const DEFAULT_DOUBAO_EMBEDDING = Object.freeze({
  model: 'doubao-embedding-vision',
  endpoint: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  apiKeyEnv: 'ARK_API_KEY'
});
const MAX_BATCH_TEXTS = 256;
const MAX_TEXT_CHARS = 32000;

function redactSecret(message, secret) {
  let text = String(message || '');
  if (secret && text.includes(secret)) text = text.split(secret).join('[redacted-api-key]');
  // Defensive belt: never surface bearer material of any shape.
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted-api-key]');
}

function assertTexts(texts) {
  if (!Array.isArray(texts) || !texts.length || texts.length > MAX_BATCH_TEXTS ||
    texts.some(value => typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_CHARS))
    throw new Error(`Invalid embedding input: expected 1..${MAX_BATCH_TEXTS} nonempty strings of at most ${MAX_TEXT_CHARS} characters`);
  return texts;
}

function parseVectors(payload, count) {
  const rows = Array.isArray(payload?.data) && payload.data.length === count
    ? payload.data.map(row => row?.embedding)
    : Array.isArray(payload?.embeddings) && payload.embeddings.length === count ? payload.embeddings : null;
  if (!rows) throw new Error('Embedding response shape unrecognized (contract unverified; verify fields at integration)');
  const dims = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (!dims || rows.some(vector => !Array.isArray(vector) || vector.length !== dims ||
      vector.some(value => typeof value !== 'number' || !Number.isFinite(value))))
    throw new Error('Embedding response vectors malformed');
  return rows.map(vector => Float64Array.from(vector));
}

// Doubao Agent Plan embedding adapter (/plan/v3). The endpoint contract is
// UNVERIFIED (client-rendered docs page); a later isolated fictional trial
// must confirm request/response fields before any real-data use.
function createDoubaoEmbeddingProvider(options = {}) {
  const config = { ...DEFAULT_DOUBAO_EMBEDDING, ...options };
  const { model, endpoint, apiKeyEnv, timeoutMs = 10000 } = config;
  const enabled = config.enabled === true;
  const allowRealNetwork = config.allowRealNetwork === true;
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : null;
  const apiKey = () => process.env[apiKeyEnv] || '';
  const identity = { name: 'doubao-embedding-vision', model, providerVersion: EMBEDDING_PROVIDER_VERSION };
  return {
    ...identity,
    kind: 'embedding',
    remote: true,
    contractUnverified: true,
    enabled,
    availability() {
      return { ...identity, enabled, hasApiKey: !!apiKey(), allowRealNetwork,
        isolatedTestHook: !!fetchImpl,
        reason: enabled ? (apiKey() ? 'enabled' : 'missing_env_api_key') : 'disabled_by_default' };
    },
    async embed(texts) {
      const input = assertTexts(texts);
      if (!enabled) throw new Error('Embedding provider disabled by default (design \u00a72.3 stage 3; enable requires the resource-doc gap gate)');
      const key = apiKey();
      if (!key) throw new Error(`Embedding provider api key missing: set ${apiKeyEnv} in the environment (keys are never persisted)`);
      let response;
      try {
        if (fetchImpl) {
          // Isolated test hook only: no network involved.
          response = await fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input }) });
        } else {
          if (!allowRealNetwork) throw new Error('Real network disabled: isolated test hooks only (inject fetchImpl, or pass allowRealNetwork after integration verification)');
          if (typeof fetch !== 'function') throw new Error('fetch unavailable');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input }) });
          } finally { clearTimeout(timer); }
        }
        const payload = await response.json();
        if (!response.ok) throw new Error(`Embedding request failed with status ${response.status}`);
        return { vectors: parseVectors(payload, input.length), model, usage: payload?.usage || null };
      } catch (error) {
        // The key must never reach logs, caches or callers.
        throw new Error(redactSecret(error && error.message ? error.message : 'embedding request failed', key));
      }
    }
  };
}

// Deterministic offline provider for isolated tests ONLY (fictional data):
// a hashed bag-of-terms vector with optional synonym-set normalization, so a
// test can prove synonym recall that lexical bigram search structurally
// misses while keeping the same provider interface.
function createLocalTestEmbeddingProvider(options = {}) {
  const dims = Number.isInteger(options.dims) && options.dims > 0 ? options.dims : 256;
  const synonymSets = Array.isArray(options.synonymSets) ? options.synonymSets
    .filter(set => Array.isArray(set) && set.length > 1 && set.every(value => typeof value === 'string' && value.trim()))
    .map(set => [...new Set(set.map(value => value.trim()))]) : [];
  const normalizeText = text => {
    let normalized = String(text || '');
    for (const set of synonymSets) {
      const canonical = set[0];
      for (const variant of set.slice(1)) {
        if (normalized.includes(variant)) normalized = normalized.split(variant).join(canonical);
      }
    }
    return normalized;
  };
  const embedOne = text => {
    const vector = new Float64Array(dims);
    for (const term of terms(normalizeText(text))) vector[Math.abs(parseInt(createHash('sha1').update(term).digest('hex').slice(0, 8), 16)) % dims] += 1;
    let norm = 0; for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) vector[i] /= norm;
    return vector;
  };
  return {
    name: 'local-test-embedding', model: 'local-hash-bigram', providerVersion: EMBEDDING_PROVIDER_VERSION,
    kind: 'embedding', remote: false, enabled: true, dims, synonymSets: synonymSets.map(set => [...set]),
    async embed(texts) {
      const input = assertTexts(texts);
      return { vectors: input.map(embedOne), model: 'local-hash-bigram', usage: null };
    }
  };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) && !(a instanceof Float64Array)) throw new Error('Invalid vector');
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] * a[i]; right += b[i] * b[i]; }
  const norm = Math.sqrt(left) * Math.sqrt(right);
  return norm === 0 ? 0 : dot / norm;
}

function roundVector(vector, digits = 6) {
  const factor = 10 ** digits;
  return Array.from(vector, value => Math.round(value * factor) / factor);
}

module.exports = { EMBEDDING_PROVIDER_VERSION, DEFAULT_DOUBAO_EMBEDDING, createDoubaoEmbeddingProvider, createLocalTestEmbeddingProvider, cosineSimilarity, roundVector, redactSecret };
