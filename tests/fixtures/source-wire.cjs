'use strict';
// Pure test-fixture representation changes using only the actual HTTP receipt.
// No producer input, text, entity ID, unknown reference or validation changes.
const {mapSourceReferences}=require('../../src/source-handles.cjs');
const {createHash}=require('node:crypto');
const digest=text=>createHash('sha256').update(JSON.stringify(text)).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function restoreSource(source,revisions,originals){
 if(!Array.isArray(source?.segments))return source;
 const start=source.delivery?.start??0;
 let offset=start,text='';
 for(const segment of source.segments){
  const partText=Array.isArray(segment?.parts)?segment.parts.map(part=>{
   if(Array.isArray(part)&&part.length===2&&(part[0]===null||typeof part[0]==='string')&&typeof part[1]==='string')return part[1];
   if(plain(part)&&(part.at===null||typeof part.at==='string')&&typeof part.text==='string')return part.text;
   throw new Error('Fixture word parts are not a readable exact body representation');
  }).join(''):segment?.text;
  const segmentStart=segment?.start??offset,segmentEnd=segment?.end??segmentStart+partText?.length;
  if(!plain(segment)||typeof partText!=='string'||!Number.isSafeInteger(segmentStart)||!Number.isSafeInteger(segmentEnd)||segmentStart!==offset||segmentEnd-segmentStart!==partText.length)
   throw new Error('Fixture source segments are not an exact contiguous UTF16 representation');
  text+=partText;offset=segmentEnd;
 }
 if(source.delivery?.end!==undefined&&source.delivery.end!==offset||source.text!==undefined&&source.text!==text)
  throw new Error('Fixture source segments disagree with the delivered body');
 const {segments,materialChoices,authorityChoices,refinementCoverage,...original}=source;
 const result={...original,text},revision=revisions.get(source.id),captured=originals.get(source.id);
 if(typeof revision==='string')result.revision=revision;
 if(captured&&captured.text===text&&captured.revision===revision)for(const key of ['revision','version','evidenceRevisions']){
  if(Object.hasOwn(captured,key))result[key]=structuredClone(captured[key]);
 }
 return result;
}
function restorePayload(payload,revisions,originals){
 if(!plain(payload))return payload;
 delete payload.sourceReferenceProtocol;
 delete payload.primaryReferenceProtocol;
 if(Array.isArray(payload.sources))payload.sources=payload.sources.map(source=>restoreSource(source,revisions,originals));
 if(payload.originalInput)restorePayload(payload.originalInput,revisions,originals);
 return payload;
}
function canonicalSourceView(value,receipt,canonicalPayload){
 const refs=new Map((receipt?.bindings||[]).map(item=>[item.handle,item.sourceId]));
 const result=mapSourceReferences(value,id=>refs.get(id)||id);
 const revisions=new Map((receipt?.bindings||[]).map(item=>[item.sourceId,item.revision])),original=canonicalPayload?.originalInput||canonicalPayload;
 return restorePayload(result,revisions,new Map((original?.sources||[]).map(source=>[source.id,source])));
}
function wireSourceView(value,receipt,primaryReceipt,canonicalPayload){
 const canonicalRefs=new Map((receipt?.bindings||[]).map(item=>[item.handle,item.sourceId]));
 const data=mapSourceReferences(value,id=>canonicalRefs.get(id)||id);
 if(primaryReceipt?.version==='primary-reference-choices-v1'&&plain(data)){
  const materials=primaryReceipt.materials||[],authorities=primaryReceipt.authorities||[];
  const payload=canonicalPayload?.originalInput||canonicalPayload;
  // Legacy tuples lack occurrence offsets. Match only identical offered
  // source/text witnesses; never widen a quote to a surrounding sentence.
  const materialFor=(ref,allowRefinement=true)=>{
   if(!plain(ref)||typeof ref.sourceId!=='string'||typeof ref.text!=='string')return undefined;
   const exact=materials.find(item=>item.sourceId===ref.sourceId&&item.end-item.start===ref.text.length&&item.bodyDigest===digest(ref.text));
   if(exact||!allowRefinement)return exact;
   const source=payload?.sources?.find(item=>item.id===ref.sourceId);
   if(!source||!ref.text)return undefined;
   for(let local=source.text.indexOf(ref.text);local>=0;local=source.text.indexOf(ref.text,local+1)){
    const start=(source.delivery?.start||0)+local,end=start+ref.text.length;
    const boundaries=primaryReceipt.boundaries||[],from=boundaries.find(item=>item.sourceId===source.id&&item.revision===source.revision&&item.offset===start),to=boundaries.find(item=>item.sourceId===source.id&&item.revision===source.revision&&item.offset===end);
    const parent=materials.find(item=>item.sourceId===source.id&&item.revision===source.revision&&item.start<=start&&item.end>=end);
    if(from&&to&&parent)return {...parent,start,end,bodyDigest:digest(ref.text),materialRef:`${parent.materialRef}@${from.boundaryRef}:${to.boundaryRef}`};
   }
   return undefined;
  };
  const quote=item=>{
   if(!plain(item)||Object.keys(item).some(key=>!['sourceId','text','authorization'].includes(key)))return item;
   const material=materialFor(item);if(!material)return item;
   const program=authorities.find(authority=>authority.kind==='PROGRAM_SOURCE_AUTHORITY'&&authority.targetSourceId===material.sourceId&&authority.targetRevision===material.revision&&
    (authority.start===undefined||authority.start===material.start&&authority.end===material.end));
   let candidate;
   if(item.authorization!==undefined){
    const auth=item.authorization;
    // Do not repair wrong or absent legacy proof. In particular, another
    // material's referent cannot be silently replaced with this quote.
    if(!plain(auth)||Object.keys(auth).some(key=>!['permission','referent'].includes(key))||!plain(auth.referent)||
     Object.keys(auth.referent).some(key=>!['sourceId','text'].includes(key))||auth.referent.sourceId!==item.sourceId||auth.referent.text!==item.text||
     !plain(auth.permission)||Object.keys(auth.permission).some(key=>!['sourceId','text'].includes(key)))return item;
    const permission=materialFor(auth.permission,false);
    candidate=permission&&authorities.find(authority=>authority.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&authority.materialRef===permission.materialRef);
    if(!candidate)return item;
   }
   const authority=program||candidate;
   return {materialRef:material.materialRef,...(authority?{authorityRef:authority.authorityRef}:{})};
  };
  if(plain(data.draftPlan)&&Array.isArray(data.draftPlan.quotes))data.draftPlan.quotes=data.draftPlan.quotes.map(quote);
  if(Array.isArray(data.expressionOptions))for(const option of data.expressionOptions)if(plain(option)&&Array.isArray(option.quotes))option.quotes=option.quotes.map(quote);
  const delivery=data.requestDelivery;
  if(payload&&plain(delivery)&&Object.keys(delivery).every(key=>['mode','sourceId','quote','blocker'].includes(key))&&
   Object.hasOwn(delivery,'sourceId')&&Object.hasOwn(delivery,'quote')){
   const currentId=payload.intentAuthority?.sourceId||payload.userRequest?.sourceId,current=payload.sources?.find(source=>source.id===currentId);
   if(delivery.sourceId===currentId&&current&&typeof delivery.quote==='string'&&delivery.quote.trim()&&delivery.quote.length<=1000&&current.text?.includes(delivery.quote)){
    const {sourceId,quote:currentQuote,...mode}=delivery;data.requestDelivery=mode;
   }
  }
 }
 const refs=new Map((receipt?.bindings||[]).map(item=>[item.sourceId,item.handle]));
 return mapSourceReferences(data,id=>refs.get(id)||id);
}
module.exports={canonicalSourceView,wireSourceView};
