'use strict';
// Single source of truth for the account-owner/contact identity vocabulary
// and the speech-attribution write gate (target architecture M3: identity by
// entailment, not assertion). Every model-facing projection (help wire,
// memory wire, fidelity check), the speech-attribution validators and the
// per-fragment holder rendering consume these definitions so speaker identity
// survives the whole ingestion -> memory -> context chain.
//
// Identity mapping (fixed, never inferred from wording):
//   account owner  == QQ speaker 我 == sources role user == claim subject self
//   selected peer  == QQ speaker 对方 == sources role contact == subject contact
//   type private/feedback role user sources are the account owner talking to
//   the assistant in the assistant window: first person means the owner, they
//   are never contact speech and never actually sent QQ messages.
//   Notes are user records: their body may quote anyone, so a note never
//   proves speech by itself; only its evidence lineage can attribute content.
const SPEAKER_IDENTITY_MARKER='speaker-identity-v1';
const SPEAKER_IDENTITY_RULE=`[speaker-identity-v1 身份词汇，全链路统一，不可从措辞猜测]你服务的用户=账号本人=QQ里的"我"：type:"qq" 的 direction:"outgoing"/role:"user"/speaker:"我"。所选QQ联系人=对方：type:"qq" 的 direction:"incoming"/role:"contact"/speaker:"对方"。type:"private" 或 "feedback" 且 role:"user" 的来源是用户本人在助手窗口对你说的话或反馈：其中第一人称（我/我的）一律指用户本人，绝不是对方发言，也不是已发送的QQ消息；记忆里它们的 author/subject 用 "self"。type:"note" 是用户记录的笔记，正文可能转述任何人，先按 evidenceSourceIds 溯源再定归属。relationshipContext.claims/understanding 的 subject："self"=用户本人，"contact"=所选联系人，"dyad"=双方共同。每条派生记录带 speakerBasis（程序从其证据闭包机械推导，非模型断言）：speakers 列出证据说话人（account_owner/contact/undetermined），holderLabel 说明该记录按证据只能如何呈现，例如 user_report_not_her_words 表示证据里没有对方原话，只能作为用户转述，不得渲染成她说的；her_words_evidence 才有对方原话支撑。缺方向或来源不明的QQ消息 speaker 记 undetermined，不得默认成任何一方；归属不明保留 unknown，禁止用猜测补齐。`;

// The authoritative speaker of one observation, derived mechanically from
// the canonical projection fields. Never falls back to a default speaker.
function observationSpeaker(source) {
  if (!source || source.deleted) return 'undetermined';
  if (source.type === 'qq') {
    if (source.direction === 'incoming' || source.role === 'contact') return 'contact';
    if (source.direction === 'outgoing' || source.role === 'user') return 'account_owner';
    return 'undetermined';
  }
  if ((source.type === 'private' || source.type === 'feedback') && source.role === 'user') return 'account_owner';
  return 'undetermined';
}
// A source whose body is the account owner speaking: an actually sent
// outgoing QQ message, a private consultation turn, or canonical feedback.
function accountOwnerSpeech(source) { return observationSpeaker(source) === 'account_owner'; }
// A source whose body is the selected contact speaking in actual QQ.
function contactSpeech(source) { return observationSpeaker(source) === 'contact'; }
// A user-authored record that may support a self statement: owner speech, or
// a note the user wrote without derivation lineage (lineage notes trace back
// to their roots instead, via the evidence closure).
function ownerAuthoredRecord(source) {
  return accountOwnerSpeech(source) ||
    (!!source && !source.deleted && source.type === 'note' && !(source.evidenceSourceIds || []).length);
}

