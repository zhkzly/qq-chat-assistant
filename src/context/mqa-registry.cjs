'use strict';
// C2 MQA Registry (greenfield context subsystem, design §3.2): the
// material-type × question-type × authorization-level matrix as versioned
// data instead of prompt rule text. This is the structural fix for bottleneck
// B5: mandatory materials and the consumption-required output field
// (arrangementHandling) become registry rows the compiler and the draft
// validator both read, so a declared arrangement can no longer be shadowed by
// a confirmation question without an explicit stated reason.
const { declarationSentences, timeWindowTokens, normalizedTimeText } = require('./evidence-digest.cjs');

const MQA_VERSION = 'mqa-registry-v1';

// Canonical question-type enum (single source; the request analyzer re-exports
// it so classification and policy can never drift apart).
const INTENT_CLASSES = Object.freeze([
  'invitation_arrangement', 'availability_check', 'personal_share', 'experience_recount',
  'emotional_support', 'repair', 'reconnect', 'work_handoff', 'learning_help',
  'goal_change', 'feedback_continue', 'boundary_check', 'generic_consultation'
]);

// Typed material classes. `extractor` names the deterministic program
// extractor that can pull this material out of candidate sources.
const MATERIAL_CLASSES = Object.freeze({
  declared_arrangement: { extractor: 'declarationSentences', note: 'user-stated availability/willingness tied to a near-time expression' },
  availability_state: { extractor: 'declarationSentences', note: 'stated availability independent of a specific arrangement' },
  preference: { extractor: 'preferenceNotes', note: 'user-owned style/boundary preference records' },
  personal_fact: { extractor: 'memoryClaims', note: 'personal near-history fact usable for sharing when authorized' },
  experience_event: { extractor: 'experienceCases', note: 'lived experience event with actual actions' },
  contact_statement: { extractor: 'incomingMessages', note: 'what the contact actually said in QQ' },
  third_party_report: { extractor: 'memoryClaims', note: 'quoted third-party experience; never the contact\'s own' },
  closed_topic: { extractor: 'retainedTopics', note: 'topics the user closed; must not be resurrected' },
  goal_record: { extractor: 'goalRecords', note: 'current long-term purpose record' },
  feedback_target: { extractor: 'feedbackTargets', note: 'feedback artifact the user is continuing from' },
  boundary_control: { extractor: 'boundaryRecords', note: 'explicit boundary; negative control, never violated' }
});

// Authorization tiers (design §3.2). Rank supports `tierAtLeast` checks; the
// tier bounds outbound use, it never grants admission by itself. `code` +
// `semantic` mirror the trunk retrieval service (RT1) tier vocabulary
// (T0 public_qq ... T4 never_outbound) so retrieval tier filters and MQA
// minTier rows compose at integration without string surgery.
const AUTHORIZATION_TIERS = Object.freeze({
  T0_public_qq: { rank: 0, code: 'T0', semantic: 'public_qq', note: 'actual QQ conversation content' },
  T1_current_permission: { rank: 1, code: 'T1', semantic: 'current_permission', note: 'current complete user statement' },
  T2_declared_shareable: { rank: 2, code: 'T2', semantic: 'declared_shareable', note: 'user pre-declared shareable' },
  T3_private_planning: { rank: 3, code: 'T3', semantic: 'private_planning', note: 'private planning material; never outbound' },
  T4_never_outbound: { rank: 4, code: 'T4', semantic: 'never_outbound', note: 'never leaves local planning' }
});

const POLICY = Object.freeze({ MANDATORY: 'MANDATORY', SELECTED: 'SELECTED', NEGATIVE_MANDATORY: 'NEGATIVE_MANDATORY' });

// Representation floors (ladder tier names shared with the admission
// compiler). The registry floor is a minimum; the compiler may exceed it.
const FLOORS = Object.freeze(['verbatim', 'ranged', 'digest', 'declarations', 'marker']);

