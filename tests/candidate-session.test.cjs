'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CandidateSession}=require('../src/candidate-session.cjs');
const {scope}=require('./fixtures/native.cjs');
const wording=text=>({id:`turn-${text}`,requestId:`request-${text}`,text:'Generated explanation',suggestions:[{style:'自然',text}]});
test('a newer private input fences publication even when QQ revision has not changed',()=>{
 const session=new CandidateSession({now:()=>1000});
 const first=session.begin({scope,revision:7,requestId:'one',origin:'automatic'});assert.ok(session.bindPlan(first,'plan-one'));
 assert.ok(session.publish(first,{scope,revision:7,reply:wording('old'),planDigest:'plan-one',messageIds:['1']}));
 const second=session.begin({scope,revision:7,requestId:'two',origin:'user',advancePrivateInput:true});
 assert.equal(session.current({scope,revision:7}),null);assert.equal(session.privateInputSeq,1);
 assert.equal(session.publish(first,{scope,revision:7,reply:wording('late-old'),planDigest:'plan-one'}),null);
 assert.ok(session.bindPlan(second,'plan-two'));const next=session.publish(second,{scope,revision:7,reply:wording('revised'),planDigest:'plan-two'});
 assert.equal(next.suggestions[0].text,'revised');assert.equal(next.binding.privateInputSeq,1);assert.equal(next.binding.planDigest,'plan-two');
});
test('publication requires the validated plan and exact account, contact and QQ revision',()=>{
 const session=new CandidateSession();const request=session.begin({scope,revision:4,requestId:'one',origin:'user',advancePrivateInput:true});
 assert.equal(session.publish(request,{scope,revision:4,reply:wording('unplanned'),planDigest:'missing'}),null);
 assert.ok(session.bindPlan(request,'validated'));
 for(const current of [{scope:{...scope,accountUin:'2222222222'},revision:4},{scope:{...scope,peerUid:'other'},revision:4},{scope,revision:5}])assert.equal(session.publish(request,{...current,reply:wording('stale'),planDigest:'validated'}),null);
 assert.equal(session.publish(request,{scope,revision:4,reply:wording('wrong-plan'),planDigest:'different'}),null);
 assert.ok(session.publish(request,{scope,revision:4,reply:wording('valid'),planDigest:'validated'}));
});
test('TTL and automatic reuse belong to the session; unrelated memory generations do not invalidate it',()=>{
 let now=1000;const session=new CandidateSession({now:()=>now,ttlMs:300000});const request=session.begin({scope,revision:2,requestId:'one',origin:'automatic'});session.bindPlan(request,'plan');
 session.publish(request,{scope,revision:2,reply:wording('current'),planDigest:'plan',automaticFingerprint:'fingerprint'});
 assert.equal(session.canReuseAutomatic('fingerprint',{scope,revision:2}),true);
 assert.ok(session.current({scope,revision:2,generation:'background-memory-changed'}));
 now+=300001;assert.equal(session.current({scope,revision:2}),null);assert.equal(session.status({scope,revision:2,auto:true}).phase,'expired');assert.equal(session.canReuseAutomatic('fingerprint',{scope,revision:2}),false);
});
