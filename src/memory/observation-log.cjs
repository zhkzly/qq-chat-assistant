'use strict';
// M1 Observation Log (greenfield design docs/dsh-subsystem-redesign.md §2.1/§4.1).
// The durable append-only source of truth for everything observed in one
// conversation scope: actual QQ messages, private consultation turns, user
// notes, feedback, recalls, exclusions and redactions.
//
// Structural contract:
//   1. Identity is frozen once. Every observation event records the speaker
//      identity (speaker/heldBy) derived mechanically by speaker-identity.cjs
//      at append time. Downstream consumers read the frozen fields; they never
//      re-derive identity from mutable projections. A later event may change
//      identity only by declaring identityChanged with the previous identity
//      preserved (problem-backlog #6: sender-role corrections must surface).
//   2. observation_events is append-only, enforced by SQLite triggers: no
//      code path can UPDATE or DELETE an observation event. History is audit
//      truth for identity, lifecycle and digests.
//   3. Bodies are redactable, separately. observation_bodies keeps the current
//      text/descriptor per observation; privacy operations (recall, forget,
//      user deletion) append an event and drop the body row, matching the
//      retention behavior of the previous memory_sources tombstones. Event
//      digests prove what existed without retaining it.
//   4. Revisions are speaker-fingerprinted: revisionOf hashes the observation
//      evidence together with a canonical speaker-role fingerprint, so a
//      correction of who spoke invalidates derived memory instead of leaving
//      it bound to a revision that no longer represents the attribution
//      (problem-backlog #6). Enrichment that does not change the speaker role
//      (for example a late scoped sender id) keeps the revision stable.
//   5. All derived views (memory sources, relationship understanding, context
//      projection) are folds over this log; reconcile keeps the projection
//      equal to the ingest-store derivation after every mutation.
const { createHash } = require('node:crypto');
const { observationSpeaker } = require('../speaker-identity.cjs');

const OBSERVATION_LOG_VERSION = 1;
const EVENT_KINDS = new Set(['observed', 'revised', 'recalled', 'excluded', 'redacted']);
const ID_PATTERN = /^(qq|private|note):.+$/;

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function freezeIdentity(source) {
  const speaker = observationSpeaker(source);
  return { speaker, heldBy: speaker, basis: 'mechanical_ingestion_derivation' };
}

// Canonical speaker-role fingerprint: WHAT party the observation proves, not
// which redundant sender id happened to arrive. Derived from the same
// mechanical vocabulary the write gates and renderer consume.
function speakerFingerprint(source) {
  return hash({
    type: source?.type || null,
    speaker: observationSpeaker(source),
    role: source?.role || null,
    direction: source?.direction || null,
  });
}

// Speaker-fingerprinted content revision. QQ ordering (sequence) and redundant
// scoped sender ids stay excluded: enriching a legacy source with late ids is
// not a correction. Everything that determines WHO spoke is inside the hash.
function revisionOf(source) {
  if (!plain(source)) throw new Error('Invalid observation for revision');
  const fingerprint = speakerFingerprint(source);
  if (source.type !== 'qq') return hash({ evidence: source, speakerFingerprint: fingerprint });
  const { sequence, senderUid, senderUin, ...evidence } = source;
  return hash({ evidence, speakerFingerprint: fingerprint });
}

// The descriptor is the observation content minus the large text body. Event
// digests cover descriptor+text so a redaction cannot silently rewrite what
// was observed.
function splitSource(source) {
  const { text, revision, speaker, heldBy, ...descriptor } = source;
  return { descriptor, text: typeof text === 'string' ? text : '', revision };
}
function digestOf(descriptor, text) { return hash({ descriptor, text }); }

