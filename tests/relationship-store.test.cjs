'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const user = (s,text) => s.appendTurn(scope,{role:'user',kind:'discussion',text});
const options = s => ({baseRevision:s.getCompanion(scope).revision,sourceIds:s.memorySources(scope).map(x=>x.id),sourceRevisions:Object.fromEntries(s.memorySources(scope).map(x=>[x.id,x.revision]))});
const claim = (sourceId,extra={}) => ({subject:'contact',aspect:'recent_context',text:'她说本周在准备考试',assertionKind:sourceId.startsWith('qq:')?'stated':'reported',epistemicStatus:'supported',sourceIds:[sourceId],...extra});
const complete = (batch,extra={}) => ({reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[],...extra});

test('typed views separate self/contact/dyad and expire applicability without erasing evidence',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());
  const m=normalize(raw(undefined,false,{elements:[{textElement:{content:'这周准备考试'}}]}),scope);s.add(scope,[m]);
  const u=user(s,'我想邀请她一起看电影，但不确定她的意思');
  const result=s.applyRelationshipPatch(scope,{claims:[claim(`qq:${m.messageId}`,{validUntil:'2026-10-15T00:00:00Z'}),claim(`private:${u.id}`,{subject:'self',aspect:'relationship_intent',text:'用户想邀请她看电影'}),claim(`private:${u.id}`,{subject:'dyad',aspect:'interaction_hypothesis',text:'双方是否想约会尚不确定',assertionKind:'inferred',epistemicStatus:'tentative'})]},options(s));
  assert.equal(result.applied,true,JSON.stringify(result));
  const view=s.relationshipView(scope,{asOf:'2026-10-20T00:00:00Z'});
  assert.equal(view.self.length,1);assert.equal(view.contact.length,1);assert.equal(view.dyad.length,1);
  assert.equal(view.contact[0].applicability,'expired');assert.equal(view.contact[0].evidenceValidity,'valid');
  assert.equal(s.relationshipView({...scope,peerUin:'different'}).claims.length,0);
});

test('typed updates require live delivered evidence and object versions; inferred certainty cannot be promoted',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=user(s,'她说喜欢电影');const id=`private:${u.id}`;
  assert.equal(s.applyRelationshipPatch(scope,{claims:[claim(id,{assertionKind:'inferred'})]},options(s)).applied,false);
  assert.equal(s.applyRelationshipPatch(scope,{claims:[claim(id,{assertionKind:'observed'})]},options(s)).applied,false);
  assert.equal(s.applyRelationshipPatch(scope,{claims:[claim('qq:invented')]},options(s)).applied,false);
  assert.equal(s.applyRelationshipPatch(scope,{claims:[claim(id)]},options(s)).applied,true);
  const stored=s.relationshipView(scope).claims[0];
  assert.equal(s.applyRelationshipPatch(scope,{claims:[claim(id,{id:stored.id,expectedVersion:stored.version+1,text:'wrong version'})]},options(s)).applied,false);
  const before=options(s);s.updateTurn(scope,u.id,'更正，她没有说喜欢电影');
  assert.equal(s.applyRelationshipPatch(scope,{claims:[claim(id)]},before).applied,false);
  assert.equal(s.relationshipView(scope).claims.length,0);
});

test('same evidence and interpretation is idempotent while conflicting interpretations remain separate',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=user(s,'她之前说喜欢电影，后来解释这次只是陪朋友');const id=`private:${u.id}`;
  const a=claim(id,{aspect:'interest',text:'她之前说喜欢电影',epistemicStatus:'contested'});
  assert.equal(s.applyRelationshipPatch(scope,{claims:[a]},options(s)).applied,true);
  const first=s.relationshipView(scope).claims[0];s.applyRelationshipPatch(scope,{claims:[a]},options(s));
  assert.equal(s.relationshipView(scope).claims.length,1);assert.equal(s.relationshipView(scope).claims[0].version,first.version);
  s.applyRelationshipPatch(scope,{claims:[claim(id,{aspect:'interest',text:'她解释这次是陪朋友',epistemicStatus:'contested'})]},options(s));
  assert.equal(s.relationshipView(scope).claims.length,2);
});

