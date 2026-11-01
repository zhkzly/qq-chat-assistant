'use strict';
// M2 storage half (design docs/dsh-subsystem-redesign.md §2.1 Overlay):
// corrections are additive scoped overlays, never record rewrites. The
// corrected record keeps its identity, version and evidence; an overlay
// carries the correction semantics bound to the observation that issued it,
// and read models resolve overlays at view time inside their scope.
//
// Resolution rules (design §5 M2 conflict row):
//   - A correction wins inside its scope.
//   - Evidence currency wins everywhere: an overlay whose own source
//     revisions no longer match the live projection is stale and is rendered
//     as a visible stale correction, not applied.
//   - When both change (the target record was legitimately re-reviewed after
//     the correction), the correction is kept but flagged
//     needs_current_interpretation and the current record text wins.
const { randomUUID } = require('node:crypto');

const OVERLAY_SCHEMA_VERSION = 1;
const OPERATIONS = new Set(['annotate', 'suppress']);
// Narrowest-default scope vocabulary. record-level corrections (a user
// corrects one derived understanding) are the widest a user correction gets
// without an explicit widening attestation; program/model corrections may
// only use the narrow kinds.
const USER_SCOPES = new Set(['record', 'until_evidence']);
const PROGRAM_SCOPES = new Set(['next_exchange', 'topic', 'episode']);
const ORIGINS = new Set(['user_correction', 'model_scoped']);

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function normalizeOverlay(value, { origin = 'user_correction' } = {}) {
  if (!plain(value)) throw new Error('Invalid correction overlay');
  const allowed = ['id', 'targetRecordId', 'targetVersion', 'targetKind', 'operation', 'content', 'issuedAt', 'sourceIds', 'sourceRevisions', 'scope', 'origin', 'status'];
  if (Object.keys(value).some(field => !allowed.includes(field))) throw new Error('Unauthorized correction overlay field');
  if (typeof value.targetRecordId !== 'string' || !value.targetRecordId.trim()) throw new Error('Correction overlay requires a target record id');
  if (!Number.isSafeInteger(value.targetVersion) || value.targetVersion < 1) throw new Error('Correction overlay requires the target record version');
  if (!OPERATIONS.has(value.operation)) throw new Error('Invalid correction overlay operation');
  if (value.operation === 'annotate' && (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 2000)) throw new Error('Correction overlay content must be nonempty text');
  if (value.operation === 'suppress' && value.content !== undefined) throw new Error('A suppression overlay carries no replacement content');
  if (!Array.isArray(value.sourceIds) || !value.sourceIds.length || value.sourceIds.length > 8 || value.sourceIds.some(id => typeof id !== 'string' || !/^(qq|private|note):.+/.test(id))) throw new Error('Correction overlays require 1..8 observation source ids');
  if (!plain(value.sourceRevisions) || Object.keys(value.sourceRevisions).some(id => !value.sourceIds.includes(id) || typeof value.sourceRevisions[id] !== 'string')) throw new Error('Correction overlay evidence revisions must match its sources');
  const scope = value.scope || { kind: 'record' };
  if (!plain(scope) || Object.keys(scope).some(field => !['kind', 'bound'].includes(field))) throw new Error('Invalid correction overlay scope');
  // The origin is carried by the value; the parameter is a caller-side
  // assertion. A model correction can never claim user-level scope kinds.
  const effectiveOrigin = value.origin || origin;
  if (origin !== 'user_correction' && effectiveOrigin !== origin) throw new Error('Correction overlay origin does not match the caller assertion');
  const legalScopes = effectiveOrigin === 'user_correction' ? USER_SCOPES : PROGRAM_SCOPES;
  if (!legalScopes.has(scope.kind)) throw new Error('Correction overlay scope ' + scope.kind + ' is not allowed for origin ' + origin);
  if (scope.bound !== undefined && (typeof scope.bound !== 'string' || !scope.bound.trim() || scope.bound.length > 200)) throw new Error('Invalid correction overlay scope bound');
  if (!ORIGINS.has(effectiveOrigin)) throw new Error('Invalid correction overlay origin');
  if (effectiveOrigin === 'model_scoped' && !PROGRAM_SCOPES.has(scope.kind)) throw new Error('Model corrections are always narrowly scoped');
  if (value.status !== undefined && !['active', 'retired'].includes(value.status)) throw new Error('Invalid correction overlay status');
  return {
    id: value.id || randomUUID(),
    targetRecordId: value.targetRecordId,
    targetVersion: value.targetVersion,
    ...(value.targetKind !== undefined ? { targetKind: value.targetKind } : {}),
    operation: value.operation,
    ...(value.operation === 'annotate' ? { content: value.content } : {}),
    issuedAt: value.issuedAt || new Date().toISOString(),
    sourceIds: [...new Set(value.sourceIds)],
    sourceRevisions: { ...value.sourceRevisions },
    scope: { kind: scope.kind, ...(scope.bound !== undefined ? { bound: scope.bound } : {}) },
    origin: effectiveOrigin,
    status: value.status || 'active',
  };
}

// Overlay validity against the live projection. Evidence currency wins: a
// correction whose sources were withdrawn or revised is stale, never applied.
function overlayValidity(overlay, { revisionOf }) {
  const stale = (overlay.sourceIds || []).some(id => revisionOf(id) !== overlay.sourceRevisions[id]);
  return stale ? 'stale_sources' : 'active';
}

// Resolve overlays onto projected claim rows. `recordsById` supplies the
// stored record (version/updatedAt) so an overtaken correction is
// detectable; the resolver is pure and leaves the stored record untouched.
function applyOverlaysToClaims(claims, overlays, { revisionOf, recordsById = new Map() }) {
  const active = overlays.filter(overlay => overlay.status === 'active');
  const byTarget = new Map();
  for (const overlay of active) {
    if (!byTarget.has(overlay.targetRecordId)) byTarget.set(overlay.targetRecordId, []);
    byTarget.get(overlay.targetRecordId).push(overlay);
  }
  return claims.map(claim => {
    const candidates = byTarget.get(claim.id);
    if (!candidates?.length) return claim;
    // Latest issued correction wins when several target one record.
    const overlay = candidates.sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)))[0];
    const validity = overlayValidity(overlay, { revisionOf });
    const record = recordsById.get(claim.id) || claim;
    const overtaken = Number.isSafeInteger(record.version) && record.version > overlay.targetVersion
      && String(record.updatedAt || '') > String(overlay.issuedAt);
    if (validity === 'stale_sources')
      return { ...claim, staleCorrection: { overlayId: overlay.id, issuedAt: overlay.issuedAt, reason: 'overlay_sources_withdrawn_or_revised' } };
    if (overlay.operation === 'suppress')
      return { ...claim, lifecycle: 'withdrawn', suppressedByOverlay: { overlayId: overlay.id, issuedAt: overlay.issuedAt, sourceIds: [...overlay.sourceIds] } };
    if (overtaken)
      return { ...claim, priorCorrection: { overlayId: overlay.id, text: overlay.content, issuedAt: overlay.issuedAt, status: 'needs_current_interpretation' } };
    return { ...claim, originalText: claim.text, text: overlay.content, correctedByOverlay: { overlayId: overlay.id, issuedAt: overlay.issuedAt, sourceIds: [...overlay.sourceIds] } };
  });
}

module.exports = { OVERLAY_SCHEMA_VERSION, normalizeOverlay, applyOverlaysToClaims, overlayValidity };