class ObservationLog {
  constructor(db, { scopeKey }) {
    this.db = db;
    this.scopeKey = scopeKey;
    db.exec(`CREATE TABLE IF NOT EXISTS observation_events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      record TEXT NOT NULL,
      recorded_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS observation_event_id ON observation_events(scope_key,event_id);
      CREATE INDEX IF NOT EXISTS observation_observation ON observation_events(scope_key,observation_id,seq);
      CREATE TRIGGER IF NOT EXISTS observation_events_append_only_update
        BEFORE UPDATE ON observation_events
        BEGIN SELECT RAISE(ABORT,'observation_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS observation_events_append_only_delete
        BEFORE DELETE ON observation_events
        BEGIN SELECT RAISE(ABORT,'observation_events is append-only'); END;
      CREATE TABLE IF NOT EXISTS observation_bodies(
      scope_key TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      descriptor TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY(scope_key,observation_id));
      CREATE TABLE IF NOT EXISTS observation_migrations(scope_key TEXT PRIMARY KEY,version INTEGER NOT NULL,record TEXT NOT NULL);`);
  }

  _append(scope, event) {
    const key = this.scopeKey(scope);
    if (!plain(event) || !EVENT_KINDS.has(event.kind) || typeof event.observationId !== 'string' || !ID_PATTERN.test(event.observationId) || event.observationId.length > 300)
      throw new Error('Invalid observation event');
    if (!Object.keys(event).every(field => ['eventId', 'observationId', 'kind', 'at', 'identity', 'identityChanged', 'previousIdentity', 'reason', 'bodyRevision', 'bodyDigest', 'recalledAt'].includes(field)))
      throw new Error('Unauthorized observation event field');
    const { eventId, at, ...content } = event;
    // Idempotent by content: the same observation state always produces the
    // same event id (the wall-clock `at` is metadata, never identity), so
    // reconciliation replays and baseline backfills are deterministic and
    // re-running them cannot duplicate history.
    const id = eventId || hash({ scopeKey: key, observationId: event.observationId, kind: event.kind, ...content });
    this.db.prepare('INSERT OR IGNORE INTO observation_events(scope_key,event_id,observation_id,kind,record,recorded_at) VALUES(?,?,?,?,?,?)')
      .run(key, id, event.observationId, event.kind, JSON.stringify({ ...content, eventId: id, at }), event.at);
    return id;
  }

  _writeBody(scope, source) {
    const { descriptor, text } = splitSource(source);
    const revision = source.revision || revisionOf({ ...source, revision: undefined });
    this.db.prepare('INSERT INTO observation_bodies VALUES(?,?,?,?,?) ON CONFLICT(scope_key,observation_id) DO UPDATE SET revision=excluded.revision,descriptor=excluded.descriptor,text=excluded.text')
      .run(this.scopeKey(scope), source.id, revision, JSON.stringify(descriptor), text);
    return digestOf(descriptor, text);
  }

  _dropBody(scope, observationId) {
    this.db.prepare('DELETE FROM observation_bodies WHERE scope_key=? AND observation_id=?').run(this.scopeKey(scope), observationId);
  }

  observed(scope, source, { at = new Date().toISOString() } = {}) {
    if (!plain(source) || typeof source.id !== 'string') throw new Error('Invalid observation');
    const identity = freezeIdentity(source);
    const digest = this._writeBody(scope, source);
    return this._append(scope, { observationId: source.id, kind: 'observed', at, identity, bodyRevision: source.revision, bodyDigest: digest });
  }

  revised(scope, source, { at = new Date().toISOString(), reason = 'source_revision' } = {}) {
    const previous = this.identityOf(scope, source.id);
    const identity = freezeIdentity(source);
    const identityChanged = !!previous && previous.speaker !== identity.speaker;
    const digest = this._writeBody(scope, source);
    return this._append(scope, {
      observationId: source.id, kind: 'revised', at, reason, identity,
      ...(identityChanged ? { identityChanged: true, previousIdentity: previous } : {}),
      bodyRevision: source.revision, bodyDigest: digest,
    });
  }