test('activity timelines keep later cancellation despite older invitation arriving afterwards',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());
  const cancel=normalize(raw('72057594037927999',false,{msgTime:'1791926000',elements:[{textElement:{content:'周日电影先取消吧'}}]}),scope);s.add(scope,[cancel]);
  const event=(m,eventKind)=>({activityKey:'sunday-film',eventKind,actor:'contact',text:m.text,sourceIds:[`qq:${m.messageId}`]});
  assert.equal(s.applyRelationshipPatch(scope,{events:[event(cancel,'cancellation')]},options(s)).applied,true);
  const invite=normalize(raw('72057594037927997',true,{msgTime:'1791726000',elements:[{textElement:{content:'周日一起看电影吗'}}]}),scope);s.add(scope,[invite]);
  assert.equal(s.applyRelationshipPatch(scope,{events:[{...event(invite,'invitation'),actor:'self'}]},options(s)).applied,true);
  const v=s.relationshipView(scope,{query:'电影'});assert.equal(v.activities[0].status,'cancelled');assert.equal(v.events.length,2);
  assert.equal(v.activities[0].relationshipStatus,undefined);
  assert.equal(s.experiences.list(scope).cases.some(c=>c.activityId==='sunday-film'),true);
});

test('background relationship patches commit with review progress and source removal prevents resurrection',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=user(s,'她最近忙着准备考试');let b=s.memoryBatch(scope);
  const r=s.applyMemoryBatch(scope,b,complete(b,{relationshipPatch:{claims:[claim(`private:${u.id}`,{assertionKind:'reported'})]}}));
  assert.equal(r.applied,true,JSON.stringify(r));assert.equal(s.relationshipView(scope).claims.length,1);assert.equal(s.memoryStatus(scope).pending,0);
  s.forgetSource(scope,`private:${u.id}`);assert.equal(s.relationshipView(scope).claims.length,0);
  assert.equal(s.applyMemoryBatch(scope,b,complete(b,{relationshipPatch:{claims:[claim(`private:${u.id}`)]}})).applied,false);
  assert.equal(JSON.stringify(s.memoryBatch(scope)).includes('忙着准备考试'),false);
});

test('canonical feedback and its derived note cannot launder a local complaint into stable preference',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());s.saveRun(scope,{id:'request'});
  const f=s.addFeedback(scope,{requestId:'request',text:'这句太正式',kind:'local'});
  s.appendTurn(scope,{role:'user',kind:'feedback',text:'对助手建议的反馈：这句太正式',requestId:'request'});
  const sources=s.memorySources(scope);assert.equal(sources.filter(x=>x.text.includes('这句太正式')).length,1);
  const n=s.saveNote(scope,{text:'这次正式语气不合适',use:'discussion',evidenceSourceIds:[`private:feedback-${f.id}`]});
  const b=s.memoryBatch(scope);
  const result=s.applyMemoryBatch(scope,b,complete(b,{items:[{kind:'preference',text:'以后永远不用正式表达',sourceIds:[`note:${n.id}`],explicitPreference:true}]}));
  assert.equal(result.applied,false);
});

test('legacy reviewed sources become eligible once for typed bootstrap without changing source revisions',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=user(s,'旧记录里她说喜欢电影');let b=s.memoryBatch(scope);s.applyMemoryBatch(scope,b,complete(b));
  const before=s.memorySources(scope)[0];
  s.db.prepare('UPDATE memory_meta SET processor_version=NULL WHERE scope_key=?').run(s.scopeKey(scope));
  s.maintainLocal(scope);b=s.memoryBatch(scope);assert.ok(b);assert.equal(b.sources[0].revision,before.revision);
  s.applyMemoryBatch(scope,b,complete(b));s.maintainLocal(scope);assert.equal(s.memoryBatch(scope),null);
});

