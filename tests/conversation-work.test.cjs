'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildConversationWork}=require('../src/conversation-work.cjs');
test('work references current meaning, applicable topic and real focus without copying private bodies',()=>{
 const privateText='PRIVATE_WORK_BODY_'.repeat(100),payload={purpose:'discussion',goal:'PRIVATE_LONG_TERM_GOAL',userRequest:{sourceId:'private:current',text:privateText},intentAuthority:{sourceId:'private:current'},
  sources:[{id:'private:current',type:'private',role:'user',text:privateText},{id:'private:prior',type:'private',role:'user',text:'applicable prior instruction'},{id:'qq:1',type:'qq',direction:'incoming',text:'Actual sharing'}],
  taskContext:{invocation:{origin:'user',trigger:'private_request',requestedPurpose:'discussion'},consultationTask:{focus:[{sourceId:'qq:1'}]}},
  topicContext:{active:{id:'topic-one',version:3,lifecycle:'active',objective:'Private direction',constraints:['local constraint'],sourceIds:['private:prior'],interpretationStatus:'user_stated'}},
  pendingPrivateReview:{sourceIds:['private:current']}};
 const work=buildConversationWork(payload);assert.equal(work.authority,'derived_work_view_not_factual_evidence');assert.equal(work.request.sourceId,'private:current');assert.equal(work.current.topicId,'topic-one');assert.deepEqual(work.focus.sourceIds,['qq:1']);assert.ok(work.sourceIds.includes('private:prior'));
 assert.equal(JSON.stringify(work).includes(privateText),false);assert.equal(JSON.stringify(work).includes(payload.goal),false);assert.equal(work.outputUse,'planning_only_not_outbound_authorization');
 assert.equal(payload.topicContext.active.version,3,'projection does not mutate stored/current state');
});
test('restricted wording work never inherits private current meaning or long-term direction',()=>{
 const payload={purpose:'draft',goal:'PRIVATE_GOAL',userRequest:{sourceId:'private:secret',text:'PRIVATE_REASON'},topicContext:{active:{objective:'PRIVATE_TOPIC'}},sources:[{id:'qq:1',type:'qq',text:'Actual fact'}],
  draftingGuidance:{objective:{text:'Answer the actual fact',sourceIds:['qq:1']}},replyFocus:['1']};
 const work=buildConversationWork(payload);assert.equal(work.outputUse,'restricted_wording_only');assert.ok(!JSON.stringify(work).includes('PRIVATE_'));assert.equal(work.request,undefined);assert.equal(work.goal,undefined);assert.deepEqual(work.sourceIds,['qq:1']);
});