  recalled(scope, { observationId, recalledAt = null, at = new Date().toISOString() }) {
    const previous = this._bodyDigest(scope, observationId);
    this._dropBody(scope, observationId);
    return this._append(scope, { observationId, kind: 'recalled', at, reason: 'native_recall', ...(recalledAt ? { recalledAt } : {}), ...(previous ? { bodyDigest: previous } : {}) });
  }

  excluded(scope, { observationId, reason = 'source_removed', at = new Date().toISOString() }) {
    const previous = this._bodyDigest(scope, observationId);
    this._dropBody(scope, observationId);
    return this._append(scope, { observationId, kind: 'excluded', at, reason, ...(previous ? { bodyDigest: previous } : {}) });
  }

  redacted(scope, { observationId, reason = 'privacy_redaction', at = new Date().toISOString() }) {
    return this.excluded(scope, { observationId, reason, at });
  }

  _bodyDigest(scope, observationId) {
    const row = this.db.prepare('SELECT revision,descriptor,text FROM observation_bodies WHERE scope_key=? AND observation_id=?').get(this.scopeKey(scope), observationId);
    return row ? digestOf(JSON.parse(row.descriptor), row.text) : null;
  }

  events(scope) {
    return this.db.prepare('SELECT record FROM observation_events WHERE scope_key=? ORDER BY seq').all(this.scopeKey(scope)).map(row => JSON.parse(row.record));
  }

  identityOf(scope, observationId) {
    for (const event of this.db.prepare('SELECT record FROM observation_events WHERE scope_key=? AND observation_id=? ORDER BY seq DESC').all(this.scopeKey(scope), observationId).map(row => JSON.parse(row.record)))
      if (event.identity) return event.identity;
    return null;
  }

