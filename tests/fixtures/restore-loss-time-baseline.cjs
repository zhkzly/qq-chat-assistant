'use strict';
// Actual frozen041-created fictional state; restore/verify through raw SQLite
// before any current Store opens it. Historical code is never loaded by tests.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const sha=value=>createHash('sha256').update(value).digest('hex');
const sqlName=value=>'"'+value.replaceAll('"','""')+'"';
const pins={
  'loss-time-pre-041':{file:'c62203e39bc459c73afa8663814a1059ca412d3572915cde3a451c50f557c6f1',logical:'7d02028e57e313bfc328ac375473e91e551b6fb8081abbe180b83ec27d4d7255',records:3,gaps:0,pending:0,status:'cancelled'},
  'loss-time-post-041':{file:'1a2f2c5ccbc5f8f5f9ba361e902e44bea16247fe0bcee780e6676cdf2f18e48d',logical:'c4a7823cf5e99ec571055f1a74f79d346b2c532ebd2f25026c4e65bd145d9998',records:0,gaps:3,pending:1,status:'needs_review'}
};
function logicalSnapshot(db){
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
  const tables=schema.filter(row=>row.type==='table').map(table=>({name:table.name,columns:db.prepare('PRAGMA table_info('+sqlName(table.name)+')').all().map(column=>column.name),rows:db.prepare('SELECT rowid AS snapshot_rowid,* FROM '+sqlName(table.name)+' ORDER BY rowid').all()}));
  return {user_version:db.prepare('PRAGMA user_version').get().user_version,schema,tables,sequences:db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()};
}
function load(name){
  const pin=pins[name];assert.ok(pin,'known old041 fixture only');
  const bytes=fs.readFileSync(path.join(__dirname,name+'-snapshot.json'));assert.equal(sha(bytes),pin.file,'exact historical fixture bytes');
  const fixture=JSON.parse(bytes),p=fixture.provenance;
  assert.equal(fixture.format,'qq-fictional-sqlite-logical-snapshot-v1');
  assert.equal(p.source_revision,'9b865baaea0bf018ca771b241ac245ad20b0d8f7');
  assert.equal(p.source_backend_hash,'9290b8b0a6621bdd702e5590218996d1ff48ca33c687375a131a8562c84227ab');
  assert.equal(p.source_store_sha256,'eb30cafca43f488dbb4c8ff9c6a87e612dcc13b2b63a733dedfaec450e5ebbc3');
  assert.equal(p.input_fixture_sha256,'7b5f8246780fb84aa89f759683ea63e202661762b9d0478bfd65417912b5e6ba');
  assert.equal(p.generator_sha256,'6dc62711aa1e21709f24337a217265080d3568042bebff1717fddba1c7c58d42');
  assert.equal(p.logical_snapshot_sha256,pin.logical);assert.equal(sha(JSON.stringify(fixture.snapshot)),pin.logical);
  assert.equal(p.synthetic_only,true);assert.equal(p.http_attempts,0);
  assert.equal(JSON.stringify(fixture).includes('/home/'),false);assert.equal(JSON.stringify(fixture).includes('/tmp/'),false);
  assert.equal(fixture.expected.relationship.activities[0].status,pin.status);
  return fixture;
}
function verifyOldState(db,fixture,pin){
  const expected=fixture.expected,key=JSON.stringify(['accountUid','accountUin','peerUid','peerUin'].map(field=>expected.scope[field]));
  const rows=table=>db.prepare('SELECT * FROM '+sqlName(table)+' WHERE scope_key=? ORDER BY rowid').all(key);
  const sources=rows('memory_sources').filter(row=>!row.deleted).map(row=>JSON.parse(row.record)),byId=values=>[...values].sort((a,b)=>a.id.localeCompare(b.id));
  assert.deepEqual(byId(sources),byId(expected.sources),'old source IDs/revisions/body/times/permissions');
  const messages=db.prepare('SELECT record FROM messages WHERE account_uid=? AND peer_uid=? ORDER BY rowid').all(expected.scope.accountUid,expected.scope.peerUid).map(row=>JSON.parse(row.record));
  assert.deepEqual(messages,expected.messages,'old QQ IDs/times/recall state');
  const companion=JSON.parse(rows('companion')[0].record);assert.deepEqual(companion.notes,expected.companion.notes);assert.deepEqual(companion.goal,expected.companion.goal);
  assert.equal(companion.notes.find(note=>note.id==='old041-private-note').use,'discussion');
  const feedbacks=rows('experience_objects').filter(row=>row.kind==='feedback').map(row=>JSON.parse(row.record));assert.equal(feedbacks.length,1);assert.equal(feedbacks[0].id,expected.companion.feedback[0].id);assert.equal(feedbacks[0].text,expected.companion.feedback[0].text);
  assert.equal(rows('memory_records').length,pin.records);assert.equal(rows('memory_gaps').length,pin.gaps);assert.deepEqual(rows('memory_gaps').map(row=>({...row})),expected.gaps);assert.equal(rows('memory_journal').filter(row=>row.status==='pending').length,pin.pending);
  const original=expected.invalidatedOriginal;assert.equal(original.at,'2026-10-01T10:00:00.000Z');assert.equal(original.role,'user');
  for(const row of rows('memory_gaps')){
    const loss=JSON.parse(row.record).evidenceLoss;assert.ok(loss,'041 retained actual source-loss identity');
    assert.equal(loss.invalidatedOriginal.canonicalId,original.id);assert.equal(loss.invalidatedOriginal.previousRevision,original.revision);assert.equal(loss.invalidatedOriginal.authorRole,'user');assert.equal(loss.operationActor,'unknown');
    assert.deepEqual(Object.keys(loss.invalidatedOriginal).sort(),['authorRole','canonicalId','previousRevision','type'],'old loss stores no original time, despite saved original at');
  }
}
function restore(name,filename){
  assert.equal(fs.existsSync(filename),false,'snapshot restoration never overwrites a database');
  const fixture=load(name),{snapshot}=fixture,db=new DatabaseSync(filename);
  try{
    db.exec('BEGIN IMMEDIATE');for(const entry of snapshot.schema.filter(entry=>entry.type==='table'))db.exec(entry.sql);
    for(const table of snapshot.tables){const columns=['rowid',...table.columns],insert=db.prepare('INSERT INTO '+sqlName(table.name)+'('+columns.map(sqlName).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');for(const row of table.rows)insert.run(row.snapshot_rowid,...table.columns.map(column=>row[column]));}
    for(const entry of snapshot.schema.filter(entry=>entry.type!=='table'))db.exec(entry.sql);
    db.exec('DELETE FROM sqlite_sequence');for(const row of snapshot.sequences)db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);
    assert.equal(snapshot.user_version,2);db.exec('PRAGMA user_version=2; COMMIT');
    assert.equal(sha(JSON.stringify(logicalSnapshot(db))),fixture.provenance.logical_snapshot_sha256,'exact old logical DB before current Store open');verifyOldState(db,fixture,pins[name]);
  }finally{db.close();}
  return {fixture,expected:fixture.expected,oldStateVerifiedBeforeCurrent:true,loadedDbSha256:sha(fs.readFileSync(filename))};
}
module.exports={load,restore};
