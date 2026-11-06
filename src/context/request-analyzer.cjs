'use strict';
// C1 Request Analyzer (greenfield context subsystem, design §3.1 step 1 and
// §3.2): infer one ContextRequest per assist invocation from lexical anchors
// plus goal/topic context, BEFORE any material selection happens. Question
// types are a closed enum shared with the MQA registry so material requirements
// can be derived structurally instead of living in prompt rule text.
//
// Contract highlights (design §4.1 C1):
//   - inference only; never selects materials itself;
//   - deterministic lexical-first classification, optional caller-supplied
//     confirmation hint (a cheap model/JEV confirm can populate it later);
//   - generic_consultation fallback so a request is never "unclassifiable";
//   - no owned state beyond a small cache keyed by the request hash.
const { digest } = require('./shared.cjs');
const { requirementsFor, isIntentClass } = require('./mqa-registry.cjs');

const CONTEXT_REQUEST_VERSION = 'context-request-v1';

// Closed question-type enum, owned by the MQA registry so classification and
// admission policy share one source. Order here = specificity tie-break used
// by the classifier; generic_consultation is the terminal fallback.
// Common product shapes map as: 邀约→invitation_arrangement, 接话→
// generic_consultation with wants.continueThread (reply help), 分享→
// personal_share, 咨询→generic_consultation, 更正→feedback_continue.
const INTENT_CLASSES = require('./mqa-registry.cjs').INTENT_CLASSES;

// Lexical marker table. Lower rank = evaluated as more specific; the first
// matching rank wins and ties inside one rank are resolved by marker count
// then enum order, so classification is a pure function of the input text.
const MARKER_RULES = Object.freeze([
  { rank: 1, intentClass: 'feedback_continue', markers: [
    /上(一?次|一?版|条|个)(的)?(回|答|回复|建议|草稿|说法)?[^。！？\n]{0,16}(不对|不好|错了?|有错|改|重新|不对劲|不准)/u,
    /更正|纠正|说错了|不是这样|搞错了|重新(组织|生成|写|回)/u,
    /按我(刚|才)?(说的|改的|更正的)来/u ] },
  { rank: 2, intentClass: 'repair', markers: [
    /误会|道歉|和解|闹掰|吵架|冷战|说错(话|了)|闹翻|修复|补救|挽回|赔不是/u ] },
  { rank: 3, intentClass: 'invitation_arrangement', markers: [
    /约我|邀请|邀约|相约|赴约|想约|约她/u,
    /要不要[^。！？\n]{0,12}一起|一起[^。！？\n]{0,10}(去|看|吃|逛|玩|参加|试|聚)/u,
    /答应[^。！？\n]{0,8}(约|邀)|接受[^。！？\n]{0,8}邀|婉拒|赴约|改(个)?时间(再)?(约|见)/u,
    /见面|见个面/u ] },
  { rank: 4, intentClass: 'availability_check', markers: [
    /有空|没空|有没有时间|没时间|什么时候[^。！？\n]{0,6}(方便|有空|行)|方便吗|不方便/u,
    /(时间|档期|排期)(上|上怎么样|冲突)?/u ] },
  { rank: 5, intentClass: 'emotional_support', markers: [
    /安慰|心情|难过|低落|崩溃|焦虑|压力|情绪|不开心|开心|累|委屈|担心她|支持她|陪她|哄她/u ] },
  { rank: 6, intentClass: 'boundary_check', markers: [
    /越界|冒犯了吗|会不会太(主动|急|快|热情)|唐突|轻浮|失礼|过分吗|边界|合适吗/u ] },
  { rank: 7, intentClass: 'goal_change', markers: [
    /换(个)?目标|目标[^。！？\n]{0,8}(改|变|换|停)|不再[^。！？\n]{0,8}(追|继续|这个目标)/u,
    /新的方向|改变(目的|方向)|不打算[^。！？\n]{0,10}(追|继续|推进)/u ] },
  { rank: 8, intentClass: 'reconnect', markers: [
    /好久没(聊|联系|说话)|很久没(聊|联系)|重新(联系|开口|聊起来)|破冰/u,
    /开场|第一句话[^。！？\n]{0,8}(怎么说|说什?么)|怎么开聊|怎么开(始)?(聊|口)/u ] },
  { rank: 9, intentClass: 'personal_share', markers: [
    /分享|我的近况|近况|跟她(说|讲)|告诉她|说给她|主动(说|聊|分享)/u,
    /怎么开口(说|讲)|自我介绍/u ] },
  { rank: 10, intentClass: 'experience_recount', markers: [
    /(上次|之前|最近|那段|那次)(的)?经历|经历(怎么讲|怎么说|分享)?/u,
    /复盘|旧事|往事|把这事(讲|说)给她/u ] },
  { rank: 11, intentClass: 'work_handoff', markers: [
    /(工作|项目|任务|活)[^。！？\n]{0,12}(交接|转交|接手|移交|转给别人)/u,
    /(交接|接手|移交)[^。！？\n]{0,10}(工作|项目|任务|活)/u,
    /同事|领导|离职|入职|请假|调岗/u ] },
  { rank: 12, intentClass: 'learning_help', markers: [
    /学习|考试|作业|课程|复习|刷题|论文|做题|题库|背书/u ] }
]);

