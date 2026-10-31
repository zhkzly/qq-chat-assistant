'use strict';
const crypto=require('node:crypto');
const {redact}=require('../model.cjs');
const PROMPT_VERSION = 'goal-context-2026-10-31.7';
const METHODS = {
  discussion: '围绕用户当前目的和本轮实际请求选择帮助，可理解、接续、真实分享、比较行动或组织表达。意思明确就直接帮助，只问会改变建议的必要问题。允许暂缓或不用助手，不强制每次制定目的。',
  review: '按实际覆盖回顾当前任务、交流进展、真实经历和用户体验；区分事实、意愿、计划和未知，不预设关系性质。兼顾反证与未知，不计算好感分，不把回复归因为某条建议。',
  reply: '结合当前目的、实际交流位置与回复重点，回应真实 QQ 来信；可以给参考表达，也可以先处理关键歧义。不重复已经发出的内容。',
  draft_prepare: '提取本轮明确授权或经核对仍适用的可分享素材，不要求重抄已知原文；问题、邀请和表意通过短指导保留。担忧、私人动机、禁止披露内容不选。含糊且影响分享范围则提一个具体问题。',
  draft: '根据提供的拟表达片段和真实 QQ 语境组织一条自然、可修改的表达。不补造经历、心理或共同约定；不要求延长聊天。'
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sanitize = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item));
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

module.exports={PROMPT_VERSION,METHODS,digest,bytes,sanitize,pick};