test('partial evidence never yields a current supported profile and source recall remains final',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=user(s,'历史说明'.repeat(1800));const b=s.memoryBatch(scope,{maxBytes:4000});
  assert.equal(s.applyMemoryBatch(scope,b,complete(b,{relationshipPatch:{claims:[claim(`private:${u.id}`,{assertionKind:'reported'})]}})).applied,true);
  assert.equal(s.relationshipView(scope).claims[0].evidenceValidity,'partial');
  const m=normalize(raw(),scope);s.add(scope,[{...m,recalled:true,text:'[已撤回]'}]);s.add(scope,[m]);
  assert.equal(s.memorySources(scope).some(x=>x.id===`qq:${m.messageId}`),false);
});

test('ordinary correction keeps a stale evaluation target but forget purges its body and dependent feedback',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=user(s,'合成私人素材：周六一起看电影');const sourceId=`private:${u.id}`;
  const answer=s.appendTurn(scope,{role:'assistant',kind:'discussion',text:'可以接着讨论周六看电影',requestId:'old-answer',sourceIds:[sourceId]});
  const f=s.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:answer.artifactRef},text:'这句话没考虑时间'});
  s.updateTurn(scope,u.id,'更正：周日才有空');
  assert.equal(s.experiences.artifact(scope,answer.artifactRef).availability,'stale');
  assert.ok(s.experiences.hydrateFeedback(scope,f.id).target);
  const rev=s.memorySources(scope).find(x=>x.id===f.sourceId).revision;
  assert.equal(s.memorySources(scope).find(x=>x.id===f.sourceId).revision,rev);
  s.forgetSource(scope,sourceId);
  assert.equal(s.experiences.artifact(scope,answer.artifactRef).body,'');
  assert.equal(s.experiences.hydrateFeedback(scope,f.id),null);
  assert.equal(s.memorySources(scope).some(x=>x.id===f.sourceId),false);
});

test('user corrects a derived understanding with a user report while original QQ and goal stay intact',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());s.setGoal(scope,'希望建立双方愿意的恋爱关系');
  const m=normalize(raw(),scope);s.add(scope,[m]);s.applyRelationshipPatch(scope,{claims:[claim(`qq:${m.messageId}`,{text:'她忙于考试'})]},options(s));
  const old=s.relationshipView(scope).claims[0],count=s.getCompanion(scope).turns.length;
  assert.equal(s.correctRelationshipClaim(scope,{id:old.id,expectedVersion:old.version+1,operation:'withdraw'}).applied,false);
  assert.equal(s.getCompanion(scope).turns.length,count);
  const result=s.correctRelationshipClaim(scope,{id:old.id,expectedVersion:old.version,operation:'correct',text:'我刚才理解错了，她是在忙工作'});
  assert.equal(result.applied,true,JSON.stringify(result));
  const view=s.relationshipView(scope);assert.equal(view.claims.find(c=>c.id===old.id).lifecycle,'withdrawn');
  const replacement=view.claims.find(c=>c.id===result.claimId);assert.equal(replacement.assertionKind,'reported');assert.ok(replacement.sourceIds.every(id=>id.startsWith('private:')));
  assert.equal(s.messages(scope)[0].text,m.text);assert.equal(s.getCompanion(scope).goal.text,'希望建立双方愿意的恋爱关系');
});

test('legacy retirement cannot corrupt the typed record lane',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const u=user(s,'她说近期很忙');s.applyRelationshipPatch(scope,{claims:[claim(`private:${u.id}`)]},options(s));
  const old=s.relationshipView(scope).claims[0];user(s,'这次改了');const b=s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope,b,complete(b,{retire:[{id:old.id,sourceIds:[b.sources.at(-1).id],status:'superseded'}]})).applied,false);
  assert.equal(s.relationshipView(scope).claims[0].subject,'contact');
});

