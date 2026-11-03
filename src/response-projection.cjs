'use strict';
// B16 pending-question projection state (deterministic architecture fix).
//
// Blind-review evidence from replay rounds: after the user manually sends
// their own message, the visible channel could still surface an earlier
// automatic-phase clarification re-asking something that send already
// answered (for example the draft correctly states a preference while a
// visible clarification re-asks for that same preference). Prompt-level
// guards reduced but did not eliminate the behavior, so the projection state
// itself owns the rule deterministically:
//
//   1. Recording: when a finalized assistant turn's visible explanation or
//      notice content contains a clarification question directed at the user
//      (heuristic: question mark + second-person pronoun), that question is
//      recorded as pending for the current contact. A typed kind:question
//      turn body is a clarification by construction and is recorded whole.
//   2. Supersede: any observed human send (an outgoing actual QQ message)
//      supersedes ALL pending clarifications for that contact. There is no
//      semantic matching on purpose: the user's own send is the answer
//      channel, so no later turn may keep treating the question as open.
//   3. Projection: when a new assistant turn is finalized, a clarification
//      portion that normalized-matches a SUPERSEDED pending clarification is
//      stripped from the visible explanation/notice content and from
//      non-draft visible bodies, while draft and suggestion content in the
//      same turn is preserved untouched. Outbound draft bodies address the
//      peer, never the user, so they are never treated as clarifications.
//
// Stripping is sentence-granular: a visible sentence that carries a
// superseded question is removed as the clarification portion it is; the
// remaining sentences of the same turn stay readable.
//
// Read-only assistant boundary: this module only shapes what the assistant
// projects about its own visible channel. It never generates, sends,
// forwards, or auto-replies to QQ messages, and it never rewrites the user's
// own words. QQ records and message IDs are not touched here.

const VERSION = 1;
// At most the last 3 pending clarifications per contact, LRU eviction.
const MAX_PENDING_PER_CONTACT = 3;
// Questions the user has already answered (consumed superseded matchers)
// keep stripping assistant re-asks and are never re-recorded as pending;
// LRU-bounded so a genuinely new topic with similar wording eventually
// asks freely again.
const MAX_ANSWERED_PER_CONTACT = 3;
// Defense in depth for long-lived processes: the registry is contact-scoped,
// so the number of tracked contacts is bounded as well (LRU by last contact
// activity). The per-contact bound above always applies first.
const MAX_CONTACTS = 64;
// Normalized questions shorter than this require exact equality; longer
// questions also match when one normalized form contains the other, so a
// re-ask with an extra tail or lead-in still matches.
const MIN_CONTAINMENT_CHARS = 6;
const QUESTION_MARK = /[?？]/;
const SECOND_PERSON = /[你您]/;
const SENTENCE_SPLIT = /(?<=[。！？!?；;\n])/;
const STRIPPED_BODY_PLACEHOLDER = '（这条重复追问已被你刚发送的消息回答，不再重复。）';

function createPendingClarificationRegistry() {
  return { version: VERSION, seq: 0, contacts: new Map() };
}

// Normalized identity of a clarification question: case and width folding,
// pronoun unification (你/您), and removal of every punctuation, symbol and
// whitespace character so question marks and spacing never decide a match.
function normalizeClarificationQuestion(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[你您]/g, '你')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function questionsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const longer = a.length >= b.length ? a : b, shorter = a.length >= b.length ? b : a;
  return shorter.length >= MIN_CONTAINMENT_CHARS && longer.includes(shorter);
}

function splitSentences(text) {
  return String(text || '').split(SENTENCE_SPLIT).map(sentence => sentence.trim()).filter(Boolean);
}

// Detection heuristic for clarification questions directed at the user.
function isClarificationQuestionSentence(sentence) {
  return QUESTION_MARK.test(sentence) && SECOND_PERSON.test(sentence);
}

function clarificationQuestionsIn(text) {
  return splitSentences(text).filter(isClarificationQuestionSentence);
}

function contactRecord(registry, scopeKey) {
  let contact = registry.contacts.get(scopeKey);
  if (!contact) { contact = { entries: [], answered: [], touchedAt: 0 }; registry.contacts.set(scopeKey, contact); }
  contact.touchedAt = Date.now();
  if (registry.contacts.size > MAX_CONTACTS) {
    let oldest = null;
    for (const [key, value] of registry.contacts) {
      if (key !== scopeKey && (!oldest || value.touchedAt < oldest[1].touchedAt)) oldest = [key, value];
    }
    if (oldest) registry.contacts.delete(oldest[0]);
  }
  return contact;
}

function touchEntry(contact, entry) {
  const index = contact.entries.indexOf(entry);
  if (index >= 0) contact.entries.splice(index, 1);
  contact.entries.push(entry);
}

