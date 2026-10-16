'use strict';
const crypto=require('node:crypto');
const {redact}=require('../model.cjs');
const PROMPT_VERSION = 'relationship-context-2026-10-16.4';
const METHODS = {
  discussion: '围绕用户真正希望的恋爱发展选择当前帮助，可接续、邀请、表达好感或讨论。意思明确就直接帮助，只问会改变建议的必要问题。允许暂缓或不用助手，不强制每次制定目的。',
  review: '按实际覆盖回顾相处、共同经历、用户体验与双方明确的浪漫方向，分别说普通友好、活动意愿和恋爱意图。兼顾反证与未知，不计算好感分，不把回复归因为某条建议。',
  reply: '结合当前关系背景与回复重点，回应真实 QQ 来信；可以给参考表达，也可以先处理关键歧义。不重复已经发出的内容。',
  draft_prepare: '只提取用户此次明确想对她表达的原文片段，或用户选中的可分享素材。担忧、私人动机、禁止披露内容不选。含糊且影响分享范围则提一个具体问题。',
  draft: '根据提供的拟表达片段和真实 QQ 语境组织一条自然、可修改的表达。不补造经历、心理或共同约定；不要求延长聊天。'
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sanitize = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item));
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

module.exports={PROMPT_VERSION,METHODS,digest,bytes,sanitize,pick};
