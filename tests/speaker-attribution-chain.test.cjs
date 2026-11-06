'use strict';
// Deterministic speaker-attribution chain repro: the account owner own
// private statement ("压力很大") must stay attributed to the account owner
// from ingestion through source snapshot, memory wire, storage guards and
// consumer prompts. Assertions target prompt/storage structure only; no model
// output quality is claimed. Fictional inputs throughout.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {normalize}=require('../src/messages.cjs');
const {buildContext}=require('../src/assistant-context.cjs');
const {prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {parseAssistant}=require('./fixtures/assistant-protocol.cjs');
const {SPEAKER_IDENTITY_MARKER}=require('../src/speaker-identity.cjs');
const {scope,raw}=require('./fixtures/native.cjs');

function qq(id,at,own,text){
  return normalize(raw(id,own,{msgTime:String(Date.parse(at)/1000),msgSeq:id,elements:[{textElement:{content:text}}]}),scope);
}
// The reported scenario: her busy incoming message, the user own outgoing
// reply, and the user telling the assistant about the USER OWN stress.
function scenario(t,{asOf='2026-10-16T08:00:00Z'}={}){
  const store=new Store(':memory:');t.after(()=>store.close());
  store.setGoal(scope,'PRIVATE_GOAL_发展双方愿意的恋爱关系');
  store.add(scope,[qq('9001','2026-10-15T15:00:00Z',false,'这周一直在赶项目，事情特别多'),
    qq('9002','2026-10-15T15:01:00Z',true,'注意休息，别太累了')]);
  const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'我最近压力很大，想找机会跟她聊聊我的近况，怎么开口比较好'});
  const context=buildContext({scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',
    coverage:{status:'partial'},availableSources:store.memorySources(scope),asOf,viewerTimeZone:'Asia/Shanghai',
    invocation:{origin:'user',trigger:'private_request',requestedPurpose:'discussion'}});
  return {store,turn,context};
}
const baseSettings={model:'synthetic-attribution',baseUrl:'http://fixture.invalid/v1',anonymous:true};
// Delivery options proving the writer actually read the cited originals.
function grounded(store){
  const sources=store.memorySources(scope);
  return {baseRevision:store.getCompanion(scope).revision,sourceIds:sources.map(s=>s.id),
    sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),
    deliveredSources:store.readOriginalEvidence(scope,{sourceIds:sources.map(s=>s.id),maxBytes:100000}).sources};
}

test('help wire labels every user-authored source with the account-owner speaker',t=>{
  const {context}=scenario(t);
  const privateSource=context.payload.sources.find(s=>s.type==='private');
  assert.ok(privateSource,'private turn is delivered');
  assert.equal(privateSource.role,'user','private turn keeps role=user');
  // Before the fix the private source carried no speaker label at all, so the
  // only spoken-person vocabulary in sources was the QQ 我/对方 pair.
  assert.equal(privateSource.speaker,'我','account-owner private statement is labeled 我, not left for guessing');
  const herQQ=context.payload.sources.find(s=>s.id==='qq:9001');
  assert.equal(herQQ.speaker,'对方');assert.equal(herQQ.role,'contact');
  const ownQQ=context.payload.sources.find(s=>s.id==='qq:9002');
  assert.equal(ownQQ.speaker,'我');assert.equal(ownQQ.role,'user');
});

