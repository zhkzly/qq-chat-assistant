'use strict';
// F1 Feedback Binder - candidate-session side (greenfield design section 2.5).
//
// PresentationCandidateSession composes the existing CandidateSession: every
// successful publish() (the moment a candidate becomes visible in the UI)
// mints one presentation per displayed artifact - the whole-response artifact
// and each suggestion leaf - through a PresentationLedger, and returns a
// candidate enriched with:
//   candidate.presentation                  -> {presentationId, artifactRef, ...}
//   candidate.suggestions[i].presentationId -> per-suggestion presentation id
// The UI echoes these ids back with feedback; the store resolves them
// server-side (see feedback-binding-store.cjs). No client-side artifact
// caching is needed anymore.
//
// Enrichment is additive only: suggestion items are copied, so the stored
// companion turn objects are never mutated. All other CandidateSession
// behavior is delegated unchanged, so this wrapper can replace the plain
// session at the controller seam without touching call sites.

const { contentDigest } = require('./presentation-ledger.cjs');

class PresentationCandidateSession {
  constructor({ session, ledger }) {
    if (!session || !ledger) throw new Error('PresentationCandidateSession needs a session and a ledger');
    this.session = session;
    this.ledger = ledger;
  }

  // Delegated surface (controller seams) -----------------------------------
  get candidate() { return this.session.candidate; }
  set candidate(value) { this.session.candidate = value; }
  get reason() { return this.session.reason; }
  set reason(value) { this.session.reason = value; }
  get lastAutomaticFingerprint() { return this.session.lastAutomaticFingerprint; }
  set lastAutomaticFingerprint(value) { this.session.lastAutomaticFingerprint = value; }
  get privateInputSeq() { return this.session.privateInputSeq; }
  get version() { return this.session.version; }
  begin(...args) { return this.session.begin(...args); }
  bindPlan(...args) { return this.session.bindPlan(...args); }
  isCurrent(...args) { return this.session.isCurrent(...args); }
  finish(...args) { return this.session.finish(...args); }
  cancel() { this.session.cancel(); }
  invalidate(reason) { this.session.invalidate(reason); }
  canReuseAutomatic(...args) { return this.session.canReuseAutomatic(...args); }
  current(...args) { return this.session.current(...args); }
  status(...args) { return this.session.status(...args); }

  // Minting ----------------------------------------------------------------
  publish(ticket, options) {
    const candidate = this.session.publish(ticket, options);
    if (!candidate) return null;
    return this._attachPresentations(candidate, options);
  }

  _attachPresentations(candidate, options) {
    const scope = options?.scope || candidate.scope;
    const mintFor = (reference, body) => reference && typeof body === 'string'
      ? this.ledger.mint({ scope, artifactRef: reference, bodyDigest: contentDigest(body), requestId: candidate.requestId, displayedAt: candidate.createdAt })
      : null;
    // The response artifact body is visibleResponseText(reply); the candidate
    // carries it as `analysis`. Suggestion artifact bodies are the suggestion
    // texts. Both digests are re-verified against the stored artifacts at
    // binding time, so a divergence fails loudly rather than mis-binding.
    const presentation = candidate.artifactRef ? mintFor(candidate.artifactRef, candidate.analysis) : null;
    const suggestions = (candidate.suggestions || []).map(item => {
      const minted = item.artifactRef ? mintFor(item.artifactRef, item.text) : null;
      return minted ? { ...item, presentationId: minted.presentationId } : item;
    });
    const enriched = { ...candidate, suggestions, ...(presentation ? { presentation: { ...presentation, artifactRef: { ...presentation.artifactRef } } } : {}) };
    // Keep every reader (current(), status(), the advice getter) on the
    // enriched projection. The stored companion turns stay untouched because
    // suggestion items above are copies.
    this.session.candidate = enriched;
    return enriched;
  }
}

module.exports = { PresentationCandidateSession };
