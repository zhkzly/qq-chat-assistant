'use strict';
// M4 Retrieval Service (DSH greenfield redesign \u00a72.3 / \u00a74.3 build
// package RT1). One retrieval service replaces the three legacy rankers
// (conversation-discovery term overlap, memory-search rank, relationshipView
// rank) with composed filters first and semantic candidates second:
//
//   stage 1  hard filters, precise and never bypassed: scope binding,
//            observation kind, speaker (single speaker-identity vocabulary,
//            undetermined is never defaulted), time window, withdrawal /
//            exclusion tombstones, disclosure/authorization tier
//   stage 2  lexical rank: SQLite FTS5 bm25 over JS-tokenized CJK-bigram
//            terms, time decay, anchor / reply neighborhoods (the
//            RECENT_CONTEXT_LIMITS neighborhood rules from context/policy.cjs
//            are absorbed here)
//   stage 3  optional semantic candidates, DISABLED BY DEFAULT: reorder /
//            augment the stage-1 legal set only; a vector hit can never admit
//            a filtered-out source. Vector rows are revision-keyed; a stale
//            row is dropped, never reused (stale-index recovery)
//   stage 4  optional JEV narrow typed decisions, DISABLED BY DEFAULT:
//            batched, hash-cached, invoked on change, reorder-only - items
//            and counter-evidence are never dropped and corrections are
//            exempt from negative adjustment
//
// Every returned item and every rejected candidate is explainable in a
// manifest ({matchedStages, reasons, filter counts}) for the context
// compiler. Appendix B9: retrieveRanges() resolves multiple
// {sourceId, offset, maxChars} continuation ranges in ONE program-side call
// so navigable evidence stops spending per-range model round-trips.
//
// Shim startup (design \u00a74.3): the default adapter reads CURRENT tables
// (messages, companion, memory_exclusions, experience feedback) without
// touching any existing caller; at integration it is swapped for the M1
// observation-log projection. Index tables below are owned by this service
// and namespaced retrieval_*; they never alter existing schema. Retrieval
// text is program-internal evidence: wire-time redaction stays with the
// existing snapshot path.
const { createHash } = require('node:crypto');
const { terms, focusSourceOffset } = require('../memory-search.cjs');
const { observationSpeaker } = require('../speaker-identity.cjs');
const { RECENT_CONTEXT_LIMITS } = require('../context/policy.cjs');
const { sourceRevision } = require('../store.cjs');
const { qqSourceMetadata } = require('../messages.cjs');
const { EMBEDDING_PROVIDER_VERSION, cosineSimilarity, roundVector } = require('./embedding-provider.cjs');
const { hashDecisionInput } = require('./jev-decisions.cjs');

const RETRIEVAL_SERVICE_VERSION = 'retrieval-service-2026-11-01.1';
const ADAPTER_VERSION = 'retrieval-store-shim-2026-11-01.1';

const OBSERVATION_KINDS = Object.freeze(['qq', 'private', 'note', 'feedback']);
const SPEAKERS = Object.freeze(['account_owner', 'contact', 'undetermined']);
const AUTHORIZATION_TIERS = Object.freeze({
  T0: 'public_qq', T1: 'current_permission', T2: 'declared_shareable',
  T3: 'private_planning', T4: 'never_outbound'
});
const TIER_CODES = Object.freeze(Object.keys(AUTHORIZATION_TIERS));
// Program-owned default tier classification for the store shim. T1 (the
// current request statement) and T4 (never-outbound marks) belong to the M1/M2
// observation layers and are reserved; override with the provider tierFor.
function defaultTierFor(source) {
  if (source.type === 'qq') return 'T0';
  if (source.type === 'note') return source.use === 'draft' ? 'T2' : 'T3';
  return 'T3';
}

const TOMBSTONE_REASONS = Object.freeze({
  withdrawn_recall: 'qq message recalled by its sender',
  user_excluded: 'source excluded by an explicit user request',
  use_disabled: 'note use set to disabled',
  turn_excluded: 'private turn excluded from memory',
  redacted_feedback: 'feedback observation withdrawn by redaction'
});

// Deterministic scoring vocabulary. All weights are explicit, echoed in the
// manifest and never model-choosable.
const SCORING = Object.freeze({
  weights: Object.freeze({ lexical: 1, decay: 0.6, anchor: 8, neighborhood: 3, replyTarget: 5, semantic: 4, jev: 2 }),
  decayFormula: 'max(0, 5 - log2(ageDays + 1)) * weights.decay',
  semanticMap: '(cosine + 1) / 2',
  semanticHitThreshold: 0.55,
  tieBreak: 'score desc, at desc, id asc'
});

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 200;
const MAX_REJECTED_LISTED = 500;
const MAX_ANCHORS = 16;
const MAX_ONLY_IDS = 500;
const RANGE_LIMITS = Object.freeze({ maxRanges: 64, maxCharsPerRange: 16384, defaultTotalChars: 65536 });
const round = (value, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
const digestOf = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function assertScope(scope) {
  const fields = ['accountUid', 'accountUin', 'peerUid', 'peerUin'];
  if (!scope || typeof scope !== 'object' || fields.some(key => typeof scope[key] !== 'string' || !scope[key].trim() || scope[key].length > 256))
    throw new Error('Invalid conversation scope: four nonempty string identifiers are required');
  return JSON.stringify(fields.map(key => scope[key]));
}
function requireIso(label, value) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(time)) throw new Error(`Invalid ${label}: expected an ISO-8601 timestamp`);
  return time;
}
function optionalEnumList(label, value, allowed) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length || value.some(item => !allowed.includes(item)))
    throw new Error(`Invalid ${label}: expected a nonempty subset of ${allowed.join(', ')}`);
  return [...new Set(value)];
}
function optionalIdList(label, value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > MAX_ONLY_IDS || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 300))
    throw new Error(`Invalid ${label}: expected source id strings`);
  return [...new Set(value)];
}