test('help wire keeps speaker labels through source-handle encoding without a payload legend',t=>{
  const {context}=scenario(t);
  const prepared=prepareAssistantRequest(baseSettings,context.payload);
  const wire=JSON.parse(prepared.request.messages[1].content),delivered=wire.originalInput||wire;
  // Identity travels as cheap per-source labels and per-record entailment
  // tokens (speaker / speakerBasis), not as a bulky payload legend: tight
  // evidence budgets must not pay bytes for prose (consultation-context
  // regression) and system prompts stay bounded (help-generation-contract).
  // On the primary operation lane the private intent source is deliberately
  // reshaped into userRequest (structural identity: the current human
  // statement); every remaining delivered source keeps its speaker label.
  assert.ok(delivered.userRequest&&delivered.userRequest.text.includes('压力很大'),
    'the account-owner private statement stays the named current human request');
  const herWire=delivered.sources.find(s=>s.type==='qq'&&s.direction==='incoming');
  assert.equal(herWire.speaker,'对方');
  const ownWire=delivered.sources.find(s=>s.type==='qq'&&s.direction==='outgoing');
  assert.equal(ownWire.speaker,'我');
  assert.equal(delivered.speakerIdentityRule,undefined,'no payload-scale legend on the help path');
  // Union re-bound (recorded decision, context-memory-20261105): the composed
  // help contract adds D006's irreducible delivery-honesty commitments
  // (unread-gap honesty, delivery.lookup continuation, materials top-level
  // only, restored-source provenance) at ~200 minimum characters after
  // compression to 4803; B007's own constants were already 4579/1639. The
  // bound keeps real headroom (~100 chars under the compressed floor) so the
  // prompt stays bounded and prose creep stays detectable. The consultation
  // 7000-byte budget regression keeps its own separate assertion unchanged.
  assert.ok(prepared.request.messages[0].content.length<5000,'bounded foreground system prompt');
});

test('memory wire marks private user sources as the account owner (author self) and pins the legend',t=>{
  const {store}=scenario(t);
  const batch=store.memoryBatch(scope),request=prepareMemoryRequest(baseSettings,batch);
  const body=JSON.parse(request.serialized),payload=JSON.parse(body.messages[1].content);
  const privateSource=payload.sources.find(s=>s.type==='private');
  assert.ok(privateSource);
  // Before the fix only QQ sources received an author alias; private user
  // statements had no author field while claim subjects use self/contact.
  assert.equal(privateSource.author,'self','a private role=user source is the account owner speaking');
  const herQQ=payload.sources.find(s=>s.type==='qq'&&s.direction==='incoming');
  assert.equal(herQQ.author,'contact');
  const ownQQ=payload.sources.find(s=>s.type==='qq'&&s.direction==='outgoing');
  assert.equal(ownQQ.author,'self');
  assert.ok(body.messages[0].content.includes(SPEAKER_IDENTITY_MARKER),
    'the memory writer must see the identity vocabulary definition');
});

test('a contact speech claim cannot be proven by the account-owner private statement',t=>{
  const {store}=scenario(t);
  const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'补充：她上周说他们项目也要验收'});
  const options=grounded(store);
  const rejected=store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',
    text:'她最近压力很大。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:['private:'+turn.id]}]},options);
  assert.equal(rejected.applied,false);
  assert.match(rejected.detail,/Contact statements require actual contact messages/,
    'the reported reversed claim (her stress from user own words) must be rejected at write time');
});

