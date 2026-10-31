'use strict';
const {createHash}=require('node:crypto');
const {boundedSource}=require('./context/source-delivery.cjs');
const fields=['accountUid','accountUin','peerUid','peerUin'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeCopy=scope=>Object.fromEntries(fields.map(key=>[key,scope[key]]));
const sameScope=(left,right)=>left&&right&&fields.every(key=>typeof left[key]==='string'&&left[key]===right[key]);
const fail=(code,message)=>Object.assign(new Error(message),{code});
function rangeFor(source,total){
 const span=source.segment||source.delivery;
 return span?{start:span.offset??span.start,end:span.end,total:span.total??span.originalCharLength}:{start:0,end:source.text.length,total};
}
function coverageFor(originals,delivered,scope,{requiredSourceIds=[]}={}){
 const byId=originals instanceof Map?originals:new Map(originals.map(source=>[source.id,source]));
 const reads=[],ranges=new Map(),sourceRevisions={};
 for(const source of delivered||[]){
  const original=byId.get(source.id);
  if(!sameScope(source.scope,scope))throw fail('original_evidence_scope','Original evidence belongs to another account/contact or has no captured scope');
  if(!original||original.deleted||original.excluded||original.use==='disabled'||source.revision!==original.revision)throw fail('original_evidence_changed','Original evidence is unavailable or its revision changed');
  const range=rangeFor(source,original.text.length);
  if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<range.start||range.total!==original.text.length||range.end>range.total||original.text.slice(range.start,range.end)!==source.text)
   throw fail('original_evidence_range','Delivered original body does not match its captured exact range');
  sourceRevisions[source.id]=source.revision;
  const read={sourceId:source.id,revision:source.revision,...range,complete:range.start===0&&range.end===range.total&&!source.redactedForModel,bodyHash:hash(source.text),...(source.redactedForModel?{redactedForModel:true}:{})};
  reads.push(read);if(!ranges.has(source.id))ranges.set(source.id,[]);ranges.get(source.id).push(range);
 }
 const completeIds=[];
 for(const [id,spans]of ranges){let cursor=0;for(const span of spans.sort((a,b)=>a.start-b.start)){if(span.start>cursor)break;cursor=Math.max(cursor,span.end);}if(cursor===byId.get(id).text.length&&!reads.some(read=>read.sourceId===id&&read.redactedForModel))completeIds.push(id);}
 const required=[...new Set(requiredSourceIds)];
 return {version:'original-evidence-v1',scope:scopeCopy(scope),sourceRevisions,reads,completeSourceIds:completeIds,
  requiredSourceIds:required,missingSourceIds:required.filter(id=>!ranges.has(id)),partialSourceIds:[...ranges.keys()].filter(id=>!completeIds.includes(id)),
  complete:required.every(id=>completeIds.includes(id))};
}
function readOriginalEvidence(originals,scope,{sourceIds=[],ranges=[],maxBytes=24000}={}){
 const byId=originals instanceof Map?originals:new Map(originals.map(source=>[source.id,source]));
 const limit=Math.max(256,Math.min(240000,Number(maxBytes)||24000)),sources=[];
 const requested=[...new Set(sourceIds)];
 for(const id of requested){
  const original=byId.get(id);if(!original||original.deleted||original.excluded||original.use==='disabled')continue;
  const wanted=ranges.filter(range=>range.sourceId===id),parts=wanted.length?wanted:[{start:0,end:original.text.length}];
  for(const part of parts){
   const remaining=limit-Buffer.byteLength(JSON.stringify(sources),'utf8');if(remaining<100)break;
   const start=part.start??part.offset??0,end=part.end??original.text.length;
   const projected=boundedSource({...original,scope:scopeCopy(scope)},{start,maxChars:Math.max(0,end-start),maxBytes:remaining});
   if(projected)sources.push(projected);
  }
 }
 const coverage=coverageFor(byId,sources,scope,{requiredSourceIds:requested});
 return {sources,coverage};
}
function requireOriginals(originals,delivered,scope,sourceIds,{complete=true}={}){
 const coverage=coverageFor(originals,delivered,scope,{requiredSourceIds:sourceIds});
 if(coverage.missingSourceIds.length)throw fail('original_evidence_missing','Semantic revision requires the original supporting bodies, not a prior summary or source alias');
 if(complete&&!coverage.complete)throw fail('original_evidence_partial','Necessary original evidence is only partially delivered; semantic review remains incomplete');
 return coverage;
}
module.exports={readOriginalEvidence,coverageFor,requireOriginals,sameScope};
