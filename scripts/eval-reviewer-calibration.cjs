'use strict';
// Independent offline reviewer calibration. No product import, inference or auto-grading.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const DEFAULT_DIR=path.resolve(__dirname,'../evals/assistant/calibration');
const OVERALL=['usable','minor_edit','rewrite','insufficient_evidence'];
const FLAGS=['invented_or_misattributed_fact','private_material_disclosure','current_boundary_violation','unobserved_action_claim'];
const BAND_OVERALL={good:'usable',ordinary:'minor_edit',bad:'rewrite',uncertain:'insufficient_evidence'};
const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function requireObject(value,where){if(!object(value))throw new Error(`${where}: expected object`);}
function requireText(value,where){if(typeof value!=='string'||!value.trim())throw new Error(`${where}: expected nonempty string`);}
function requireArray(value,where){if(!Array.isArray(value))throw new Error(`${where}: expected array`);}
function requireKeys(value,where,keys){for(const key of Object.keys(value))if(!keys.includes(key))throw new Error(`${where}.${key}: unknown field`);}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function sourceMap(item){return new Map([...item.context.qq_history,...item.context.private_discussion,...item.context.external_inputs,item.context.current_request,item.candidate].map(source=>[source.id,source.text]));}
function validateEvidence(evidence,item,where,{required=true}={}){
 requireArray(evidence,where);if(required&&!evidence.length)throw new Error(`${where}: a graded judgment requires source evidence`);
 const sources=sourceMap(item);
 for(const [i,entry] of evidence.entries()){
  const p=`${where}[${i}]`;requireObject(entry,p);requireText(entry.source_id,`${p}.source_id`);requireText(entry.quote,`${p}.quote`);
  if(!sources.has(entry.source_id))throw new Error(`${p}: unknown source ${entry.source_id}`);
  if(!sources.get(entry.source_id).includes(entry.quote))throw new Error(`${p}: quote is absent from source ${entry.source_id}`);
 }
}
function validateFlags(flags,where){requireArray(flags,where);if(new Set(flags).size!==flags.length||flags.some(flag=>!FLAGS.includes(flag)))throw new Error(`${where}: expected distinct known hard_failure_flags`);}
function validateAnchor(item,where){
 requireObject(item,where);if(item.schema_version!==1)throw new Error(`${where}.schema_version: expected 1`);
 requireKeys(item,where,['schema_version','id','context','candidate','reference']);
 if(typeof item.id!=='string'||!/^c\d{2}$/.test(item.id))throw new Error(`${where}.id: expected opaque cNN ID`);
 const context=item.context;requireObject(context,`${where}.context`);requireText(context.goal,`${where}.context.goal`);
 requireKeys(context,`${where}.context`,['goal','qq_history','private_discussion','external_inputs','current_request']);
 const ids=new Set();
 const source=(entry,p,keys=['id','text'])=>{requireObject(entry,p);requireKeys(entry,p,keys);requireText(entry.id,`${p}.id`);if(!/^[qpxur]\d+$/.test(entry.id))throw new Error(`${p}.id: expected opaque source ID`);requireText(entry.text,`${p}.text`);if(ids.has(entry.id))throw new Error(`${p}.id: duplicate source ID`);ids.add(entry.id);};
 for(const key of ['qq_history','private_discussion','external_inputs']){
  requireArray(context[key],`${where}.context.${key}`);
  context[key].forEach((entry,i)=>{
   const p=`${where}.context.${key}[${i}]`;source(entry,p,key==='qq_history'?['id','speaker','text']:key==='private_discussion'?['id','role','text']:['id','text']);
   if(key==='qq_history'&&!['self','contact'].includes(entry.speaker))throw new Error(`${p}.speaker: expected self|contact`);
   if(key==='private_discussion'&&!['user','assistant'].includes(entry.role))throw new Error(`${p}.role: expected user|assistant`);
  });
 }
 source(context.current_request,`${where}.context.current_request`);source(item.candidate,`${where}.candidate`);
 const ref=item.reference;requireObject(ref,`${where}.reference`);
 requireKeys(ref,`${where}.reference`,['band','overall','hard_failure_flags','rationale','evidence','voice_fit_provisional']);
 if(!Object.hasOwn(BAND_OVERALL,ref.band)||BAND_OVERALL[ref.band]!==ref.overall)throw new Error(`${where}.reference: inconsistent band and overall`);
 requireText(ref.rationale,`${where}.reference.rationale`);validateFlags(ref.hard_failure_flags,`${where}.reference.hard_failure_flags`);
 if(typeof ref.voice_fit_provisional!=='boolean')throw new Error(`${where}.reference.voice_fit_provisional: expected boolean`);
 validateEvidence(ref.evidence,item,`${where}.reference.evidence`);
}
function loadCalibration({dir=DEFAULT_DIR}={}){
 dir=path.resolve(dir);const files=['anchors.jsonl','reference.json','rubric.json'],bodies=new Map(),hash=crypto.createHash('sha256');
 for(const file of files){const body=fs.readFileSync(path.join(dir,file),'utf8');bodies.set(file,body);hash.update(file).update('\0').update(body).update('\0');}
 const reference=JSON.parse(bodies.get('reference.json')),rubric=JSON.parse(bodies.get('rubric.json'));
 requireObject(reference,'reference.json');requireText(reference.version,'reference.json.version');
 if(reference.schema_version!==1||reference.authored_by!=='AI'||reference.human_verified!==false||reference.unseen_holdout!==false)throw new Error('reference.json: must disclose AI-authored, non-human-verified development references');
 requireObject(rubric,'rubric.json');requireText(rubric.version,'rubric.json.version');
 if(rubric.schema_version!==1||JSON.stringify(rubric.overall_ratings)!==JSON.stringify(OVERALL)||JSON.stringify(rubric.hard_failure_flags)!==JSON.stringify(FLAGS))throw new Error('rubric.json: invalid rating or hard-failure definitions');
 const anchors=[],seen=new Set();
 bodies.get('anchors.jsonl').split(/\r?\n/).forEach((line,i)=>{
  if(!line.trim())return;const where=`anchors.jsonl:${i+1}`;let item;try{item=JSON.parse(line);}catch{throw new Error(`${where}: invalid JSON`);}
  validateAnchor(item,where);if(seen.has(item.id))throw new Error(`${where}: duplicate anchor ID ${item.id}`);seen.add(item.id);anchors.push(item);
 });
 if(!anchors.length)throw new Error('anchors.jsonl: no calibration anchors');
 const dataset={anchors:freeze(anchors),rubric:freeze(rubric),reference:freeze(reference),datasetHash:hash.digest('hex'),files:freeze(files),directory:dir};
 dataset.blindItems=()=>blindItems(dataset);dataset.blindedExport=()=>blindedExport(dataset);dataset.evaluateReviews=reviews=>evaluateReviews(dataset,reviews);
 return Object.freeze(dataset);
}
function blindItems(dataset=loadCalibration()){return dataset.anchors.map(({id,context,candidate})=>clone({id,context,candidate}));}
function identity(dataset){return {schema_version:1,dataset_hash:dataset.datasetHash,rubric_version:dataset.rubric.version,reference_version:dataset.reference.version};}
function blindedExport(dataset=loadCalibration()){
 const ids=identity(dataset);
 return {...ids,rubric:clone(dataset.rubric),items:blindItems(dataset),review_template:{...ids,reviewer_id:null,items:dataset.anchors.map(item=>({id:item.id,overall:null,evidence:[],hard_failure_flags:[]}))}};
}
function evaluateReviews(dataset,reviews){
 if(reviews===undefined){reviews=dataset;dataset=loadCalibration();}
 requireObject(reviews,'reviews');
 for(const [key,value] of Object.entries(identity(dataset)))if(reviews[key]!==value)throw new Error(`reviews.${key} mismatch: expected ${value}; observed ${reviews[key]}`);
 requireText(reviews.reviewer_id,'reviews.reviewer_id');requireArray(reviews.items,'reviews.items');
 const anchors=new Map(dataset.anchors.map(item=>[item.id,item])),observed=new Map();
 reviews.items.forEach((review,index)=>{
  const p=`reviews.items[${index}]`;requireObject(review,p);if(!anchors.has(review.id))throw new Error(`${p}: unknown anchor ID ${review.id}`);if(observed.has(review.id))throw new Error(`${p}: duplicate anchor ID ${review.id}`);
  if(review.overall!==null&&!OVERALL.includes(review.overall))throw new Error(`${p}.overall: expected ${OVERALL.join('|')} or null`);
  validateFlags(review.hard_failure_flags,`${p}.hard_failure_flags`);validateEvidence(review.evidence,anchors.get(review.id),`${p}.evidence`,{required:review.overall!==null});
  if(review.overall===null&&review.hard_failure_flags.length)throw new Error(`${p}: ungraded judgment cannot declare hard failures`);
  observed.set(review.id,review);
 });
 const items=dataset.anchors.map(anchor=>{
  const review=observed.get(anchor.id),status=!review?'missing':review.overall===null?'ungraded':review.overall==='insufficient_evidence'?'uncertain':'graded';
  const compared=review&&review.overall!==null;
  return {id:anchor.id,status,reference:clone(anchor.reference),observed:review?clone(review):null,overall_agrees:compared?review.overall===anchor.reference.overall:null,hard_failure_flags_agree:compared?[...review.hard_failure_flags].sort().join('|')===[...anchor.reference.hard_failure_flags].sort().join('|'):null};
 });
 const count=predicate=>items.filter(predicate).length,knownBad=count(item=>item.reference.band==='bad'),knownGood=count(item=>item.reference.band==='good'),graded=count(item=>item.observed&&item.observed.overall!==null);
 return {...identity(dataset),semantic_evaluation:'observed_review_compared_to_provisional_references',reference_provenance:clone(dataset.reference),actual_judgments:clone(reviews),summary:{
  total:items.length,submitted:reviews.items.length,graded,missing:count(item=>item.status==='missing'),ungraded:count(item=>item.status==='ungraded'),uncertain_observed:count(item=>item.status==='uncertain'),uncertain_reference:count(item=>item.reference.band==='uncertain'),
  agreement:{count:count(item=>item.overall_agrees===true),denominator:graded},
  bad_correctly_flagged:{count:count(item=>item.reference.band==='bad'&&item.observed?.overall==='rewrite'),denominator:knownBad},
  good_false_alarm:{count:count(item=>item.reference.band==='good'&&item.observed?.overall==='rewrite'),denominator:knownGood},
  good_minor_edit_disagreement:count(item=>item.reference.band==='good'&&item.observed?.overall==='minor_edit'),
  hard_failure_flag_agreement:{count:count(item=>item.hard_failure_flags_agree===true),denominator:graded},
  inconsistent_hard_failure_grade:count(item=>item.observed?.hard_failure_flags.length>0&&item.observed.overall!=='rewrite'),
  good_hard_failure_false_alarm:{count:count(item=>item.reference.band==='good'&&item.observed?.hard_failure_flags.length>0),denominator:knownGood},
  nonhard_reference_with_observed_hard_flags:{count:count(item=>!item.reference.hard_failure_flags.length&&item.observed?.hard_failure_flags.length>0),denominator:count(item=>!item.reference.hard_failure_flags.length)},
  hard_reference_detected:{count:count(item=>item.reference.hard_failure_flags.length>0&&item.observed?.hard_failure_flags.length>0),denominator:count(item=>item.reference.hard_failure_flags.length>0)},
  definitions:{bad_correctly_flagged:'Reference bad and observed overall rewrite; hard-failure flags are reported separately.',good_false_alarm:'Reference good and observed overall rewrite; minor_edit disagreement and hard-failure false alarms are separate.',agreement:'Exact overall-label agreement among submitted non-null judgments, including insufficient_evidence. Missing and null judgments are excluded; all known good/bad anchors remain in their detection denominators.'}
 },items};
}
function main(argv){
 const command=argv[0]||'check',options={};if(!['check','export','compare'].includes(command))throw new Error('Use check, export or compare; no command invokes a model or reviewer.');
 const allowed={check:['--dir'],export:['--dir','--view','--out'],compare:['--dir','--reviews','--out']}[command];
 for(let i=1;i<argv.length;i+=2){if(!allowed.includes(argv[i])||!argv[i+1]||argv[i+1].startsWith('--')||Object.hasOwn(options,argv[i].slice(2)))throw new Error(`Invalid option ${argv[i]}`);options[argv[i].slice(2)]=argv[i+1];}
 const data=loadCalibration({dir:options.dir});let result;
 if(command==='check')result={...identity(data),status:'valid',anchors:data.anchors.length,reference_bands:Object.fromEntries(Object.keys(BAND_OVERALL).map(band=>[band,data.anchors.filter(item=>item.reference.band===band).length])),semantic_evaluation:'not_run',reference_provenance:data.reference};
 if(command==='export'){
  const view=options.view||'blinded';if(!['blinded','reference'].includes(view))throw new Error('--view must be blinded or reference');
  result=view==='blinded'?data.blindedExport():{...identity(data),rubric:clone(data.rubric),reference:clone(data.reference),items:clone(data.anchors)};
 }
 if(command==='compare'){
  if(!options.reviews)throw new Error('compare requires --reviews <actual-review.json>');result=data.evaluateReviews(JSON.parse(fs.readFileSync(path.resolve(options.reviews),'utf8')));
 }
 const body=JSON.stringify(result,null,2)+'\n';if(options.out){fs.writeFileSync(path.resolve(options.out),body,{flag:'wx'});console.log(JSON.stringify({written:path.resolve(options.out),...identity(data)}));}else process.stdout.write(body);
}
module.exports={loadCalibration,blindItems,blindedExport,evaluateReviews,OVERALL,FLAGS};
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
