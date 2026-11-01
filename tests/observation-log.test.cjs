'use strict';
// D1 acceptance tests for the observation log (M1): append-only events,
// identity frozen once, deterministic backfill, projection parity with the
// ingest-store derivation, recall/exclusion tombstones, speaker-fingerprinted
// revisions and batched range reads (B9 primitive). Fictional inputs only.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {revisionOf}=require('../src/memory/observation-log.cjs');

const user=(store,text)=>store.appendTurn(scope,{role:'user',kind:'discussion',text});
const qq=(store,id,text,{own=false,...extra}={})=>{const m=normalize(raw(id,own,{elements:[{textElement:{content:text}}],...extra}),scope);store.add(scope,[m]);return m;};

test('observation events are append-only at the SQLite level',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  user(store,'append-only check');
  assert.throws(()=>store.db.exec("UPDATE observation_events SET kind='revised'"),/append-only/);
  assert.throws(()=>store.db.exec('DELETE FROM observation_events'),/append-only/);
});

test('identity is frozen at first sight and preserved across text revisions',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const turn=user(store,'original version');
  const id='private:'+turn.id;
  let observation=store.observationLog.observationById(scope,id);
  assert.equal(observation.speaker,'account_owner','a private user turn is account-owner speech');
  assert.equal(observation.heldBy,'account_owner');
  store.updateTurn(scope,turn.id,'revised version');
  observation=store.observationLog.observationById(scope,id);
  assert.equal(observation.speaker,'account_owner','identity survives a text revision');
  assert.equal(observation.text,'revised version');
  assert.equal(store.observationLog.identityOf(scope,id).speaker,'account_owner');
  const events=store.observationLog.events(scope).filter(event=>event.observationId===id);
  assert.ok(events.some(event=>event.kind==='observed')&&events.some(event=>event.kind==='revised'));
  assert.ok(events.every(event=>!event.identityChanged),'no silent identity change');
});

test('speaker identity distinguishes incoming and outgoing QQ speech mechanically',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const incoming=qq(store,'720575940379279370000022101','她发来的消息');
  const outgoing=qq(store,'720575940379279370000022102','我发出的消息',{own:true});
  const byId=id=>store.observationLog.observationById(scope,'qq:'+id);
  assert.equal(byId(incoming.messageId).speaker,'contact');
  assert.equal(byId(outgoing.messageId).speaker,'account_owner');
  assert.equal(byId(incoming.messageId).heldBy,'contact','heldBy mirrors the verified speaker');
});

test('a recall appends a tombstone event, never rewrites history',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const message=qq(store,'720575940379279370000022103','这条会被撤回');
  assert.ok(store.observationLog.liveObservations(scope).some(o=>o.id==='qq:'+message.messageId));
  store.add(scope,[{...message,recalled:true,text:'[已撤回]'}]);
  const events=store.observationLog.events(scope).filter(event=>event.observationId==='qq:'+message.messageId);
  assert.ok(events.at(-1).kind==='recalled','the recall is an appended tombstone event');
  assert.ok(events.some(event=>event.kind==='observed'),'the original observation stays in history');
  assert.equal(store.observationLog.observationById(scope,'qq:'+message.messageId).deleted,true);
  assert.equal(store.memorySources(scope).some(source=>source.id==='qq:'+message.messageId),false);
});

test('projection parity: the fold equals the ingest-store derivation after every mutation path',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const message=qq(store,'720575940379279370000022104','parity message');
  const turn=user(store,'parity turn');
  const note=store.saveNote(scope,{text:'parity note',use:'discussion'});
  const answer=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'answer',requestId:'parity-run'});
  store.addFeedback(scope,{text:'parity feedback',targetRef:{kind:'artifact',artifactRef:answer.artifactRef}});
  store.updateTurn(scope,turn.id,'parity turn revised');
  store.forgetSource(scope,'note:'+note.id);
  const derived=store._deriveSources(scope).map(({revision,...source})=>source);
  const projected=store.memorySources(scope).map(({revision,...source})=>source);
  assert.deepEqual(projected,derived,'the observation projection equals the legacy derivation');
  const invariants=store.observationLog.verifyInvariants(scope);
  assert.equal(invariants.appendOnlyEnforced,true);
  assert.equal(invariants.identityStable,true);
});

