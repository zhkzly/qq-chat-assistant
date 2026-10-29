'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {loadCalibration,blindItems,evaluateReviews}=require('../scripts/eval-reviewer-calibration.cjs');
const V1_HASH='3da045d1183317900d1b7dff52f4892b38a4424d84407918388bcf2603d78fb8';
const V1_DIR=path.resolve(__dirname,'../evals/assistant/calibration/versions/v1');
const EXPECTED={
 'assistant-calibration-reference-v1':{total:16,bands:{good:6,ordinary:4,bad:5,uncertain:1}},
 'assistant-calibration-reference-v2':{total:20,bands:{good:8,ordinary:4,bad:7,uncertain:1}}
};

function observedReferences(data){return {schema_version:1,dataset_hash:data.datasetHash,rubric_version:data.rubric.version,reference_version:data.reference.version,reviewer_id:'functional-fixture-not-an-actual-review',items:data.anchors.map(item=>({id:item.id,overall:item.reference.overall,evidence:structuredClone(item.reference.evidence),hard_failure_flags:[...item.reference.hard_failure_flags]}))};}

test('authored calibration anchors are balanced, versioned, fictional and independent of product data',()=>{
 const latest=loadCalibration();assert.equal(latest.reference.version,'assistant-calibration-reference-v2');
 for(const data of [loadCalibration({dir:V1_DIR}),latest]){
  const expected=EXPECTED[data.reference.version];assert.ok(expected);assert.equal(data.anchors.length,expected.total);assert.match(data.datasetHash,/^[a-f0-9]{64}$/);
  for(const [band,count] of Object.entries(expected.bands))assert.equal(data.anchors.filter(item=>item.reference.band===band).length,count);
  assert.equal(data.reference.human_verified,false);assert.equal(data.reference.unseen_holdout,false);assert.equal(data.reference.authored_by,'AI');
  for(const item of data.anchors){assert.match(item.id,/^c\d\d$/);assert.ok(item.context.current_request.text);assert.ok(item.candidate.text);}
 }
});

test('v1 archive retains the exact frozen hash and all old anchors and rubric remain unchanged in v2',()=>{
 const archived=loadCalibration({dir:V1_DIR}),latest=loadCalibration();assert.equal(archived.datasetHash,V1_HASH);
 assert.deepEqual(latest.anchors.slice(0,16),archived.anchors);assert.equal(latest.reference.version,'assistant-calibration-reference-v2');
 assert.ok(fs.readFileSync(path.join(latest.directory,'anchors.jsonl'),'utf8').startsWith(fs.readFileSync(path.join(V1_DIR,'anchors.jsonl'),'utf8')),'v1 JSONL bytes remain the unchanged prefix');
 assert.deepEqual(fs.readFileSync(path.join(latest.directory,'rubric.json')),fs.readFileSync(path.join(V1_DIR,'rubric.json')));
 assert.equal(latest.rubric.version,archived.rubric.version);
 assert.equal(latest.reference.extension.previous_dataset_hash,V1_HASH);assert.deepEqual(latest.reference.extension.unchanged_anchor_ids,archived.anchors.map(item=>item.id));assert.deepEqual(latest.reference.extension.added_anchor_ids,['c17','c18','c19','c20']);
 assert.throws(()=>latest.evaluateReviews(observedReferences(archived)),/dataset_hash mismatch/,'v1 judgments cannot silently become fresh v2 judgments');
});

test('all four hard-failure flags have bad positive anchors and added pairs have clean good controls',()=>{
 const data=loadCalibration(),byId=new Map(data.anchors.map(item=>[item.id,item]));
 for(const flag of data.rubric.hard_failure_flags)assert.ok(data.anchors.some(item=>item.reference.band==='bad'&&item.reference.hard_failure_flags.includes(flag)),`${flag} needs a bad positive example`);
 for(const [badId,goodId,flag] of [['c17','c18','private_material_disclosure'],['c19','c20','unobserved_action_claim']]){
  const bad=byId.get(badId),good=byId.get(goodId);assert.deepEqual(bad.context,good.context);assert.equal(bad.reference.overall,'rewrite');assert.deepEqual(bad.reference.hard_failure_flags,[flag]);assert.equal(good.reference.overall,'usable');assert.deepEqual(good.reference.hard_failure_flags,[]);
 }
 assert.ok(byId.get('c17').context.private_discussion[0].text.includes('不授权'));assert.ok(byId.get('c17').context.private_discussion[0].text.includes('我其实很怕自己表现不好，有点紧张。'));
 assert.ok(byId.get('c19').context.private_discussion[0].text.includes('还没去QQ发送'));
});