  // Fold the event stream into the current observation state (the M1
  // projection, sourcesFor-shaped). Liveness is the last lifecycle event;
  // content is the current body row; identity is the last recorded identity
  // (frozen unless an identityChanged event exists in history).
  project(scope) {
    const key = this.scopeKey(scope);
    const state = new Map();
    for (const event of this.events(scope)) {
      const current = state.get(event.observationId) || { observationId: event.observationId, live: false, eventCount: 0 };
      current.eventCount++;
      current.lastEventAt = event.at;
      if (event.identity) current.identity = event.identity;
      if (event.identityChanged) current.identityChanges = (current.identityChanges || 0) + 1;
      if (event.kind === 'observed' || event.kind === 'revised') { current.live = true; current.bodyDigest = event.bodyDigest; current.bodyRevision = event.bodyRevision; }
      else current.live = false;
      if (event.kind === 'recalled') current.recalledAt = event.recalledAt || event.at;
      if (event.reason) current.lastReason = event.reason;
      if (event.kind === 'observed') current.firstObservedAt = current.firstObservedAt || event.at;
      state.set(event.observationId, current);
    }
    const bodies = new Map(this.db.prepare('SELECT observation_id,revision,descriptor,text FROM observation_bodies WHERE scope_key=?').all(key)
      .map(row => [row.observation_id, { ...JSON.parse(row.descriptor), text: row.text, revision: row.revision }]));
    const observations = [];
    for (const [observationId, current] of state) {
      const body = bodies.get(observationId);
      if (!current.live || !body) { observations.push({ id: observationId, deleted: true, revision: current.bodyRevision || null, lastReason: current.lastReason, lastEventAt: current.lastEventAt }); continue; }
      observations.push({
        ...body, deleted: false, bodyDigest: current.bodyDigest,
        speaker: current.identity?.speaker || 'undetermined', heldBy: current.identity?.heldBy || 'undetermined',
        observedAt: current.firstObservedAt || null, lastEventAt: current.lastEventAt,
        ...(current.identityChanges ? { identityChanges: current.identityChanges } : {}),
      });
    }
    observations.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.id).localeCompare(String(b.id)));
    return observations;
  }

  liveObservations(scope) { return this.project(scope).filter(observation => !observation.deleted); }

  observationById(scope, id) { return this.project(scope).find(observation => observation.id === id) || null; }

  // Provenance closure over the live projection: derived notes resolve to
  // their evidence roots; unavailable or withdrawn dependencies fail loudly.
  // One implementation (absorbed from provenance.cjs sourceClosure) so every
  // consumer resolves speaker/holder and lineage from the same authority.
  closure(scope, ids) {
    const byId = new Map(this.liveObservations(scope).map(observation => [observation.id, observation]));
    const result = new Map(), visiting = new Set();
    const visit = id => {
      if (visiting.has(id)) throw new Error('Cyclic source provenance');
      if (result.has(id)) return;
      const observation = byId.get(id);
      if (!observation) throw new Error(`Unavailable source dependency: ${id}`);
      visiting.add(id);
      for (const parent of observation.evidenceSourceIds || []) {
        const current = byId.get(parent);
        if (!current || observation.evidenceRevisions && observation.evidenceRevisions[parent] !== current.revision) throw new Error('Stale source dependency');
        visit(parent);
      }
      visiting.delete(id);
      result.set(id, observation);
    };
    (ids || []).forEach(visit);
    return [...result.values()];
  }

  // Bring the log up to date with a freshly derived legacy source set. This is
  // the single reconciliation point: every store mutation funnels through
  // _rawMemorySources, so the log cannot drift from the ingest stores.
  // Ordering is deterministic (at, then id), which makes baseline backfill
  // reproducible across copies of the same database.
  reconcile(scope, derived, { isRecalled = () => false, exclusionReasons = new Map(), knownTombstones = [] } = {}) {
    const key = this.scopeKey(scope);
    const projected = new Map(this.project(scope).map(observation => [observation.id, observation]));
    let appended = 0;
    const ordered = [...derived].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.id).localeCompare(String(b.id)));
    const firstBackfill = !projected.size && ordered.length;
    for (const source of ordered) {
      const current = projected.get(source.id);
      const digest = digestOf(splitSource(source).descriptor, splitSource(source).text);
      if (!current || current.deleted) { this.observed(scope, source); appended++; continue; }
      if (current.bodyDigest !== digest) { this.revised(scope, source); appended++; }
    }
    for (const [observationId, current] of projected) {
      if (current.deleted) continue;
      if (derived.some(source => source.id === observationId)) continue;
      if (isRecalled(observationId)) { this.recalled(scope, { observationId }); appended++; }
      else { this.excluded(scope, { observationId, reason: exclusionReasons.get(observationId) || 'source_removed' }); appended++; }
    }
    // Lifecycle that predates the log (a recall or user exclusion that happened
    // under the legacy store) is still knowable from the ingest tables: record
    // it as a tombstone without inventing an observed body for it.
    for (const tombstone of knownTombstones) {
      if (projected.has(tombstone.observationId)) continue;
      if (tombstone.kind === 'recalled') this.recalled(scope, { observationId: tombstone.observationId, ...(tombstone.recalledAt ? { recalledAt: tombstone.recalledAt } : {}) });
      else this.excluded(scope, { observationId: tombstone.observationId, reason: tombstone.reason || 'user_excluded' });
      appended++;
    }
    if (firstBackfill && appended) {
      this.db.prepare('INSERT OR IGNORE INTO observation_migrations VALUES(?,?,?)').run(key, OBSERVATION_LOG_VERSION,
        JSON.stringify({ version: OBSERVATION_LOG_VERSION, observations: ordered.length, at: new Date().toISOString() }));
    }
    return { appended, backfilled: !!firstBackfill };
  }

  migrationReceipt(scope) {
    const row = this.db.prepare('SELECT record FROM observation_migrations WHERE scope_key=?').get(this.scopeKey(scope));
    return row ? JSON.parse(row.record) : null;
  }

  // Structural invariants, checkable on any database (tests + migration
  // acceptance). identityStable means no event silently changed a speaker.
  verifyInvariants(scope) {
    const key = this.scopeKey(scope);
    const triggers = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='observation_events'").all().map(row => row.name));
    const appendOnlyEnforced = triggers.has('observation_events_append_only_update') && triggers.has('observation_events_append_only_delete');
    let identityStable = true;
    const identities = new Map();
    for (const event of this.events(scope)) {
      if (!event.identity) continue;
      const previous = identities.get(event.observationId);
      if (previous && previous.speaker !== event.identity.speaker && !event.identityChanged) identityStable = false;
      identities.set(event.observationId, event.identity);
    }
    const rows = this.db.prepare('SELECT count(*) n FROM observation_events WHERE scope_key=?').get(key);
    return { appendOnlyEnforced, identityStable, eventCount: rows.n, version: OBSERVATION_LOG_VERSION };
  }

  // Deterministic batched range reads over live observations: the data-layer
  // primitive for budget bottleneck B9 (design appendix A). A controller can
  // satisfy many continuation ranges in one program round trip instead of
  // spending a model call per lookup.
  readRanges(scope, requests) {
    if (!Array.isArray(requests) || !requests.length || requests.length > 32) throw new Error('Range reads accept 1..32 requests');
    const byId = new Map(this.liveObservations(scope).map(observation => [observation.id, observation]));
    return requests.map(request => {
      if (!plain(request) || Object.keys(request).some(field => !['sourceId', 'start', 'end'].includes(field)) || typeof request.sourceId !== 'string')
        throw new Error('Invalid range request');
      const observation = byId.get(request.sourceId);
      if (!observation) return { sourceId: request.sourceId, available: false, reason: 'unavailable_source' };
      const start = Number.isSafeInteger(request.start) && request.start >= 0 ? request.start : null;
      const end = Number.isSafeInteger(request.end) && request.end > (start ?? -1) ? request.end : null;
      if (start == null || end == null || end > observation.text.length)
        return { sourceId: request.sourceId, available: false, reason: 'range_out_of_bounds', length: observation.text.length };
      return { sourceId: request.sourceId, available: true, revision: observation.revision, start, end, text: observation.text.slice(start, end), totalLength: observation.text.length };
    });
  }
}