// The matrix. `intentClass: 'ANY'` rows apply to every intent unless a more
// specific row exists. Unlisted pairs resolve to the SELECTED/T3/marker
// default in `policyFor` — lookup is total, never undefined.
const ROWS = Object.freeze([
  { intentClass: 'invitation_arrangement', materialClass: 'declared_arrangement', policy: POLICY.MANDATORY, minTier: 'T1_current_permission', floor: 'declarations', note: 'declared arrangements are mandatory evidence for invitation answers' },
  { intentClass: 'invitation_arrangement', materialClass: 'availability_state', policy: POLICY.MANDATORY, minTier: 'T1_current_permission', floor: 'declarations' },
  { intentClass: 'invitation_arrangement', materialClass: 'boundary_control', policy: POLICY.NEGATIVE_MANDATORY, minTier: 'T0_public_qq', floor: 'ranged', note: 'negative control: render, never violate' },
  { intentClass: 'availability_check', materialClass: 'availability_state', policy: POLICY.MANDATORY, minTier: 'T1_current_permission', floor: 'declarations' },
  { intentClass: 'availability_check', materialClass: 'declared_arrangement', policy: POLICY.MANDATORY, minTier: 'T1_current_permission', floor: 'declarations' },
  { intentClass: 'emotional_support', materialClass: 'contact_statement', policy: POLICY.MANDATORY, minTier: 'T0_public_qq', floor: 'ranged', note: 'support must stand on what she actually said' },
  { intentClass: 'repair', materialClass: 'contact_statement', policy: POLICY.MANDATORY, minTier: 'T0_public_qq', floor: 'ranged' },
  { intentClass: 'personal_share', materialClass: 'personal_fact', policy: POLICY.SELECTED, minTier: 'T2_declared_shareable', floor: 'ranged', note: 'per-fragment authorization binding (draft-material protocol)' },
  { intentClass: 'experience_recount', materialClass: 'experience_event', policy: POLICY.SELECTED, minTier: 'T3_private_planning', floor: 'digest' },
  { intentClass: 'feedback_continue', materialClass: 'feedback_target', policy: POLICY.MANDATORY, minTier: 'T1_current_permission', floor: 'ranged' },
  { intentClass: 'goal_change', materialClass: 'goal_record', policy: POLICY.MANDATORY, minTier: 'T1_current_permission', floor: 'digest' },
  { intentClass: 'boundary_check', materialClass: 'boundary_control', policy: POLICY.MANDATORY, minTier: 'T1_current_permission', floor: 'ranged', note: 'positive consultation over the boundary record itself' },
  { intentClass: 'ANY', materialClass: 'closed_topic', policy: POLICY.NEGATIVE_MANDATORY, minTier: 'T0_public_qq', floor: 'marker', note: 'render closed marker; must not resurrect (closed-topic guard)' },
  { intentClass: 'ANY', materialClass: 'third_party_report', policy: POLICY.SELECTED, minTier: 'T3_private_planning', floor: 'digest', note: 'entailment label user_report; quoted experience is not hers' }
].map(row => Object.freeze(row)));

const DEFAULT_ROW = Object.freeze({ intentClass: 'ANY', materialClass: '*', policy: POLICY.SELECTED, minTier: 'T3_private_planning', floor: 'marker', note: 'unlisted pairs are optional private-planning material' });

function isIntentClass(value) { return INTENT_CLASSES.includes(value); }
function isMaterialClass(value) { return Object.prototype.hasOwnProperty.call(MATERIAL_CLASSES, value); }
function tierAtLeast(tier, minimum) { return AUTHORIZATION_TIERS[tier].rank >= AUTHORIZATION_TIERS[minimum].rank; }
// Map an RT1 manifest/filter tier code back to the registry key; null when the
// code is outside the closed five-tier vocabulary.
function tierFromCode(code) {
  const entry = Object.entries(AUTHORIZATION_TIERS).find(([, tier]) => tier.code === code);
  return entry ? entry[0] : null;
}

// Total lookup: specific row beats ANY row beats the default. Never throws
// for unknown pairs — the matrix is closed under (intent × material).
function policyFor(intentClass, materialClass) {
  const specific = ROWS.find(row => row.intentClass === intentClass && row.materialClass === materialClass);
  if (specific) return specific;
  const any = ROWS.find(row => row.intentClass === 'ANY' && row.materialClass === materialClass);
  if (any) return any;
  return DEFAULT_ROW;
}

// Everything the compiler must honor for one question type: mandatory
// materials with their floors, negative controls, optional classes.
function requirementsFor(intentClass) {
  if (!isIntentClass(intentClass)) throw new Error(`Unknown intent class: ${intentClass}`);
  const applicable = ROWS.filter(row => row.intentClass === intentClass || row.intentClass === 'ANY');
  return Object.freeze({
    version: MQA_VERSION,
    intentClass,
    mandatory: Object.freeze(applicable.filter(row => row.policy === POLICY.MANDATORY)),
    negative: Object.freeze(applicable.filter(row => row.policy === POLICY.NEGATIVE_MANDATORY)),
    selected: Object.freeze(applicable.filter(row => row.policy === POLICY.SELECTED))
  });
}