test('historical relationship view hides future evidence and sharing does not overwrite coordination status',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());
  const add=(id,at,eventKind,text)=>{
    const m=normalize(raw(id,false,{msgTime:String(Date.parse(at)/1000),elements:[{textElement:{content:text}}]}),scope);s.add(scope,[m]);
    const r=s.applyRelationshipPatch(scope,{events:[{activityKey:'film',eventKind,actor:'contact',text,sourceIds:[`qq:${id}`]}]},options(s));assert.equal(r.applied,true);
  };
  add('72057594037927990','2026-10-10T10:00:00Z','acceptance','周日可以一起看');
  add('72057594037927991','2026-10-11T10:00:00Z','sharing','想起来电影有个有趣的情节');
  assert.equal(s.relationshipView(scope).activities[0].status,'accepted');
  add('72057594037927992','2026-10-13T10:00:00Z','cancellation','改天吧，这次先取消');
  const historical=s.relationshipView(scope,{asOf:'2026-10-12T10:00:00Z'});
  assert.equal(historical.activities[0].status,'accepted');assert.equal(historical.events.length,2);
});

test('duplicate source order and repeated rows in one model patch do not inflate profile evidence',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const a=user(s,'她以前说喜欢看电影'),b=user(s,'她提到最近看了一部电影');
  const ids=[`private:${a.id}`,`private:${b.id}`],c=claim(ids[0],{sourceIds:ids});
  assert.equal(s.applyRelationshipPatch(scope,{claims:[c,{...c,sourceIds:[...ids].reverse()}]},options(s)).applied,true);
  assert.equal(s.relationshipView(scope).claims.length,1);
  s.applyRelationshipPatch(scope,{claims:[{...c,sourceIds:[...ids].reverse()}]},options(s));
  assert.equal(s.relationshipView(scope).claims.length,1);
});

test('legacy feedback identity normalization preserves local notes and unsent artifact text',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const at='2026-10-10T10:00:00Z',alias='private:legacy-feedback-turn';
  const oldSource={id:alias,type:'private',text:'对助手建议的反馈：这句太正式',at,role:'user',use:'discussion',kind:'feedback',version:1};
  const revision=createHash('sha256').update(JSON.stringify(oldSource)).digest('hex');
  const record={revision:3,goal:{text:'愿意认真了解彼此',version:1},notes:[{id:'legacy-note',text:'用户用来继续修改的语气说明',use:'discussion',version:1,createdAt:at,updatedAt:at,evidenceSourceIds:[alias],evidenceRevisions:{[alias]:revision}}],turns:[{id:'legacy-response',role:'assistant',kind:'discussion',text:'先前的建议',requestId:'legacy-request',createdAt:at},{id:'legacy-feedback-turn',role:'user',kind:'feedback',text:oldSource.text,requestId:'legacy-request',createdAt:at}],state:{version:0,focus:'',items:[],openThreads:[],unknowns:[],possiblyStale:true,coverage:{complete:false,sourceIds:[]}},runs:[],feedback:[{id:'legacy-f',requestId:'legacy-request',text:'这句太正式',kind:'local',createdAt:at}],pendingActions:[],actionReceipts:[]};
  s.db.prepare('INSERT INTO companion VALUES(?,?)').run(s.scopeKey(scope),JSON.stringify(record));
  s.db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?,0)').run(s.scopeKey(scope),alias,revision,JSON.stringify({...oldSource,revision}));
  const ref={artifactId:'legacy-unsent',version:1};s.experiences._put(scope,'artifact','legacy-unsent@1',{ref,kind:'message_candidate',body:'仍在编辑的合成草稿',availability:'active',sourceIds:[alias],sourceRefs:[{sourceId:alias,revision}],createdAt:at});
  s.memorySources(scope);const after=s.getCompanion(scope);
  assert.equal(after.notes.length,1);assert.deepEqual(after.notes[0].evidenceSourceIds,['private:feedback-legacy-f']);
  assert.equal(s.experiences.artifact(scope,ref).body,'仍在编辑的合成草稿');
  assert.notEqual(s.experiences.artifact(scope,ref).availability,'redacted');
  assert.equal(s.memorySources(scope).some(source=>source.id===alias),false);
  s.forgetSource(scope,'private:feedback-legacy-f');assert.equal(s.experiences.artifact(scope,ref).body,'');
});