test('a self speech claim must cite the account-owner own words, not her messages',t=>{
  const {store}=scenario(t);
  const sources=store.memorySources(scope),options=grounded(store);
  // Before the fix this reversed attribution was accepted: the user stated X
  // proven only by her incoming QQ message.
  const reversed=store.applyRelationshipPatch(scope,{claims:[{subject:'self',aspect:'recent_context',
    text:'用户本人说最近压力很大。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:['qq:9001']}]},options);
  assert.equal(reversed.applied,false,'self+stated citing only her message must not apply');
  assert.match(reversed.detail,/User statements require the account owner own words/);
  // Positive controls: legitimate attributions still apply.
  const privateId=sources.find(s=>s.type==='private').id;
  const applied=store.applyRelationshipPatch(scope,{claims:[{subject:'self',aspect:'recent_context',
    text:'用户本人说最近压力很大。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:[privateId]}]},options);
  assert.equal(applied.applied,true,JSON.stringify(applied));
  const reported=store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',
    text:'用户转述她这周在赶项目。',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:[privateId]}]},options);
  assert.equal(reported.applied,true,'a user report about her remains a legal reported claim');
});

test('foreground audit rejects a self speech claim proven only by her message',()=>{
  const foreground={purpose:'reply',generationOrigin:'private_discussion',
    userRequest:{sourceId:'private:current',text:'我最近压力很大，怎么开口'},
    intentAuthority:{sourceId:'private:current'},
    sources:[{id:'qq:9001',type:'qq',role:'contact',direction:'incoming',speaker:'对方',text:'这周一直在赶项目',revision:'r1'},
      {id:'private:current',type:'private',role:'user',kind:'discussion',text:'我最近压力很大，怎么开口',revision:'r2'}],
    relationshipContext:{claims:[],events:[]}};
  assert.throws(()=>parseAssistant({kind:'discussion',text:'Synthetic help text.',
    relationshipPatch:{claims:[{subject:'self',aspect:'recent_context',text:'用户本人说最近压力很大。',
      assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',sourceIds:['qq:9001']}],events:[],retire:[]}},
    'reply',foreground),/用户本人|relationshipPatch/,'foreground wire rejects the reversed self attribution early');
});

test('a QQ speech-act clock must come from the acting party own message',t=>{
  const {store}=scenario(t);
  const batch=store.memoryBatch(scope),request=prepareMemoryRequest(baseSettings,batch);
  const body=JSON.parse(request.serialized),payload=JSON.parse(body.messages[1].content);
  const herStatement=payload.sources.find(s=>s.type==='qq'&&s.direction==='incoming');
  const ownStatement=payload.sources.find(s=>s.type==='qq'&&s.direction==='outgoing');
  const event=(actor,statement,definition)=>({activityKey:'fictional-sharing',eventKind:'sharing',actor,
    text:'A fictional sharing event.',sourceIds:[statement.id],
    ...(definition?{activity:{ref:'NEW',definition:{sourceId:definition.id,quote:definition.text}}}:{}),
    evidence:{statement:{sourceId:statement.id,quote:statement.text},time:{basis:'qq_statement'}}});
  assert.throws(()=>request.decode({batchId:payload.batchId,reviewedAll:true,episodes:[],
    relationshipPatch:{claims:[],events:[event('self',herStatement,herStatement)],retire:[]}}),
    /speech-act|actor/i,'actor self cannot borrow her incoming message as a user speech-act clock');
  const legit=request.decode({batchId:payload.batchId,reviewedAll:true,episodes:[],
    relationshipPatch:{claims:[],events:[event('contact',herStatement,herStatement)],retire:[]}});
  assert.equal(legit.relationshipPatch.events.length,1,'her own message still proves her speech act');
  assert.throws(()=>request.decode({batchId:payload.batchId,reviewedAll:true,episodes:[],
    relationshipPatch:{claims:[],events:[event('contact',ownStatement,ownStatement)],retire:[]}}),
    /speech-act|actor/i,'actor contact cannot borrow the account-owner outgoing message as her speech-act clock');
});

test('vision image speakers use the unified 我/对方 vocabulary',()=>{
  const {selectVisionContext}=require('../src/vision-context.cjs');
  const at=Date.parse('2026-10-14T04:00:00Z');
  const picture=(id,own)=>normalize(raw(id,own,{msgTime:String(Math.floor((at-1000)/1000)),msgSeq:id,
    elements:[{textElement:{content:'Synthetic image context'}},{picElement:{sourcePath:'/synthetic/qq/'+id+'.png',fileName:'synthetic.png'}}]}),scope);
  const records=[picture('90071992547409999001',true),picture('90071992547409999002',false)];
  const result=selectVisionContext({records,automatic:true,now:at,availableSources:records.map(record=>({id:'qq:'+record.messageId,type:'qq',text:record.text})),
    readImageFn:()=>({type:'image/png',data:Buffer.from('synthetic bytes')})});
  assert.deepEqual(result.images.map(image=>image.speaker),['我','对方'],
    'model-visible speaker fields share one vocabulary with QQ sources');
});

test('conversation discovery never defaults a directionless QQ source to a speaker',()=>{
  // Static sources; no Store needed.
  const {discoverConversationEvidence}=require('../src/conversation-discovery.cjs');
  const at='2026-10-15T15:00:00Z';
  const directionless={id:'qq:unknown-direction',type:'qq',text:'说话人未知的一句话，不能默认成我或她',at};
  const incoming={id:'qq:9001',type:'qq',direction:'incoming',role:'contact',text:'这周一直在赶项目',at};
  const outgoing={id:'qq:9002',type:'qq',direction:'outgoing',role:'user',text:'注意休息',at};
  const directory=discoverConversationEvidence({sources:[directionless,incoming,outgoing],asOf:at}).directory;
  assert.equal(directory.find(item=>item.id==='raw:qq:unknown-direction').sourceSpeaker,'undetermined',
    'a QQ source without direction stays undetermined instead of becoming self');
  assert.equal(directory.find(item=>item.id==='raw:qq:9001').sourceSpeaker,'contact');
  assert.equal(directory.find(item=>item.id==='raw:qq:9002').sourceSpeaker,'self');
});

test('rendered claims carry closure-derived holder labels, never guessed attribution',t=>{
  const {store}=scenario(t);
  const options=grounded(store);
  const herQQ=store.memorySources(scope).find(s=>s.id==='qq:9001').id;
  const privateId=store.memorySources(scope).find(s=>s.type==='private').id;
  // Her own words: contact stated with contact evidence.
  store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',
    text:'她这周在赶项目。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:[herQQ]}]},options);
  // User report about her from the user private turn.
  store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',
    text:'用户转述她最近事情多。',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:[privateId]}]},options);
  // The user own stress, correctly attributed.
  store.applyRelationshipPatch(scope,{claims:[{subject:'self',aspect:'recent_context',
    text:'用户本人最近压力很大。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:[privateId]}]},options);
  const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'再帮我看看怎么开口'});
  const context=buildContext({scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'review',
    coverage:{status:'partial'},availableSources:store.memorySources(scope),asOf:'2026-10-16T08:00:00Z',viewerTimeZone:'Asia/Shanghai',
    relationshipContext:store.relationshipView(scope),
    invocation:{origin:'user',trigger:'private_request',requestedPurpose:'review'}});
  const claims=context.payload.relationshipContext.claims;
  assert.ok(claims.length>=3,'claims rendered');
  const herWords=claims.find(claim=>claim.assertionKind==='stated'&&claim.subject==='contact');
  assert.equal(herWords.speakerBasis.holderLabel,'her_words_evidence');
  assert.ok(herWords.speakerBasis.speakers.includes('contact'));
  const userReport=claims.find(claim=>claim.assertionKind==='reported'&&claim.subject==='contact');
  assert.equal(userReport.speakerBasis.holderLabel,'user_report_not_her_words');
  assert.ok(!userReport.speakerBasis.speakers.includes('contact'),'closure has no contact speech');
  const ownerWords=claims.find(claim=>claim.subject==='self');
  assert.equal(ownerWords.speakerBasis.holderLabel,'owner_words_evidence');
  assert.ok(ownerWords.speakerBasis.speakers.includes('account_owner'));
});

test('identity annotations are wire-only: derived memory keeps ids and revisions',t=>{
  const {store}=scenario(t);
  const options=grounded(store);
  const privateId=store.memorySources(scope).find(s=>s.type==='private').id;
  store.applyRelationshipPatch(scope,{claims:[{subject:'self',aspect:'recent_context',
    text:'用户本人最近压力很大。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:[privateId]}]},options);
  const claimBefore=store.relationshipView(scope).claims[0];
  const revisionBefore=store.memorySources(scope).find(s=>s.id===privateId).revision;
  // Rebuilding the identity-annotated snapshot must not invalidate stored
  // memory: revisions and record ids are stable across the projection change.
  const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'继续刚才的话题'});
  const context=buildContext({scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',
    coverage:{status:'partial'},availableSources:store.memorySources(scope),asOf:'2026-10-16T08:00:00Z',viewerTimeZone:'Asia/Shanghai',
    invocation:{origin:'user',trigger:'private_request',requestedPurpose:'discussion'}});
  const privateSource=context.payload.sources.find(s=>s.id===privateId);
  assert.equal(privateSource.speaker,'我');
  assert.equal(store.memorySources(scope).find(s=>s.id===privateId).revision,revisionBefore,
    'the wire-only speaker annotation never changes the hashed source revision');
  const claimAfter=store.relationshipView(scope).claims[0];
  assert.equal(claimAfter.id,claimBefore.id);
  assert.equal(claimAfter.version,claimBefore.version);
  assert.ok(store.personUnderstanding(scope).self.recentCircumstances.some(item=>item.id===claimBefore.id),
    'the stored correct attribution survives the projection upgrade');
});