// ---------------------------------------------------------------- adapter ---

// Shim adapter over the CURRENT tables (design \u00a74.3 RT1: start against
// today's store, swap to M1 projections at integration). Read-only: it never
// materializes legacy artifacts, so retrieval cannot trigger companion
// write-backs. Revisions reuse store.sourceRevision so parity with
// _rawMemorySources is exact on current-shape databases.
function createStoreObservationProvider(store, options = {}) {
  if (!store || typeof store.messages !== 'function' || !store.db) throw new Error('A Store instance is required for the store observation adapter');
  const tierFor = typeof options.tierFor === 'function' ? options.tierFor : defaultTierFor;
  return {
    name: 'store-shim',
    adapterVersion: ADAPTER_VERSION,
    observationLog: false,
    tierFor,
    universe(scope) {
      const key = store.scopeKey(scope);
      const sources = [], tombstones = [];
      for (const message of store.messages(scope)) {
        if (message.recalled) {
          tombstones.push({ id: `qq:${message.messageId}`, reason: 'withdrawn_recall',
            at: Number.isSafeInteger(message.recalledAt) ? new Date(message.recalledAt).toISOString() : null });
          continue;
        }
        const base = { id: `qq:${message.messageId}`, type: 'qq', text: message.text, at: new Date(message.timestamp).toISOString(),
          role: message.direction === 'outgoing' ? 'user' : 'contact', direction: message.direction, use: 'discussion',
          messageId: message.messageId, ...qqSourceMetadata(message) };
        sources.push({ ...base, revision: sourceRevision(base) });
      }
      const companionRow = store.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(key);
      const record = companionRow ? JSON.parse(companionRow.record) : {};
      const turns = Array.isArray(record.turns) ? record.turns : [];
      const notes = Array.isArray(record.notes) ? record.notes : [];
      for (const turn of turns) {
        if (turn.role !== 'user') continue;
        const id = `private:${turn.id}`;
        if (turn.memoryExcluded) { tombstones.push({ id, reason: 'turn_excluded', at: turn.updatedAt || turn.createdAt || null }); continue; }
        if (['feedback', 'feedback_ref'].includes(turn.kind)) continue; // represented by canonical feedback sources
        const base = { id, type: 'private', text: turn.text, at: turn.createdAt, role: 'user', use: 'discussion', kind: turn.kind, version: turn.version || 1 };
        sources.push({ ...base, revision: sourceRevision(base) });
      }
      for (const note of notes) {
        const id = `note:${note.id}`;
        if (note.use === 'disabled') { tombstones.push({ id, reason: 'use_disabled', at: note.updatedAt || null }); continue; }
        const base = { id, type: 'note', text: note.text, at: note.updatedAt, use: note.use, kind: note.kind || 'material', version: note.version,
          ...(note.evidenceSourceIds ? { evidenceSourceIds: note.evidenceSourceIds } : {}), ...(note.evidenceRevisions ? { evidenceRevisions: note.evidenceRevisions } : {}) };
        sources.push({ ...base, revision: sourceRevision(base) });
      }
      for (const row of store.db.prepare('SELECT source_id FROM memory_exclusions WHERE scope_key=?').all(key))
        tombstones.push({ id: row.source_id, reason: 'user_excluded', at: null });
      for (const row of store.db.prepare('SELECT record FROM experience_objects WHERE scope_key=? AND kind=?').all(key, 'feedback')) {
        const feedback = JSON.parse(row.record);
        const id = feedback.sourceId || `private:feedback-${feedback.id}`;
        if (feedback.redacted) { tombstones.push({ id, reason: 'redacted_feedback', at: feedback.updatedAt || feedback.createdAt || null }); continue; }
        const base = { id, type: 'feedback', text: feedback.text, at: feedback.updatedAt || feedback.createdAt, role: 'user', kind: 'local',
          use: 'discussion', version: feedback.revision, requestId: feedback.requestId, targetRef: feedback.targetRef,
          canonicalFeedbackId: feedback.id, applicability: feedback.applicability || 'local' };
        sources.push({ ...base, revision: sourceRevision(base) });
      }
      // A tombstone always wins over a live row with the same id.
      const dead = new Set(tombstones.map(item => item.id));
      return { sources: sources.filter(source => !dead.has(source.id)), tombstones };
    }
  };
}

// ---------------------------------------------------------------- service ---

