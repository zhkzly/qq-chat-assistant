'use strict';
// B16 pending-question projection state: deterministic verification that a
// clarification whose question the user's own send already answered stops
// being re-asked on the visible channel, while draft and suggestion content
// in the same turn is preserved. Synthetic fixtures only; no live model, no
// real chat records, and no QQ messages are sent by these checks.
const test=require('node:test'),assert=require('node:assert/strict');
const projection=require('../src/response-projection.cjs');
const {Controller}=require('./fixtures/whole-answer-fidelity.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const QUESTION='你平时更喜欢桂花还是红枣？';
const REASK='刚才没确认完：你平时更喜欢桂花还是红枣呢？定了我再补完整表达。';
const STRIPPED_REMAINDER='定了我再补完整表达。';
const DRAFT_BODY='那就先按桂花味帮你写一段。';
const SUGGESTION='我下次给你带桂花糕试试呀。';
const HUMAN='帮我组织一下怎么回应她。';

test('the detection heuristic needs a question mark and a second-person pronoun in user-addressed content',()=>{
  assert.equal(projection.isClarificationQuestionSentence(QUESTION),true);
  assert.equal(projection.isClarificationQuestionSentence('我更喜欢桂花味的。'),false);
  assert.equal(projection.isClarificationQuestionSentence('她最近喜欢吃桂花糕吗？'),false,'third-person questions are not clarifications to the user');
  assert.deepEqual(projection.detectClarificationQuestions({kind:'discussion',text:'你平时更喜欢桂花还是红枣？'}),
    [{text:QUESTION,normalized:projection.normalizeClarificationQuestion(QUESTION)}]);
  assert.deepEqual(projection.detectClarificationQuestions({kind:'draft',text:'你喜欢桂花吗？',explanation:{kind:'discussion',text:'她说不定喜欢桂花。'}}),[],
    'outbound draft bodies address the peer and are never assistant clarifications');
  assert.ok(projection.detectClarificationQuestions({kind:'question',text:'方便说说她最近的安排吗？'}).length,
    'a typed kind:question body is a clarification by construction even without 你/您');
});

test('no user send keeps a pending clarification visible; a superseding human send strips the re-ask and preserves the draft',()=>{
  const registry=projection.createPendingClarificationRegistry(),key='contact-a';
  projection.recordPendingClarifications(registry,{scopeKey:key,questions:[QUESTION]});
  const kept=projection.projectAssistantTurn(registry,{scopeKey:key,kind:'draft',text:DRAFT_BODY,
    discussionExplanation:{kind:'discussion',text:REASK}});
  assert.equal(kept.discussionExplanation.text,REASK,'without a user send the visible clarification is untouched');
  assert.equal(kept.strippedQuestions.length,0);

  assert.equal(projection.supersedePendingClarifications(registry,{scopeKey:key}),1,'the human send supersedes the pending question');
  const projected=projection.projectAssistantTurn(registry,{scopeKey:key,kind:'draft',text:DRAFT_BODY,
    discussionExplanation:{kind:'discussion',text:REASK}});
  assert.equal(projected.text,DRAFT_BODY,'the draft body is preserved');
  assert.equal(projected.discussionExplanation.text,STRIPPED_REMAINDER,'only the clarification portion is stripped');
  assert.equal(projected.discussionExplanation.text.includes(QUESTION),false);
  assert.deepEqual(projected.strippedQuestions.map(item=>item.text),['刚才没确认完：你平时更喜欢桂花还是红枣呢？']);
  assert.equal(projected.detectedQuestions.length,0,'a stripped re-ask is never recorded as pending again');
});

test('suggestion content and draft outbound wording survive an explanatory strip',()=>{
  const registry=projection.createPendingClarificationRegistry(),key='contact-a';
  projection.recordPendingClarifications(registry,{scopeKey:key,questions:[QUESTION]});
  projection.supersedePendingClarifications(registry,{scopeKey:key});
  const suggestions=[{style:'自然',text:SUGGESTION},{style:'直接',text:'带桂花糕给你？'}];
  const projected=projection.projectAssistantTurn(registry,{scopeKey:key,kind:'draft',text:DRAFT_BODY,
    discussionExplanation:{kind:'discussion',text:REASK}});
  assert.equal(projected.text,DRAFT_BODY);
  assert.equal(JSON.stringify(suggestions).includes(SUGGESTION),true,'suggestions are never inputs to the projection');
});

test('a question-kind turn that only re-asks the superseded question keeps a transparent placeholder',()=>{
  const registry=projection.createPendingClarificationRegistry(),key='contact-a';
  projection.recordPendingClarifications(registry,{scopeKey:key,questions:[QUESTION]});
  projection.supersedePendingClarifications(registry,{scopeKey:key});
  const projected=projection.projectAssistantTurn(registry,{scopeKey:key,kind:'question',text:QUESTION});
  assert.equal(projected.text,projection.STRIPPED_BODY_PLACEHOLDER);
  assert.equal(projected.strippedQuestions.length,1);
  assert.equal(projected.detectedQuestions.length,0,'the placeholder must not become a new pending clarification');
});

test('normalized matching tolerates width, pronoun and tail variants but not different questions',()=>{
  const registry=projection.createPendingClarificationRegistry(),key='contact-a';
  projection.recordPendingClarifications(registry,{scopeKey:key,questions:['你平时更喜欢桂花还是红枣？']});
  projection.supersedePendingClarifications(registry,{scopeKey:key});
  const variant=projection.projectAssistantTurn(registry,{scopeKey:key,kind:'discussion',
    text:'你平时更喜欢桂花，还是红枣呢？'});
  assert.equal(variant.text,projection.STRIPPED_BODY_PLACEHOLDER,'the reworded re-ask is stripped as the same superseded question');
  const other=projection.projectAssistantTurn(registry,{scopeKey:key,kind:'discussion',
    text:'你更喜欢红枣还是桂花？'});
  assert.equal(other.text,'你更喜欢红枣还是桂花？','a different question is not matched by normalization');
  assert.equal(other.detectedQuestions.length,1,'and it is a new pending clarification of its own');
});

test('the registry keeps at most the last 3 clarifications per contact with LRU eviction',()=>{
  const registry=projection.createPendingClarificationRegistry(),key='contact-a';
  const questions=['你白天方便聊天吗？','你周末一般几点起？','你想让她看到这条吗？','你确定要这样表达吗？','你最近还想聊这个吗？'];
  for(const question of questions)projection.recordPendingClarifications(registry,{scopeKey:key,questions:[question]});
  let entries=projection.pendingClarificationsFor(registry,key);
  assert.equal(entries.length,projection.MAX_PENDING_PER_CONTACT);
  assert.deepEqual(entries.map(entry=>entry.questions[0]),questions.slice(-3),'the oldest clarifications were evicted');
  projection.supersedePendingClarifications(registry,{scopeKey:key});
  entries=projection.pendingClarificationsFor(registry,key);
  assert.ok(entries.length&&entries.every(entry=>entry.status==='superseded'),'a human send supersedes all kept clarifications');
});

test('a different contact is unaffected by another contact\'s superseded clarifications',()=>{
  const registry=projection.createPendingClarificationRegistry();
  projection.recordPendingClarifications(registry,{scopeKey:'contact-a',questions:[QUESTION]});
  projection.supersedePendingClarifications(registry,{scopeKey:'contact-a'});
  const other=projection.projectAssistantTurn(registry,{scopeKey:'contact-b',kind:'draft',text:DRAFT_BODY,
    discussionExplanation:{kind:'discussion',text:REASK}});
  assert.equal(other.discussionExplanation.text,REASK,'contact-b still sees its own visible content unchanged');
  assert.equal(projection.supersedePendingClarifications(registry,{scopeKey:'contact-b'}),0);
});

function setup(scripted){
  const store=new Store(':memory:'),calls=[];
  const controller=new Controller({store,compactionModel:null,
    settings:{anonymous:true,auto:false,baseUrl:'http://fixture.invalid/v1',model:'synthetic-pending-projection',
      assistantRequestLimit:4,discussionCompactionEnabled:false,
      realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-pending-projection'}},
    read:async command=>command==='bind'?scope:{messages:[]},
    assistantModel:async(_settings,context)=>{calls.push(context);
      if(context.payload.purpose==='fidelity_check')return context.payload.candidate.suggestions.length
        ?{checkRef:context.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]}
        :{checkRef:context.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
      return scripted.shift()(context);}});
  controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
  return {store,controller,calls,close(){controller.close();store.close();}};
}
const WHY='需要先确认你更喜欢哪种口味。';
const control=(id,text)=>({text,sourceIds:[id]});
const askClarification=context=>{const id=context.payload.intentAuthority.sourceId;
  return {kind:'question',text:WHY,
    requestDelivery:{mode:'editable_message',sourceId:id,quote:context.payload.sources.find(source=>source.id===id).text.slice(0,1000),
      blocker:{kind:'missing_fact',missing:'你偏好的口味',question:QUESTION,explanation:WHY}}};};
const draftWithReask=()=>context=>{const id=context.payload.intentAuthority.sourceId,current=context.payload.sources.find(source=>source.id===id);
  return {kind:'discussion',text:'先按你的口味整理一下。',answer:{privateExplanation:REASK,suggestions:[{text:SUGGESTION}]},
    requestDelivery:{mode:'editable_message',sourceId:id,quote:current.text.slice(0,1000)},
    draftPlan:{intent:'reply',quotes:[],guidance:{objective:control(id,'回应她的实际问题'),
      allowedApproach:control(id,'仅用已经核对的素材'),avoidances:[]}}}};

test('companion wiring: clarification shown, user sends a message, the next re-asking draft turn loses the clarification and keeps the draft',async()=>{
  const app=setup([askClarification,draftWithReask()]);
  await app.controller.bind(scope.peerUin);
  const first=await app.controller.assist({text:HUMAN,taskId:'b16-turn-1',purpose:'discussion'});
  assert.equal(first.kind,'question');
  const pending=projection.pendingClarificationsFor(app.controller.pendingClarifications,JSON.stringify(['accountUid','accountUin','peerUid','peerUin'].map(key=>scope[key])));
  assert.equal(pending.filter(entry=>entry.status==='pending').length,1,'the visible clarification is recorded as pending');

  app.controller.live({scope,messages:[raw('72057594037927950',true,{elements:[{textElement:{content:'我更喜欢桂花味的，就按这个来。'}}]})]});
  assert.equal(projection.pendingClarificationsFor(app.controller.pendingClarifications,JSON.stringify(['accountUid','accountUin','peerUid','peerUin'].map(key=>scope[key]))).filter(entry=>entry.status==='superseded').length,1,'the observed human send supersedes it');

  const second=await app.controller.assist({text:HUMAN+'再按我刚才说的写。',taskId:'b16-turn-2',purpose:'discussion'});
  assert.equal(second.kind,'draft');
  assert.equal(second.text,SUGGESTION,'the promoted draft body is preserved');
  assert.equal(second.suggestions[0].text,SUGGESTION,'the suggestion is preserved');
  assert.equal(second.discussionExplanation.text,STRIPPED_REMAINDER,'the superseded clarification is stripped from the visible explanation');
  assert.equal(second.discussionExplanation.text.includes(QUESTION),false);
  app.close();
});

test('companion wiring: without an observed user send the same re-asking draft keeps its clarification',async()=>{
  const app=setup([askClarification,draftWithReask()]);
  await app.controller.bind(scope.peerUin);
  const first=await app.controller.assist({text:HUMAN,taskId:'b16-kept-1',purpose:'discussion'});
  assert.equal(first.kind,'question');
  const second=await app.controller.assist({text:HUMAN+'再按我刚才说的写。',taskId:'b16-kept-2',purpose:'discussion'});
  assert.equal(second.kind,'draft');
  assert.equal(second.discussionExplanation.text,REASK,'no user send means the visible clarification is kept whole');
  app.close();
});