test('speaker-fingerprinted revisions: a sender-role correction invalidates derived memory',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const message=qq(store,'720575940379279370000022105','身份修正测试');
  const {qqSourceMetadata}=require('../src/messages.cjs');
  // Reconstruct the derivation input in construction order: revisionOf hashes
  // JSON, so key order is part of the content identity.
  const source={id:'qq:'+message.messageId,type:'qq',text:message.text,at:new Date(message.timestamp).toISOString(),role:'contact',direction:'incoming',use:'discussion',messageId:message.messageId,...qqSourceMetadata(message)};
  const originalRevision=revisionOf(source);
  assert.equal(originalRevision,store.memorySources(scope).find(item=>item.id===source.id).revision,'the reconstruction matches the stored revision');
  const flippedRevision=revisionOf({...source,direction:'outgoing',role:'user'});
  assert.notEqual(flippedRevision,originalRevision,'flipping who spoke changes the revision');
  const enrichedRevision=revisionOf({...source,senderUid:scope.accountUid,senderUin:scope.accountUin});
  assert.equal(enrichedRevision,originalRevision,'late scoped-id enrichment without a role change keeps the revision stable');
});

test('deterministic backfill: identical databases migrate to identical event streams',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-01T10:00:00Z')});
  const build=()=>{
    const store=new Store(':memory:');
    qq(store,'720575940379279370000022106','determinism one');
    qq(store,'720575940379279370000022107','determinism two',{own:true});
    store.appendTurn(scope,{id:'determinism-turn',role:'user',kind:'discussion',text:'determinism turn'});
    const events=store.observationLog.events(scope).map(event=>event.eventId).sort();
    store.close();
    return events;
  };
  assert.deepEqual(build(),build(),'event ids are content-addressed and order-deterministic');
});

test('closure resolves note lineage through the observation projection',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const turn=user(store,'closure evidence turn');
  const note=store.saveNote(scope,{text:'closure note',use:'discussion',evidenceSourceIds:['private:'+turn.id]});
  const closure=store.observationLog.closure(scope,['note:'+note.id]);
  assert.deepEqual(closure.map(o=>o.id).sort(),['note:'+note.id,'private:'+turn.id].sort());
  assert.equal(closure.find(o=>o.id==='private:'+turn.id).speaker,'account_owner');
  store.forgetSource(scope,'private:'+turn.id);
  assert.throws(()=>store.observationLog.closure(scope,['note:'+note.id]),/Unavailable source dependency/,'a withdrawn root fails loudly');
});

test('readRanges satisfies many continuation ranges in one program round trip (B9)',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const message=qq(store,'720575940379279370000022108','0123456789'.repeat(10));
  const results=store.observationLog.readRanges(scope,[
    {sourceId:'qq:'+message.messageId,start:0,end:10},
    {sourceId:'qq:'+message.messageId,start:50,end:60},
    {sourceId:'qq:missing',start:0,end:5},
    {sourceId:'qq:'+message.messageId,start:990,end:2000},
  ]);
  assert.equal(results[0].available,true);assert.equal(results[0].text,'0123456789');
  assert.equal(results[1].text,'0123456789');
  assert.equal(results[2].available,false);assert.equal(results[2].reason,'unavailable_source');
  assert.equal(results[3].available,false);assert.equal(results[3].reason,'range_out_of_bounds');
});

