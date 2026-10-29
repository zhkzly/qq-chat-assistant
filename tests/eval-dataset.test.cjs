'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateCase,loadDataset,modelInput,reviewView}=require('../scripts/eval-dataset.cjs');
const clone=value=>structuredClone(value);
// Derived from the existing L3 actual-send/next-incoming fixture shape.
function fixture(){return {schema_version:1,id:'fixture-continuity',family:'continuity',goal_type:'friendship',goal:'与朋友自然交流',tags:['actual-send'],contrast_group:'fixture',initial_context:{as_of:'2026-10-29T18:00:00+08:00',qq_history:[{id:'q1',at:'2026-10-29T17:59:00+08:00',speaker:'contact',text:'今天总算把拼图拼完了'}],private_discussion:[],notes:[]},steps:[{id:'s1',as_of:'2026-10-29T18:00:00+08:00',qq_updates:[],private_updates:[],request:{id:'u1',text:'给一句参考'},evaluation:{acceptable_outputs:['draft'],should:['接具体分享'],should_not:['编造一起拼过'],critical_failures:['把生成当发送'],evidence_ids:['q1','u1']}},{id:'s2',as_of:'2026-10-29T18:05:00+08:00',qq_updates:[{id:'q2',at:'2026-10-29T18:02:00+08:00',speaker:'self',text:'这一桌的工程总算竣工了'},{id:'q3',at:'2026-10-29T18:04:00+08:00',speaker:'contact',text:'还舍不得拆，打算找框裱起来'}],private_updates:[],request:{id:'u2',text:'接着聊'},evaluation:{acceptable_outputs:['draft','discussion'],should:['接住裱框新进展'],should_not:['重复已发原句'],critical_failures:[],evidence_ids:['q2','q3','u2']}}]};}

