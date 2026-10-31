'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Current producer/controller fixtures with local deterministic model transport.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/whole-answer-fidelity.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {buildContext}=require('../src/assistant-context.cjs');
const {candidatesForCompaction,planDiscussionCompaction}=require('../src/discussion-compaction.cjs');
const {discussionReadBody,projectDiscussionReads}=require('../src/context/discussion-view.cjs');
const {discussionTurnFingerprint}=require('../src/discussion-compaction-store.cjs');
const {createServer}=require('../src/server.cjs');
const path=require('node:path');
const SECRET='LEAF_ONLY_SENTINEL',SIBLING='UNAFFECTED_SIBLING_SENTINEL';
function fixture(t){
 const store=new Store(':memory:'),calls=[];
 const settings={auto:false,anonymous:true,discussionCompactionEnabled:false,baseUrl:'http://fixture.invalid/v1',model:'synthetic-generated-projection',
 realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-generated-projection'}};
 const controller=new Controller({store,settings,read:async()=>{throw Error('No native QQ read');},assistantModel:async(_,input)=>{
  const p=input.payload;calls.push(structuredClone(p));
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  const selected=/改/.test(p.userRequest.text)?p.editingReferences?.[0]:null;
  return {kind:'discussion',text:'独立的规划说明。',draftPlan:withCurrentDraftControls({quotes:[],intent:'reply',...(selected?{editingReference:{choice:selected.choice}}:{})},p),answer:{privateExplanation:'独立的私下解释。',suggestions:selected?[{style:'自然',text:selected.text.replace('旧句','改句')}]:[{style:'自然',text:`旧句 ${SECRET}`},{style:'另外',text:SIBLING}]}};
 }});controller.scope={...scope};controller.ingest(scope,[raw('59001',false,{elements:[{textElement:{content:'薄荷又长新叶了。'}}]})]);
 t.after(()=>{controller.close();store.close();});return {store,controller,calls};
}
function argsFor(store,turn,companion,extra={}){if(!companion.turns.some(item=>item.id===turn.id))companion={...companion,turns:[...companion.turns,turn]};return {scope,store,records:store.messages(scope),companion,turn,purpose:'discussion',requestId:'projection-read',settings:{discussionCompactionEnabled:false},...extra};}
test('deleting an original output hides its actual edited descendants from companion, UI, planning and generated reads',async t=>{
 const {store,controller}=fixture(t),original=await controller.assist({text:'接住这条分享。'}),edited=await controller.assist({text:'从原句改起。'});
 const independent=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'ORDINARY_UNRELATED_DISCUSSION',sourceIds:['qq:59001']});
 const retained=store.getCompanion(scope),request=store.appendTurn(scope,{role:'user',kind:'discussion',text:'再商量一下。'});
 assert.equal(store.experiences.artifact(scope,edited.artifactRef).inputArtifactRefs[0].artifactRef.artifactId,original.suggestions[0].artifactRef.artifactId);
 store.deleteTurn(scope,original.id);
 assert.equal(store.experiences.artifact(scope,edited.artifactRef).availability,'redacted');
 const companion=store.getCompanion(scope);assert.equal(JSON.stringify(companion).includes(`改句 ${SECRET}`),false);
 assert.equal(JSON.stringify(controller.snapshot()).includes(`改句 ${SECRET}`),false);
 const context=buildContext(argsFor(store,request,retained,{sourceTurnIds:[edited.id],retrievedDiscussion:[edited]}));
 assert.equal(JSON.stringify(context.payload).includes(SECRET),false);
 assert.equal(JSON.stringify(candidatesForCompaction(null,retained,{store,scope,sourceTurnIds:[edited.id]})).includes(SECRET),false);
 assert.equal(JSON.stringify(projectDiscussionReads([edited],{store,scope})).includes(SECRET),false);
 assert.ok(companion.turns.some(turn=>turn.id===independent.id));assert.equal(store.messages(scope)[0].text,'薄荷又长新叶了。');
});
test('direct leaf redaction preserves parent and sibling but cannot leak retained leaf text through any generated projection',async t=>{
 const {store,controller}=fixture(t),original=await controller.assist({text:'接住这条分享。'}),retained=store.getCompanion(scope),rawBefore=JSON.parse(store.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(store.scopeKey(scope)).record);
 const request=store.appendTurn(scope,{role:'user',kind:'discussion',text:'看一下上一轮。'});
 store.experiences.invalidateArtifacts(scope,[original.suggestions[0].artifactRef]);
 assert.equal(store.experiences.artifact(scope,original.artifactRef).availability,'active');
 assert.ok(rawBefore.turns.find(turn=>turn.id===original.id).suggestions[0].text.includes(SECRET));
 const companion=store.getCompanion(scope),view=companion.turns.find(turn=>turn.id===original.id);
 assert.equal(JSON.stringify(companion).includes(SECRET),false);assert.equal(view.suggestions[1].text,SIBLING);assert.equal(view.suggestions[0].text,'');
 assert.equal(JSON.stringify(controller.snapshot()).includes(SECRET),false);
 const context=buildContext(argsFor(store,request,retained,{sourceTurnIds:[original.id],retrievedDiscussion:[original]}));
 assert.equal(JSON.stringify(context.payload).includes(SECRET),false);assert.ok(JSON.stringify(context.payload).includes(SIBLING));
 const candidates=candidatesForCompaction(null,retained,{store,scope,sourceTurnIds:[original.id]});
 assert.equal(JSON.stringify(candidates).includes(SECRET),false);assert.ok(candidates.some(item=>item.index===1&&item.text===SIBLING));
 const reads=projectDiscussionReads([original],{store,scope});assert.equal(JSON.stringify(reads).includes(SECRET),false);assert.ok(JSON.stringify(reads).includes(SIBLING));
 assert.equal(discussionReadBody(view).text.includes(SECRET),false);
 const rawAfter=JSON.parse(store.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(store.scopeKey(scope)).record);
 assert.equal(rawAfter.turns.find(turn=>turn.id===original.id).suggestions[0].text,original.suggestions[0].text,'scoped read projection does not overwrite retained original evidence');
});
async function compactionFixture(t,{quoteRefs}={}){
 const app=fixture(t),{store,controller}=app,original=await controller.assist({text:'接住这条分享。'});
 const longUser=store.appendTurn(scope,{role:'user',kind:'discussion',text:'长期商量的原话。'.repeat(700)}),longAnswer=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'长期商量的回答。'.repeat(700)});
 const current=store.appendTurn(scope,{role:'user',kind:'discussion',text:'继续看看。'}),companion=store.getCompanion(scope);
 const options=argsFor(store,current,companion,{settings:{baseUrl:'http://fixture.invalid/v1',model:'synthetic-generated-projection'},promptVersion:require('../src/assistant-context.cjs').PROMPT_VERSION});
 const plan=planDiscussionCompaction(options);assert.ok(plan);assert.ok(JSON.stringify(plan.payload).includes(SECRET));
 const input={...plan,summary:`A former summary ${SECRET}`,quoteRefs:quoteRefs||[{turnId:original.id,role:'assistant',field:'suggestions',index:0,text:original.suggestions[0].text,artifactRef:original.suggestions[0].artifactRef}]};
 const fields=['summary','quoteRefs','sourceTurnIds','turnFingerprints','sourceRevisions','coverage','goalVersion','topicVersion','topicBinding','model','modelBinding','promptVersion','protocolVersion'];
 const saved=store.saveDiscussionCompaction(scope,Object.fromEntries(fields.map(key=>[key,input[key]])),{...plan,baseRevision:companion.revision,currentTurnId:current.id});assert.equal(saved.applied,true);
 return {...app,original,longUser,longAnswer,current,companion,options,plan,saved};
}
test('a cached compaction cannot retain a leaf after direct redaction and a new plan receives only available siblings',async t=>{
 const {store,original,longUser,longAnswer,current,companion,options,plan}=await compactionFixture(t);
 store.experiences.invalidateArtifacts(scope,[original.suggestions[0].artifactRef]);
 assert.equal(store.getDiscussionCompaction(scope,{...plan,currentTurnId:current.id}),null);
 const fresh=planDiscussionCompaction({...options,companion});assert.ok(fresh);assert.equal(JSON.stringify(fresh.payload).includes(SECRET),false);assert.ok(JSON.stringify(fresh.payload).includes(SIBLING));
 assert.ok(fresh.sourceTurnIds.includes(longUser.id)&&fresh.sourceTurnIds.includes(longAnswer.id));
 assert.notEqual(fresh.turnFingerprints[original.id],discussionTurnFingerprint(original));
});
test('scoped leaf projections survive ordinary writes and bind later generated-read descendants without overwriting raw evidence',async t=>{
 const {store,controller}=fixture(t),original=await controller.assist({text:'接住这条分享。'});
 store.experiences.invalidateArtifacts(scope,[original.suggestions[0].artifactRef]);
 const view=store.getCompanion(scope).turns.find(turn=>turn.id===original.id);
 const followup=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'只根据仍可用的另一条表达继续商量。',
  artifactMetadata:{discussionTurnFingerprints:{[original.id]:discussionTurnFingerprint(view)}}});
 store.saveNote(scope,{kind:'material',use:'discussion',text:'NEW_UNRELATED_PRIVATE_NOTE'});
 const companion=store.getCompanion(scope);assert.ok(companion.turns.some(turn=>turn.id===followup.id));
 const persisted=store._getCompanion(scope).turns.find(turn=>turn.id===original.id);assert.equal(persisted.suggestions[0].text,original.suggestions[0].text);
 store.experiences.invalidateArtifacts(scope,[original.suggestions[1].artifactRef]);
 assert.ok(!store.getCompanion(scope).turns.some(turn=>turn.id===followup.id));
 assert.equal(store.experiences.artifact(scope,followup.artifactRef).availability,'redacted');
 assert.equal(store.experiences.artifact(scope,original.artifactRef).availability,'active');
 assert.ok(store.getCompanion(scope).notes.some(note=>note.text==='NEW_UNRELATED_PRIVATE_NOTE'));
});
test('older ordinary generated artifacts without input-artifact metadata retain their readable content and sibling identity',async t=>{
 const {store,controller}=fixture(t),original=await controller.assist({text:'接住这条分享。'});
 for(const reference of [original.artifactRef,...original.suggestions.map(item=>item.artifactRef)]){
  const artifact=store.experiences.artifact(scope,reference);delete artifact.inputArtifactRefs;
  store.experiences._put(scope,'artifact',`${reference.artifactId}@${reference.version}`,artifact);
 }
 assert.deepEqual(store.getCompanion(scope).turns.find(turn=>turn.id===original.id),original);
 store.experiences.invalidateArtifacts(scope,[original.suggestions[0].artifactRef]);
 const view=store.getCompanion(scope).turns.find(turn=>turn.id===original.id);
 assert.equal(view.text,'','the canonical first-suggestion duplicate must disappear with its withdrawn leaf');assert.deepEqual(view.discussionExplanation,original.discussionExplanation);assert.equal(view.suggestions[0].text,'');assert.deepEqual(view.suggestions[1],original.suggestions[1]);
 assert.equal(JSON.stringify(controller.snapshot()).includes(SECRET),false);
});