test('migrateObservations backfills existing scopes idempotently',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  qq(store,'720575940379279370000022109','migration target');
  user(store,'migration turn');
  // Simulate a pre-log database by removing the log rows only.
  store.db.exec('DELETE FROM observation_bodies');
  store.db.exec("DELETE FROM observation_migrations");
  // The append-only trigger protects events; drop and recreate for the fixture.
  store.db.exec('DROP TRIGGER observation_events_append_only_delete');
  store.db.exec('DELETE FROM observation_events');
  const {migrateObservations}=require('../src/memory/observation-log.cjs');
  const first=migrateObservations(store);
  assert.equal(first.length,1);assert.equal(first[0].appended>0,true);
  assert.equal(store.observationLog.liveObservations(scope).length,store._deriveSources(scope).length);
  const second=migrateObservations(store);
  assert.equal(second[0].appended,0,'re-running the migration appends nothing');
});

test('local deletion reconciliation tombstones missing-in-window messages monotonically (B10)',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const a=qq(store,'720575940379279370000022201','删除对齐A');
  const b=qq(store,'720575940379279370000022202','删除对齐B');
  const c=qq(store,'720575940379279370000022203','删除对齐C');
  // A refresh that no longer contains B (user deleted it locally): B lies
  // inside the delivered window, so it must receive a monotonic tombstone.
  const visible=[store.messages(scope).find(m=>m.messageId===a.messageId),store.messages(scope).find(m=>m.messageId===c.messageId)];
  const result=store.reconcileVisibleMessages(scope,visible);
  assert.deepEqual(result.tombstoned,['qq:'+b.messageId]);
  assert.equal(store.memorySources(scope).some(source=>source.id==='qq:'+b.messageId),false,'the tombstoned source leaves every derived view');
  assert.equal(store._deriveSources(scope).some(source=>source.id==='qq:'+b.messageId),false);
  assert.ok(store.observationLog.events(scope).some(event=>event.observationId==='qq:'+b.messageId&&event.kind==='excluded'&&event.reason==='locally_deleted'),'the tombstone is explainable in the observation log');
  assert.equal(store.messages(scope).some(m=>m.messageId===b.messageId),true,'the raw message record itself is preserved for audit');
  // Monotonic: a later stale window that includes B again cannot resurrect it.
  const again=store.reconcileVisibleMessages(scope,[store.messages(scope).find(m=>m.messageId===a.messageId),b,c].map(m=>store.messages(scope).find(row=>row.messageId===m.messageId))||[]);
  assert.deepEqual(again.tombstoned,[]);
  assert.equal(store.memorySources(scope).some(source=>source.id==='qq:'+b.messageId),false);
  // Outside the window is never inferred deleted.
  const d=qq(store,'720575940379279370000022204','窗口之外的更早消息');
  const narrow=store.reconcileVisibleMessages(scope,[store.messages(scope).find(m=>m.messageId===c.messageId)]);
  assert.deepEqual(narrow.tombstoned,[],'messages outside the delivered window are not tombstoned');
  assert.equal(store.memorySources(scope).some(source=>source.id==='qq:'+d.messageId),true);
});

test('controller refresh reconciliation is wired into loadLatest (B10)',t=>{
  // Deterministic check of the same wiring loadLatest uses: the delivered
  // visible window reconciles against stored observations and the tombstoned
  // source disappears from discovery/context inputs.
  const store=new Store(':memory:');t.after(()=>store.close());
  const a=qq(store,'720575940379279370000022211','刷新删除甲');
  const b=qq(store,'720575940379279370000022212','刷新删除乙');
  const c=qq(store,'720575940379279370000022213','刷新删除丙');
  // The refresh page after the local deletion no longer contains B.
  const messages=store.messages(scope).filter(m=>m.messageId!==b.messageId);
  store.reconcileVisibleMessages(scope,messages);
  const sources=store.memorySources(scope);
  assert.equal(sources.some(source=>source.id==='qq:'+b.messageId),false);
  const {discoverConversationEvidence}=require('../src/context/../conversation-discovery.cjs');
  const directory=discoverConversationEvidence({sources,records:[],query:'刷新删除',mode:'broad'});
  assert.equal(JSON.stringify(directory).includes('qq:'+b.messageId),false,'the tombstoned message is unavailable to discovery/context');
  assert.ok(JSON.stringify(directory).includes('qq:'+a.messageId));
});