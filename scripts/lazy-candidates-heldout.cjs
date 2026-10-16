'use strict';
// Newly clarified goal acceptance: independent fictional inputs and report-only gold.
// If implementation is tuned after disclosure, report these as independent
// acceptance cases, not an untouched unseen generalization set.
function definitions(){return [
  {id:'H8-manual-new-opening',family:'proactive-reopening',invocation:'manual',request:null,
    asOf:'2026-10-16T01:00:00.000Z',ageMs:17*3600000,
    exchange:[
      [false,'上周末逛旧书集市，买了本旧植物百科，里面有几页插画特别怪'],
      [true,'怪到像外星植物那种吗'],
      [false,'哈哈有几页真的像，我还没仔细看'],
      [false,'我去开会啦，今天先聊到这'],
      [true,'好，你忙']
    ],criteria:{
      situation:'Seventeen hours after the closed exchange, the user has no new incoming message or fresh personal event and clicks manual help. There is a specific known book/illustration detail that has not been followed up. No private request supplies a new micro-goal.',
      expectedGood:'Offer a concrete renewed opening and complete editable wording from the known unexamined book/odd-illustration detail, or an equally specific supported hook. Treat the earlier meeting/closing as local to that exchange. A modest relevant follow-up question or truthful non-question can work without inventing a personal event. Explain its purpose concretely rather than treating more messages as success.',
      expectedBad:'Only wait because the last actual QQ was outgoing or she was previously busy; repeat the finished goodbye; merely retell the history; require the user to supply a new daily event first; invent having suddenly remembered, having read the book, her present availability or reciprocal interest.'
    }},
  {id:'H9-share-specific-expansion',family:'substantive-continuation',
    asOf:'2026-10-16T01:00:00.000Z',ageMs:60000,
    exchange:[
      [false,'今天组队打副本，队友全跑去捡宝箱，boss都没人管'],
      [true,'哈哈全员寻宝队'],
      [false,'最后还是我把boss遛着跑了一圈']
    ],request:'这句怎么接自然一点？想有内容地聊下去，不要像采访，给我一个具体方向和完整的话。',
    criteria:{
      situation:'She shares a concrete playful game incident and adds her own action after the user already joked about treasure hunters. No source states the user plays this game or has had the same experience.',
      expectedGood:'Respond to the particular division of action between her kiting the boss and teammates seeking chests, or explore a concrete not-yet-known next detail of that scene. Offer a substantive direction plus complete natural wording that can invite her own elaboration. A question is optional; neither generic praise nor an abstract interview is enough.',
      expectedBad:'Repeat only the already sent treasure-hunter joke; ask generic questions about her favorite game, general motivation or what gaming means to her; claim the user has played with similar teammates; invent teammates returning, victory, her feelings or a stable personality trait; provide only relationship strategy without usable wording.'
    }}
];}
module.exports={definitions};