// ---- Consumption-field contracts (B5 enforcement surface) ----

const ARRANGEMENT_DISPOSITIONS = Object.freeze(['used', 'conflict', 'stale', 'missing']);
const ARRANGEMENT_HANDLING_VERSION = 'arrangement-handling-v1';
// A declaration counts as current for this long after its source time; older
// ones are "stale" and no longer force a reason when unused.
const DECLARATION_FRESHNESS_MS = 7 * 24 * 3600 * 1000;

const ARRANGEMENT_HANDLING_FIELD = Object.freeze({
  name: 'arrangementHandling',
  version: ARRANGEMENT_HANDLING_VERSION,
  required: true,
  disposition: ARRANGEMENT_DISPOSITIONS,
  evidenceRefs: 'non-empty array of delivered declaration sourceIds cited by disposition used',
  rule: 'If a current, non-expired declared arrangement was delivered and disposition is not "used", a concrete reason is mandatory; the confirmation question stays available exactly when disposition is conflict, stale or missing.'
});

// intents whose output contract gains consumption-required fields
const CONSUMPTION_FIELDS = Object.freeze({
  invitation_arrangement: Object.freeze([ARRANGEMENT_HANDLING_FIELD]),
  availability_check: Object.freeze([ARRANGEMENT_HANDLING_FIELD])
});

function consumptionContractFor(intentClass) {
  const fields = CONSUMPTION_FIELDS[intentClass] || [];
  return Object.freeze({ version: MQA_VERSION, intentClass, fields });
}

// ---- Declared-arrangement material extraction ----

// The declared_arrangement extractor (design §3.2): declarationSentences from
// evidence-digest becomes a typed material with provenance, a copy-ready
// lookup handle and a currency flag. Pure over the given sources.
function declaredArrangementMaterials(sources, { asOf = null, freshnessMs = DECLARATION_FRESHNESS_MS } = {}) {
  const materials = [];
  for (const source of sources || []) {
    if (!source || typeof source.text !== 'string' || !source.text) continue;
    for (const found of declarationSentences(source.text)) {
      const age = asOf && source.at ? Math.abs(Date.parse(asOf) - Date.parse(source.at)) : null;
      materials.push(Object.freeze({
        materialClass: 'declared_arrangement',
        sourceId: source.id,
        revision: source.revision,
        at: source.at || null,
        sentence: found.sentence,
        start: found.start,
        end: found.end,
        current: age == null ? null : age <= freshnessMs,
        lookup: Object.freeze({ sourceIds: Object.freeze([source.id]), offset: found.start, maxChars: Math.max(1, found.end - found.start) })
      }));
    }
  }
  return materials;
}

// Reconstruct delivered declaration materials from delivered source views:
// the declarations tier rides on digest views (digest.declarations) even when
// the mandatoryMaterials metadata itself was evicted under budget pressure,
// so the response validator can still see what the model actually received.
function deliveredDeclarationMaterials(sources, { asOf = null, freshnessMs = DECLARATION_FRESHNESS_MS } = {}) {
  const materials = [];
  for (const source of sources || []) {
    const declarations = source?.digest?.declarations;
    if (!Array.isArray(declarations)) continue;
    const age = asOf && source.at ? Math.abs(Date.parse(asOf) - Date.parse(source.at)) : null;
    for (const found of declarations) {
      if (!found || typeof found.sentence !== 'string' || !Number.isSafeInteger(found.start) || !Number.isSafeInteger(found.end)) continue;
      materials.push(Object.freeze({
        materialClass: 'declared_arrangement', sourceId: source.id, revision: found.revision || source.revision,
        at: source.at || null, sentence: found.sentence, start: found.start, end: found.end,
        current: age == null ? null : age <= freshnessMs,
        lookup: Object.freeze({ sourceIds: Object.freeze([source.id]), offset: found.start,
          maxChars: Math.max(1, found.end - found.start) })
      }));
    }
  }
  return materials;
}