test('blinded export removes reference labels, rationales, descriptive IDs and reference provenance',()=>{
 const data=loadCalibration(),items=blindItems(data),exported=data.blindedExport();assert.deepEqual(items,data.blindItems());
 assert.equal(exported.dataset_hash,data.datasetHash);assert.equal(exported.reference_version,data.reference.version);
 assert.deepEqual(exported.items,items);assert.ok(exported.rubric.overall_ratings.includes('minor_edit'));
 for(const [i,item] of items.entries()){
  assert.deepEqual(Object.keys(item).sort(),['candidate','context','id']);assert.equal(item.id,data.anchors[i].id);
  assert.equal(JSON.stringify(item).includes(data.anchors[i].reference.rationale),false);
 }
 assert.equal(Object.hasOwn(exported,'reference'),false);assert.equal(Object.hasOwn(exported,'authored_by'),false);
 assert.ok(exported.review_template.items.every(item=>item.overall===null&&item.evidence.length===0));
 items[0].candidate.text='changed';assert.notEqual(data.anchors[0].candidate.text,'changed');
});

test('known matching judgments and deliberately reversed judgments produce observable different counts',()=>{
 const data=loadCalibration(),matching=observedReferences(data),report=evaluateReviews(data,matching);
 assert.equal(report.summary.agreement.count,data.anchors.length);assert.equal(report.summary.bad_correctly_flagged.count,report.summary.bad_correctly_flagged.denominator);
 assert.equal(report.summary.good_false_alarm.count,0);assert.equal(report.semantic_evaluation,'observed_review_compared_to_provisional_references');
 assert.deepEqual(report.summary.nonhard_reference_with_observed_hard_flags,{count:0,denominator:13});assert.deepEqual(report.summary.hard_reference_detected,{count:7,denominator:7});
 const overflagged=structuredClone(matching);overflagged.items.find(item=>item.id==='c08').hard_failure_flags=['current_boundary_violation'];
 assert.deepEqual(data.evaluateReviews(overflagged).summary.nonhard_reference_with_observed_hard_flags,{count:1,denominator:13});
 const reversed=structuredClone(matching);
 for(const item of reversed.items){if(item.overall==='usable')item.overall='rewrite';else if(item.overall==='rewrite')item.overall='usable';item.hard_failure_flags=[];}
 const wrong=data.evaluateReviews(reversed);assert.equal(wrong.summary.bad_correctly_flagged.count,0);assert.equal(wrong.summary.good_false_alarm.count,wrong.summary.good_false_alarm.denominator);assert.ok(wrong.summary.agreement.count<report.summary.agreement.count);
 assert.deepEqual(wrong.actual_judgments,reversed);assert.deepEqual(wrong.items[0].observed.evidence,reversed.items[0].evidence);
});

test('missing, explicitly ungraded and insufficient-evidence judgments stay separate from agreement',()=>{
 const data=loadCalibration(),reviews=observedReferences(data),missing=reviews.items.pop();reviews.items[0]={id:reviews.items[0].id,overall:null,evidence:[],hard_failure_flags:[]};reviews.items[1].overall='insufficient_evidence';
 const report=data.evaluateReviews(reviews);assert.equal(report.summary.missing,1);assert.equal(report.summary.ungraded,1);assert.equal(report.summary.uncertain_observed,data.anchors.filter(item=>item.reference.overall==='insufficient_evidence').length+1);assert.equal(report.summary.agreement.denominator,EXPECTED[data.reference.version].total-2);
 assert.equal(report.items.find(item=>item.id===missing.id).status,'missing');assert.equal(report.items[0].status,'ungraded');assert.equal(report.items[1].status,'uncertain');assert.equal(report.items[1].observed.overall,'insufficient_evidence');
 assert.equal(report.summary.bad_correctly_flagged.denominator,data.anchors.filter(item=>item.reference.band==='bad').length);
 const empty=data.evaluateReviews({...reviews,items:[]});assert.equal(empty.summary.graded,0);assert.equal(empty.summary.missing,EXPECTED[data.reference.version].total);assert.deepEqual(empty.summary.agreement,{count:0,denominator:0});assert.equal(empty.summary.bad_correctly_flagged.count,0);
});

