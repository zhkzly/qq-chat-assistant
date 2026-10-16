'use strict';

// These are fallible assistance methods, not inferred facts or relationship stages.
// Research references were checked in the local context-memory research package.
const METHOD_VERSION = 'relationship-methods-2026-10-16.1';
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
    limit: '服务双方愿意发展的恋爱目标；了解、友好回复和活动完成不是恋爱成功，不能保证她的选择。' },
  interest: { kind: 'human-study', source: 'https://doi.org/10.1016/j.chb.2018.04.023',
    limit: '脚本在线互动中的兴趣和不确定性实验；性吸引不是长期承诺，不支持忽冷忽热策略。' },
  development: { kind: 'human-study', source: 'https://doi.org/10.1177/08902070221085877',
    limit: '早期关系纵向自述；对这个对象的体验有信息，不能从人格匹配或单次回应预测她的恋爱意愿。' }
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
    instruction: '按当前请求、真实近况与交流时间，分清回应当轮还是重新联系；通常给一个最适合的方向，有实质差别再比较备选及依据。可组合了解、真实分享、邀请、共同活动、表达好感或暂缓；历史少也允许认识邀请。意图明确就直接帮助，不必先提问。',
    evidence: [sources.userGoal, sources.disclosure, sources.familiarity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'respond', name: '理解并回应她的话', goalContribution: '让对方所说的事情得到具体回应，并保留交流的自然延续。',
    applicability: '有实际来信，需要理解、回应分享或接续她提出的话题。',
    avoid: '读心、审讯式连问、模板夸奖、立刻转移到自己或无限延长聊天。',
    requiredContext: ['currentRequest', 'latestCompleteExchange', 'relevantEarlierEvidence', 'applicablePreferences'],
    instruction: '结合前后语境和时间理解她实际在分享、询问或回应什么，再选择有内容的反应、了解或真实自我分享。问题连接这段交流中值得了解的具体事情，不用泛问填空；没有问句也能有交流价值。她明确要忙或结束时尊重当轮原话。需要成稿时遵循独立分享授权。',
    evidence: [sources.responsiveness, sources.positive, sources.ambiguity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'compose', name: '组织参考表达', goalContribution: '帮助把用户愿意表达的真实意思写成自己的话。',
    applicability: '用户明确要草稿、改写，或采用已讨论且明确可分享的内容。',
    avoid: '把私人动机写给她、编造经历/感情/约定、强制给三条稿、将复制当发送。',
    requiredContext: ['authorizedOutboundMaterial', 'actualQQContext', 'applicableExpressionPreferences', 'currentTopicAndLocalCorrection'],
    instruction: '先解析此次拟表达内容与分享许可，将当前小目的、商量后的方式与适用局部纠正短写为来源绑定的guidance，再在受限上下文组织通常一条、最多三条表达。guidance是控制，不是可发送原文，不能带私下理由。明确授权的旧内容无需重抄；新明确意图覆盖旧方式，含糊会扩大披露时才询问。不要补造情绪、经历或约定。',
    evidence: [sources.userGoal, sources.ambiguity], output: { kinds: ['draft'], maxItems: 3 } },
  { id: 'review', name: '找回与回顾', goalContribution: '判断实际相处及浪漫方向的变化，帮助选择继续、表意、修复或收束。',
    applicability: '问以前说过什么、约定进展，或希望回顾一段时间的互动。',
    avoid: '只找积极证据、关系好感分、把回复率或草稿采纳率当亲近、从空检索断言没发生。',
    requiredContext: ['currentRequest', 'goal', 'timeOrderedEvidence', 'corrections', 'coverage', 'applicableFeedback'],
    instruction: '按问题和时间找原始证据及后续更正，区分实际发送、她的回复、用户体验和关系观察。普通友好、愿意共同活动、明确恋爱意图分别判断。给继续、表意、修复或收束的根据，兼顾反证和未知；没回复不自动判拒绝，明确朋友边界不自动改用户目标，不归因某条建议。',
    evidence: [sources.memory, sources.development, sources.userGoal], output: { kinds: ['discussion', 'review'], maxItems: 3 } },
  { id: 'shared_activity', name: '考虑一起做点什么', goalContribution: '在双方有兴趣时创造自然的共同经历与后续话题。',
    applicability: '用户想邀约、讨论共同兴趣或寻找文字聊天之外的共同活动。',
    avoid: '把建议视为已邀请、同意视为已发生、恢复已取消安排、把活动当拉近关系的必经阶段。',
    requiredContext: ['currentRequest', 'sharedInterestsEvidence', 'currentPlans', 'constraints', 'coverage'],
    instruction: '根据真实兴趣、时间和用户意愿，给可执行活动和邀请方向；对她的偏好未知时可开放询问，不编造共同点。用户希望带约会含义时保留该意图。允许拒绝、改期或不回应，分别记录提议、实际邀请、回复、安排和实际发生；活动同意不等于恋爱承诺。',
    evidence: [sources.userGoal, sources.familiarity], output: { kinds: ['discussion', 'options'], maxItems: 3 } },
  { id: 'correction', name: '纠正理解与用法', goalContribution: '避免错误记忆和不合适建议持续影响真实交流。',
    applicability: '用户纠正事实、分享范围、目标、建议风格，或要求记住/更改/忘记。',
    avoid: '把一次改稿泛化成长期偏好；没有真正保存却说已记住；将模糊抱怨当稳定规则。',
    requiredContext: ['currentRequest', 'affectedSource', 'applicableFeedback', 'currentPermissions'],
    instruction: '优先处理明确纠正，定位影响的事实、记录或表达。一次反馈只作用于相应场景，明确长期偏好才持久保存。只有程序确认操作成功才说已保存/更改/删除；有歧义只澄清影响范围的部分。',
    evidence: [sources.memory, sources.userGoal], output: { kinds: ['acknowledgment', 'question', 'discussion'], maxItems: 1 } },
  { id: 'express_interest', name: '表达好感与关系意图', goalContribution: '帮助用户真实表达欣赏、想多认识或约会意图，让双方能选择是否向恋爱发展。',
    applicability: '用户想表达喜欢、明确邀请含义，或希望讨论怎样从友好交流走向恋爱认识。',
    avoid: '用历史少阻止真诚表达；固定升温阶段；编造强烈感情；将朋友定位或明确拒绝解释成隐藏喜欢；自动改写用户目标。',
    requiredContext: ['currentRequest', 'goal', 'actualRelationshipEvidence', 'currentBoundaries', 'authorizedOutboundMaterial'],
    instruction: '区分具体欣赏、想多认识、带约会意味的邀请与关系讨论，按用户真实意图选择表达强度。历史少也能帮助说出真实好感，不要求先证明她喜欢用户或填关系阶段；准备接受、暂不确定、朋友定位或拒绝后的自然回应。需要成稿时只用授权意思，不把普通友好当双方恋爱意愿。',
    evidence: [sources.interest, sources.development, sources.userGoal], output: { kinds: ['discussion', 'options', 'draft'], maxItems: 3 } }
].map(item => ({ ...item, version: METHOD_VERSION }));