function createRetrievalService(options = {}) {
  const provider = options.provider || (options.store ? createStoreObservationProvider(options.store, options) : null);
  if (!provider || typeof provider.universe !== 'function') throw new Error('A provider or a Store is required');
  const db = options.db || (options.store && options.store.db) || null;
  if (!db) throw new Error('A sqlite database (store or explicit) is required for the retrieval index');
  const excerptChars = Number.isInteger(options.excerptChars) && options.excerptChars >= 40 && options.excerptChars <= 4000 ? options.excerptChars : 160;
  const embedding = options.embedding && typeof options.embedding.embed === 'function' ? options.embedding : null;
  const jev = options.jev && typeof options.jev.decide === 'function' ? options.jev : null;
  const tierFor = typeof options.tierFor === 'function' ? options.tierFor : (typeof provider.tierFor === 'function' ? provider.tierFor : defaultTierFor);
  // Corrections and user control statements are exempt from JEV demotion
  // (counter-evidence protection). The M2 overlay kinds land here later.
  const protect = typeof options.protect === 'function' ? options.protect : source =>
    source?.correction === true || ['user_control', 'correction'].includes(source?.kind);

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(scope_key UNINDEXED, source_id UNINDEXED, tokens);
CREATE TABLE IF NOT EXISTS retrieval_lex_meta(scope_key TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
  kind TEXT NOT NULL, speaker TEXT NOT NULL, tier TEXT NOT NULL, at TEXT NOT NULL, indexed_at TEXT NOT NULL,
  PRIMARY KEY(scope_key, source_id));
CREATE TABLE IF NOT EXISTS retrieval_vectors(scope_key TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL, vector TEXT NOT NULL, embedded_at TEXT NOT NULL,
  PRIMARY KEY(scope_key, source_id, provider));
CREATE TABLE IF NOT EXISTS retrieval_jev_cache(cache_key TEXT PRIMARY KEY, model TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const statements = {
    metaRows: db.prepare('SELECT source_id, revision FROM retrieval_lex_meta WHERE scope_key=?'),
    deleteFts: db.prepare('DELETE FROM retrieval_fts WHERE scope_key=? AND source_id=?'),
    insertFts: db.prepare('INSERT INTO retrieval_fts(scope_key, source_id, tokens) VALUES(?,?,?)'),
    upsertMeta: db.prepare('INSERT OR REPLACE INTO retrieval_lex_meta VALUES(?,?,?,?,?,?,?,?)'),
    deleteMeta: db.prepare('DELETE FROM retrieval_lex_meta WHERE scope_key=? AND source_id=?'),
    vectorRows: db.prepare('SELECT source_id, revision FROM retrieval_vectors WHERE scope_key=?'),
    deleteVector: db.prepare('DELETE FROM retrieval_vectors WHERE scope_key=? AND source_id=?'),
    insertVector: db.prepare('INSERT OR REPLACE INTO retrieval_vectors VALUES(?,?,?,?,?,?,?,?)'),
    readVector: db.prepare('SELECT revision, dims, vector FROM retrieval_vectors WHERE scope_key=? AND source_id=? AND provider=?'),
    ftsMatch: db.prepare('SELECT source_id, bm25(retrieval_fts) AS score FROM retrieval_fts WHERE retrieval_fts MATCH ? AND scope_key=?'),
    jevGet: db.prepare('SELECT decision FROM retrieval_jev_cache WHERE cache_key=?'),
    jevSet: db.prepare('INSERT OR REPLACE INTO retrieval_jev_cache VALUES(?,?,?,?)')
  };

  const transaction = fn => {
    const own = !db.isTransaction;
    if (own) db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (own) db.exec('COMMIT'); return result; }
    catch (error) { if (own && db.isTransaction) db.exec('ROLLBACK'); throw error; }
  };

  // Normalize the provider universe into index rows. Sources are validated,
  // never repaired: a malformed observation is a loud error, not a guess.
  function universe(scope) {
    assertScope(scope);
    const raw = provider.universe(scope);
    const seen = new Set();
    const rows = new Map();
    for (const source of raw.sources) {
      if (!source || typeof source.id !== 'string' || !/^(qq|private|note|feedback):/.test(source.id))
        throw new Error('Observation source id must use the qq:/private:/note:/feedback: vocabulary');
      if (seen.has(source.id)) throw new Error(`Duplicate observation id in universe: ${source.id}`);
      seen.add(source.id);
      if (!OBSERVATION_KINDS.includes(source.type)) throw new Error(`Unknown observation kind: ${source.type}`);
      if (typeof source.text !== 'string') throw new Error(`Observation text must be a string: ${source.id}`);
      if (typeof source.revision !== 'string' || !source.revision) throw new Error(`Observation revision missing: ${source.id}`);
      requireIso(`observation time for ${source.id}`, source.at);
      rows.set(source.id, { id: source.id, revision: source.revision, kind: source.type,
        speaker: observationSpeaker(source), tier: tierFor(source), at: source.at, text: source.text, source });
    }
    const tombstones = [];
    for (const tombstone of raw.tombstones || []) {
      if (!tombstone || typeof tombstone.id !== 'string' || !TOMBSTONE_REASONS[tombstone.reason])
        throw new Error('Invalid tombstone in observation universe');
      tombstones.push({ id: tombstone.id, reason: tombstone.reason, at: tombstone.at || null });
      rows.delete(tombstone.id);
    }
    return { rows, tombstones };
  }

  // Incremental index sync: revision-keyed upserts, deletes for gone ids, and
  // stale vector rows are dropped (never reused for a changed observation).
  function syncIndex(scope) {
    const key = assertScope(scope);
    const state = universe(scope);
    return transaction(() => {
      const existing = new Map(statements.metaRows.all(key).map(row => [row.source_id, row.revision]));
      let updated = 0, dropped = 0;
      for (const row of state.rows.values()) {
        if (existing.get(row.id) === row.revision) continue;
        statements.deleteFts.run(key, row.id);
        statements.insertFts.run(key, row.id, terms(row.text).join(' '));
        statements.upsertMeta.run(key, row.id, row.revision, row.kind, row.speaker, row.tier, row.at, new Date().toISOString());
        updated++;
      }
      for (const [id] of existing) if (!state.rows.has(id)) {
        statements.deleteFts.run(key, id); statements.deleteMeta.run(key, id); dropped++;
      }
      const staleVectors = [];
      for (const vectorRow of statements.vectorRows.all(key)) {
        const row = state.rows.get(vectorRow.source_id);
        if (!row || row.revision !== vectorRow.revision) {
          statements.deleteVector.run(key, vectorRow.source_id);
          staleVectors.push(vectorRow.source_id);
        }
      }
      return { indexed: state.rows.size, updated, dropped, staleVectorsDropped: [...new Set(staleVectors)] };
    });
  }

  // One predicate definition serves both the JS filter and the SQL parity
  // check: predicates with {column, values} are enforced in SQL too, so the
  // two paths cannot drift apart. Rejection reasons are part of the public
  // manifest vocabulary.
  function compilePredicates(filters, tiers) {
    const predicates = [];
    if (filters.kinds) {
      const set = new Set(filters.kinds);
      predicates.push({ reject: row => set.has(row.kind) ? null : 'kind_not_allowed', column: 'kind', values: filters.kinds });
    }
    if (filters.speakers) {
      const set = new Set(filters.speakers);
      predicates.push({ reject: row => set.has(row.speaker) ? null : (row.speaker === 'undetermined' ? 'speaker_undetermined_no_default' : 'speaker_not_allowed'), column: 'speaker', values: filters.speakers });
    }
    if (tiers) {
      const set = new Set(tiers);
      predicates.push({ reject: row => set.has(row.tier) ? null : 'tier_not_allowed', column: 'tier', values: tiers });
    }
    if (filters.since !== undefined && filters.since !== null || filters.until !== undefined && filters.until !== null) {
      const since = filters.since === undefined || filters.since === null ? -Infinity : requireIso('filters.since', filters.since);
      const until = filters.until === undefined || filters.until === null ? Infinity : requireIso('filters.until', filters.until);
      if (since > until) throw new Error('Invalid time window: since is after until');
      predicates.push({ reject: row => { const at = Date.parse(row.at); return at >= since && at <= until ? null : 'outside_time_window'; } });
    }
    if (filters.onlyIds) {
      const set = new Set(filters.onlyIds);
      predicates.push({ reject: row => set.has(row.id) ? null : 'id_not_requested' });
    }
    if (filters.excludeIds) {
      const set = new Set(filters.excludeIds);
      predicates.push({ reject: row => set.has(row.id) ? 'id_excluded' : null });
    }
    return predicates;
  }

  function validateRetrieveInput({ filters = {}, tiers, anchors = [], limit }) {
    const checked = {
      kinds: optionalEnumList('filters.kinds', filters.kinds, OBSERVATION_KINDS),
      speakers: optionalEnumList('filters.speakers', filters.speakers, SPEAKERS),
      since: filters.since, until: filters.until,
      onlyIds: optionalIdList('filters.onlyIds', filters.onlyIds),
      excludeIds: optionalIdList('filters.excludeIds', filters.excludeIds)
    };
    const allowedTiers = tiers === undefined || tiers === null ? null : optionalEnumList('tiers', tiers, TIER_CODES);
    if (!Array.isArray(anchors) || anchors.length > MAX_ANCHORS || anchors.some(anchor => !anchor || typeof anchor.sourceId !== 'string' || !anchor.sourceId ||
      anchor.reason !== undefined && typeof anchor.reason !== 'string' || anchor.neighborhoods !== undefined && anchor.neighborhoods !== false &&
      (typeof anchor.neighborhoods !== 'object' || ['maxGapMs', 'maxSpanMs', 'maxMessages'].some(field => anchor.neighborhoods[field] !== undefined &&
        (!Number.isFinite(anchor.neighborhoods[field]) || anchor.neighborhoods[field] < 0)))))
      throw new Error(`Invalid anchors: expected up to ${MAX_ANCHORS} {sourceId, reason?, neighborhoods?} entries`);
    const itemLimit = limit === undefined ? DEFAULT_LIMIT : Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : null;
    if (itemLimit === null) throw new Error(`Invalid limit: expected an integer in 1..${MAX_LIMIT}`);
    return { filters: checked, tiers: allowedTiers, anchors, limit: itemLimit };
  }

  // Stage 1: hard filters over the universe. Enumerable predicates are also
  // enforced in SQL over the lexical index and the two results must agree - a
  // disagreement is index drift and fails loudly instead of guessing.
  function hardFilter(scope, state, validated) {
    const predicates = compilePredicates(validated.filters, validated.tiers);
    const enumerable = predicates.filter(predicate => predicate.column);
    const legal = new Map(), rejected = [];
    const rejectedCounts = {};
    for (const row of state.rows.values()) {
      const reason = predicates.reduce((found, predicate) => found || predicate.reject(row), null);
      if (reason) { rejected.push({ id: row.id, reason }); rejectedCounts[reason] = (rejectedCounts[reason] || 0) + 1; }
      else legal.set(row.id, row);
    }
    const key = assertScope(scope);
    let sqlIds;
    if (enumerable.length) {
      const clauses = enumerable.map(item => `${item.column} IN (${item.values.map(() => '?').join(',')})`);
      const params = [key, ...enumerable.flatMap(item => item.values)];
      sqlIds = new Set(db.prepare(`SELECT source_id FROM retrieval_lex_meta WHERE scope_key=? AND ${clauses.join(' AND ')}`).all(...params).map(row => row.source_id));
    } else {
      sqlIds = new Set(statements.metaRows.all(key).map(row => row.source_id));
    }
    const jsIds = new Set([...state.rows.values()].filter(row => !enumerable.some(predicate => predicate.reject(row))).map(row => row.id));
    if (sqlIds.size !== jsIds.size || ![...sqlIds].every(id => jsIds.has(id)))
      throw new Error('Retrieval index drift: lexical index rows do not match the observation universe');
    return { legal, rejected: rejected.slice(0, MAX_REJECTED_LISTED), rejectedTotal: rejected.length, rejectedCounts };
  }

  // Stage 2 neighborhood plan: anchors plus their time-adjacent qq
  // neighborhoods (RECENT_CONTEXT_LIMITS absorbed) and reply targets in both
  // directions: the message an anchor replies to, and legal messages that
  // reply to the anchor (round reply edges, never dropped sub-second anchors).
  function anchorPlan(legal, anchors) {
    const resolved = [], rejected = [], neighborhoods = new Map(), replyTargets = new Map();
    const qq = [...legal.values()].filter(row => row.kind === 'qq')
      .map(row => ({ id: row.id, at: Date.parse(row.at), row }))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const position = new Map(qq.map((item, index) => [item.id, index]));
    const repliesTo = new Map();
    for (const item of qq) {
      const reply = item.row.source.replyTo;
      if (reply && reply.messageId && !reply.targetUnavailable && legal.has(`qq:${reply.messageId}`))
        repliesTo.set(item.id, `qq:${reply.messageId}`);
    }
    for (const anchor of anchors) {
      const row = legal.get(anchor.sourceId);
      if (!row) { rejected.push({ sourceId: anchor.sourceId, reason: 'anchor_not_in_legal_set' }); continue; }
      resolved.push({ sourceId: anchor.sourceId, reason: anchor.reason || 'unnamed' });
      const index = position.get(anchor.sourceId);
      if (index !== undefined && anchor.neighborhoods !== false) {
        const limits = { maxGapMs: RECENT_CONTEXT_LIMITS.maxGapMs, maxSpanMs: RECENT_CONTEXT_LIMITS.maxSpanMs,
          maxMessages: RECENT_CONTEXT_LIMITS.maxMessages, ...(anchor.neighborhoods || {}) };
        let left = index, right = index, count = 1, progress = true;
        const inSpan = edge => Math.abs(qq[edge].at - qq[index].at) <= limits.maxSpanMs;
        const adjacent = (a, b) => qq[b].at - qq[a].at <= limits.maxGapMs;
        while (progress && count < limits.maxMessages) {
          progress = false;
          if (left > 0 && adjacent(left - 1, left) && inSpan(left - 1)) { left--; count++; progress = true; if (count >= limits.maxMessages) break; }
          if (right < qq.length - 1 && adjacent(right, right + 1) && inSpan(right + 1)) { right++; count++; progress = true; }
        }
        for (let i = left; i <= right; i++) if (i !== index) neighborhoods.set(qq[i].id, 'time_adjacent');
      }
      const ownReply = repliesTo.get(anchor.sourceId);
      if (ownReply) replyTargets.set(ownReply, 'anchor_reply');
      for (const item of qq) if (repliesTo.get(item.id) === anchor.sourceId)
        replyTargets.set(item.id, 'replies_to_anchor');
    }
    return { resolved, rejected, neighborhoods, replyTargets };
  }

  // Stage 3: optional semantic reorder/augment over the legal set ONLY (the
  // candidate loop iterates legal rows, so a vector hit structurally cannot
  // admit a filtered-out source). Vectors are revision-keyed and cached; a
  // stale row was already dropped by syncIndex.
  async function semanticStage(key, legal, query, baselineMode, staleDropped) {
    if (!embedding) return { enabled: false, reason: 'no_provider' };
    if (!embedding.enabled) return { enabled: false, reason: 'disabled_by_default', provider: { name: embedding.name, model: embedding.model } };
    if (baselineMode) return { enabled: false, reason: 'baseline_run', provider: { name: embedding.name, model: embedding.model } };
    const providerName = embedding.name, model = embedding.model || 'unknown';
    const vectorFor = new Map();
    const missing = [];
    for (const row of legal.values()) {
      const cached = statements.readVector.get(key, row.id, providerName);
      if (cached && cached.revision === row.revision && Number.isInteger(cached.dims) && cached.dims > 0)
        vectorFor.set(row.id, Float64Array.from(JSON.parse(cached.vector)));
      else missing.push(row);
    }
    const queryText = query.trim();
    let embedded = 0;
    if (missing.length || queryText) {
      const result = await embedding.embed([...missing.map(row => row.text), ...(queryText ? [queryText] : [])]);
      const queryVector = queryText ? result.vectors[result.vectors.length - 1] : null;
      transaction(() => {
        missing.forEach((row, index) => {
          statements.deleteVector.run(key, row.id);
          statements.insertVector.run(key, row.id, row.revision, providerName, model, result.vectors[index].length,
            JSON.stringify(roundVector(result.vectors[index])), new Date().toISOString());
          vectorFor.set(row.id, result.vectors[index]);
        });
      });
      embedded = missing.length;
      if (queryVector) vectorFor.set('__query__', queryVector);
    }
    return { enabled: true, provider: { name: providerName, model, version: embedding.providerVersion || EMBEDDING_PROVIDER_VERSION },
      embedded, staleDropped, legalOnly: true, neverAdmittedOutsideLegalSet: true, vectorFor };
  }

  function buildItem(row, parts, textMode) {
    const text = row.text;
    const offset = textMode === 'preview' && parts.query ? focusSourceOffset(text, parts.query, { windowChars: excerptChars }) : 0;
    const excerpt = textMode === 'full' ? text : text.slice(offset, offset + excerptChars);
    const item = {
      id: row.id, revision: row.revision, kind: row.kind, sourceKind: row.source.kind || null, speaker: row.speaker,
      tier: row.tier, at: row.at, use: row.source.use || null,
      totalChars: text.length, offset, deliveredChars: excerpt.length,
      truncatedPreview: textMode === 'preview' && text.length > excerpt.length,
      score: round(parts.score), lexicalScore: parts.lexicalScore, decay: parts.decay,
      matchedStages: [...parts.matchedStages], reasons: [...parts.reasons]
    };
    if (parts.semanticScore !== undefined && parts.semanticScore !== null) item.semanticScore = parts.semanticScore;
    if (parts.jevAdjustment !== undefined && parts.jevAdjustment !== null) item.jevAdjustment = parts.jevAdjustment;
    if (parts.anchorReasons.length) item.anchorReasons = [...parts.anchorReasons];
    if (textMode === 'full') item.text = text; else item.excerpt = excerpt;
    return item;
  }

  async function retrieve(input = {}) {
    if (typeof input !== 'object') throw new Error('Invalid retrieve input');
    const { scope, query = '', asOf, textMode = 'preview', baseline = false } = input;
    if (typeof query !== 'string' || query.length > 100000) throw new Error('Invalid query: expected a string');
    if (!['preview', 'full'].includes(textMode)) throw new Error('Invalid textMode: expected preview or full');
    const key = assertScope(scope);
    const asOfMs = asOf === undefined || asOf === null ? Date.now() : requireIso('asOf', asOf);
    const validated = validateRetrieveInput(input);
    const state = universe(scope);
    const indexInfo = syncIndex(scope);
    const hard = hardFilter(scope, state, validated);
    const legal = hard.legal;

    // Stage 2: lexical rank (FTS5 bm25 over JS CJK-bigram tokens).
    const queryTerms = query ? [...new Set(terms(query))].slice(0, 96) : [];
    const lexicalScores = new Map();
    if (queryTerms.length) {
      const match = queryTerms.map(term => `"${term}"`).join(' OR ');
      for (const row of statements.ftsMatch.all(match, key))
        if (legal.has(row.source_id)) lexicalScores.set(row.source_id, round(Math.max(0, -row.score)));
    }
    const anchor = anchorPlan(legal, validated.anchors);

    // Admission: a legal row becomes an item only through an explicit stage.
    const admitted = new Map();
    const admit = (id, stage, reason, anchorReason) => {
      const entry = admitted.get(id) || { row: legal.get(id), matchedStages: new Set(['hard_filter']), reasons: new Set(['legal:passed_hard_filters']), anchorReasons: [] };
      entry.matchedStages.add(stage); entry.reasons.add(reason);
      if (anchorReason && !entry.anchorReasons.includes(anchorReason)) entry.anchorReasons.push(anchorReason);
      admitted.set(id, entry);
    };
    for (const id of lexicalScores.keys()) admit(id, 'lexical', 'lexical:bm25_match');
    for (const item of anchor.resolved) admit(item.sourceId, 'anchor', `anchor:${item.reason}`, item.reason);
    for (const [id, why] of anchor.neighborhoods) admit(id, 'anchor_neighborhood', `anchor_neighborhood:${why}`);
    for (const [id, why] of anchor.replyTargets) admit(id, 'reply_target', `reply_target:${why}`);
    if (validated.filters.onlyIds) for (const id of validated.filters.onlyIds) if (legal.has(id)) admit(id, 'direct_reference', 'direct:only_ids_reference');

    // Stage 3: optional semantic reorder/augment over the legal set only.
    const semantic = await semanticStage(key, legal, query, baseline, indexInfo.staleVectorsDropped);
    const semanticScores = new Map();
    if (semantic.enabled) {
      const queryVector = semantic.vectorFor.get('__query__');
      if (queryVector) for (const row of legal.values()) {
        const vector = semantic.vectorFor.get(row.id);
        if (!vector) continue;
        const mapped = round((cosineSimilarity(queryVector, vector) + 1) / 2);
        semanticScores.set(row.id, mapped);
        if (mapped >= SCORING.semanticHitThreshold) admit(row.id, 'semantic', 'semantic:gap_candidate');
      }
    }
    const { vectorFor, ...semanticReport } = semantic;

    // Compose deterministic scores.
    const scored = [...admitted.values()].map(entry => {
      const ageDays = Math.max(0, (asOfMs - Date.parse(entry.row.at)) / 86400000);
      const decay = round(Math.max(0, 5 - Math.log2(ageDays + 1)));
      const semanticHit = semanticScores.has(entry.row.id) && semanticScores.get(entry.row.id) >= SCORING.semanticHitThreshold;
      const score = SCORING.weights.lexical * (lexicalScores.get(entry.row.id) || 0) +
        SCORING.weights.decay * decay +
        (entry.matchedStages.has('anchor') ? SCORING.weights.anchor : 0) +
        (entry.matchedStages.has('anchor_neighborhood') ? SCORING.weights.neighborhood : 0) +
        (entry.matchedStages.has('reply_target') ? SCORING.weights.replyTarget : 0) +
        (semanticHit ? SCORING.weights.semantic * semanticScores.get(entry.row.id) : 0);
      return { ...entry, decay, rawScore: score };
    });
    scored.sort((a, b) => b.rawScore - a.rawScore || Date.parse(b.row.at) - Date.parse(a.row.at) || a.row.id.localeCompare(b.row.id));
    const limited = scored.slice(0, validated.limit);

    // Stage 4: optional JEV reorder-only adjustment (never drops; protected
    // items skip negative hints). Batched once, hash-cached: an unchanged
    // input never triggers a new decision call.
    let jevReport = null;
    if (jev && jev.enabled && !baseline && query && limited.length) {
      const candidates = limited.map(entry => ({ id: entry.row.id, revision: entry.row.revision, excerpt: entry.row.text.slice(0, 400) }));
      const cacheKey = hashDecisionInput({ model: jev.model || 'unknown', kind: 'candidate_relevance', question: query, candidates });
      let cachedDecision = statements.jevGet.get(cacheKey);
      let cached = !!cachedDecision, decision;
      if (cachedDecision) decision = JSON.parse(cachedDecision.decision);
      else {
        decision = await jev.decide({ kind: 'candidate_relevance', question: query, candidates });
        statements.jevSet.run(cacheKey, decision.model || jev.model || 'unknown', JSON.stringify(decision), new Date().toISOString());
      }
      const hints = new Map(decision.decisions.map(item => [item.id, Math.max(-1, Math.min(1, Number(item.hint) || 0))]));
      const protectedIds = [];
      for (const entry of limited) {
        const hint = hints.get(entry.row.id) || 0;
        if (!hint) continue;
        if (hint < 0 && protect(entry.row.source)) { protectedIds.push(entry.row.id); continue; }
        entry.rawScore += SCORING.weights.jev * hint;
        entry.jevAdjustment = round(SCORING.weights.jev * hint);
        entry.matchedStages.add('jev_adjusted'); entry.reasons.add(hint > 0 ? 'jev:positive_reorder' : 'jev:negative_reorder');
      }
      limited.sort((a, b) => b.rawScore - a.rawScore || Date.parse(b.row.at) - Date.parse(a.row.at) || a.row.id.localeCompare(b.row.id));
      jevReport = { enabled: true, provider: { name: jev.name, model: jev.model }, kind: 'candidate_relevance',
        batched: true, batchSize: candidates.length, cached, cacheKeyDigest: cacheKey.slice(0, 16),
        dropped: 0, adjusted: limited.filter(entry => entry.jevAdjustment !== undefined).length, protectedIds,
        probabilitiesAreHintsNotFacts: true };
    }

    const items = limited.map(entry => buildItem(entry.row, {
      score: entry.rawScore, lexicalScore: lexicalScores.get(entry.row.id) || 0, decay: entry.decay,
      matchedStages: entry.matchedStages, reasons: entry.reasons, anchorReasons: entry.anchorReasons,
      semanticScore: semanticScores.has(entry.row.id) ? semanticScores.get(entry.row.id) : null,
      jevAdjustment: entry.jevAdjustment !== undefined ? entry.jevAdjustment : null, query
    }, textMode));

    const manifest = {
      serviceVersion: RETRIEVAL_SERVICE_VERSION, adapter: { name: provider.name, version: provider.adapterVersion || null, observationLog: !!provider.observationLog },
      scopeKey: key, asOf: new Date(asOfMs).toISOString(), queryDigest: query ? digestOf(query).slice(0, 16) : null,
      queryTerms, tiers: validated.tiers || [...TIER_CODES], filters: validated.filters, limit: validated.limit, textMode,
      counts: { universe: state.rows.size, tombstones: state.tombstones.length, legal: legal.size,
        rejected: hard.rejectedTotal, admitted: admitted.size, returned: items.length },
      tombstones: state.tombstones.slice(0, MAX_REJECTED_LISTED).map(item => ({ id: item.id, reason: item.reason, explanation: TOMBSTONE_REASONS[item.reason] })),
      stages: {
        hardFilter: { legalCount: legal.size, rejectedTotal: hard.rejectedTotal, rejectedCounts: hard.rejectedCounts, rejected: hard.rejected, sqlEnforced: true, neverBypassed: true },
        lexical: { mode: 'fts5-bm25-js-cjk-bigram', indexed: indexInfo.indexed, matched: lexicalScores.size,
          updated: indexInfo.updated, dropped: indexInfo.dropped, scoring: SCORING },
        neighborhoods: { anchors: anchor.resolved, anchorRejections: anchor.rejected,
          neighborhoodHits: anchor.neighborhoods.size, replyTargetHits: anchor.replyTargets.size,
          limits: { maxGapMs: RECENT_CONTEXT_LIMITS.maxGapMs, maxSpanMs: RECENT_CONTEXT_LIMITS.maxSpanMs, maxMessages: RECENT_CONTEXT_LIMITS.maxMessages } },
        semantic: semanticReport.enabled ? { ...semanticReport, hits: [...semanticScores.values()].filter(value => value >= SCORING.semanticHitThreshold).length } : semanticReport,
        jev: jevReport
      },
      baseline: { thisRunIsBaseline: !semanticReport.enabled && !jevReport, sameInputBaselineRetained: true }
    };
    return { items, manifest };
  }

  // Appendix B9: batch program-side range retrieval. ONE call resolves many
  // {sourceId, offset, maxChars} continuation ranges against the CURRENT
  // hard-filtered observation set, so evidence continuation stops spending
  // per-range model round-trips. Stale revisions never serve old text.
  async function retrieveRanges(input = {}) {
    if (typeof input !== 'object') throw new Error('Invalid retrieveRanges input');
    const { scope, ranges, query = '' } = input;
    const key = assertScope(scope);
    if (typeof query !== 'string') throw new Error('Invalid query: expected a string');
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > RANGE_LIMITS.maxRanges ||
      ranges.some(range => !range || typeof range.sourceId !== 'string' || !range.sourceId ||
        range.offset !== undefined && (!Number.isSafeInteger(range.offset) || range.offset < 0) ||
        !Number.isSafeInteger(range.maxChars) || range.maxChars < 1 || range.maxChars > RANGE_LIMITS.maxCharsPerRange ||
        range.revision !== undefined && typeof range.revision !== 'string'))
      throw new Error(`Invalid ranges: expected up to ${RANGE_LIMITS.maxRanges} {sourceId, offset?, maxChars<=${RANGE_LIMITS.maxCharsPerRange}, revision?} entries`);
    const totalBudget = input.maxTotalChars === undefined ? RANGE_LIMITS.defaultTotalChars :
      Number.isSafeInteger(input.maxTotalChars) && input.maxTotalChars > 0 ? input.maxTotalChars : null;
    if (totalBudget === null) throw new Error('Invalid maxTotalChars: expected a positive integer');
    const validated = validateRetrieveInput({ filters: input.filters || {}, tiers: input.tiers, anchors: [], limit: 1 });
    const state = universe(scope);
    syncIndex(scope);
    const hard = hardFilter(scope, state, validated);
    const tombstoneReason = new Map(state.tombstones.map(item => [item.id, item.reason]));
    let deliveredTotal = 0;
    const resolved = ranges.map(range => {
      const row = state.rows.get(range.sourceId);
      if (!row) {
        const reason = tombstoneReason.has(range.sourceId) ? `tombstoned:${tombstoneReason.get(range.sourceId)}` : 'unknown_source';
        return { sourceId: range.sourceId, resolved: false, reason };
      }
      if (!hard.legal.has(range.sourceId)) {
        const rejected = hard.rejected.find(entry => entry.id === range.sourceId);
        return { sourceId: range.sourceId, resolved: false, reason: `filtered:${rejected ? rejected.reason : 'not_legal'}` };
      }
      if (range.revision !== undefined && range.revision !== row.revision)
        return { sourceId: range.sourceId, resolved: false, reason: 'stale_revision', expectedRevision: range.revision, currentRevision: row.revision };
      const text = row.text;
      const requestedOffset = range.offset !== undefined ? range.offset : (query ? focusSourceOffset(text, query, { windowChars: range.maxChars }) : 0);
      const offset = Math.min(requestedOffset, Math.max(0, text.length ? text.length - 1 : 0));
      const budget = Math.max(0, Math.min(range.maxChars, totalBudget - deliveredTotal));
      const slice = text.slice(offset, offset + budget);
      deliveredTotal += slice.length;
      const wanted = Math.min(range.maxChars, Math.max(0, text.length - offset));
      return { sourceId: range.sourceId, resolved: true, revision: row.revision, kind: row.kind, speaker: row.speaker,
        tier: row.tier, at: row.at, offset, offsetClamped: offset !== requestedOffset, maxChars: range.maxChars,
        deliveredChars: slice.length, totalChars: text.length, truncated: slice.length < wanted,
        budgetTruncated: budget < range.maxChars, text: slice };
    });
    return { ranges: resolved, manifest: {
      serviceVersion: RETRIEVAL_SERVICE_VERSION, adapter: { name: provider.name, version: provider.adapterVersion || null },
      scopeKey: key, roundTrips: 1, counts: { requested: ranges.length, resolved: resolved.filter(range => range.resolved).length,
        refused: resolved.filter(range => !range.resolved).length, deliveredChars: deliveredTotal },
      stages: { hardFilter: { legalCount: hard.legal.size, rejectedCounts: hard.rejectedCounts, neverBypassed: true } }
    } };
  }

  // Resource-doc gap rule: retain a same-input baseline without the optional
  // capabilities next to the enhanced run, with provider identities recorded.
  async function compareBaseline(input = {}) {
    const baselineRun = await retrieve({ ...input, baseline: true });
    const enhancedRun = await retrieve(input);
    const baselineIds = baselineRun.items.map(item => item.id);
    const enhancedIds = enhancedRun.items.map(item => item.id);
    return {
      baseline: { itemIds: baselineIds, manifest: baselineRun.manifest },
      enhanced: { itemIds: enhancedIds, manifest: enhancedRun.manifest },
      diff: { addedIds: enhancedIds.filter(id => !baselineIds.includes(id)),
        removedIds: baselineIds.filter(id => !enhancedIds.includes(id)),
        orderChanged: JSON.stringify(baselineIds) !== JSON.stringify(enhancedIds) },
      providers: { embedding: embedding ? { name: embedding.name, model: embedding.model, enabled: !!embedding.enabled } : null,
        jev: jev ? { name: jev.name, model: jev.model, enabled: !!jev.enabled } : null },
      note: 'same-input lexical-only baseline retained (docs/available-resources_CN.md gap rule)'
    };
  }

  function indexStatus(scope) {
    const key = assertScope(scope);
    return { ftsRows: statements.metaRows.all(key).length, vectorRows: statements.vectorRows.all(key).length,
      jevCacheRows: db.prepare('SELECT COUNT(*) AS n FROM retrieval_jev_cache').get().n };
  }

  return { retrieve, retrieveRanges, compareBaseline, syncIndex, indexStatus,
    serviceVersion: RETRIEVAL_SERVICE_VERSION, provider: provider.name, embeddingProvider: embedding, jevProvider: jev };
}

module.exports = { RETRIEVAL_SERVICE_VERSION, ADAPTER_VERSION, AUTHORIZATION_TIERS, OBSERVATION_KINDS, SPEAKERS,
  TOMBSTONE_REASONS, SCORING, RANGE_LIMITS, defaultTierFor, createStoreObservationProvider, createRetrievalService };