// Adoption-completeness check (sv-001 blind review Gap-s1): when a response
// claims adoption of a delivered current declaration, the outbound adoption
// must carry the declaration's scheduling constraint. A "yes" that drops the
// declared time window accepted the invitation but is not a usable adoption.
// Pure containment over normalized day/clock tokens; deterministic, no model
// call. Returns null when every token is present.
function arrangementTimeWindowGap(materials, outboundTexts) {
  const joined = normalizedTimeText((outboundTexts || []).filter(text => typeof text === 'string').join('\n'));
  for (const material of materials || []) {
    if (!material || typeof material.sentence !== 'string') continue;
    const missing = timeWindowTokens(material.sentence).filter(token => !joined.includes(token));
    if (missing.length) return { sourceId: material.sourceId, sentence: material.sentence,
      missingTimeWindows: missing, lookup: material.lookup };
  }
  return null;
}

// Draft-validator-side enforcement of the arrangementHandling consumption
// field. `delivered` = declaration materials actually present in the compiled
// context (from declaredArrangementMaterials); `handling` = the model's
// arrangementHandling output. Returns {ok, code?, message?} — deterministic,
// no model call.
function validateArrangementHandling({ intentClass, delivered = [], handling = null, asOf = null, freshnessMs = DECLARATION_FRESHNESS_MS, outboundTexts = null }) {
  const fields = CONSUMPTION_FIELDS[intentClass] || [];
  if (!fields.some(field => field.name === 'arrangementHandling')) return { ok: true, applicable: false };
  if (!handling || typeof handling !== 'object')
    return { ok: false, code: 'arrangement_handling_missing', message: 'arrangementHandling is required for invitation-type answers' };
  if (!ARRANGEMENT_DISPOSITIONS.includes(handling.disposition))
    return { ok: false, code: 'arrangement_handling_disposition_invalid', message: `disposition must be one of ${ARRANGEMENT_DISPOSITIONS.join('|')}`, allowedChoices: { disposition: ARRANGEMENT_DISPOSITIONS } };
  if (!Array.isArray(handling.evidenceRefs) || handling.evidenceRefs.some(ref => typeof ref !== 'string'))
    return { ok: false, code: 'arrangement_handling_evidence_shape', message: 'evidenceRefs must be an array of sourceId strings' };
  const current = delivered.filter(item => item.current !== false);
  if (handling.disposition === 'used') {
    if (!current.length)
      return { ok: false, code: 'arrangement_handling_used_without_evidence', message: 'disposition used requires a delivered current declaration' };
    if (!handling.evidenceRefs.some(ref => current.some(item => item.sourceId === ref)))
      return { ok: false, code: 'arrangement_handling_evidence_missing', message: 'disposition used must cite a delivered declaration sourceId in evidenceRefs' };
  }
  // B5 core: a delivered current declaration that is not used demands a
  // concrete reason. The model may still choose a confirmation question, but
  // only by stating why the declaration cannot be adopted.
  if (current.length && handling.disposition !== 'used' && !(typeof handling.reason === 'string' && handling.reason.trim()))
    return { ok: false, code: 'arrangement_handling_reason_required', message: 'a current declared arrangement was delivered but not used; a concrete reason is mandatory' };
  // Time-window adoption completeness: a used claim must carry the declared
  // scheduling constraint inside the outward candidate text. The repair
  // guidance quotes the copy-ready original sentence and its lookup handle
  // (same copy-ready pattern as the lookup repair guides).
  if (handling.disposition === 'used' && Array.isArray(outboundTexts) && outboundTexts.some(text => typeof text === 'string' && text.trim())) {
    const cited = current.filter(item => handling.evidenceRefs.includes(item.sourceId));
    const gap = arrangementTimeWindowGap(cited.length ? cited : current, outboundTexts);
    if (gap) return { ok: false, code: 'arrangement_time_window_missing',
      message: 'disposition used requires the declared time window inside the adopted outward text',
      missingTimeWindows: gap.missingTimeWindows,
      copyReady: [{ sentence: gap.sentence, lookup: gap.lookup }] };
  }
  return { ok: true };
}

module.exports = {
  MQA_VERSION, INTENT_CLASSES, MATERIAL_CLASSES, AUTHORIZATION_TIERS, POLICY, FLOORS, ROWS, DEFAULT_ROW,
  ARRANGEMENT_DISPOSITIONS, ARRANGEMENT_HANDLING_VERSION, DECLARATION_FRESHNESS_MS,
  isIntentClass, isMaterialClass, tierAtLeast, tierFromCode, policyFor, requirementsFor,
  consumptionContractFor, declaredArrangementMaterials, deliveredDeclarationMaterials,
  arrangementTimeWindowGap, validateArrangementHandling
};
