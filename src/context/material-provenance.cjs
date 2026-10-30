'use strict';
const {sourceClosure}=require('../provenance.cjs');
const {sameScopeIfPresent}=require('./source-snapshot.cjs');
const ROOT_LIMIT=8;
function recordingTime(value){
 if(typeof value!=='string')return null;
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!match||!Number.isFinite(Date.parse(value)))return null;
 const [year,month,day,hour,minute,second]=match.slice(1).map(Number),days=[31,(year%4===0&&year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 return month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<24&&minute<60&&second<60?new Date(value).toISOString():null;
}
function metadata(source){
 const recordedAt=recordingTime(source.at),type=['qq','private','feedback','note'].includes(source.type)?source.type:'unknown';
 return {sourceId:source.id,revision:typeof source.revision==='string'?source.revision:null,type,
  role:['user','contact','assistant'].includes(source.role)?source.role:'unknown',recordedAt,timeStatus:recordedAt?'known':'unknown',
  timeMeaning:source.role==='assistant'?'assistant_generated_recorded':({qq:'qq_message_recorded',private:'private_statement_recorded',feedback:'feedback_recorded',note:'note_edited'})[type]||'unknown'};
}
// This projects metadata from the captured admitted source graph, not a model
// assertion. Recording/statement/edit time is never an inferred occurrence time.
function buildMaterialProvenance(prepared,quotes,{scope=prepared.manifest?.scope}={}){
 if(!sameScopeIfPresent({scope:prepared.manifest?.scope},scope))throw new Error('Material provenance scope changed');
 const delivered=new Map((prepared.payload.sources||[]).map(source=>[source.id,source]));
 const captured=new Map((prepared.fullAvailableSources||prepared.payload.sources||[]).map(source=>[source.id,source]));
 const dependencies=new Map(),cache=new Map();
 const projected=quotes.map(quote=>{
  const admitted=delivered.get(quote.sourceId),source=captured.get(quote.sourceId);
  if(!admitted||!source||admitted.revision!==source.revision||prepared.manifest?.sourceRevisions?.[source.id]!==undefined&&prepared.manifest.sourceRevisions[source.id]!==source.revision)throw new Error('Admitted material source changed before provenance projection');
  if(source.deleted||source.excluded||source.use==='disabled'||!sameScopeIfPresent(source,scope))throw new Error('Unavailable or foreign admitted material source');
  let entry=cache.get(source.id);
  if(!entry){
   let closure=[source],known=true;
   if(source.type==='note'){
    // A temporal annotation cannot turn missing lineage metadata into a new
    // material-admission gate or bind a legacy note to a parent's latest date.
    const pending=[source.id],seen=new Set();
    while(pending.length){const id=pending.pop();if(seen.has(id))continue;seen.add(id);const node=captured.get(id);if(!node)continue;if(!sameScopeIfPresent(node,scope))throw new Error('Foreign material provenance dependency');pending.push(...(Array.isArray(node.evidenceSourceIds)?node.evidenceSourceIds:[]));}
    try{
     const resolved=sourceClosure(captured,[source.id]);
     known=resolved.every(node=>!node.deleted&&!node.excluded&&node.use!=='disabled'&&(node.evidenceSourceIds||[]).every(id=>node.evidenceRevisions&&Object.hasOwn(node.evidenceRevisions,id)));
     if(known)closure=resolved;
    }catch{known=false;}
   }
   for(const node of closure)dependencies.set(node.id,{sourceId:node.id,revision:node.revision});
   entry={closure,known};cache.set(source.id,entry);
  }
  const {closure,known}=entry;
  const derived=source.type==='note'&&!!(source.evidenceSourceIds&&(!Array.isArray(source.evidenceSourceIds)||source.evidenceSourceIds.length)),roots=derived?closure.filter(node=>node.id!==source.id&&!(node.evidenceSourceIds||[]).length).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0):[];
  const metadataCompleteness=derived&&(!roots.length||!known)?'roots_unknown':roots.length>ROOT_LIMIT?'roots_summarized':'complete';
  return {sourceId:quote.sourceId,text:quote.text,provenance:{version:1,source:metadata(source),roots:metadataCompleteness==='roots_unknown'?[]:roots.slice(0,ROOT_LIMIT).map(metadata),rootCount:roots.length,metadataCompleteness,timeSemantics:'recording_not_occurrence',roleSemantics:'record_author_not_fact_subject'}};
 });
 return {quotes:projected,dependencies:[...dependencies.values()]};
}
module.exports={buildMaterialProvenance};
