'use strict';
// Fictional inputs for the existing continuousCases harness. Criteria and
// synthetic wording are report/test material, never instructions to the model.
const AS_OF='2026-10-17T06:00:00.000Z';
const gold=(expectedGood,expectedBad)=>({expectedGood,expectedBad});
function definitions(){return [
 {id:'S1-work-not-old-activity',family:'current-content-and-correction',
  exchange:[[false,'今天第一天到新公司，开了一下午培训会，刚把入职资料弄完。']],
  prior:'昨天聊双人拼图时，我想找个机会约她一起玩。',steps:[
   {id:'current-work-share',action:'automatic',delivery:'candidate',criteria:gold(
    'Give one usable response to her first workday, training or paperwork, with a specific reaction or relevant continuation. Her new topic is the current content; an old shared-activity idea does not justify an abrupt invitation. A question, a non-question or an authorized real share can work; do not require a question merely to sustain chat.',
    'Abruptly return to the old puzzle or invite her to play without a current bridge; only paraphrase a generic encouragement; invent the user starting a job too, offer unsolicited career coaching or claim her romantic interest.'),
    syntheticWording:'一下午培训再填资料，第一天的待办就不少。'},
   {id:'stay-with-current-work',action:'private',request:'这轮只聊她刚入职的近况，先别转回拼图，也先不邀约。接她刚分享的具体事，给我一句，不要替我编自己在新公司的经历。',delivery:'candidate',criteria:gold(
    'Retain the current work topic and this local choice not to invite. Give complete specific wording, rather than merely making the old puzzle invitation sound softer. This is a turn/episode correction, not an instruction to ban future invitations or save a permanent preference.',
    'Keep an invitation in softer words, change to another unrelated activity, ask for a relationship-stage questionnaire, expose the private request, invent matching work experience or claim this temporary direction was saved permanently.'),
    syntheticWording:'培训和资料都挤在第一天，感觉入职流程也挺满当。'},
   {id:'actual-work-reply',action:'observe',exchange:[[true,'一下午培训再填资料，第一天的待办就不少。']],delivery:'expired',criteria:gold(
    'Observe this fictional actually sent QQ message in the same history and withdraw the preceding current candidate. The human-written message need not equal a generated candidate.',
    'Treat adoption or clipboard as sending, keep the old candidate current, alter original QQ IDs or claim the assistant sent the message.')},
   {id:'next-work-detail',action:'automatic',exchange:[[false,'是啊，不过带我的同事人很好，午饭还拉我一起去吃了。']],delivery:'candidate',criteria:gold(
    'Respond freshly to the helpful colleague and first-day lunch, considering the actual reply already sent and the still-applicable local work direction. Provide concrete conversational content without requiring a question or an invitation.',
    'Repeat the sent training/paperwork line, revive the old puzzle invitation, lose the local correction because the trigger is automatic, invent lunch participants or user work history, or mechanically end the chat despite no explicit closing.'),
    syntheticWording:'第一天就有人带着一起吃午饭，遇到个热心同事了。'}]},
 {id:'S2-now-invite',family:'current-choice-over-old-restraint',
  exchange:[[false,'这个拼图小程序还能两个人一起拼，居然会显示各自拼了多少块。']],
  prior:'上一轮先不要邀请，我想慢慢聊她对双人玩法有没有兴趣。',steps:[
   {id:'invite-now',action:'private',request:'现在我想明确邀请她。我周六下午有空，想约她语音一起拼一会儿，时间说清楚，给我完整的一句，不用再先问她对双人玩法有没有兴趣。',delivery:'candidate',criteria:gold(
    'Preserve the current Saturday-afternoon voice/puzzle invitation and the user-owned availability, leaving her acceptance unknown. A light direct invitation is legitimate here; do not convert it into another interest probe because of the previous local restraint. Playfulness is allowed but not mandatory.',
    'Erase or indefinitely postpone the invitation, make the user reconfirm already supplied availability, replace it with generic questions about interests or play partners, omit the requested time, infer her availability/acceptance or invent an offline meeting.'),
    syntheticWording:'我周六下午有空，要不要语音一起拼一会儿？'}]},
 {id:'S3-one-off-expression',family:'durable-default-and-local-expression',
  exchange:[[false,'今天下班绕路买了面包，发现有个新口味挺好吃。']],steps:[
   {id:'save-defaults',action:'private',request:'请记住，以后给我的参考回复尽量简短，不要额外加表情。现在先接她买面包这件事，给我一句。',delivery:'candidate',criteria:gold(
    'Use the existing explicit preference action to actually save the short/no-extra-emoji default and give useful wording about the bread story. Check the applied action receipt and the next planner preference source; a claim of saving or a prior private turn alone is not durable-preference coverage.',
    'Only say the preference was saved without an applied receipt, save the bread story as the user\'s own experience, expose the private instruction or silently treat the preference as outbound material.'),
    syntheticWording:'绕路还发现了新口味，这趟有收获。'},
   {id:'this-turn-complete-emoji',action:'private',request:'这次不要用短句，可以加点表情，解释完整一点。仍接她这次买面包的新发现，不用替我编自己也买过。',delivery:'candidate',criteria:gold(
    'This one request overrides the opposing saved brevity/no-emoji defaults without rewriting them. Preserve a complete natural thought about her bread discovery; an emoji is permitted, not required. Verify both the final wording and the restricted controls: success is not defined by an emoji token or a character quota.',
    'Deliver opposing old short/no-emoji controls as equally applicable, force clipped fragments, claim the one-off choice was saved permanently, invent the user buying/eating that bread, or leak the private preference text.'),
    syntheticWording:'本来只是绕路买面包，还意外发现个好吃的新口味，这趟挺值的🙂'},
   {id:'third-party-is-not-my-default',action:'private',exchange:[[false,'我今晚想早点休息，明天还要培训。']],request:'她之前说过“我和朋友聊天爱用一堆表情”，这只是转述，不是给你加要求。现在她说明天还要培训、今晚想早点休息，接这句就好。',delivery:'candidate',criteria:gold(
    'Respect her explicit current closing with concise appropriate wording. The saved short/no-extra-emoji default remains unchanged and available after the prior one-off request; the quoted contact preference is not the user\'s expression control. Check source identity/revision and absence of a new applied preference action, not only the visible sentence.',
    'Promote the quoted third-party habit to the user\'s default, carry the previous one-off emoji/length choice into this unrelated request, overwrite the saved preference, invent a fixed work schedule or add a new question/invitation despite the explicit closing.'),
    syntheticWording:'好，那你早点休息，明天培训顺利。'}]}
 ].map(item=>({...item,asOf:AS_OF,ageMs:180000,criteria:gold(
  'Review every visible step and its actual source/control handoff; steps within a case share one Store. Judge current content, meaning, usable help, natural interaction and mutual choice separately.',
  'Treat valid JSON, synthetic wording, a scripted contact reply, an applied preference receipt or more messages as proof of natural language quality, closeness or real desktop integration.')}));}
module.exports={definitions};