// Every compact operation includes its use case, mechanism and key boundary.
// These program-owned instructions never interpolate private user input.
const compactInstructions={
 clarify:'用户困惑或想先讨论时，区分事情、感受与此次希望，给可修正理解；只问答案会改变帮助的具体问题，不替用户定动机或反复做目的问卷。',
 choose_next_step:'按当前请求、时间与真实近况，分清接续还是重新联系，给一个适合的方向，必要时比较不同备选：了解、真实分享、活动、表意或暂缓；末条自己发言不等于必须等待。',
 respond:'按前后语境和时间理解她在分享、询问或回应什么，再选择具体反应、了解或真实自我分享；没有问句也有交流价值，问题紧贴可聊内容，忙或告别尊重当轮原话。',
 compose:'用户要具体表达时，选此次获准原文并保留小目的、方式与局部纠正，再写完整可编辑句子；私下理由不外发，不编经历，指代明确不让用户重抄。',
 review:'用户回顾时，按时间核对原话、修正、实际发送和体验，区分友好、活动意愿与恋爱意图；兼顾反证未知，再建议继续、表意、修复或收束，不算好感分。',
 shared_activity:'用户想一起做事时，按真实兴趣和条件提出具体活动及可拒绝的邀请，未知偏好可开放确认；提议、已邀请、接受和发生分开，不编共同点或恢复已取消安排。',
 correction:'用户纠正事实、用法或分享范围时，定位准确来源与受影响表达，先改善这次帮助；只有明确长期要求才保存偏好，实际回执成功才说已改，不把抱怨升级规则。',
 express_interest:'用户想表意时，按真实意思帮助表达欣赏、想多认识或约会邀请并准备自然后续；历史少不阻止真诚表达，不要求先证明她喜欢，不把朋友边界或拒绝解释为隐藏兴趣。'
};

