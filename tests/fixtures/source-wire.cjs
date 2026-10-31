'use strict';
// Pure test-fixture representation changes using only the actual HTTP receipt.
// No producer input, text, entity ID, unknown reference or validation changes.
const {mapSourceReferences}=require('../../src/source-handles.cjs');
const {createHash}=require('node:crypto');
const digest=text=>createHash('sha256').update(JSON.stringify(text)).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const primaryExcluded=new Set(['draft','memory','discussion_compaction','plain_help_recovery','plain_draft_recovery','fidelity_check']);
const legacyKinds=new Set(['discussion','question','options','review','acknowledgment']);
function legacyPrimaryOperation(value,payload,declarationValid){
 if(Object.hasOwn(value,'operation'))return value;
 if(Object.hasOwn(value,'kind')&&!legacyKinds.has(value.kind)||Object.hasOwn(value,'text')&&(typeof value.text!=='string'||!value.text.trim()||value.text.length>6000)||
  Object.hasOwn(value,'replyDisposition')&&!['wait','clarify','unavailable'].includes(value.replyDisposition))return value;
 const delivery=value.requestDelivery,hasDelivery=Object.hasOwn(value,'requestDelivery'),hasPlan=Object.hasOwn(value,'draftPlan'),hasLookup=Object.hasOwn(value,'lookup');
 const pureClarification=plain(value.draftPlan)&&Object.keys(value.draftPlan).length===1&&Object.hasOwn(value.draftPlan,'clarification');
 if((payload.requestDeliveryPolicy||hasDelivery)&&!declarationValid)return value;
 if(!hasDelivery&&!pureClarification&&(hasPlan||hasLookup))return value;
 if(!hasDelivery&&!pureClarification&&(!legacyKinds.has(value.kind)||typeof value.text!=='string'))return value;
 const result={...value};delete result.kind;delete result.requestDelivery;delete result.replyDisposition;
 const hasBlocker=plain(delivery)&&Object.hasOwn(delivery,'blocker');
 if(delivery?.mode==='private_help'){
  // Preserve every contradictory private core before considering a legacy
  // clarification carrier. Neither a plan nor a blocker changes its workflow.
  result.operation=hasLookup&&!hasPlan&&!hasBlocker?'lookup':'advise';
  if(hasBlocker)result.blocker=delivery.blocker;
  if(result.operation==='lookup')result.continuation='advise';
 }else if(hasBlocker||pureClarification&&!payload.requestDeliveryPolicy){
  result.operation='clarify';delete result.text;
  result.blocker=hasBlocker?delivery.blocker:{kind:'missing_fact',missing:value.draftPlan.clarification,question:value.draftPlan.clarification};
  if(pureClarification)delete result.draftPlan;
 }else if(!hasDelivery){
  result.operation=hasLookup&&!hasPlan?'lookup':'advise';
  if(result.operation==='lookup')result.continuation='advise';
 }else{
  result.operation=hasPlan?'prepare_message':hasLookup?'lookup':'prepare_message';
  if(result.operation==='lookup')result.continuation='prepare_message';
 }
 return result;
}
function restoreSource(source,revisions,originals){
 if(!Array.isArray(source?.segments)){
  const revision=revisions.get(source?.id),captured=originals.get(source?.id);
  if(captured&&source.text===captured.text&&captured.revision===revision)return {...source,revision};
  return source;
 }
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
function restorePayload(payload,revisions,originals,captured){
 if(!plain(payload))return payload;
 delete payload.sourceReferenceProtocol;
 delete payload.primaryReferenceProtocol;
 if(Object.hasOwn(payload,'operationProtocol')){
  delete payload.operationProtocol;
  delete payload.currentPermission;
  if(!Object.hasOwn(payload,'requestDeliveryPolicy')&&plain(captured)&&Object.hasOwn(captured,'requestDeliveryPolicy'))payload.requestDeliveryPolicy=structuredClone(captured.requestDeliveryPolicy);
  if(payload.taskContext&&captured?.taskContext?.draftControlPolicy)payload.taskContext.draftControlPolicy=structuredClone(captured.taskContext.draftControlPolicy);
  for(const card of payload.methodCards||[]){
   const original=captured?.methodCards?.find(item=>item.id===card.id&&item.version===card.version&&item.instruction===card.instruction);
   if(original&&!Object.hasOwn(card,'outputKinds')&&Object.hasOwn(original,'outputKinds'))card.outputKinds=structuredClone(original.outputKinds);
  }
 }
 if(Array.isArray(payload.sources))payload.sources=payload.sources.map(source=>restoreSource(source,revisions,originals));
 for(const field of ['recentHumanContext','priorHumanDirections'])for(const reference of payload.taskContext?.[field]||[]){
  const original=captured?.taskContext?.[field]?.find(item=>item.sourceId===reference.sourceId),source=originals.get(reference.sourceId);
  // Invert only the exact program-bound model-view expansion. A substituted
  // body, revision or unoffered reference remains visible to equality checks.
  if(original?.bodyLocation==='sources'&&!Object.hasOwn(original,'text')&&reference.bodyLocation==='sources'&&source?.revision===revisions.get(reference.sourceId)&&reference.text===source.text)delete reference.text;
 }
 if(Array.isArray(payload.sources)&&plain(captured?.userRequest)&&plain(payload.userRequest)&&captured.userRequest.sourceId===payload.userRequest.sourceId&&captured.userRequest.text===payload.userRequest.text){
  const current=captured.sources?.find(source=>source.id===payload.userRequest.sourceId);
  if(current?.text===payload.userRequest.text&&!payload.sources.some(source=>source.id===current.id)){
   payload.sources.push(structuredClone(current));
   const order=new Map(captured.sources.map((source,index)=>[source.id,index]));payload.sources.sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity));
  }
 }
 if(payload.originalInput)restorePayload(payload.originalInput,revisions,originals,captured?.originalInput||captured);
 return payload;
}
function canonicalSourceView(value,receipt,canonicalPayload){
 const refs=new Map((receipt?.bindings||[]).map(item=>[item.handle,item.sourceId]));
 const result=mapSourceReferences(value,id=>refs.get(id)||id);
 const revisions=new Map((receipt?.bindings||[]).map(item=>[item.sourceId,item.revision])),original=canonicalPayload?.originalInput||canonicalPayload;
 return restorePayload(result,revisions,new Map((original?.sources||[]).map(source=>[source.id,source])),canonicalPayload);
}
function wireSourceView(value,receipt,primaryReceipt,canonicalPayload){
 const canonicalRefs=new Map((receipt?.bindings||[]).map(item=>[item.handle,item.sourceId]));
 let data=mapSourceReferences(value,id=>canonicalRefs.get(id)||id);
 const payload=canonicalPayload?.originalInput||canonicalPayload;
 if(primaryReceipt?.version==='primary-reference-choices-v1'&&plain(data)&&!Object.hasOwn(data,'operation')&&plain(payload)&&!primaryExcluded.has(canonicalPayload?.purpose)&&!primaryExcluded.has(payload.purpose)){
  const materials=primaryReceipt.materials||[],authorities=primaryReceipt.authorities||[],currentFacts=[];
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
    const permission=materialFor(auth.permission,false),current=payload.sources?.find(source=>source.id===payload.intentAuthority?.sourceId);
    candidate=permission&&authorities.find(authority=>authority.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&(authority.materialRef===permission.materialRef||authority.wholeOriginal&&authority.sourceId===permission.sourceId&&authority.revision===permission.revision));
    if(!candidate&&current&&auth.permission.sourceId===current.id&&auth.permission.text===current.text)
     candidate=authorities.find(authority=>authority.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&authority.currentInstruction&&authority.sourceId===current.id&&authority.revision===current.revision);
    if(!candidate)return item;
   }
   const authority=program||candidate;
   return {materialRef:material.materialRef,...(authority?{authorityRef:authority.authorityRef}:{})};
  };
  if(plain(data.draftPlan)&&Array.isArray(data.draftPlan.quotes))data.draftPlan.quotes=data.draftPlan.quotes.flatMap(item=>{
   const source=payload.sources?.find(source=>source.id===item?.sourceId);
   // Normal primary answers already receive the actual QQ bodies and the whole
   // current human statement. Keep exact selected current facts as declarations;
   // neither this projection nor a declaration supplies a sharing grant.
   if(plain(item)&&Object.keys(item).every(key=>['sourceId','text','authorization'].includes(key))&&typeof item.text==='string'&&item.text&&source?.text.includes(item.text)){
    if(source.type==='qq')return [];
    if(source.id===payload.intentAuthority?.sourceId){currentFacts.push(item.text);return [];}
   }
   return [quote(item)];
  });
  if(Array.isArray(data.expressionOptions))for(const option of data.expressionOptions)if(plain(option)&&Array.isArray(option.quotes))option.quotes=option.quotes.map(quote);
  const delivery=data.requestDelivery;
  let declarationValid=false;
  if(plain(delivery)&&Object.keys(delivery).every(key=>['mode','sourceId','quote','blocker'].includes(key))&&['private_help','editable_message','both'].includes(delivery.mode)){
   const currentId=payload.intentAuthority?.sourceId,current=payload.sources?.find(source=>source.id===currentId);
   const currentValid=current&&current.role==='user'&&['private','request','feedback'].includes(current.type)&&!current.deleted&&!current.excluded&&current.use!=='disabled'&&typeof current.revision==='string'&&typeof current.text==='string'&&current.text.trim();
   const hasSource=Object.hasOwn(delivery,'sourceId'),hasQuote=Object.hasOwn(delivery,'quote');
   if(hasSource||hasQuote){
    declarationValid=!!(currentValid&&hasSource&&hasQuote&&delivery.sourceId===currentId&&typeof delivery.quote==='string'&&delivery.quote.trim()&&delivery.quote.length<=1000&&current.text.includes(delivery.quote));
   }else declarationValid=!!currentValid||!payload.requestDeliveryPolicy&&delivery.mode==='private_help'&&!Object.hasOwn(data,'draftPlan')&&!Object.hasOwn(data,'lookup');
   if(declarationValid){const {sourceId,quote:currentQuote,...mode}=delivery;data.requestDelivery=mode;}
  }
  data=legacyPrimaryOperation(data,payload,declarationValid);
  if(data.operation==='prepare_message'){
   const plan=data.draftPlan;
   // The legacy fixture's outer prose was an audit/planning carrier. Its
   // explicitly supplied answer remains the sole owner of visible explanation.
   delete data.text;
   if(plain(plan)&&!Object.hasOwn(plan,'clarification')){
    delete data.draftPlan;
    if(plan.quotes!==undefined)data.materials=plan.quotes;
    if(currentFacts.length)data.currentFacts=currentFacts;
    if(plan.editingReference!==undefined)data.editingReference=plan.editingReference;
   }
  }
 }
 const refs=new Map((receipt?.bindings||[]).map(item=>[item.sourceId,item.handle]));
 return mapSourceReferences(data,id=>refs.get(id)||id);
}
module.exports={canonicalSourceView,wireSourceView};
