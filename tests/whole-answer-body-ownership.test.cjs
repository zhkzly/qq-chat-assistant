'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Deterministic protocol and projection checks, never conversational ratings.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/whole-answer-fidelity.cjs');
const {visibleResponseText}=require('../src/experience-store.cjs');
const {projectVisibleTurn}=require('../scripts/eval-qq-adapter.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const FIRST='The first individually revocable outward message.',SECOND='An independent second outward choice.';
for(const why of [undefined,'The independent private explanation.'])test(`whole primary leaf ownership survives real Controller, Store and visible adapter with ${why?'explicit':'absent'} explanation`,async t=>{
 const store=new Store(':memory:'),settings={auto:false,anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-body-ownership',realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-body-ownership'}};
 const controller=new Controller({store,settings,read:async()=>{throw Error('No QQ reads');},assistantModel:async(_,input)=>input.payload.purpose==='fidelity_check'?{checkRef:input.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]}:{operation:'prepare_message',answer:{...(why?{privateExplanation:why}:{}),suggestions:[{text:FIRST},{text:SECOND}]}}});
 t.after(()=>{controller.close();store.close();});controller.scope={...scope};controller.ingest(scope,[raw('91000000000000411')]);const reply=await controller.assist({text:'Give me complete suggestions without inventing any experience.'});
 assert.equal(reply.text,'');assert.equal(reply.suggestions[0].text,FIRST);assert.equal(store.experiences.artifact(scope,reply.artifactRef).body,why||'');assert.equal(visibleResponseText(reply),why||'');assert.deepEqual(projectVisibleTurn(reply).suggestions.map(item=>item.text),[FIRST,SECOND]);assert.equal(projectVisibleTurn(reply).text,why||'');
 const rawBefore=JSON.stringify(store._getCompanion(scope).turns);store.experiences.invalidateArtifacts(scope,[reply.suggestions[0].artifactRef]);const view=store.getCompanion(scope);assert.equal(JSON.stringify(view).includes(FIRST),false);assert.equal(view.turns.at(-1).suggestions[1].text,SECOND);assert.equal(visibleResponseText(view.turns.at(-1)),why||'');assert.equal(JSON.stringify(controller.snapshot()).includes(FIRST),false);assert.equal(JSON.stringify(store._getCompanion(scope).turns),rawBefore);assert.equal(store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('a legacy exact draft-body alias follows only its own withdrawn leaf while independent parent prose and raw diagnostics remain retained',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const why='Independent legacy private explanation.',reply=store.appendTurn(scope,{role:'assistant',kind:'draft',text:FIRST,discussionExplanation:{kind:'discussion',text:why},suggestions:[{text:FIRST},{text:SECOND}]});
 const feedback=store.experiences.addFeedback(scope,{text:'A comment on the exact legacy response.',targetRef:{kind:'artifact',artifactRef:reply.artifactRef}, expectedDigest: store.experiences.artifact(scope, reply.artifactRef).bodyDigest});assert.equal(store.experiences.hydrateFeedback(scope,feedback.id).target.body,[why,FIRST].join('\n\n'));
 const unrelated=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'A distinct response with independently owned text.'});store.saveRun(scope,{id:'legacy-output-diagnostic',status:'complete',replyId:reply.id,payload:{candidate:{text:FIRST}}});const raw=JSON.stringify(store._getCompanion(scope));store.experiences.invalidateArtifacts(scope,[reply.suggestions[0].artifactRef]);const companion=store.getCompanion(scope),view=companion.turns.find(turn=>turn.id===reply.id);assert.equal(view.text,'');assert.equal(view.discussionExplanation.text,why);assert.equal(view.suggestions[1].text,SECOND);assert.equal(companion.turns.find(turn=>turn.id===unrelated.id).text,unrelated.text);assert.equal(JSON.stringify(companion).includes(FIRST),false);assert.equal(store.experiences.hydrateFeedback(scope,feedback.id).target,null);assert.equal(store.experiences.readableArtifact(scope,reply.artifactRef).availability,'unavailable');assert.equal(store.experiences.artifact(scope,reply.artifactRef).body,[why,FIRST].join('\n\n'));assert.equal(JSON.stringify(store._getCompanion(scope)),raw);
});