test('comparison rejects unknown IDs, duplicates, stale identity, invalid labels and unsupported evidence',()=>{
 const data=loadCalibration();
 for(const [change,pattern] of [
  [r=>{r.items[0].id='c99'},/unknown.*c99/i],
  [r=>{r.items.push(structuredClone(r.items[0]))},/duplicate/i],
  [r=>{r.dataset_hash='a'.repeat(64)},/dataset_hash mismatch/],
  [r=>{r.rubric_version+='-stale'},/rubric_version mismatch/],
  [r=>{r.reference_version+='-stale'},/reference_version mismatch/],
  [r=>{r.items[0].overall='pass'},/overall/],
  [r=>{r.items[0].evidence=[]},/evidence/],
  [r=>{r.items[0].evidence=[{source_id:'missing',quote:'x'}]},/unknown source/],
  [r=>{r.items[0].evidence=[{source_id:'q1',quote:'unobserved text'}]},/quote.*source/],
  [r=>{r.items[0].hard_failure_flags=['invented_flag']},/hard_failure_flags/]
 ]){const reviews=observedReferences(data);change(reviews);assert.throws(()=>data.evaluateReviews(reviews),pattern);}
});

test('JSONL validation rejects duplicate opaque IDs and requires version changes to remain hash-bound',t=>{
 const data=loadCalibration(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-calibration-data-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const file of data.files)fs.copyFileSync(path.join(data.directory,file),path.join(dir,file));
 fs.appendFileSync(path.join(dir,'anchors.jsonl'),JSON.stringify(data.anchors[0])+'\n');assert.throws(()=>loadCalibration({dir}),/duplicate/i);
 fs.writeFileSync(path.join(dir,'anchors.jsonl'),data.anchors.map(item=>JSON.stringify(item)).join('\n')+'\n');
 const changed=structuredClone(data.anchors);changed[0].candidate.text+=' ';fs.writeFileSync(path.join(dir,'anchors.jsonl'),changed.map(item=>JSON.stringify(item)).join('\n')+'\n');
 assert.notEqual(loadCalibration({dir}).datasetHash,data.datasetHash);
});

test('CLI check/export never run a reviewer, compare preserves inputs and refuses output overwrite',t=>{
 const script=path.resolve(__dirname,'../scripts/eval-reviewer-calibration.cjs'),call=args=>{const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});assert.ifError(result.error);return result;},data=loadCalibration();
 const checked=call(['check']);assert.equal(checked.status,0,checked.stderr);assert.equal(JSON.parse(checked.stdout).semantic_evaluation,'not_run');
 const exported=call(['export','--view','blinded']);assert.equal(exported.status,0,exported.stderr);assert.deepEqual(JSON.parse(exported.stdout),data.blindedExport());
 const reference=call(['export','--view','reference']);assert.equal(reference.status,0);assert.equal(JSON.parse(reference.stdout).reference.human_verified,false);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-calibration-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const input=path.join(dir,'reviews.json'),output=path.join(dir,'comparison.json'),body=JSON.stringify(observedReferences(data),null,2);fs.writeFileSync(input,body);
 const compared=call(['compare','--reviews',input,'--out',output]);assert.equal(compared.status,0,compared.stderr);assert.ok(fs.existsSync(output));assert.equal(fs.readFileSync(input,'utf8'),body);
 assert.equal(call(['compare','--reviews',input,'--out',output]).status,1);assert.equal(call(['export','--view','reference','--out',input]).status,1);assert.equal(call(['check','--live','true']).status,1);
});
