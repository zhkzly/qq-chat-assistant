'use strict';
// F1 Feedback Binder (greenfield design section 2.5 / component table F1).
//
// A PresentationLedger mints the server-owned identity of one *displayed*
// candidate artifact. The candidate session mints a presentation when a
// candidate becomes visible to the user; the UI returns the presentationId
// with feedback instead of caching an artifact reference client-side.
// Binding decisions (staleness after regeneration) are made here, on the
// server, from mint order - never from client-supplied requestId data.
//
// The ledger is intentionally in-memory by default: presentations follow the
// candidate-session display lifecycle ("per display; immutable once minted").
// A lost ledger resolves old ids to an explicit unknown_presentation notice;
// it never falls back to requestId-only legacy resolution.

const { createHash } = require('node:crypto');

const sha256 = value => createHash('sha256').update(value).digest('hex');
// Byte-for-byte parity with the artifact bodyDigest in experience-store.cjs
// (sha256 of JSON.stringify(body)). Binding cross-checks every presentation
// digest against the stored artifact, so any drift here fails loudly instead
// of binding the wrong version silently.
const contentDigest = body => sha256(JSON.stringify(body));

// Canonical scope identity: the four binding fields, order-stable.
const canonicalScopeKey = scope => JSON.stringify(['accountUid','accountUin','peerUid','peerUin'].map(key => scope?.[key]));

const artifactRefKey = reference => `${reference.artifactId}@${reference.version}`;

function artifactRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.artifactId !== 'string' || !value.artifactId || value.artifactId.length > 300 ||
    !Number.isSafeInteger(value.version) || value.version < 1) throw new Error('Invalid artifact reference');
  return { artifactId: value.artifactId, version: value.version };
}

function isDigest(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }

// presentationId = hash(scope, candidate identity, artifact version, digest,
// display time) - deterministic, so minting the same display twice yields the
// same immutable record.
const presentationIdOf = ({ scopeKey, artifactRef: reference, bodyDigest, requestId, displayedAt }) =>
  sha256(JSON.stringify({ scopeKey, artifactId: reference.artifactId, version: reference.version, bodyDigest, requestId: requestId ?? null, displayedAt }));

function publicView(presentation) {
  return { presentationId: presentation.presentationId, artifactRef: { ...presentation.artifactRef },
    bodyDigest: presentation.bodyDigest, requestId: presentation.requestId, displayedAt: presentation.displayedAt };
}

class PresentationLedger {
  constructor({ scopeKey = canonicalScopeKey } = {}) {
    this.scopeKey = scopeKey;
    this.presentations = new Map();   // presentationId -> record (immutable)
    this.byArtifact = new Map();      // scopeKey + artifactId -> records in mint order
    this.seq = 0;
  }

  // Mint (or idempotently return) the presentation of one displayed artifact.
  mint({ scope, artifactRef: reference, bodyDigest, requestId, displayedAt }) {
    const checked = artifactRef(reference);
    if (!isDigest(bodyDigest)) throw new Error('Invalid presentation artifact digest');
    if (requestId !== undefined && requestId !== null && (typeof requestId !== 'string' || !requestId || requestId.length > 300)) throw new Error('Invalid presentation request id');
    if (displayedAt !== undefined && displayedAt !== null && (typeof displayedAt !== 'string' || !displayedAt)) throw new Error('Invalid presentation display time');
    const scopeKeyValue = this.scopeKey(scope);
    const presentationId = presentationIdOf({ scopeKey: scopeKeyValue, artifactRef: checked, bodyDigest, requestId: requestId ?? null, displayedAt: displayedAt ?? null });
    const existing = this.presentations.get(presentationId);
    if (existing) return existing;   // immutable once minted
    const record = { presentationId, scopeKey: scopeKeyValue, artifactRef: checked, bodyDigest,
      requestId: requestId ?? null, displayedAt: displayedAt ?? null, seq: ++this.seq };
    this.presentations.set(presentationId, record);
    const key = `${scopeKeyValue}\u0000${checked.artifactId}`;
    if (!this.byArtifact.has(key)) this.byArtifact.set(key, []);
    this.byArtifact.get(key).push(record);
    return record;
  }

  // Resolve a feedback presentationId against the current artifact version.
  //  - current:               the presentation is the newest display of its artifact
  //                           (or a newer display of the *same* version+digest exists)
  //  - stale_feedback_target: a regenerated artifact version superseded this display
  //  - unknown_presentation:  never minted here, or minted for a different scope
  resolve(scope, presentationId) {
    if (!isDigest(presentationId)) return { status: 'unknown_presentation', presentationId: typeof presentationId === 'string' ? presentationId : null };
    const record = this.presentations.get(presentationId);
    if (!record) return { status: 'unknown_presentation', presentationId };
    const scopeKeyValue = this.scopeKey(scope);
    if (record.scopeKey !== scopeKeyValue) return { status: 'unknown_presentation', presentationId };
    const series = this.byArtifact.get(`${scopeKeyValue}\u0000${record.artifactRef.artifactId}`) || [];
    const latest = series[series.length - 1];
    if (!latest || latest.presentationId === record.presentationId) return { status: 'current', presentation: record };
    // Re-displaying byte-identical content (same version and digest) does not
    // stale the earlier display: both presentations denote the same artifact.
    if (latest.artifactRef.version === record.artifactRef.version && latest.bodyDigest === record.bodyDigest)
      return { status: 'current', presentation: record };
    return { status: 'stale_feedback_target', presentation: record, current: latest };
  }
}

module.exports = { PresentationLedger, canonicalScopeKey, contentDigest, presentationIdOf, publicView };
