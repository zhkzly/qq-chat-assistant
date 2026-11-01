'use strict';
// Restore actual old040-created fictional state before any current Store opens
// it. This follows the existing logical SQLite fixture format; no old code runs.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const sha=value=>createHash('sha256').update(value).digest('hex');
const sqlName=value=>'"'+value.replaceAll('"','""')+'"';
const pins={
  'withdrawal-pre-040':{
    file:'df00e2f129b890fb9fba8bfda4af961ac8bbb7842402c2cca9c7cb32c6dd3619',
    logical:'7e8f8186beeb6caa452198ae412645c014237a117c69792a17a19757757142a6',
    records:3,gaps:0,pending:0,status:'cancelled'
  },
  'withdrawal-post-040':{
    file:'0e9204896f50682e1b7e3a9bed408515769521feb267d429d7608b82da97fe61',
    logical:'e824e939e1b7905c855312521d3dfbce7690dcf72bb02f190e0d5da96960cde9',
    records:2,gaps:1,pending:1,status:'needs_review'
  }
};
function logicalSnapshot(db){
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
  const tables=schema.filter(row=>row.type==='table').map(table=>({
    name:table.name,
    columns:db.prepare('PRAGMA table_info('+sqlName(table.name)+')').all().map(column=>column.name),
    rows:db.prepare('SELECT rowid AS snapshot_rowid,* FROM '+sqlName(table.name)+' ORDER BY rowid').all()
  }));
  return {user_version:db.prepare('PRAGMA user_version').get().user_version,schema,tables,sequences:db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()};
}
function load(name){
  const pin=pins[name];assert.ok(pin,'known old040 fixture only');
  const bytes=fs.readFileSync(path.join(__dirname,name+'-snapshot.json'));
  assert.equal(sha(bytes),pin.file,'exact historical fixture bytes');
  const fixture=JSON.parse(bytes),p=fixture.provenance;
  assert.equal(fixture.format,'qq-fictional-sqlite-logical-snapshot-v1');
  assert.equal(p.source_revision,'8165b8ee1a76991ba4c28f65c42d08de4ad1461c');
  assert.equal(p.source_backend_hash,'6a0201f4d76ce6bc9aa2a952c2ef0d432b3a35f66f308d880faeaf87582b2aa1');
  assert.equal(p.source_store_sha256,'4459e63ff814e524651beec08f39f2876915ebf73e6380cf77dfe91fea3e24a2');
  assert.equal(p.input_fixture_sha256,'7b5f8246780fb84aa89f759683ea63e202661762b9d0478bfd65417912b5e6ba');
  assert.equal(p.generator_sha256,'d3e82b6b0b460b9f9d774db9ceb6d97e5ceb442655cac832de909d8141d57882');
  assert.equal(p.logical_snapshot_sha256,pin.logical);
  assert.equal(sha(JSON.stringify(fixture.snapshot)),pin.logical);
  assert.equal(p.synthetic_only,true);assert.equal(p.http_attempts,0);
  assert.equal(JSON.stringify(fixture).includes('/home/'),false);
  assert.equal(JSON.stringify(fixture).includes('/tmp/'),false);
  assert.equal(fixture.expected.relationship.activities[0].status,pin.status);
  return fixture;
}
function verifyOldState(db,fixture,pin){
  const expected=fixture.expected,key=JSON.stringify(['accountUid','accountUin','peerUid','peerUin'].map(field=>expected.scope[field]));
  const rows=table=>db.prepare('SELECT * FROM '+sqlName(table)+' WHERE scope_key=? ORDER BY rowid').all(key);
  const sources=rows('memory_sources').filter(row=>!row.deleted).map(row=>JSON.parse(row.record));
  const byId=values=>[...values].sort((a,b)=>a.id.localeCompare(b.id));
  assert.deepEqual(byId(sources),byId(expected.sources),'old raw sources, versions, times and permissions');
  const messages=db.prepare('SELECT record FROM messages WHERE account_uid=? AND peer_uid=? ORDER BY rowid').all(expected.scope.accountUid,expected.scope.peerUid).map(row=>JSON.parse(row.record));
  assert.deepEqual(messages,expected.messages,'old actual QQ IDs/body/time/recall unchanged');
  const companion=JSON.parse(rows('companion')[0].record);
  assert.deepEqual(companion.notes,expected.companion.notes);
  assert.deepEqual(companion.goal,expected.companion.goal);
  assert.equal(companion.notes.find(note=>note.id==='old040-private-note').use,'discussion');
  const feedbacks=rows('experience_objects').filter(row=>row.kind==='feedback').map(row=>JSON.parse(row.record));
  assert.equal(feedbacks.length,1);
  assert.equal(feedbacks[0].id,expected.companion.feedback[0].id);
  assert.equal(feedbacks[0].text,expected.companion.feedback[0].text);
  assert.equal(rows('memory_records').length,pin.records);
  assert.equal(rows('memory_gaps').length,pin.gaps);
  assert.deepEqual(rows('memory_gaps').map(row=>({...row})),expected.gaps);
  assert.equal(rows('memory_journal').filter(row=>row.status==='pending').length,pin.pending);
  for(const row of rows('memory_gaps')){
    const gap=JSON.parse(row.record);
    assert.equal('evidenceLoss' in gap,false,'old gap has no newly inferred provenance');
    assert.equal('evidenceLosses' in gap,false,'old gap has no newly inferred provenance');
    assert.equal('lossProvenance' in gap,false,'old gap has no newly inferred provenance');
  }
}
function restore(name,filename){
  assert.equal(fs.existsSync(filename),false,'snapshot restoration never overwrites a database');
  const fixture=load(name),{snapshot}=fixture,db=new DatabaseSync(filename);
  try{
    db.exec('BEGIN IMMEDIATE');
    for(const entry of snapshot.schema.filter(entry=>entry.type==='table'))db.exec(entry.sql);
    for(const table of snapshot.tables){
      const columns=['rowid',...table.columns];
      const insert=db.prepare('INSERT INTO '+sqlName(table.name)+'('+columns.map(sqlName).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
      for(const row of table.rows)insert.run(row.snapshot_rowid,...table.columns.map(column=>row[column]));
    }
    for(const entry of snapshot.schema.filter(entry=>entry.type!=='table'))db.exec(entry.sql);
    db.exec('DELETE FROM sqlite_sequence');
    for(const row of snapshot.sequences)db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);
    assert.equal(snapshot.user_version,2);db.exec('PRAGMA user_version=2; COMMIT');
    assert.equal(sha(JSON.stringify(logicalSnapshot(db))),fixture.provenance.logical_snapshot_sha256,'exact old logical database before current Store open');
    verifyOldState(db,fixture,pins[name]);
  }finally{db.close();}
  return {fixture,expected:fixture.expected,oldStateVerifiedBeforeCurrent:true,loadedDbSha256:sha(fs.readFileSync(filename))};
}
module.exports={load,restore};