test('a timed authored episode is valid and model export includes prior requests and actual updates only',()=>{
 const item=fixture();assert.deepEqual(validateCase(item),[]);
 const first=modelInput(item,'s1'),next=modelInput(item,'s2');assert.equal(first.qq_history.length,1);assert.equal(next.qq_history.length,3);
 assert.equal(next.current_request.id,'u2');assert.ok(next.private_discussion.some(record=>record.id==='u1'&&record.role==='user'));
 assert.equal(first.qq_history.some(record=>record.id==='q3'),false);assert.equal(JSON.stringify(item),JSON.stringify(fixture()),'export does not mutate authored data');
});
test('case-specific judging instructions do not enter exported model input and review remains ungraded',()=>{
 const item=fixture();item.steps[0].evaluation.should=['EVALUATOR_ONLY_SENTINEL'];
 assert.equal(JSON.stringify(modelInput(item,'s1')).includes('EVALUATOR_ONLY_SENTINEL'),false);
 const rubric={version:'test-rubric',dimensions:[{id:'useful_next_step'}]},review=reviewView(item,'s1',{rubric,datasetHash:'fixture-hash'});
 assert.ok(JSON.stringify(review).includes('EVALUATOR_ONLY_SENTINEL'));assert.equal(review.review.status,'not_run');assert.equal(review.review.overall,null);assert.equal(review.review.actual_response,null);
 assert.equal(review.review.rubric_version,'test-rubric');assert.equal(review.review.dataset_hash,'fixture-hash');
});
test('duplicate IDs, invalid dates and future or unknown evidence are real validation errors',()=>{
 for(const change of [
  c=>{c.steps[1].request.id='q1'},
  c=>{c.initial_context.qq_history[0].at='2026-02-30T12:00:00+08:00'},
  c=>{c.initial_context.qq_history[0].at='2026-10-29T19:00:00+08:00'},
  c=>{c.initial_context.qq_history[0].at='2026-10-29T17:59:00'},
  c=>{c.steps[0].evaluation.evidence_ids=['q3']},
  c=>{c.steps[1].evaluation.evidence_ids=['missing']},
  c=>{c.steps[1].as_of='2026-10-29T17:58:00+08:00'},
  c=>{c.steps[1].qq_updates[0].at='2026-10-29T17:58:00+08:00'},
  c=>{c.steps[0].evaluation.acceptable_outputs=['gold_sentence']},
  c=>{c.goal=''},
  c=>{c.id=123},
  c=>{c.initial_context.qq_history[0].speaker='assistant'}
 ]){const item=fixture();change(item);assert.ok(validateCase(item).length,JSON.stringify(item));}
});
test('derived understanding cites original earlier evidence, while explicit user notes can stand alone',()=>{
 const item=fixture();item.initial_context.notes=[{id:'n1',at:'2026-10-29T17:59:30+08:00',subject:'contact',kind:'understanding',use:'discussion',text:'她说拼图完成了。',source_ids:['q1']}];
 assert.deepEqual(validateCase(item),[]);
 for(const refs of [[],['q3'],['n1']]){const changed=clone(item);changed.initial_context.notes[0].source_ids=refs;assert.ok(validateCase(changed).length);}
 const manual=clone(item);manual.initial_context.notes[0]={...manual.initial_context.notes[0],subject:'self',kind:'preference',text:'参考回复简短。',source_ids:[]};assert.deepEqual(validateCase(manual),[]);
 const proposal=clone(item);proposal.initial_context.private_discussion=[{id:'d1',at:'2026-10-29T17:59:10+08:00',role:'assistant',text:'你们可能会一起拼图。'}];proposal.initial_context.notes[0].source_ids=['d1'];assert.ok(validateCase(proposal).length,'an assistant proposal is not original evidence for a person understanding');
});
test('JSONL loader reports filename and line for malformed rows and duplicate cases',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-eval-dataset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'cases.jsonl');fs.writeFileSync(source,JSON.stringify(fixture())+'\n{broken\n');
 assert.throws(()=>loadDataset(dir),error=>/cases\.jsonl:2/.test(error.message));
 fs.writeFileSync(source,JSON.stringify(fixture())+'\n'+JSON.stringify(fixture())+'\n');assert.throws(()=>loadDataset(dir),/duplicate/i);
});
test('the project dataset has multiple goals, contrast pairs and authored continuous episodes',()=>{
 const data=loadDataset();assert.ok(data.cases.length>0);assert.ok(new Set(data.cases.map(item=>item.goal_type)).size>=3);
 for(const item of data.cases)for(const step of item.steps){const input=modelInput(item,step.id);for(const event of [...input.qq_history,...input.private_discussion,...input.notes,input.current_request])assert.equal(event.id.includes(item.id),false,'source IDs must not reveal descriptive case IDs to the evaluated assistant');}
 assert.ok(data.cases.some(item=>item.steps.length>1));assert.ok(data.cases.some(item=>item.goal_type==='work'));
 const groups=new Map();for(const item of data.cases)groups.set(item.contrast_group,(groups.get(item.contrast_group)||0)+1);
 assert.ok([...groups.values()].filter(count=>count>1).length>=2);assert.equal(data.rubric.version,'assistant-help-v1');
 assert.equal(typeof data.datasetHash,'string');assert.match(data.datasetHash,/^[a-f0-9]{64}$/);
});
test('CLI commands validate and export machine-readable ungraded views without inference',()=>{
 const {spawnSync}=require('node:child_process'),script=path.resolve(__dirname,'../scripts/eval-dataset.cjs');
 const call=args=>spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
 const checked=call(['check']);assert.equal(checked.status,0,checked.stderr);const summary=JSON.parse(checked.stdout);assert.equal(summary.status,'valid');assert.equal(summary.semantic_evaluation,'not_run');
 const dataset=loadDataset(),item=dataset.cases[0],step=item.steps[0];
 const exported=call(['show','--id',item.id,'--step',step.id,'--view','model']);assert.equal(exported.status,0,exported.stderr);assert.deepEqual(JSON.parse(exported.stdout),modelInput(item,step.id));
 const reviewed=call(['show','--id',item.id,'--view','review']);assert.equal(reviewed.status,0);assert.equal(JSON.parse(reviewed.stdout).review.status,'not_run');
 assert.equal(call(['show','--id','missing']).status,1);assert.equal(call(['show','--id',item.id,'--live','true']).status,1);
});