const clone = value => structuredClone(value);
function methodFor(id) { const found = definitions.find(item => item.id === id); return found ? clone(found) : null; }
function listMethods() { return clone(definitions); }
function compactOperationalCards() {
  return definitions.map(item => ({ id: item.id, version: item.version, name: item.name, instruction: compactInstructions[item.id] }));
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
    outputKinds: [...item.output.kinds], evidenceLimit: item.evidence.filter(source => source.kind === 'human-study').map(source => source.limit).join(' ') || item.evidence.at(-1).limit };
}

function selectMethods({ purpose = 'discussion', text = '', focus = '', hasReply = false, memory = null } = {}) {
  // Arbitrary user text stays in the data channel. No keyword detector assigns
  // a psychological state, sharing permission, or durable preference here.
  void text; void focus; void memory;
  const transportHint = ['reply','suggest'].includes(purpose) ? 'respond' : null;
  const aliases = { draft: 'compose', draft_prepare: 'compose', recall: 'review', respond: 'respond',
    clarify: 'clarify', choose_next_step: 'choose_next_step', shared_activity: 'shared_activity', correction: 'correction', review: 'review', compose: 'compose', express_interest: 'express_interest' };
  const explicit = aliases[purpose];
  const preferred = explicit || transportHint;
  const order = hasReply ? ['respond', 'choose_next_step', 'express_interest', 'shared_activity', 'clarify', 'compose', 'review', 'correction']
    : ['choose_next_step', 'express_interest', 'shared_activity', 'clarify', 'respond', 'compose', 'review', 'correction'];
  // Transport purposes prioritize help; only the restricted drafting stage
  // limits available methods. A reply can still express interest or invite.
  const ids = purpose === 'draft' ? ['compose'] : preferred ? [preferred, ...order.filter(id => id !== preferred)] : order;
  const fullIds=purpose==='draft'?['compose']:preferred?[preferred,...(preferred==='compose'?['clarify']:preferred==='review'?['correction']:['choose_next_step'])]
    : hasReply?['respond','choose_next_step']:['choose_next_step', 'clarify'];
  const methods = [...new Set(fullIds)].slice(0,purpose==='draft'?1:2).map(methodFor);
  const compactCards=compactOperationalCards();
  const catalog=ids.map(id=>compactCards.find(item=>item.id===id));
  return { version: METHOD_VERSION, selection: explicit ? 'explicit' : transportHint ? 'transport_hint' : 'candidates',
    methods, catalog, maxApplied: purpose === 'draft' ? 1 : 2,
    instruction: methods.map(method => `${method.id}: ${method.instruction}`).join('\n'),
    selectionRule: '用户此次明确意图优先于旧 topic、focus、purpose和候选顺序；模糊续问承接仍有效的商量方向与局部纠正，明确改方向立即替换。候选不是必走步骤，可选择零至两个已载入方法或直接回答，不必先提问。缺方法卡不等于缺用户信息，不要求用户选择方法或固定关系阶段。',
    feedbackRule: '只使用来源有效且适用于当前场景的反馈；单次纠正不自动升级为长期偏好，不自动演化方法。论文提供有限机制参考，不能保证这段关系的结果。' };
}

module.exports = { METHOD_VERSION, methodFor, listMethods, selectMethods, compactOperationalCards, operationsFor, runtimeCard };