// Enumerate every scope present in the persisted tables and backfill its
// observation log from the current ingest stores (design §6.1 Phase A). The
// scope key is a reversible JSON array, so no extra registry is needed.
// Idempotent: reconcile is content-addressed, so calling this on an already
// migrated store appends nothing.
function migrateObservations(store) {
  const keys = new Set([
    ...store.db.prepare('SELECT DISTINCT scope_key AS key FROM memory_sources').all().map(row => row.key),
    ...store.db.prepare('SELECT DISTINCT scope_key AS key FROM companion').all().map(row => row.key),
    ...store.db.prepare('SELECT DISTINCT scope_key AS key FROM observation_events').all().map(row => row.key),
  ]);
  const results = [];
  for (const key of keys) {
    let scope;
    try { scope = { accountUid: JSON.parse(key)[0], accountUin: JSON.parse(key)[1], peerUid: JSON.parse(key)[2], peerUin: JSON.parse(key)[3] }; }
    catch { continue; }
    // Capture the pre-state first: deriving sources reads the companion, whose
    // read path already reconciles the log (idempotently). The reported delta
    // therefore covers the whole migration call, not only the final replay.
    const before = store.observationLog.liveObservations(scope).length;
    const derived = store._deriveSources(scope);
    const recalled = new Set(store.messages(scope).filter(message => message.recalled).map(message => `qq:${message.messageId}`));
    store.observationLog.reconcile(scope, derived, { isRecalled: id => recalled.has(id) });
    const live = store.observationLog.liveObservations(scope).length;
    results.push({ scopeKey: key, appended: live - before, backfilled: before === 0 && live > 0, live });
  }
  return results;
}

module.exports = { ObservationLog, migrateObservations, revisionOf, speakerFingerprint, freezeIdentity, OBSERVATION_LOG_VERSION };
