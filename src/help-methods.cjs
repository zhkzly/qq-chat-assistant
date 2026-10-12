'use strict';

// These are fallible assistance methods, not inferred facts or relationship stages.
// Research references were checked in the local context-memory research package.
const METHOD_VERSION = 'relationship-methods-2026-10-12.1';
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
    limit: '服务用户的相互了解和双向关心目标；具体方法仍需实际体验检验，不能保证她的选择。' }
};
const definitions = [
  { id: 'clarify', name: '理清这次想表达什么', goalContribution: '帮助用户辨认真实想法，表达更贴近自己。',
    applicability: '用户说不清困惑、想表达的意思，或明确希望先讨论。',
    avoid: '意图已经明确时反复追问；把每次求助变成目的问卷；替用户确定真正动机。',
    requiredContext: ['currentRequest', 'relevantPrivateDiscussion', 'goal'],
    instruction: '先准确接住用户的话，区分事情、感受和此次希望。只在缺失答案确实改变帮助时问一个具体问题；其余直接提供可修正理解。允许还没想清楚。',
    evidence: [sources.listening, sources.userGoal], output: { kinds: ['discussion', 'question'], maxItems: 1 } },
  { id: 'choose_next_step', name: '比较下一步', goalContribution: '在聊天之外也能选择适合当下的关系行动。',
    applicability: '想联系但不知道聊什么、何时继续，或有多个可行方向。',
    avoid: '固定关系阶段、每天联系配额、将沉默当作拒绝或好感、强推任何一种行动。',
    requiredContext: ['currentRequest', 'goal', 'currentState', 'recentActualExchange', 'availableMaterial'],
    instruction: '结合真实近况和对方已表达的内容，给一至三个实质不同的可行选择及各自依据；可包含回应、分享、接续话题、共同活动或暂缓。以用户当下意图选择，不必先提问。',
    evidence: [sources.userGoal, sources.disclosure, sources.familiarity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'respond', name: '理解并回应她的话', goalContribution: '让对方所说的事情得到具体回应，并保留交流的自然延续。',
    applicability: '有实际来信，需要理解、回应分享或接续她提出的话题。',
    avoid: '读心、审讯式连问、模板夸奖、立刻转移到自己或无限延长聊天。',
    requiredContext: ['currentRequest', 'latestCompleteExchange', 'relevantEarlierEvidence', 'applicablePreferences'],
    instruction: '优先理解她明确说了什么及其语境，再回应具体内容。歧义保留多个解释；可自然分享一点自己或跟进相关问题，不强制问句。她明确要忙或结束时尊重原话。需要成稿时遵循独立分享授权。',
    evidence: [sources.responsiveness, sources.positive, sources.ambiguity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'compose', name: '组织参考表达', goalContribution: '帮助把用户愿意表达的真实意思写成自己的话。',
    applicability: '用户明确要草稿、改写，或采用已讨论且明确可分享的内容。',
    avoid: '把私人动机写给她、编造经历/感情/约定、强制给三条稿、将复制当发送。',
    requiredContext: ['authorizedOutboundMaterial', 'actualQQContext', 'applicableExpressionPreferences'],
    instruction: '先解析此次拟表达内容与分享许可，再在受限的草稿上下文中组织通常一条、最多三条可编辑表达。沿用明确授权的旧内容无需重抄；含糊会扩大披露时才询问。不要补造情绪、经历或约定。',
    evidence: [sources.userGoal, sources.ambiguity], output: { kinds: ['draft'], maxItems: 3 } },
  { id: 'review', name: '找回与回顾', goalContribution: '跨天接续真实经历，并发现彼此了解和双向关心的变化。',
    applicability: '问以前说过什么、约定进展，或希望回顾一段时间的互动。',
    avoid: '只找积极证据、关系好感分、把回复率或草稿采纳率当亲近、从空检索断言没发生。',
    requiredContext: ['currentRequest', 'goal', 'timeOrderedEvidence', 'corrections', 'coverage', 'applicableFeedback'],
    instruction: '按问题和时间找原始证据及后续更正，区分实际发送、她的回复、用户体验和关系观察。指出已知、未知和覆盖缺口；关注了解、接续、共同经历及双向关心，兼顾无变化和不顺利，不能归因某条建议。',
    evidence: [sources.memory, sources.familiarity, sources.userGoal], output: { kinds: ['discussion', 'review'], maxItems: 3 } },
  { id: 'shared_activity', name: '考虑一起做点什么', goalContribution: '在双方有兴趣时创造自然的共同经历与后续话题。',
    applicability: '用户想邀约、讨论共同兴趣或寻找文字聊天之外的共同活动。',
    avoid: '把建议视为已邀请、同意视为已发生、恢复已取消安排、把活动当拉近关系的必经阶段。',
    requiredContext: ['currentRequest', 'sharedInterestsEvidence', 'currentPlans', 'constraints', 'coverage'],
    instruction: '根据真实共同兴趣、时间和用户意愿，比较轻量可行活动；允许她拒绝、改期或不回应。分别处理提议、实际邀请、回复、安排和实际发生。缺少兴趣或时间证据时保持开放，不编造共同点。',
    evidence: [sources.userGoal, sources.familiarity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'correction', name: '纠正理解与用法', goalContribution: '避免错误记忆和不合适建议持续影响真实交流。',
    applicability: '用户纠正事实、分享范围、目标、建议风格，或要求记住/更改/忘记。',
    avoid: '把一次改稿泛化成长期偏好；没有真正保存却说已记住；将模糊抱怨当稳定规则。',
    requiredContext: ['currentRequest', 'affectedSource', 'applicableFeedback', 'currentPermissions'],
    instruction: '优先处理明确纠正，定位影响的事实、记录或表达。一次反馈只作用于相应场景，明确长期偏好才持久保存。只有程序确认操作成功才说已保存/更改/删除；有歧义只澄清影响范围的部分。',
    evidence: [sources.memory, sources.userGoal], output: { kinds: ['acknowledgment', 'question', 'discussion'], maxItems: 1 } }
].map(item => ({ ...item, version: METHOD_VERSION }));

const clone = value => structuredClone(value);
function methodFor(id) { const found = definitions.find(item => item.id === id); return found ? clone(found) : null; }
function listMethods() { return clone(definitions); }

function selectMethods({ purpose = 'discussion', text = '', focus = '', hasReply = false, memory = null } = {}) {
  // Arbitrary user text stays in the data channel. No keyword detector assigns
  // a psychological state, sharing permission, or durable preference here.
  void text; void focus; void memory;
  const aliases = { draft: 'compose', draft_prepare: 'compose', recall: 'review', respond: 'respond', reply: 'respond', suggest: 'respond',
    clarify: 'clarify', choose_next_step: 'choose_next_step', shared_activity: 'shared_activity', correction: 'correction', review: 'review', compose: 'compose' };
  const explicit = aliases[purpose];
  const order = hasReply ? ['respond', 'choose_next_step', 'clarify', 'compose', 'review', 'shared_activity', 'correction']
    : ['choose_next_step', 'clarify', 'respond', 'compose', 'review', 'shared_activity', 'correction'];
  const methods = (explicit ? [explicit] : order).map(methodFor);
  return { version: METHOD_VERSION, selection: explicit ? 'explicit' : 'candidates',
    methods, maxApplied: explicit ? 1 : 2,
    instruction: methods.map(method => `${method.id}: ${method.instruction}`).join('\n'),
    selectionRule: '用户此次明确意图优先于旧 focus 和候选顺序；候选不是必走步骤，可选择零至两个方法或直接回答，不必先提问。不要求用户选择方法，不推断固定关系阶段。',
    feedbackRule: '只使用来源有效且适用于当前场景的反馈；单次纠正不自动升级为长期偏好，不自动演化方法。论文提供有限机制参考，不能保证这段关系的结果。' };
}

module.exports = { METHOD_VERSION, methodFor, listMethods, selectMethods };