test('structural migration is atomic and future schema versions are rejected without writes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-relationship-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'rollback.db');let db=new DatabaseSync(filename);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,description TEXT NOT NULL); CREATE TRIGGER migration_failure BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END;");db.close();
  assert.throws(()=>new Store(filename),/synthetic migration failure/);db=new DatabaseSync(filename);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='memory_records'").get(),undefined);assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);db.exec('DROP TRIGGER migration_failure');db.close();
  let s=new Store(filename);assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,1);s.close();
  const future=path.join(dir,'future.db');db=new DatabaseSync(future);db.exec('PRAGMA user_version=99');db.close();
  assert.throws(()=>new Store(future),/newer|unsupported/i);db=new DatabaseSync(future);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,0);db.close();
});

test('an older new batch cannot retire later evidence merely by citing that later evidence too',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());const newer=normalize(raw('72057594037927999',false,{msgTime:'1791926000'}),scope);s.add(scope,[newer]);let b=s.memoryBatch(scope);
  s.applyMemoryBatch(scope,b,complete(b,{relationshipPatch:{events:[{activityKey:'movie',eventKind:'cancellation',actor:'contact',text:'这次取消',sourceIds:[`qq:${newer.messageId}`]}]}}));
  const event=s.relationshipView(scope).events[0];const older=normalize(raw('72057594037927990',false,{msgTime:'1791726000'}),scope);s.add(scope,[older]);b=s.memoryBatch(scope);
  const result=s.applyMemoryBatch(scope,b,complete(b,{relationshipPatch:{retire:[{id:event.id,expectedVersion:event.version,lifecycle:'withdrawn',sourceIds:[`qq:${older.messageId}`,`qq:${newer.messageId}`]}]}}));
  assert.equal(result.applied,false);assert.equal(s.relationshipView(scope).activities[0].status,'cancelled');
});

test('rereading a contact statement with a new user question and changed tags does not refresh or multiply it',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());
  const m=normalize(raw('72057594037927970',false,{msgTime:'1791326000',elements:[{textElement:{content:'最近在准备考试'}}]}),scope);s.add(scope,[m]);const sourceId=`qq:${m.messageId}`;
  const c=claim(sourceId,{topicKeys:['考试']});s.applyRelationshipPatch(scope,{claims:[c]},options(s));
  const first=s.relationshipView(scope).claims[0],question=user(s,'她之前忙考试，现在怎样了？');
  s.applyRelationshipPatch(scope,{claims:[{...c,sourceIds:[sourceId,`private:${question.id}`],topicKeys:['忙碌','考试']}]},options(s));
  const view=s.relationshipView(scope);assert.equal(view.claims.length,1);assert.equal(view.claims[0].lastEvidenceAt,first.lastEvidenceAt);
  assert.deepEqual(view.claims[0].sourceIds,[sourceId]);assert.ok(view.claims[0].topicKeys.includes('忙碌'));
});

test('forgetting a possible canonical target removes an ambiguous legacy plaintext mirror',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());s.saveRun(scope,{id:'ambiguous-request'});
  const a=s.addFeedback(scope,{requestId:'ambiguous-request',text:'同样的局部意见'});s.addFeedback(scope,{requestId:'ambiguous-request',text:'同样的局部意见'});
  const r=s.getCompanion(scope);r.turns.push({id:'ambiguous-mirror',role:'user',kind:'feedback',text:'对助手建议的反馈：同样的局部意见',requestId:'ambiguous-request',createdAt:new Date().toISOString()});
  s.db.prepare('UPDATE companion SET record=? WHERE scope_key=?').run(JSON.stringify(r),s.scopeKey(scope));s.memorySources(scope);
  s.forgetSource(scope,a.sourceId);
  const stored=JSON.parse(s.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(s.scopeKey(scope)).record);
  assert.equal(stored.turns.some(turn=>turn.id==='ambiguous-mirror'),false);
  assert.equal(s.getCompanion(scope).feedback.length,1);
});

