'use strict';
// tests/observation-migration.test.cjs — D1 baseline-DB upgrade scenario
// (design docs/dsh-subsystem-redesign.md 6.1 and goal.json
// evidence.lifecycle.requirement): a fictional database created by the frozen
// 009b4aa baseline Store is upgraded by the candidate and the observation log
// must preserve original QQ message IDs (strings), source times, disclosure
// purpose (authored-note permissions), withdrawal/recall tombstones and
// feedback identity — with a deterministic, idempotent event backfill. No
// real chats, no model calls, no desktop integration.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store.cjs');
const {scope,buildLegacyDatabase}=require('./fixtures/evidence-backed-memory.cjs');

function database(t,name){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-observation-migration-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,name);
  buildLegacyDatabase(filename);
  return filename;
}

test('upgrading a baseline database backfills a deterministic observation event stream',t=>{
  // The fixture mints fresh turn/feedback uuids per build, so determinism is
  // proven on byte-identical copies of ONE baseline database (the real upgrade
  // scenario): both copies must produce the same content-addressed events.
  const a=database(t,'copy-a.sqlite'),b=path.join(path.dirname(a),'copy-b.sqlite');
  fs.copyFileSync(a,b);
  const first=new Store(a);t.after(()=>first.close());
  first.memorySources(scope);
  const stream=store=>store.observationLog.events(scope).map(event=>({eventId:event.eventId,observationId:event.observationId,kind:event.kind}));
  const eventsA=stream(first);
  assert.ok(eventsA.length>=6,'the legacy state backfills into observation events');
  const second=new Store(b);t.after(()=>second.close());
  second.memorySources(scope);
  assert.deepEqual(stream(second),eventsA,'two copies of the same baseline database produce identical event streams');
});

test('the observation projection preserves ids, times, disclosure and recall identity after upgrade',t=>{
  const filename=database(t,'identity.sqlite');
  const store=new Store(filename);t.after(()=>store.close());
  // First use backfills the log (same entry point every consumer goes through).
  store.memorySources(scope);
  const observations=store.observationLog.liveObservations(scope);
  const byId=new Map(observations.map(o=>[o.id,o]));
  // Original QQ message identity: string ids, source time, speaker role.
  const qqObservation=[...byId.values()].find(o=>o.type==='qq');
  assert.ok(qqObservation);
  assert.equal(typeof qqObservation.messageId,'string');
  assert.equal(qqObservation.id,'qq:'+qqObservation.messageId);
  assert.equal(qqObservation.speaker,'contact','the incoming baseline message proves contact speech');
  assert.equal(qqObservation.at,'2026-09-01T10:00:00.000Z','the source time is preserved');
  // Recall tombstone: the recalled baseline message is absent from the live
  // projection and recorded as a recall event, never silently dropped.
  const recalledId='qq:720575940379279370000022002';
  assert.equal(byId.has(recalledId),false);
  const recalledEvents=store.observationLog.events(scope).filter(event=>event.observationId===recalledId);
  assert.ok(recalledEvents.some(event=>event.kind==='recalled'),'the pre-log recall is an appended tombstone');
  assert.equal(recalledEvents.some(event=>event.kind==='observed'),false,'no observed body is invented for history the log never saw');
  // Excluded (forgotten) source: absent live, exclusion event in history.
  const forgottenId='qq:720575940379279370000022003';
  assert.equal(byId.has(forgottenId),false);
  assert.ok(store.observationLog.events(scope).some(event=>event.observationId===forgottenId&&event.kind==='excluded'));
  // Disclosure purpose: the disabled note never becomes an observation; the
  // preference note keeps its use/kind provenance in its descriptor.
  assert.equal([...byId.values()].some(o=>o.id==='note:legacy-disabled'),false);
  const preferenceNote=byId.get('note:legacy-preference');
  assert.ok(preferenceNote,'the enabled note is observed');
  assert.equal(preferenceNote.use,'discussion');
  assert.equal(preferenceNote.kind,'preference');
  assert.ok(preferenceNote.evidenceSourceIds?.includes('private:legacy-recurring'),'note lineage survives');
  // Feedback identity: the baseline fixture carries no feedback rows; feedback
  // identity is covered by tests/observation-log.test.cjs (speaker parity) and
  // the alias-normalization regression in relationship-store tests.
  const invariants=store.observationLog.verifyInvariants(scope);
  assert.equal(invariants.appendOnlyEnforced,true);
  assert.equal(invariants.identityStable,true);
});

test('reopening the upgraded database appends no further observation events',t=>{
  const filename=database(t,'idempotent.sqlite');
  let store=new Store(filename);
  store.memorySources(scope);store.relationshipView(scope);
  const count=store.observationLog.events(scope).length;
  const receipt=store.observationLog.migrationReceipt(scope);
  assert.ok(receipt,'the backfill wrote a migration receipt');
  store.close();
  store=new Store(filename);t.after(()=>store.close());
  store.memorySources(scope);store.relationshipView(scope);
  assert.equal(store.observationLog.events(scope).length,count,'reopening is event-idempotent');
  assert.equal(store.observationLog.migrationReceipt(scope).at,receipt.at,'the receipt is not rewritten');
});

test('migrateObservations covers scopes present only in the companion table',t=>{
  const filename=database(t,'companion-only.sqlite');
  const store=new Store(filename);t.after(()=>store.close());
  const {migrateObservations}=require('../src/memory/observation-log.cjs');
  const results=migrateObservations(store);
  assert.ok(results.length>=1);
  assert.ok(results.every(result=>result.live===store._deriveSources(scope).length));
  assert.equal(store.observationLog.verifyInvariants(scope).appendOnlyEnforced,true);
});
