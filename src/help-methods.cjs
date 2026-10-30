'use strict';

// These are fallible assistance methods, not inferred facts or relationship stages.
// Research references were checked in the local context-memory research package.
const METHOD_VERSION = 'goal-methods-2026-10-30.2';
const sources = {
  listening: { kind: 'human-study', source: 'https://doi.org/10.1177/0146167217747874',
    limit: '倾听与态度清晰度的实验，未检验 AI 恋爱咨询；清楚不等于正确。' },
  disclosure: { kind: 'human-study', source: 'https://doi.org/10.1002/ijop.12957',
    limit: '女性学生在同步 QQ 任务中的相互披露；不证明异性异步关系结果，样本报告存在差异。' },
  responsiveness: { kind: 'human-study', source: 'https://doi.org/10.1037/0022-3514.74.5.1238',
    limit: '日记中的披露、回应感与心理亲近关联；不能证明一句话导致浪漫兴趣。' },
  positive: { kind: 'human-study', source: 'https://doi.org/10.1037/0022-3514.87.2.228',
    limit: '分享好事与回应方式主要为观察证据，含既有伴侣；不应套成夸奖模板。' },
  familiarity: { kind: 'human-study', source: 'https://doi.org/10.1037/a0022885',
    limit: '同性交友、指定次数的实时互动；不提供联系频率、恋爱概率或共同活动的因果保证。' },
  ambiguity: { kind: 'human-study', source: 'https://doi.org/10.1037/0022-3514.89.6.925',
    limit: '受控邮件语气任务，不能概括所有现代 QQ 交流；支持检查歧义，不要求消除幽默。' },
  memory: { kind: 'engineering-reference', source: 'https://arxiv.org/abs/2410.10813',
    limit: '长期记忆问答评测，支持时间、更新、拒答检查，不是关系效果验证。' },
  userGoal: { kind: 'user-requirement', source: 'docs/context-management_CN.md',
    limit: '服务用户当前明确目的；恋爱是适用场景之一，不能擅自替换朋友、工作或学习目的，也不保证对方的选择。' },
  interest: { kind: 'human-study', source: 'https://doi.org/10.1016/j.chb.2018.04.023',
    limit: '脚本在线互动中的兴趣和不确定性实验；性吸引不是长期承诺，不支持忽冷忽热策略。' },
  development: { kind: 'human-study', source: 'https://doi.org/10.1177/08902070221085877',
    limit: '早期关系纵向自述；对这个对象的体验有信息，不能从人格匹配或单次回应预测她的恋爱意愿。' }
};
// One canonical operation per family serves both compact and expanded views.
// Permission, output-shape and shared source rules belong to the phase protocol.
const operations={
 clarify:'用户没想清时，先给一种可修正理解和能做的帮助；只私下核对会改变这句内容的事实，意图明确就接着做，不把求助变成目的问卷。',
 choose_next_step:'想联系时，从她的生活细节、未跟进旧事或用户真实材料选一个具体切口，说明这句增加什么；可回应、了解、分享、活动或表意，末条自己发不等于等待。',
 respond:'先回应她实际强调的细节或意思，选贴切反应、相关后续或获准的真实分享；认可贴着具体事情，不替她打分或擅自叮嘱收尾；有内容的问题照常可问，明确忙或告别按当轮收住。',
 compose:'结合实际QQ与获准事实成稿；guidance仅派生提议，先核对其事实前提。用当前完整人类原话和明确UI理解行动、提问目标及力度，不把请求当作事件证明；保留真实选择，不外发控制原文或未获准私事。',
 review:'按当前目的和时间找回实际来往与更正，区分事实、意愿和计划，指出可接续事项；兼顾反证与未知，不用回复数或好感分代替进展。',
 shared_activity:'想一起做事时，按本轮意思选聊兴趣、轻松试探或具体活动与邀请；明确邀约保留对象与力度，未知安排留选择。提议、发出、接受、发生分开，取消不复活，不编共同喜好。',
 correction:'按反馈改被否定部分，保留用户仍确认的目的、方式与轻松趣味；嫌做作不自动改成直问或取消邀请，助手旧建议不算用户确认。局部改稿不升长期偏好，保存须有回执。',
 express_interest:'用户想表意时，按真实意思表达具体欣赏、想多认识或约会邀请，保留所要的力度和选择空间；历史少不阻止表达，朋友边界或拒绝不解释成隐藏喜欢。'
};
// These are teaching illustrations, never candidate facts or shareable quotes.
// Only the selected expanded cards expose them, and request measurement includes
// their serialized bytes. The compact eight-family catalog carries no examples.
const examples={
 respond:[{authority:'fictional_illustration_not_task_evidence',
   situation:'虚构来信：椅子终于装好，试坐才发现靠背装反了。',
   approach:'回应装好后才发现装反的反差，轻松接住分享；若她在求助，再跟进处理方式。例子展示一种反应，实际交流仍可选择贴切的问题或分享。',
   wording:'都到试坐这一步了，靠背还给你留了一关哈哈。'}],
 choose_next_step:[{authority:'fictional_illustration_not_task_evidence',
   situation:'虚构旧交流：她前天练口琴配乐，中间换气处总断，随后告别。今天用户想联系，没新鲜近况。',
   approach:'用未跟进的具体练习进展重新开口，旧告别留在当时，不假称用户听过或也会口琴。',
   wording:'你前两天练的那段配乐，换气那一下后来接顺了吗？'}]
};
const definitions = [
  { id: 'clarify', name: '理清这次想表达什么', goalContribution: '帮助用户辨认真实想法，表达更贴近自己。',
    applicability: '用户说不清困惑、想表达的意思，或明确希望先讨论。',
    avoid: '意图已经明确时反复追问；把每次求助变成目的问卷；替用户确定真正动机。',
    requiredContext: ['currentRequest', 'relevantPrivateDiscussion', 'goal'],
    evidence: [sources.listening, sources.userGoal], output: { kinds: ['discussion', 'question'], maxItems: 1 } },
  { id: 'choose_next_step', name: '比较下一步', goalContribution: '在聊天之外也能选择适合当下的关系行动。',
    applicability: '想联系但不知道聊什么、何时继续，或有多个可行方向。',
    avoid: '固定关系阶段、每天联系配额、将沉默当作拒绝或好感、强推任何一种行动。',
    requiredContext: ['currentRequest', 'goal', 'currentState', 'recentActualExchange', 'availableMaterial'],
    evidence: [sources.userGoal, sources.disclosure, sources.familiarity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'respond', name: '理解并回应她的话', goalContribution: '让对方所说的事情得到具体回应，并保留交流的自然延续。',
    applicability: '有实际来信，需要理解、回应分享或接续她提出的话题。',
    avoid: '读心、审讯式连问、模板夸奖、立刻转移到自己或无限延长聊天。',
    requiredContext: ['currentRequest', 'latestCompleteExchange', 'relevantEarlierEvidence', 'applicablePreferences'],
    evidence: [sources.responsiveness, sources.positive, sources.ambiguity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'compose', name: '组织参考表达', goalContribution: '帮助把用户愿意表达的真实意思写成自己的话。',
    applicability: '用户明确要草稿、改写，或采用已讨论且明确可分享的内容。',
    avoid: '把私人动机写给她、编造经历/感情/约定、强制给三条稿、将复制当发送。',
    requiredContext: ['authorizedOutboundMaterial', 'actualQQContext', 'applicableExpressionPreferences', 'currentTopicAndLocalCorrection'],
    evidence: [sources.userGoal, sources.ambiguity], output: { kinds: ['draft'], maxItems: 3 } },
  { id: 'review', name: '找回与回顾', goalContribution: '回顾实际进展及当前目的，帮助选择继续、调整、修复或收束；恋爱方向仅在用户确有此目的时适用。',
    applicability: '问以前说过什么、约定进展，或希望回顾一段时间的互动。',
    avoid: '只找积极证据、关系好感分、把回复率或草稿采纳率当亲近、从空检索断言没发生。',
    requiredContext: ['currentRequest', 'goal', 'timeOrderedEvidence', 'corrections', 'coverage', 'applicableFeedback'],
    evidence: [sources.memory, sources.development, sources.userGoal], output: { kinds: ['discussion', 'review'], maxItems: 3 } },
  { id: 'shared_activity', name: '考虑一起做点什么', goalContribution: '在双方有兴趣时创造自然的共同经历与后续话题。',
    applicability: '用户想邀约、讨论共同兴趣或寻找文字聊天之外的共同活动。',
    avoid: '把建议视为已邀请、同意视为已发生、恢复已取消安排、把活动当拉近关系的必经阶段。',
    requiredContext: ['currentRequest', 'sharedInterestsEvidence', 'currentPlans', 'constraints', 'coverage'],
    evidence: [sources.userGoal, sources.familiarity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'correction', name: '纠正理解与用法', goalContribution: '避免错误记忆和不合适建议持续影响真实交流。',
    applicability: '用户纠正事实、分享范围、目标、建议风格，或要求记住/更改/忘记。',
    avoid: '把一次改稿泛化成长期偏好；没有真正保存却说已记住；将模糊抱怨当稳定规则。',
    requiredContext: ['currentRequest', 'affectedSource', 'applicableFeedback', 'currentPermissions'],
    evidence: [sources.memory, sources.userGoal], output: { kinds: ['acknowledgment', 'question', 'discussion'], maxItems: 1 } },
  { id: 'express_interest', name: '表达好感与关系意图', goalContribution: '帮助用户真实表达欣赏、想多认识或约会意图，让双方能选择是否向恋爱发展。',
    applicability: '用户想表达喜欢、明确邀请含义，或希望讨论怎样从友好交流走向恋爱认识。',
    avoid: '用历史少阻止真诚表达；固定升温阶段；编造强烈感情；将朋友定位或明确拒绝解释成隐藏喜欢；自动改写用户目标。',
    requiredContext: ['currentRequest', 'goal', 'actualRelationshipEvidence', 'currentBoundaries', 'authorizedOutboundMaterial'],
    evidence: [sources.interest, sources.development, sources.userGoal], output: { kinds: ['discussion', 'options', 'draft'], maxItems: 3 } }
].map(item => ({ ...item, version: METHOD_VERSION, instruction: operations[item.id],...(examples[item.id]?{examples:examples[item.id]}:{}) }));

const clone = value => structuredClone(value);
function methodFor(id) { const found = definitions.find(item => item.id === id); return found ? clone(found) : null; }
function listMethods() { return clone(definitions); }
function compactOperationalCards() {
  return definitions.map(item => ({ id: item.id, version: item.version, name: item.name, instruction: item.instruction }));
}
function operationsFor(ids) {
  if (!Array.isArray(ids)) throw new TypeError('Assistance method IDs must be an array');
  const cards = compactOperationalCards();
  return [...new Set(ids)].map(id => {
    const card = cards.find(item => item.id === id);
    if (!card) throw new TypeError('Unknown assistance method');
    return `${card.id}: ${card.instruction}`;
  }).join('\n');
}
function runtimeCard(method) {
  const item = typeof method === 'string' ? methodFor(method) : method;
  if (!item) return null;
  return { id: item.id, version: item.version, goalContribution: item.goalContribution, applicability: item.applicability,
    avoid: item.avoid, requiredContext: [...item.requiredContext], instruction: item.instruction,
    ...(item.examples?{examples:clone(item.examples)}:{}),
    outputKinds: [...item.output.kinds], evidenceLimit: item.evidence.filter(source => source.kind === 'human-study').map(source => source.limit).join(' ') || item.evidence.at(-1).limit };
}

function selectMethods({ purpose='discussion', hasReply=false, methodIds=[] }={}) {
  const aliases={draft:'compose',draft_prepare:'compose',recall:'review',respond:'respond',clarify:'clarify',choose_next_step:'choose_next_step',shared_activity:'shared_activity',correction:'correction',review:'review',compose:'compose',express_interest:'express_interest'};
  const requested=[...new Set(Array.isArray(methodIds)?methodIds:[])].filter(id=>methodFor(id)).slice(0,2);
  const preferred=aliases[purpose]||(['reply','suggest'].includes(purpose)?'respond':null);
  const full=purpose==='draft'?['compose']:requested.length?requested:preferred?[preferred]:[];
  const methods=full.map(methodFor);
  const ids=purpose==='draft'?['compose']:[...(preferred?[preferred]:[]),...definitions.map(item=>item.id).filter(id=>id!==preferred)];
  // Directory metadata supports selection; full instructions are delivered once
  // in methodCards. Requesting a card does not classify the other person's mind.
  const catalog=ids.map(id=>{const method=methodFor(id);return {id,version:method.version,name:method.name,applicability:method.applicability};});
  return {version:METHOD_VERSION,selection:requested.length?'requested_cards':aliases[purpose]?'explicit':['reply','suggest'].includes(purpose)?'transport_hint':'candidates',methods,catalog,maxApplied:purpose==='draft'?1:2,
    instruction:'',operationalInstructionsLocation:'methodCards',
    selectionRule:'以当前用户目的和本次意思选择零至两个方法；目录不是必走步骤，也不表示对方的心理。完整卡按需用lookup.methodIds读取，已有足够依据可以直接帮助，不必多查或先提问。',
    feedbackRule:'局部反馈只用于对应情境，稳定偏好须有用户明确依据。方法及论文只是有适用范围的参考，不保证交流或关系结果。'};
}

module.exports = { METHOD_VERSION, methodFor, listMethods, selectMethods, compactOperationalCards, operationsFor, runtimeCard };