// Anchor-side markers: when the request text itself stays generic, an anchored
// reply-focus message can still carry the question type (design: "lexical
// anchors + goal/topic context"). Applied only to lift the fallback class.
const ANCHOR_RULES = Object.freeze([
  { intentClass: 'invitation_arrangement', markers: [
    /一起[^。！？\n]{0,10}(去|看|吃|逛|玩|参加)|要不要[^。！？\n]{0,12}一起|约(你|我)[^。！？\n]{0,10}(吗|吧|？|不)/u,
    /你(周|这|下|明|后)[^。！？\n]{0,10}有空|有空[^。！？\n]{0,8}(吗|么|一起)/u ] },
  { intentClass: 'emotional_support', markers: [
    /好累|压力|难过|不开心|心情|emo|崩溃|烦死/u ] },
  { intentClass: 'availability_check', markers: [
    /你[^。！？\n]{0,8}有空(吗|么|不|没)|什么时候[^。！？\n]{0,6}方便/u ] }
]);

const WANT_RULES = Object.freeze({
  continueThread: /怎么(回|接|答)|回什么|怎么接话|接话|怎么继续(聊|说|这个话题)|如何回复|怎么回她|回她/u,
  discovery: /聊什么|话题|没话(题|聊)|找话题|可以聊(些|点)?什么/u,
  methods: /怎么(做|办|处理|推进|选择)|方法|策略|建议|思路|怎么办|怎么推进/u,
  materials: /素材|材料|近况|可以分享|分享什么|说什么(好|呢)|拿出(来)?(说|讲)/u
});

function matchRule(rule, text) {
  const hits = [];
  for (const marker of rule.markers) {
    for(const found of text.matchAll(new RegExp(marker.source,'gu'))){
      // A lexical invitation inside a locally negated instruction is not a
      // positive task signal. Keep the full original for semantic judgment;
      // this conservative classifier controls navigation only.
      const prefix=text.slice(0,found.index),clause=prefix.slice(Math.max(...['。','！','？',';','；','\n','，',','].map(mark=>prefix.lastIndexOf(mark)))+1);
      if(rule.intentClass==='invitation_arrangement'&&/(?:不(?:是|想|要|用|打算|准备|希望|在|等于)|不要|并非|无需|别|不能)[^。！？；;\n，,]*$/u.test(clause))continue;
      hits.push({marker:String(marker),excerpt:found[0]});break;
    }
  }
  return hits;
}

