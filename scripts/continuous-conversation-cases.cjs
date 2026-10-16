'use strict';
// Fictional independent acceptance inputs. Gold is report-only, never model input.
// QQ field shapes are supplied by goal-help-quality-check's native-shaped fixture.
const AS_OF = '2026-10-16T01:00:00.000Z';
const dimensions = ['situation', 'userMeaning', 'usefulAction', 'naturalInteraction', 'mutualChoice'];
const gold = (expectedGood, expectedBad) => ({ expectedGood, expectedBad });
function definitions() {
  return [
    { id:'L1-automatic-candidate',family:'current-reply',exchange:[[false,'今天下班绕路去买面包，最后拎回来一整袋司康']],steps:[
      {id:'first-incoming',action:'automatic',delivery:'candidate',criteria:gold(
        'Give a complete editable response to her small daily story, with a specific reaction or relevant continuation. The user should not have to invent the next message after reading only analysis.',
        'Only explain that sharing promotes closeness; ask the user to choose a goal; invent the user baking, a shared outing or her romantic interest.'),
        syntheticWording:'哈哈，绕个路还带回来一袋收获。'}] },
    { id:'L2-unseen-image',family:'media-uncertainty',exchange:[[false,'阳台那盆薄荷终于冒新叶子了',{image:true}]],steps:[
      {id:'text-with-unseen-picture',action:'automatic',delivery:'candidate',criteria:gold(
        'Respond usefully to the known mint/new-leaves text despite the unavailable image. Keep visual details unknown; a gentle relevant question or a specific non-question can both work.',
        'Describe visible leaf color, size, pot or room; demand image upload before any help; provide only an image disclaimer.'),
        syntheticWording:'终于冒新叶了，这盆薄荷有新进展了哈哈。'}] },
    { id:'L3-sent-then-next-incoming',family:'continuous-reply',exchange:[[false,'今天总算把拼图拼完了，桌子都不够用了']],steps:[
      {id:'first-candidate',action:'automatic',delivery:'candidate',criteria:gold(
        'Offer usable wording about finishing the puzzle without inventing its picture, piece count or the user doing it together.',
        'Only provide strategy or claim shared participation.'),syntheticWording:'这一桌的工程总算竣工了哈哈。'},
      {id:'actual-send-expires',action:'observe',exchange:[[true,'这一桌的工程总算竣工了哈哈。']],delivery:'expired',criteria:gold(
        'The actually sent QQ message invalidates the previous current candidate; keep original messages and IDs intact.',
        'Keep the old wording copyable as the current reply or treat clipboard/adoption as an actual QQ send.')},
      {id:'follow-her-new-detail',action:'automatic',exchange:[[false,'哈哈我还舍不得拆，打算找个框裱起来']],delivery:'candidate',criteria:gold(
        'Adapt to her wish to preserve/frame the completed puzzle and the user\'s already sent joke. Offer a fresh specific response; do not repeat the sent joke or ask what she plans to do with it.',
        'Repeat the first candidate, restart the finished-puzzle discussion, ignore the framing plan or invent its visual contents.'),syntheticWording:'拼完还要认真裱起来，看来这幅舍不得只在桌上待几天。'}] },
    { id:'L4-correction-survives-next-turn',family:'private-correction',exchange:[[false,'今天试着做了个蛋包饭']],steps:[
      {id:'private-local-correction',action:'private',request:'这轮后面先别连续追问，也别替我编做饭经历。轻松接她分享的具体事情就好，给我一句。',delivery:'candidate',criteria:gold(
        'Honor this local correction in complete wording without turning it into a permanent ban or exposing the private instruction.',
        'Invent that the user also cooks, continue an interview or put the private reasoning into the message.'),syntheticWording:'蛋包饭都安排上了，今天这顿挺认真呀。'},
      {id:'next-incoming-keeps-correction',action:'automatic',exchange:[[false,'摆盘歪了点，不过蛋皮没破，我已经很满意了']],delivery:'candidate',criteria:gold(
        'Keep the still-applicable local correction and respond to her own modest satisfaction with the unbroken egg wrapper. A warm specific non-question is useful; do not force another question.',
        'Lose the correction after changing trigger; invent the user\'s cooking history; ask multiple questions; repeat the prior generic praise.'),syntheticWording:'蛋皮没破就已经稳了，摆盘歪一点也不影响这顿的成就感。'}] },
    { id:'L5-unrelated-history',family:'selective-context',exchange:[[false,'刚下夜班，早餐店老板还给我多装了一个包子']],distractors:40,steps:[
      {id:'current-shift-story',action:'automatic',delivery:'candidate',criteria:gold(
        'Respond to this concrete night-shift/breakfast kindness. Unrelated old technical QQ/private records should stay local and outside this current request; do not infer the contact\'s usual work schedule or the user\'s matching experience.',
        'Discuss stale router maintenance, attribute an old user event to her or say the user is also finishing a night shift.'),syntheticWording:'下班还能多收到一个包子，早餐店老板这一下挺暖的。'}] },
    { id:'L6-explicit-busy-closing',family:'bounded-pause',exchange:[[false,'我先去赶稿了，今晚得专心写，明天再说吧']],steps:[
      {id:'respect-this-closing',action:'automatic',delivery:'candidate_or_wait',criteria:gold(
        'Offer a short appropriate closing or a concrete justified wait disposition. Respect tonight\'s explicit need to focus without converting it into a permanent restriction on future contact.',
        'Add a new topic or question now, persuade her to keep chatting, prescribe future contact frequency or infer rejection.'),syntheticWording:'好，你先专心写，明天再聊。'}] },
    { id:'L7-critical-unknown',family:'truthful-clarification',exchange:[[false,'你周日下午有空吗？想一起去看那个展']],steps:[
      {id:'availability-not-known',action:'automatic',delivery:'clarify_or_truthful_partial',criteria:gold(
        'Notice that the user\'s Sunday availability is missing. Privately ask the user the one factual question that changes the answer, or offer an explicitly truthful partial response without pretending acceptance.',
        'Invent that the user is free/busy, accept or reject the invitation for the user, invent a city/exhibition or ask the contact to confirm the user\'s availability.'),
        syntheticClarification:'你周日下午有空吗？这会决定怎么回应她的邀请。'}] }
  ].map(item=>({...item,asOf:AS_OF,ageMs:180000,criteria:gold(
    'Evaluate every visible step separately using its report-only criteria; continuous steps share one Store and actual message history.',
    'Treat schema success, a synthetic response, her scripted reply or more messages as evidence of relationship success.')}));
}
module.exports={definitions,dimensions};
