'use strict';
// Handle domains for the assist wire: the sets of identifiers a model result
// may legally reference, extracted once per request from the same payload the
// prompt was rendered from. Validation membership checks, copy-ready error
// rendering and repair guidance all read these domains, so "which handles are
// usable" is program knowledge in exactly one place.
const { methodFor } = require('../help-methods.cjs');

// Every source-shaped identifier reachable in the delivered payload. Peer
// text only ever occupies data lanes; this walk stays a pure id census and
// never executes or interprets content.
function deliveredSourceHandles(payload) {
  const handles = new Set();
  const collect = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    for (const [key, item] of Object.entries(node)) {
      if (['sourceId', 'id'].includes(key) && typeof item === 'string' && /^(qq|private|note|feedback):/.test(item)) handles.add(item);
      if (key === 'sourceIds' && Array.isArray(item)) for (const id of item) if (typeof id === 'string') handles.add(id);
      if (item && typeof item === 'object') collect(item);
    }
  };
  collect(payload);
  return handles;
}

// Ranged-read candidates: sources whose delivery is partial or digest-backed
// carry an explicit character range a continuation read can target. This is
// the domain the range-read completion resolves against.
function rangedLookupTargets(payload) {
  const candidates = new Map();
  for (const source of payload?.sources || []) {
    if (source.digest?.entries?.length) {
      const covered = source.digest.coveredCharRange;
      candidates.set(source.id, { start: covered?.start ?? 0, end: covered?.end ?? source.digest.originalCharLength ?? Infinity });
    } else if (source.delivery?.status === 'partial')
      candidates.set(source.id, { start: 0, end: source.delivery.originalCharLength ?? Infinity });
  }
  return candidates;
}

function methodCandidates(payload) {
  const allowed = payload?.methodSelection?.candidates;
  const ids = new Set();
  for (const id of Array.isArray(allowed) ? allowed : [])
    if (typeof id === 'string' && methodFor(id)) ids.add(id);
  return ids;
}

// Private discussion turn ids the controller can actually serve: turns named
// by compaction coverage, deferred groups, read coverage, retrieved sets and
// offered candidates. Single definition shared by validation and repair.
function allowedDiscussionTurns(payload) {
  const turns = new Set();
  const add = ids => { for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string') turns.add(id); };
  add(payload?.discussionCompaction?.sourceTurnIds);
  add(payload?.discussionCompaction?.coveredTurnIds);
  add(payload?.discussionCompaction?.lookupTurnIds);
  add(payload?.pendingPrivateReview?.lookupTurnIds);
  add(payload?.deferredDiscussion?.turnIds);
  add(payload?.discussionReadCoverage?.requestedTurnIds);
  for (const item of payload?.privateCandidates || []) if (typeof item?.turnId === 'string') turns.add(item.turnId);
  for (const item of payload?.retrievedDiscussion || []) if (typeof item?.id === 'string') turns.add(item.id);
  return turns;
}

// Build the domain map for one assist request. Each domain is a Set (or Map
// for ranged targets) usable by handleArrayRule membership checks and by
// copy-ready rendering in errors and repair guidance.
function domainsFor(payload) {
  return {
    deliveredSources: deliveredSourceHandles(payload),
    rangedLookupTargets: rangedLookupTargets(payload),
    methodCandidates: methodCandidates(payload),
    discussionTurns: allowedDiscussionTurns(payload)
  };
}

module.exports = { deliveredSourceHandles, rangedLookupTargets, methodCandidates, allowedDiscussionTurns, domainsFor };