test('state CAS persists canonical feedback references without creating a semantic revision on read',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());s.saveRun(scope,{id:'feedback-state'});
  s.addFeedback(scope,{requestId:'feedback-state',text:'这次语气太正式'});
  const before=s.getCompanion(scope),ids=s.memorySources(scope).map(source=>source.id);
  const state=s.applyState(scope,{},{baseRevision:before.revision,baseStateVersion:before.state.version,sourceIds:ids,coverage:{complete:true,sourceIds:ids}});
  assert.equal(state.applied,true);assert.equal(s.getCompanion(scope).revision,before.revision);
  const raw=JSON.parse(s.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(s.scopeKey(scope)).record);
  assert.deepEqual(raw.feedback,[]);assert.ok(raw.turns.filter(t=>t.kind==='feedback_ref').every(t=>!Object.hasOwn(t,'text')));
  assert.doesNotThrow(()=>s.saveRun(scope,{id:'after-state',baseRevision:before.revision,status:'complete'}));
});

test('a known start without an evidenced end never makes short-lived context permanently current',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());
  const m=normalize(raw(undefined,false,{elements:[{textElement:{content:'这周备考，周末想自己待着，先不约活动'}}]}),scope);s.add(scope,[m]);const sourceId=`qq:${m.messageId}`;
  const claims=['recent_context','boundary','coordination'].map(aspect=>claim(sourceId,{aspect,text:`她提到的${aspect}`,validFrom:'2026-10-11T00:00:00Z'}));
  assert.equal(s.applyRelationshipPatch(scope,{claims},options(s)).applied,true);
  const later=s.relationshipView(scope,{asOf:'2026-12-01T00:00:00Z'});
  assert.ok(later.claims.every(c=>c.applicability==='unspecified'));assert.ok(later.claims.every(c=>c.validUntil===undefined));
  s.applyRelationshipPatch(scope,{claims:[claim(sourceId,{text:'有明确范围的合成时间说明',validFrom:'2026-10-11T00:00:00Z',validUntil:'2026-10-16T00:00:00Z'})]},options(s));
  assert.equal(s.relationshipView(scope,{asOf:'2026-10-14T00:00:00Z'}).claims.find(c=>c.validUntil).applicability,'current');
  assert.equal(s.relationshipView(scope,{asOf:'2026-12-01T00:00:00Z'}).claims.find(c=>c.validUntil).applicability,'expired');
});

test('later maintenance cannot recreate an explicitly withdrawn interpretation from the same evidence',t=>{
 const s=new Store(':memory:');t.after(()=>s.close());
 const m=normalize(raw(),scope);s.add(scope,[m]);const proposal=claim(`qq:${m.messageId}`,{text:'她忙于考试',topicKeys:['考试']});
 assert.equal(s.applyRelationshipPatch(scope,{claims:[proposal]},options(s)).applied,true);
 const old=s.relationshipView(scope).claims[0];assert.equal(s.correctRelationshipClaim(scope,{id:old.id,expectedVersion:old.version,operation:'withdraw'}).applied,true);
 assert.equal(s.applyRelationshipPatch(scope,{claims:[{...proposal,topicKeys:['最近','考试']}]},options(s)).applied,true);
 const view=s.relationshipView(scope);assert.equal(view.claims.filter(x=>x.lifecycle==='active').length,0);
 assert.equal(view.claims.filter(x=>x.lifecycle==='withdrawn').length,1);
 const newer=normalize(raw('990000000000001',false,{msgTime:String(Math.floor(Date.now()/1000)+2),elements:[{textElement:{content:'我这周确实要准备考试'}}]}),scope);s.add(scope,[newer]);
 assert.equal(s.applyRelationshipPatch(scope,{claims:[{...proposal,sourceIds:[`qq:${newer.messageId}`]}]},options(s)).applied,true);
 assert.equal(s.relationshipView(scope).claims.filter(x=>x.lifecycle==='active').length,1,'new actual evidence can support a new understanding');
});