// Deterministic lexical classification. Pure function of the inputs: the first
// rule rank with any match wins; inside a rank, most marker hits wins, then
// enum order. Unknown/empty input degrades to generic_consultation.
function classify(text, anchorText) {
  const body = String(text || '');
  const byRank = new Map();
  for (const rule of MARKER_RULES) {
    const hits = matchRule(rule, body);
    if (!hits.length) continue;
    const current = byRank.get(rule.rank) || [];
    byRank.set(rule.rank, current.concat(hits.map(hit => ({ intentClass: rule.intentClass, ...hit }))));
  }
  const bestRank = Math.min(...[...byRank.keys()]);
  if (Number.isFinite(bestRank)) {
    const grouped = new Map();
    for (const signal of byRank.get(bestRank)) grouped.set(signal.intentClass, (grouped.get(signal.intentClass) || []).concat(signal));
    const ordered = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length || INTENT_CLASSES.indexOf(a[0]) - INTENT_CLASSES.indexOf(b[0]));
    return { intentClass: ordered[0][0], basis: 'lexical', signals: ordered[0][1] };
  }
  // No request-text signal: fall back to anchored reply-focus content before
  // conceding to the generic class.
  for (const rule of ANCHOR_RULES) {
    const hits = matchRule(rule, String(anchorText || ''));
    if (hits.length) return { intentClass: rule.intentClass, basis: 'anchor', signals: hits.map(hit => ({ intentClass: rule.intentClass, ...hit })) };
  }
  return { intentClass: 'generic_consultation', basis: 'fallback', signals: [] };
}

const CACHE_LIMIT = 256;
const cache = new Map();

// Analyze one assist request into a ContextRequest. `input`:
//   text             the current user request body (assistant-window turn)
//   replyFocusTexts  texts of anchored incoming messages (reply focus)
//   images           image anchor descriptors (passed through verbatim)
//   replyFocus       anchored source ids (passed through verbatim)
//   feedbackTargets  [{sourceId,...}] selected feedback targets for this turn
//   goalText/topicObjective  long-range context consulted for wants only
//   hint             optional confirmed intentClass (model/JEV confirm later)
//   asOf             observation time recorded on the request
function analyzeRequest(input = {}) {
  const { text = '', replyFocusTexts = [], images = [], replyFocus = [], feedbackTargets = [],
    goalText = '', topicObjective = '', asOf = null, hint = null } = input;
  const anchorText = (Array.isArray(replyFocusTexts) ? replyFocusTexts : [replyFocusTexts]).filter(Boolean).join('\n');
  const key = digest({ text, anchorText, goalText, topicObjective, hint, feedbackTargets });
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  let classification;
  if (hint && isIntentClass(hint)) classification = { intentClass: hint, basis: 'supplied', signals: [] };
  else classification = classify(text, anchorText);
  const wants = {};
  for (const [name, marker] of Object.entries(WANT_RULES)) wants[name] = marker.test(text);
  const context = [goalText, topicObjective].filter(Boolean).join('\n');
  if (context && !Object.values(wants).some(Boolean) && classification.intentClass === 'generic_consultation' && /怎么|如何|帮我想/.test(text)) wants.methods = true;
  const request = Object.freeze({
    version: CONTEXT_REQUEST_VERSION,
    ...(asOf ? { asOf } : {}),
    intentClass: classification.intentClass,
    classification: { basis: classification.basis, signals: classification.signals.slice(0, 8) },
    anchors: Object.freeze({ replyFocus: Object.freeze([...replyFocus]), images: Object.freeze([...images]) }),
    feedbackTargets: Object.freeze([...feedbackTargets]),
    wants: Object.freeze(wants)
  });
  cache.set(key, request);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return request;
}

// Full ContextRequest including MQA-derived evidence requirements (design
// §3.1 step 2). The registry stays the authority for admission policy; this
// only freezes the requirement list onto the request for the compiler.
function contextRequest(input = {}) {
  const request = analyzeRequest(input);
  const requirements = requirementsFor(request.intentClass);
  return Object.freeze({
    ...request,
    requiredEvidenceClasses: Object.freeze(requirements.mandatory.map(row => row.materialClass)),
    negativeEvidenceClasses: Object.freeze(requirements.negative.map(row => row.materialClass))
  });
}

function clearRequestCache() { cache.clear(); }

module.exports = { CONTEXT_REQUEST_VERSION, INTENT_CLASSES, analyzeRequest, contextRequest, clearRequestCache };
