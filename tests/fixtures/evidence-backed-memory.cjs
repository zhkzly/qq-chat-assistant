'use strict';
// Fictional inputs use production Store/message APIs. This fixture does not
// provide semantic quality scores and never reads a user database.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {scope,raw}=require('./native.cjs');
const FROZEN_REVISION='009b4aa332e2b5ddd6e6a719930aaf391358852a';
const FROZEN_STORE_SHA256='a71f9da170145b3d2c72f7be41c148bc09a7f15b5977e6cfeac26ffed0846b1c';
function legacyRoot(){
 // Isolated source candidates can read the same frozen worktree explicitly;
 // revision and Store-byte assertions below remain mandatory.
 if(process.env.QQ_TEST_FROZEN_LEGACY_ROOT)return path.resolve(process.env.QQ_TEST_FROZEN_LEGACY_ROOT);
 const root=path.resolve(__dirname,'../..'),marker=path.join(root,'.git');
 const gitdir=fs.statSync(marker).isDirectory()?marker:path.resolve(root,fs.readFileSync(marker,'utf8').trim().replace(/^gitdir: /,''));
 const common=fs.existsSync(path.join(gitdir,'commondir'))?path.resolve(gitdir,fs.readFileSync(path.join(gitdir,'commondir'),'utf8').trim()):gitdir;
 return path.join(path.dirname(common),'.worktrees/eval-coverage-fidelity-20261029');
}
function frozenLegacy(){
 const root=legacyRoot(),file=path.join(root,'src/store.cjs');
 const gitdir=path.resolve(root,fs.readFileSync(path.join(root,'.git'),'utf8').trim().replace(/^gitdir: /,''));
 const head=fs.readFileSync(path.join(gitdir,'HEAD'),'utf8').trim();
 const revision=head.startsWith('ref: ')?fs.readFileSync(path.resolve(gitdir,fs.readFileSync(path.join(gitdir,'commondir'),'utf8').trim(),head.slice(5)),'utf8').trim():head;
 assert.equal(revision,FROZEN_REVISION,'use the actual frozen baseline worktree');
 assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),FROZEN_STORE_SHA256,'baseline Store bytes must remain frozen');
 return {root,Store:require(file).Store,normalize:require(path.join(root,'src/messages.cjs')).normalize};
}
const complete=(batch,extra={})=>({reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[],...extra});
function options(store,extra={}){
 const sources=store.memorySources(scope);
 return {baseRevision:store.getCompanion(scope).revision,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),...extra};
}
function addQQ(store,normalize,id,text,{at='2026-09-01T10:00:00Z',own=false,...extra}={}){
 const message=normalize(raw(id,own,{msgTime:String(Date.parse(at)/1000),elements:[{textElement:{content:text}}],...extra}),scope);
 store.add(scope,[message]);return message;
}
function claim(sourceId,extra={}){
 return {subject:'contact',aspect:'recent_context',text:'The contact reported temporary shift work.',assertionKind:sourceId.startsWith('qq:')?'stated':'reported',epistemicStatus:'supported',sourceIds:[sourceId],...extra};
}
function tableRows(db,table){return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>({...row}));}
function snapshot(store){
 const sources=store.memorySources(scope),companion=store.getCompanion(scope),view=store.relationshipView(scope);
 return {sources,companion,view,records:tableRows(store.db,'memory_records'),journal:tableRows(store.db,'memory_journal'),
  messages:store.messages(scope),status:store.memoryStatus(scope),schemaVersion:store.db.prepare('PRAGMA user_version').get().user_version};
}
function buildLegacyDatabase(filename){
 const frozen=frozenLegacy(),store=new frozen.Store(filename);
 const qqId='720575940379279370000022001',recalledId='720575940379279370000022002',forgottenId='720575940379279370000022003';
 try{
  store.setGoal(scope,'Understand each other and keep ordinary contact.');
  const original=addQQ(store,frozen.normalize,qqId,'Last month I worked evening shifts. I also like climbing.');
  const recalled=addQQ(store,frozen.normalize,recalledId,'A fictional recalled observation.');
  const forgotten=addQQ(store,frozen.normalize,forgottenId,'A fictional excluded observation.');
  const recurring=store.appendTurn(scope,{id:'legacy-recurring',role:'user',kind:'discussion',text:'When we discuss work, I prefer the complete wording before its explanation.'});
  const corrected=store.appendTurn(scope,{id:'legacy-corrected-source',role:'user',kind:'discussion',text:'A fictional source before correction.'});
  store.updateTurn(scope,corrected.id,'A fictional source after correction.');
  const preference=store.saveNote(scope,{id:'legacy-preference',kind:'preference',use:'discussion',text:recurring.text,evidenceSourceIds:['private:'+recurring.id]});
  store.saveNote(scope,{id:'legacy-material',kind:'material',use:'discussion',text:'A fictional personal material.',evidenceSourceIds:['private:'+corrected.id]});
  store.saveNote(scope,{id:'legacy-disabled',use:'disabled',text:'A preserved disabled note.'});
  let batch=store.memoryBatch(scope);
  assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{items:[{kind:'fact',text:'The contact once described shift work and climbing.',sourceIds:['qq:'+qqId],topicKeys:['work','climbing']}],episodes:[{text:'A historical conversation about work and climbing.',sourceIds:['qq:'+qqId],topicKeys:['work','climbing']}]})).applied,true);
  assert.equal(store.applyRelationshipPatch(scope,{claims:[claim('qq:'+qqId),claim('qq:'+qqId,{aspect:'interest',text:'The contact likes climbing.'})]},options(store)).applied,true);
  const old=store.relationshipView(scope).claims.find(c=>c.aspect==='recent_context');
  const correction=store.correctRelationshipClaim(scope,{id:old.id,expectedVersion:old.version,operation:'correct',text:'That was a temporary shift rather than her current job.'});
  assert.equal(correction.applied,true,JSON.stringify(correction));
  const interest=store.relationshipView(scope).claims.find(c=>c.aspect==='interest');
  assert.equal(store.correctRelationshipClaim(scope,{id:interest.id,expectedVersion:interest.version,operation:'withdraw'}).applied,true);
  store.add(scope,[{...recalled,recalled:true,text:'[已撤回]'}]);
  assert.equal(store.forgetSource(scope,'qq:'+forgottenId),true);
  store.add(scope,[forgotten]);
  while((batch=store.memoryBatch(scope)))assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).applied,true);
  const long=store.appendTurn(scope,{id:'legacy-unfinished',role:'user',kind:'discussion',text:'A fictional long source. '.repeat(2000)});
  batch=store.memoryBatch(scope,{maxBytes:4000});
  assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).applied,true);
  assert.ok(batch.events[0].end<batch.sources[0].segment.total);
  return {before:snapshot(store),ids:{qqId,recalledId,forgottenId,oldClaimId:old.id,correctedClaimId:correction.claimId,interestId:interest.id,preferenceId:preference.id,longSourceId:'private:'+long.id},original,frozenRevision:FROZEN_REVISION};
 }finally{store.close();}
}
module.exports={scope,complete,options,addQQ,claim,tableRows,snapshot,frozenLegacy,buildLegacyDatabase,FROZEN_REVISION};
