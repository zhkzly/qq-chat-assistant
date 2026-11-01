'use strict';
// F1 Feedback Binder - experience-store side (greenfield design section 2.5).
//
// FeedbackBindingStore adapts the existing ExperienceStore tables with the
// design's mandatory server-side feedback target resolution:
//   * feedback carries a server-minted presentationId and the store resolves
//     it to the CURRENT artifact version itself, never trusting a client target;
//   * after a regeneration the old presentation resolves to an explicit
//     stale_feedback_target notice carrying the current presentation for
//     re-bind, instead of silently binding the version the user no longer sees;
//   * requestId-only legacy resolution is removed: candidate feedback needs a
//     presentationId, or an explicit artifact reference plus its expected
//     digest, or an inherently server-verified target (actual message/experience);
//   * clientEventId retries stay idempotent: an already-saved feedback is
//     returned unchanged even after its presentation has aged out.
//
// Stale and unknown resolutions are returned as structured notices rather
// than thrown so the UI can offer the re-bind flow; contract violations
// still throw like the base store.

const { ExperienceStore } = require('../experience-store.cjs');
const { PresentationLedger, publicView } = require('./presentation-ledger.cjs');

const artifactRefKey = reference => `${reference.artifactId}@${reference.version}`;

function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

function artifactRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.artifactId !== 'string' || !value.artifactId || value.artifactId.length > 300 ||
    !Number.isSafeInteger(value.version) || value.version < 1) throw new Error('Invalid artifact reference');
  return { artifactId: value.artifactId, version: value.version };
}

class FeedbackBindingStore extends ExperienceStore {
  constructor(store, { scopeKey, ledger } = {}) {
    super(store, { scopeKey });
    this.presentationLedger = ledger || new PresentationLedger({ scopeKey: scope => this.scopeKey(scope) });
  }

  addFeedback(scope, args = {}) {
    // Phase 0 - idempotent replay of an already-saved event, checked before
    // presentation resolution so a retry after regeneration still returns the
    // stored record instead of a stale notice.
    if (args.clientEventId !== undefined) {
      text(args.clientEventId, 'feedback event id', 256);
      const prior = this._all(scope, 'feedback').find(item => item.clientEventId === args.clientEventId);
      if (prior) {
        const sameText = args.text === undefined || prior.text === args.text;
        const sameRequest = !args.requestId || prior.requestId === args.requestId;
        const samePresentation = args.presentationId === undefined || prior.presentationId === args.presentationId;
        let sameTarget = true;
        if (args.targetRef) {
          const resolved = this._target(scope, args.targetRef, args.requestId);
          sameTarget = JSON.stringify(prior.targetRef) === JSON.stringify(resolved);
        }
        if (!(sameText && sameRequest && samePresentation && sameTarget)) throw new Error('Feedback event ID reused with different content or target');
        return prior;
      }
    }
    if (args.presentationId !== undefined) return this._addPresentationFeedback(scope, args);
    if (args.targetRef) return this._addExplicitFeedback(scope, args);
    // requestId-only legacy resolution is removed by design: every candidate
    // target must be resolved from a server-minted identity.
    throw new Error('Feedback needs a server-minted presentationId or an explicit target reference');
  }

  _notice(code, message, extra = {}) {
    return { staleFeedbackTarget: { code, message, ...extra } };
  }

  _addPresentationFeedback(scope, args) {
    if (typeof args.presentationId !== 'string' || !args.presentationId.trim() || args.presentationId.length > 128)
      throw new Error('Invalid feedback presentation id');
    const resolution = this.presentationLedger.resolve(scope, args.presentationId);
    if (resolution.status === 'unknown_presentation')
      return this._notice('unknown_presentation', 'The reviewed suggestion presentation is not known here; open the current suggestion and comment again.', { presentationId: args.presentationId });
    if (resolution.status === 'stale_feedback_target')
      return this._notice('stale_feedback_target', 'The reviewed suggestion has a newer regenerated version; submit again to comment on the current version.',
        { presentationId: args.presentationId, prior: publicView(resolution.presentation), current: publicView(resolution.current) });
    const presentation = resolution.presentation;
    if (args.targetRef) {
      // Server-side resolution is authoritative; a disagreeing client targetRef
      // is a contract violation, not an alternative binding.
      const resolved = this._target(scope, args.targetRef, args.requestId);
      if (resolved.kind !== 'artifact' || artifactRefKey(resolved.artifactRef) !== artifactRefKey(presentation.artifactRef))
        throw new Error('Feedback target conflicts with its presentation');
    }
    const artifact = this.artifact(scope, presentation.artifactRef);
    if (artifact && artifact.bodyDigest !== presentation.bodyDigest)
      return this._notice('stale_feedback_target', 'The reviewed suggestion content changed after display; submit again to comment on the current version.',
        { presentationId: args.presentationId, prior: publicView(presentation), reason: 'artifact_digest_changed' });
    const saved = super.addFeedback(scope, { ...args, targetRef: { kind: 'artifact', artifactRef: presentation.artifactRef }, expectedDigest: presentation.bodyDigest });
    if (!saved || saved.staleFeedbackTarget || !saved.id) return saved;
    // The feedback record itself carries the presentation identity (the
    // design stores feedback as an observation with its presentationId).
    const annotated = { ...saved, presentationId: presentation.presentationId, presentation: publicView(presentation) };
    return this._put(scope, 'feedback', annotated.id, annotated);
  }

  _addExplicitFeedback(scope, args) {
    if (args.targetRef && typeof args.targetRef === 'object' && args.targetRef.kind === 'artifact') {
      // Explicit artifact feedback must pin the version by digest; a bare
      // client-side artifact reference is exactly the soil B8 removes.
      if (typeof args.expectedDigest !== 'string' || !args.expectedDigest) throw new Error('Artifact feedback requires a presentationId or an expected artifact digest');
      const reference = artifactRef(args.targetRef.artifactRef);
      const artifact = this.artifact(scope, reference);
      if (artifact && artifact.bodyDigest !== args.expectedDigest)
        return this._notice('stale_feedback_target', 'The selected suggestion version changed; reopen the current version and comment again.', { artifactRef: reference });
    }
    return super.addFeedback(scope, args);
  }
}

module.exports = { FeedbackBindingStore };