function evictContact(contact) {
  while (contact.entries.length > MAX_PENDING_PER_CONTACT) contact.entries.shift();
}

function questionParts(questions) {
  const list = (Array.isArray(questions) ? questions : [questions])
    .map(item => typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '')
    .map(text => text.trim()).filter(Boolean);
  return [...new Map(list.map(text => [normalizeClarificationQuestion(text), text]).filter(([normalized]) => normalized).map(([normalized, text]) => [normalized, text]))]
    .map(([normalized, text]) => ({ text, normalized }));
}

// Record pending clarification questions for one contact. A question that is
// already pending for the contact stays one entry; recording again only
// refreshes its recency (LRU). Returns the created or refreshed entry.
function recordPendingClarifications(registry, { scopeKey, questions, turnId, requestId, at } = {}) {
  if (!registry || !registry.contacts || !scopeKey) return null;
  const parts = questionParts(questions);
  if (!parts.length) return null;
  const contact = contactRecord(registry, scopeKey);
  // A question the user already answered is never re-recorded as pending:
  // the answer channel closed it, and re-asking it is the echo this module
  // exists to prevent.
  const fresh = parts.filter(part => !answeredMatcher(contact, part.normalized));
  if (!fresh.length) return null;
  for (const entry of contact.entries) {
    if (entry.status !== 'pending') continue;
    const known = entry.questions.map(question => question.normalized);
    if (fresh.some(part => known.some(existing => questionsMatch(existing, part.normalized)))) {
      touchEntry(contact, entry);
      return entry;
    }
  }
  registry.seq++;
  const entry = { id: `pending-${registry.seq}`, status: 'pending', questions: fresh,
    ...(typeof turnId === 'string' ? { turnId } : {}), ...(typeof requestId === 'string' ? { requestId } : {}),
    recordedAt: at || new Date().toISOString() };
  contact.entries.push(entry);
  evictContact(contact);
  return entry;
}

// Any human send supersedes ALL pending clarifications of this contact.
// Deterministic by design; returns the number of superseded entries.
function supersedePendingClarifications(registry, { scopeKey, at } = {}) {
  if (!registry || !registry.contacts || !scopeKey) return 0;
  const contact = registry.contacts.get(scopeKey);
  if (!contact) return 0;
  const when = at || new Date().toISOString();
  let count = 0;
  for (const entry of contact.entries) {
    if (entry.status === 'pending') { entry.status = 'superseded'; entry.supersededAt = when; count++; }
  }
  return count;
}

// Introspection for tests and diagnostics; never mutates the registry.
function pendingClarificationsFor(registry, scopeKey) {
  const contact = registry && registry.contacts && registry.contacts.get(scopeKey);
  return contact ? contact.entries.map(entry => ({ id: entry.id, status: entry.status,
    questions: entry.questions.map(question => question.text), recordedAt: entry.recordedAt, supersededAt: entry.supersededAt })) : [];
}

function supersededMatchers(contact) {
  const matchers = [];
  for (const entry of contact.entries) {
    if (entry.status !== 'superseded') continue;
    for (const question of entry.questions) matchers.push({ entry, question });
  }
  return matchers;
}

// Answered questions strip assistant re-asks exactly like superseded ones;
// they additionally block re-recording (see recordPendingClarifications).
function answeredMatchers(contact) {
  return (contact.answered || []).map(question => ({ entry: null, question }));
}

function touchAnswered(contact, question) {
  const index = contact.answered.indexOf(question);
  if (index >= 0) contact.answered.splice(index, 1);
  contact.answered.push(question);
  while (contact.answered.length > MAX_ANSWERED_PER_CONTACT) contact.answered.shift();
}

function answeredMatcher(contact, normalized) {
  return (contact.answered || []).find(question => question.normalized === normalized) || null;
}

// Removes every visible sentence that normalized-matches one of the
// superseded questions; reports which matchers actually stripped content so
// the caller can consume them.
function stripMatchingQuestions(text, matchers) {
  let projected = String(text || '');
  const stripped = [], matched = new Set();
  for (const matcher of matchers) {
    for (const sentence of clarificationQuestionsIn(projected)) {
      if (questionsMatch(normalizeClarificationQuestion(sentence), matcher.question.normalized)) {
        const before = projected;
        projected = projected.replace(sentence, '');
        if (projected !== before) { stripped.push({ text: sentence, normalized: matcher.question.normalized }); matched.add(matcher); }
      }
    }
  }
  return { text: projected.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), stripped, matched };
}