// Single speech-attribution write gate (architecture M3: implement once,
// consume everywhere). `closureSources` are the resolved evidence sources of
// the record (after provenance closure). A stated claim about a speaker must
// be proven by that speaker's own words; anything else stays reported.
function assertSpeechAttribution(record, closureSources, field = 'claims') {
  if (!record || record.assertionKind !== 'stated') return;
  if (record.subject === 'contact' && !closureSources.some(contactSpeech))
    throw new Error(`${field}: Contact statements require actual contact messages; use reported for user reports`);
  if (record.subject === 'self' && !closureSources.some(ownerAuthoredRecord))
    throw new Error(`${field}: User statements require the account owner own words (outgoing QQ, private turn, canonical feedback or an authored note); use reported for what others said`);
}
// Speech-act clock gate: a QQ statement time can only back a speech act by
// the party who actually sent that QQ message.
function assertSpeechActClock({ actor, eventKind, isSpeechAct }, statementSource, field = 'events') {
  if (statementSource?.type !== 'qq' || !isSpeechAct(eventKind)) return;
  const expected = actor === 'contact' ? 'incoming' : actor === 'self' ? 'outgoing' : null;
  if (expected && statementSource.direction !== expected)
    throw new Error(`${field}.evidence.time.basis: a QQ speech-act clock must come from the acting party own message; a report about the other party is not their speech act`);
}

// Entailment rendering: derive which speakers the evidence closure actually
// contains. `sourcesById` maps delivered observation ids to sources; note
// lineage is followed so derived notes resolve to their roots. Resolution
// failures stay visible instead of being guessed away.
function evidenceSpeakers(sourcesById, ids) {
  const speakers = new Set(), pending = [...(ids || [])], seen = new Set();
  let resolvable = true;
  while (pending.length) {
    const id = pending.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const source = sourcesById.get?.(id) || sourcesById[id];
    if (!source) { resolvable = false; continue; }
    speakers.add(observationSpeaker(source));
    for (const parent of source.evidenceSourceIds || []) pending.push(parent);
  }
  return { speakers: [...speakers].sort(), contactSpeech: speakers.has('contact'),
    ownerSpeech: speakers.has('account_owner'), fullyResolved: resolvable };
}
// Per-fragment holder basis: the label says how the record MAY be presented.
// A closure without contact speech can never yield a her-words label.
function holderBasis(record, sourcesById) {
  const basis = evidenceSpeakers(sourcesById, record.sourceIds);
  let holderLabel;
  if (record.recordType === 'relationship_event' || record.eventKind !== undefined || record.actor !== undefined) {
    const origin = record.origin;
    if (record.actor === 'contact') holderLabel = basis.contactSpeech || origin === 'qq_observation' ? 'her_action_with_contact_evidence' : 'user_reported_about_contact';
    else if (record.actor === 'self') holderLabel = basis.ownerSpeech || origin === 'qq_observation' ? 'owner_action_with_owner_evidence' : 'user_reported_about_owner';
    else holderLabel = basis.contactSpeech && basis.ownerSpeech ? 'dyad_evidence' : 'mixed_or_unknown_evidence';
  } else if (record.subject === 'contact')
    holderLabel = record.assertionKind === 'stated'
      ? (basis.contactSpeech ? 'her_words_evidence' : 'cannot_present_as_her_words_no_contact_evidence')
      : 'user_report_not_her_words';
  else if (record.subject === 'self')
    holderLabel = record.assertionKind === 'stated'
      ? (basis.ownerSpeech ? 'owner_words_evidence' : 'cannot_present_as_owner_words_no_owner_evidence')
      : 'report_about_owner';
  else holderLabel = basis.contactSpeech && basis.ownerSpeech ? 'dyad_evidence' : 'mixed_or_unknown_evidence';
  return { speakers: basis.speakers, holderLabel, ...(basis.fullyResolved ? {} : { evidenceCoverage: 'partial_closure_unresolved_sources' }) };
}

module.exports = { SPEAKER_IDENTITY_MARKER, SPEAKER_IDENTITY_RULE, observationSpeaker,
  accountOwnerSpeech, contactSpeech, ownerAuthoredRecord, assertSpeechAttribution,
  assertSpeechActClock, evidenceSpeakers, holderBasis };
