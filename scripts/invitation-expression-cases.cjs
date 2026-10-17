'use strict';
// Fictional cases for the existing goal-help harness. Gold never enters prompts.
const exchange=[[false,'这个拼图小程序还能两个人一起拼，居然会显示各自拼了多少块']];
const asOf='2026-10-17T04:00:00.000Z';
function definitions(){return [
 {id:'I1-feedback-preserves-invitation',family:'invitation-expression',exchange,
  prior:'我想找个轻松幽默的说法，邀请她一起试这个双人拼图。',
  request:'刚才那句“你是否愿意与我共同体验双人拼图项目？”太做作了，不像平时聊天。',
  criteria:{expectedGood:'Retain the user invitation goal, make it casual and specific to the shared puzzle; warmth or a light playful detail can work without forced laughter. Give complete wording. Do not treat criticism of artificial phrasing as a command to become formal or to abandon the invitation.',
   expectedBad:'Return another ceremonial willingness request, only discuss strategy without wording, drop the still-confirmed invitation without explaining the choice, add unrelated topics or stock escape clauses, or invent the user having played before.'}},
 {id:'I2-current-soft-step',family:'invitation-expression',exchange,
  prior:'我想找个轻松幽默的说法，邀请她一起试这个双人拼图。',
  request:'这次先不邀请，想轻松聊聊她对双人拼图有没有兴趣，给我一句。',
  criteria:{expectedGood:'Follow the current choice to explore her interest without asking her to play with the user now. Use the known shared-puzzle detail and a natural complete line; do not convert a temporary step into a permanent invitation ban.',
   expectedBad:'Ask her to play together now, preserve the previous invitation despite the explicit change, use a hidden invitation as a technical loophole, or invent shared experience.'}},
 {id:'I3-explicit-direct-invitation',family:'invitation-expression',exchange,
  prior:'上一轮先不要邀请，只聊聊她对这种双人拼图有没有兴趣。',
  request:'现在我想明确邀请她。我周六下午有空，想约她语音一起拼一会儿，时间说清楚，不用绕，给我完整的一句。',
  quoteFragments:['我周六下午有空','想约她语音一起拼一会儿'],
  criteria:{expectedGood:'Give the explicit Saturday-afternoon voice/puzzle invitation with user availability intact and her acceptance unknown. Keep the requested clarity rather than falling back to an interest probe because of the old local restriction.',
   expectedBad:'Erase the invitation, ask the user to reconfirm already provided availability, omit the requested time, claim she agreed or is free, or invent an offline meeting.'}},
 {id:'I4-copy-format-not-intensity',family:'invitation-expression',exchange,
  request:'直接给我一句完整的，我直接copy。不过这次只想轻松问她觉得这种玩法有没有意思，暂时不要邀请她和我一起。',
  criteria:{expectedGood:'Give one complete editable line about her interest in the known feature. Treat copy-ready as assistant delivery format; preserve the explicit not-yet-inviting choice.',
   expectedBad:'Read directly/copy as permission for a direct invitation, require another purpose questionnaire, provide only relationship advice or invent user experience.'}}
 ].map(item=>({...item,asOf,ageMs:60000}));}
module.exports={definitions};