test('failed and pending diagnostic runs cannot expose stale generated reads or cached summaries through public inspectors',async t=>{
 const {store,controller,original,saved,options}=await compactionFixture(t,{quoteRefs:[]});
 // Continue a real consultation far enough that the original leaf is no longer
 // offered as a direct candidate. The retained cache remains source-bound.
 for(let i=0;i<7;i++){
  store.appendTurn(scope,{role:'user',kind:'discussion',text:`后续讨论 ${i}`});
  store.appendTurn(scope,{role:'assistant',kind:'discussion',text:`仍可核对的后续说明 ${i}`});
 }
 const request=store.appendTurn(scope,{role:'user',kind:'discussion',text:'继续商量当前这件事。'}),companion=store.getCompanion(scope);
 const common={...options,turn:request,companion,availableSources:store.memorySources(scope),requestId:'diagnostic-read'};
 const compacted=buildContext({...common,discussionCompaction:saved.record});
 const read=buildContext({...common,retrievedDiscussion:[original]});
 const valid=buildContext(common);
 assert.ok(compacted.payload.discussionCompaction?.summary.includes(SECRET));
 assert.ok(read.payload.retrievedDiscussion?.some(item=>item.text?.includes(SECRET)));
 for(const input of [compacted,read])assert.equal(JSON.stringify(input.payload).includes(original.suggestions[0].artifactRef.artifactId),false,'the guard must inspect generated witnesses, not rely on a duplicate leaf artifact ref');
 const opaqueSummary=structuredClone(compacted);delete opaqueSummary.manifest.discussionCompaction.turnFingerprints;
 const opaqueRead=structuredClone(read);for(const item of opaqueRead.payload.retrievedDiscussion||[])if(item.role==='assistant')delete item.turnFingerprint;
 for(const [id,input]of [['unverifiable-summary',opaqueSummary],['unverifiable-read',opaqueRead]]){
  store.saveRun(scope,{id,status:'failed',purpose:input.payload.purpose,payload:input.payload,manifest:input.manifest,error:'Incomplete legacy diagnostics'});
  assert.ok(!store.getCompanion(scope).runs.some(run=>run.id===id),'opaque generated inputs without a verifiable body witness stay internal');
 }
 store.saveRun(scope,{id:'valid-inspectable-run',status:'complete',purpose:valid.payload.purpose,payload:valid.payload,manifest:valid.manifest});
 store.saveRun(scope,{id:'failed-cached-input',status:'failed',purpose:compacted.payload.purpose,payload:compacted.payload,manifest:compacted.manifest,error:'Synthetic provider failure'});
 store.saveRun(scope,{id:'pending-nested-read',status:'pending',purpose:valid.payload.purpose,payload:valid.payload,manifest:valid.manifest,
  requests:[{purpose:read.payload.purpose,payload:read.payload,manifest:read.manifest}]});
 const rawBefore=JSON.stringify(store._getCompanion(scope).runs);
 assert.equal(controller.assistantContext().run.id,'pending-nested-read');
 assert.ok(JSON.stringify(store.getCompanion(scope).runs).includes(SECRET));
 const server=createServer({controller,token:'synthetic-projection-token',uiDir:path.resolve(__dirname,'../ui')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/assistant-context`,headers={Authorization:'Bearer synthetic-projection-token'};
 assert.ok((await (await fetch(url,{headers})).text()).includes(SECRET));
 store.experiences.invalidateArtifacts(scope,[original.suggestions[0].artifactRef]);
 assert.equal(store.experiences.artifact(scope,original.artifactRef).availability,'active');
 const publicRuns=store.getCompanion(scope).runs;
 assert.equal(JSON.stringify(publicRuns).includes(SECRET),false);assert.ok(publicRuns.some(run=>run.id==='valid-inspectable-run'));
 assert.equal(controller.assistantContext().run.id,'valid-inspectable-run');
 const inspected=await (await fetch(url,{headers})).json();assert.equal(JSON.stringify(inspected).includes(SECRET),false);assert.equal(inspected.run.id,'valid-inspectable-run');
 assert.equal(JSON.stringify(store._getCompanion(scope).runs),rawBefore,'original internal diagnostic inputs remain byte-identical');
});