// A consumed superseded question stops echoing forever; the entry (or the
// matched question inside a multi-question entry) is dropped once used.
function consumeMatchers(contact, matched) {
  for (const matcher of matched) {
    // The answered question keeps stripping later re-asks and never returns
    // to pending; move it to the answered memory instead of dropping it.
    touchAnswered(contact, matcher.question);
    if (!matcher.entry) continue;
    const index = contact.entries.indexOf(matcher.entry);
    if (index < 0) continue;
    matcher.entry.questions = matcher.entry.questions.filter(question => question !== matcher.question);
    if (!matcher.entry.questions.length) contact.entries.splice(index, 1);
  }
}

// Visible-content detection used when recording pending clarifications: a
// typed kind:question body is a clarification by construction; everything
// else needs the question-mark + second-person heuristic inside
// explanation/notice content or a non-draft visible body.
function detectClarificationQuestions({ kind, text, explanation, allowTypedFallback = true } = {}) {
  const kindText = String(kind || '');
  const found = [];
  const collect = source => {
    if (typeof source !== 'string' || !source.trim()) return;
    let sentences = clarificationQuestionsIn(source);
    // The typed-carrier fallback applies only to an unstripped kind:question
    // body; what remains visible after a strip (including the placeholder)
    // must never be recorded as a new pending clarification.
    if (!sentences.length && kindText === 'question' && allowTypedFallback) sentences = [source.trim()];
    for (const sentence of sentences) {
      const normalized = normalizeClarificationQuestion(sentence);
      if (normalized && !found.some(item => questionsMatch(item.normalized, normalized))) found.push({ text: sentence, normalized });
    }
  };
  if (kindText === 'question') collect(text);
  if (explanation) collect(explanation.text);
  if (!kindText.includes('draft')) collect(text);
  return found;
}

// Deterministic projection of one assistant turn's visible content: strips
// clarification portions that a later human send already superseded,
// preserves draft and suggestion content, and reports the clarification
// questions that remain visible so the caller can record them as pending.
// Recording is deliberately left to the caller after the turn is saved, so
// the registry never describes a turn that never became visible. Returns
// { text, discussionExplanation, strippedQuestions, detectedQuestions }.
function projectAssistantTurn(registry, { scopeKey, kind, text, discussionExplanation } = {}) {
  const kindText = String(kind || '');
  const originalText = typeof text === 'string' ? text : '';
  const explanation = discussionExplanation && typeof discussionExplanation.text === 'string'
    ? { kind: discussionExplanation.kind, text: discussionExplanation.text } : null;
  const contact = registry && registry.contacts && registry.contacts.get(scopeKey) || null;
  const matchers = contact ? supersededMatchers(contact).concat(answeredMatchers(contact)) : [];
  // Outbound draft bodies are wording for the peer, never a clarification to
  // the user; every other visible body and the explanation address the user.
  const outboundBody = kindText.includes('draft');
  let projectedText = originalText;
  let projectedExplanation = explanation;
  const stripped = [], matched = new Set();
  if (matchers.length) {
    if (!outboundBody && projectedText) {
      const body = stripMatchingQuestions(projectedText, matchers);
      if (body.stripped.length) { projectedText = body.text; stripped.push(...body.stripped); for (const item of body.matched) matched.add(item); }
    }
    if (projectedExplanation) {
      const notice = stripMatchingQuestions(projectedExplanation.text, matchers);
      if (notice.stripped.length) {
        stripped.push(...notice.stripped);
        for (const item of notice.matched) matched.add(item);
        // An explanation that was entirely the superseded clarification is
        // dropped; a partially stripped explanation keeps its remainder.
        projectedExplanation = notice.text.trim() ? { ...projectedExplanation, text: notice.text } : null;
      }
    }
  }
  if (contact) consumeMatchers(contact, matched);
  // A body that consisted only of the stripped clarification keeps a short
  // transparent placeholder instead of an empty visible body.
  if (stripped.length && !projectedText.trim()) projectedText = STRIPPED_BODY_PLACEHOLDER;
  return {
    text: projectedText,
    discussionExplanation: projectedExplanation ? { kind: projectedExplanation.kind, text: projectedExplanation.text } : undefined,
    strippedQuestions: stripped,
    detectedQuestions: detectClarificationQuestions({ kind: kindText, text: projectedText, explanation: projectedExplanation, allowTypedFallback: !stripped.length }),
  };
}

module.exports = { VERSION, MAX_PENDING_PER_CONTACT, MAX_CONTACTS, STRIPPED_BODY_PLACEHOLDER,
  createPendingClarificationRegistry, normalizeClarificationQuestion, questionsMatch,
  isClarificationQuestionSentence, clarificationQuestionsIn, detectClarificationQuestions,
  recordPendingClarifications, supersedePendingClarifications, pendingClarificationsFor,
  projectAssistantTurn };
