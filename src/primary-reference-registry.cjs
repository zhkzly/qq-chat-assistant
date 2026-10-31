'use strict';
const {createHash}=require('node:crypto');
const {deliveryRange}=require('./context/source-delivery.cjs');
const {validationError}=require('./validation-issues.cjs');

const VERSION='primary-reference-choices-v1';
const SYSTEM='Use offered materialRef per fragment. Only currently offered public QQ material may omit authorityRef under its existing target-bound PROGRAM_SOURCE_AUTHORITY; other material requires its exact offered authorityRef. Explicit wrong pairs still fail. parts pairs are [boundaryRef,text], null is unanchored; endBoundary follows anchored parts. Refine only as mPARENT@bSTART:bEND inside the same offered parent; from/to include those atoms. ORIGINALUSERSTATEMENTCANDIDATE is NOT GRANT: judge full context, quotes, negation, conditions and later restrictions. a# cannot refine. Program restores exact text/identity; never copy or fix them. Catalog-only records provide no material/permission.';
const canonical=new WeakMap(),materialBindings=new WeakMap();
const clone=value=>value===undefined?undefined:structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeIdentity=scope=>scope?Object.fromEntries(['accountUid','accountUin','peerUid','peerUin'].map(key=>[key,scope[key]??null])):null;
const usable=source=>source&&!source.deleted&&!source.excluded&&source.use!=='disabled';
const originalUser=source=>usable(source)&&source.role==='user'&&['private','feedback'].includes(source.type)&&!['feedback_continue','user_control'].includes(source.kind);
const fail=(path,code,message)=>validationError(path,code,`${path}: ${message}`);
const sameScope=(source,scope)=>!source.scope||source.scope==='this_relationship'||scope&&typeof source.scope==='object'&&Object.entries(scope).every(([key,value])=>(source.scope[key]??null)===value);
const sentenceSegmenter=new Intl.Segmenter('und',{granularity:'sentence'});
const wordSegmenter=new Intl.Segmenter('und',{granularity:'word'});
const graphemeSegmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const PART_LIMIT=32;
function wordsFor(text){
 const parts=[];
 for(const item of wordSegmenter.segment(text)){
  // Long indivisible tokens get grapheme addresses rather than UTF-16 cuts.
  // Ordinary words stay readable and consume one bounded part each.
  if(item.segment.length>32)for(const part of graphemeSegmenter.segment(item.segment))parts.push({start:item.index+part.index,end:item.index+part.index+part.segment.length});
  else parts.push({start:item.index,end:item.index+item.segment.length});
 }
 return parts;
}

// Segmentation assigns addresses only. It does not identify facts, permission,
// private clauses, subjects, or event times. Every delimiter remains in place.
function rangesFor(text){
 const sentences=[...sentenceSegmenter.segment(text)].map(item=>({start:item.index,end:item.index+item.segment.length}));
 const atoms=[];
 for(const sentence of sentences){
  let start=sentence.start;
  for(const match of text.slice(sentence.start,sentence.end).matchAll(/[；;，,：:\n\r]+/gu)){
   const end=sentence.start+match.index+match[0].length;
   if(end>start)atoms.push({start,end});start=end;
  }
  if(start<sentence.end)atoms.push({start,end:sentence.end});
 }
 const bounded=[];
 for(const range of atoms){
  if(range.end-range.start<=4000){bounded.push(range);continue;}
  let start=range.start,end=start;
  for(const item of graphemeSegmenter.segment(text.slice(range.start,range.end))){
   const next=range.start+item.index+item.segment.length;
   if(next-start>4000&&end>start){bounded.push({start,end});start=end;}
   end=next;
   // A single grapheme beyond the material bound remains visible but has no
   // material address; splitting it would corrupt the source representation.
   if(end-start>4000){bounded.push({start,end,unselectable:true});start=end;}
  }
  if(start<end)bounded.push({start,end});
 }
 return {atoms:bounded,sentences};
}

class PrimaryReferenceOwner{
 #scope;#taskId;#entries=new Map();#generation=0;#materialCount=0;#authorityCount=0;#boundaryCount=0;
 constructor({scope=null,taskId='standalone'}={}){this.#scope=scopeIdentity(scope);this.#taskId=taskId;}
 matches(scope,taskId){return digest(scopeIdentity(scope))===digest(this.#scope)&&taskId===this.#taskId;}
 get size(){return this.#entries.size;}
 preview(payload,{foreground=false}={}){
  const projected=clone(payload),input=projected?.originalInput||projected;
  const original=payload?.originalInput||payload;
  if(!input||typeof input!=='object'||['draft','memory','discussion_compaction'].includes(input.purpose))throw fail('$','primary_reference_phase_invalid','reference choices are only a foreground planning contract');
  const entries=new Map(this.#entries),generation=this.#generation;
  let materialCount=this.#materialCount,authorityCount=this.#authorityCount,boundaryCount=this.#boundaryCount,committed=false;
  const offeredMaterials=new Map(),offeredAuthorities=new Map(),offeredBoundaries=new Map(),sourceById=new Map(),receiptMaterials=[],receiptAuthorities=[],receiptBoundaries=[];
  const entry=(kind,metadata)=>{
   const key=JSON.stringify([kind,metadata]);let result=entries.get(key);
   if(!result){const field=kind==='material'?'materialRef':kind==='authority'?'authorityRef':'boundaryRef',ref=kind==='material'?`m${++materialCount}`:kind==='authority'?`a${++authorityCount}`:`b${++boundaryCount}`;result=freeze({...metadata,[field]:ref});entries.set(key,result);}
   return result;
  };
  const intentId=original.intentAuthority?.sourceId||original.userRequest?.sourceId;
  // Current-input binding proves whose request is being interpreted. It is
  // not program-owned sharing authority for everything in those user words.
  const allowed=new Set(original.allowedMaterialIds||original.selectedMaterialIds||[]);
  const selected=original.selectedOption&&(original.expressionOptions||[]).find(option=>option.turnId===original.selectedOption.turnId&&option.index===original.selectedOption.index);
  input.sources=(original.sources||[]).map(source=>{
   const view=clone(source),text=typeof source.text==='string'?source.text:'',range=deliveryRange(source);
   for(const key of ['text','revision','version','evidenceRevisions'])delete view[key];
   if(!sameScope(source,this.#scope))throw fail('sources','primary_reference_scope_invalid','a delivered source belongs to another scope');
   const available=usable(source)&&typeof source.id==='string'&&typeof source.revision==='string'&&
    Number.isSafeInteger(range.start)&&range.start>=0&&Number.isSafeInteger(range.end)&&range.end-range.start===text.length&&
    Number.isSafeInteger(range.originalCharLength)&&range.originalCharLength>=range.end&&['delivered','partial'].includes(range.status);
   if(sourceById.has(source.id))throw fail('sources','primary_reference_offer_invalid','a delivered source may occur only once');
   sourceById.set(source.id,{source:clone(source),text,available});
   if(foreground&&source.id===intentId){
    if(originalUser(source)){
     input.userRequest={sourceId:source.id,text};
     if(available&&range.status!=='partial'){
      const offered=entry('authority',{kind:'ORIGINALUSERSTATEMENTCANDIDATE',sourceId:source.id,revision:source.revision,currentInstruction:true});
      offeredAuthorities.set(offered.authorityRef,offered);receiptAuthorities.push(offered);
      input.currentPermission={authorityRef:offered.authorityRef,authority:'original_current_human_statement_candidate_not_grant',bodyLocation:'userRequest'};
     }
    }
    return undefined;
   }
   if(foreground&&source.type==='qq'){view.text=text;return view;}
   const {atoms,sentences}=rangesFor(text),choices=new Map(),atomicKeys=new Set(),atomicMaterials=[];
   let usedParts=0,coveredEnd=0;
   const boundary=offset=>{
    // The canonical source revision already witnesses its complete body. The
    // owner stores only this identity/revision/offset, never a retained body.
    const offered=entry('boundary',{sourceId:source.id,revision:source.revision,bodyWitness:source.revision,offset:range.start+offset});
    if(!offeredBoundaries.has(offered.boundaryRef)){offeredBoundaries.set(offered.boundaryRef,offered);receiptBoundaries.push(offered);}
    return offered.boundaryRef;
   };
   const offerMaterial=local=>{
    if(!available||local.unselectable||local.end-local.start>4000||!text.slice(local.start,local.end).trim())return undefined;
    const metadata={sourceId:source.id,revision:source.revision,start:range.start+local.start,end:range.start+local.end,bodyDigest:digest(text.slice(local.start,local.end))};
    const material=entry('material',metadata),key=JSON.stringify([local.start,local.end]);
    if(!choices.has(key)){
     choices.set(key,material);offeredMaterials.set(material.materialRef,{metadata:material,text:text.slice(local.start,local.end)});receiptMaterials.push(material);
    }
    return material;
   };
   view.segments=atoms.map(local=>{
    const material=offerMaterial(local);atomicKeys.add(JSON.stringify([local.start,local.end]));
    atomicMaterials.push({local,material});
    const segment={...(material?{materialRef:material.materialRef}:{})},body=text.slice(local.start,local.end);
    if(!available||usedParts>=PART_LIMIT){segment.text=body;return segment;}
    const words=wordsFor(body),parts=[];let anchoredEnd=local.start;
    for(const word of words){
     if(usedParts>=PART_LIMIT)break;
     const start=local.start+word.start,end=local.start+word.end;
     parts.push([boundary(start),text.slice(start,end)]);usedParts++;anchoredEnd=end;coveredEnd=end;
    }
    if(!parts.length){segment.text=body;return segment;}
    segment.parts=parts;segment.endBoundary=boundary(anchoredEnd);
    if(anchoredEnd<local.end)parts.push([null,text.slice(anchoredEnd,local.end)]);
    return segment;
   });
   // Adjacent parts already display this exact shared endpoint. Suppressing
   // its duplicate label changes neither the offered map nor any body text.
   for(let index=0;index<view.segments.length-1;index++){
    const segment=view.segments[index],next=view.segments[index+1];
    if(segment.endBoundary&&next.parts?.[0]?.[0]===segment.endBoundary)delete segment.endBoundary;
   }
   for(const local of [...sentences,{start:0,end:text.length}])offerMaterial(local);
   // A UI choice retains only its exact previously admitted source/text/
   // revision tuple. Its boundary may fall inside a sentence or clause.
   if(selected)for(const quote of selected.quotes||[]){
    if(quote.sourceId!==source.id||quote.revision!==source.revision||typeof quote.text!=='string'||!quote.text.trim()||quote.text.length>4000)continue;
    const start=text.indexOf(quote.text);if(start>=0)offerMaterial({start,end:start+quote.text.length});
   }
   view.materialChoices=[...choices].filter(([key])=>!atomicKeys.has(key)).map(([,material])=>{
    const from=atomicMaterials.find(item=>range.start+item.local.start===material.start)?.material;
    const to=atomicMaterials.find(item=>range.start+item.local.end===material.end)?.material;
    return {materialRef:material.materialRef,...(from&&to?{from:from.materialRef,to:to.materialRef}:{selectedExactFragment:true})};
   });
   const partial=available&&coveredEnd<text.length;
   view.refinementCoverage={status:partial?'partial':'complete',maxParts:PART_LIMIT,...(partial?{lookup:{sourceId:source.id,offset:range.start+coveredEnd,maxChars:2000}}:{})};
   view.authorityChoices={program:[],originalUserStatementCandidates:[],candidateMeaning:'ORIGINALUSERSTATEMENTCANDIDATE_NOT_GRANT'};
   const authority=metadata=>{
    const offered=entry('authority',metadata);offeredAuthorities.set(offered.authorityRef,offered);receiptAuthorities.push(offered);
    const group=offered.kind==='ORIGINALUSERSTATEMENTCANDIDATE'?'originalUserStatementCandidates':'program';
    view.authorityChoices[group].push({authorityRef:offered.authorityRef,...(offered.kind==='ORIGINALUSERSTATEMENTCANDIDATE'
     ?{materialRef:offered.materialRef}:{target:'this_source',...(offered.materialRef?{materialRef:offered.materialRef}:{})})});
   };
   const ordinaryMaterial=available&&['qq','private','feedback','note'].includes(source.type)&&!['feedback_continue','user_control'].includes(source.kind);
   if(ordinaryMaterial&&(source.type==='qq'||allowed.has(source.id)))
    authority({kind:'PROGRAM_SOURCE_AUTHORITY',targetSourceId:source.id,targetRevision:source.revision});
   else if(ordinaryMaterial&&selected)for(const material of choices.values()){
    const fragment=offeredMaterials.get(material.materialRef);
    if(selected.quotes?.some(quote=>quote.sourceId===source.id&&quote.revision===source.revision&&quote.text===fragment.text))
     authority({kind:'PROGRAM_SOURCE_AUTHORITY',targetSourceId:source.id,targetRevision:source.revision,start:material.start,end:material.end,materialRef:material.materialRef});
   }
   if(available&&originalUser(source)&&source.delivery?.status!=='partial'&&!(source.historicalOnly&&source.id!==intentId)){
    if(foreground)authority({kind:'ORIGINALUSERSTATEMENTCANDIDATE',sourceId:source.id,revision:source.revision,wholeOriginal:true});
    else for(const material of choices.values())authority({kind:'ORIGINALUSERSTATEMENTCANDIDATE',materialRef:material.materialRef,sourceId:source.id,revision:source.revision,start:material.start,end:material.end});
   }
   if(!view.authorityChoices.program.length)delete view.authorityChoices.program;
   if(!view.authorityChoices.originalUserStatementCandidates.length){delete view.authorityChoices.originalUserStatementCandidates;delete view.authorityChoices.candidateMeaning;}
   return view;
  }).filter(Boolean);
  if(foreground)for(const field of ['recentHumanContext','priorHumanDirections'])if(Array.isArray(input.taskContext?.[field]))input.taskContext[field]=input.taskContext[field].flatMap(reference=>{
    const delivered=sourceById.get(reference.sourceId);
    return delivered?.available&&originalUser(delivered.source)&&delivered.source.delivery?.status!=='partial'?[{...reference,text:delivered.text}]:[];
   });
  input.primaryReferenceProtocol={version:VERSION};
  freeze(projected);
  const bindingId=digest({scope:this.#scope,taskId:this.#taskId,materials:receiptMaterials,authorities:receiptAuthorities,boundaries:receiptBoundaries});
  const receipt=freeze({version:VERSION,bindingId,scope:clone(this.#scope),taskId:this.#taskId,materials:receiptMaterials,authorities:receiptAuthorities,boundaries:receiptBoundaries});
  const requireCommit=()=>{if(!committed)throw fail('$','primary_reference_not_dispatched','reference snapshot was not dispatched');};
  const snapshot={payload:projected,receipt,
   commit:()=>{if(committed)return;if(this.#generation!==generation)throw fail('$','primary_reference_offer_changed','reference owner changed before dispatch; rebuild this request');this.#entries=entries;this.#materialCount=materialCount;this.#authorityCount=authorityCount;this.#boundaryCount=boundaryCount;this.#generation++;committed=true;},
   material:(ref,path='materialRef')=>{
    requireCommit();
    const refined=typeof ref==='string'&&/^(m[1-9]\d*)@(b[1-9]\d*):(b[1-9]\d*)$/.exec(ref),base=refined?refined[1]:ref;
    const found=typeof base==='string'&&offeredMaterials.get(base);
    if(!found)throw fail(path,'unknown_material_reference','choose only an exact materialRef offered in this HTTP request');
    let metadata=found.metadata,text=found.text;
    if(refined){
     const start=offeredBoundaries.get(refined[2]),end=offeredBoundaries.get(refined[3]);
     if(!start||!end||start.sourceId!==metadata.sourceId||end.sourceId!==metadata.sourceId||start.revision!==metadata.revision||end.revision!==metadata.revision||start.offset<metadata.start||end.offset>metadata.end||start.offset>=end.offset)
      throw fail(path,'material_reference_boundary_invalid','choose ordered nonempty offered boundaries inside this same material parent');
     text=found.text.slice(start.offset-metadata.start,end.offset-metadata.start);
     if(!text.trim())throw fail(path,'material_reference_boundary_invalid','a refined material span must contain nonempty source text');
     metadata={...metadata,start:start.offset,end:end.offset,bodyDigest:digest(text)};
    }
    const result=freeze({sourceId:metadata.sourceId,text,revision:metadata.revision});
    materialBindings.set(result,{snapshot,metadata});return result;
   },
   publicAuthority:(material,path='authorityRef')=>{
    requireCommit();const bound=material&&materialBindings.get(material);
    if(!bound||bound.snapshot!==snapshot)throw fail(path,'material_reference_binding_invalid','public authority requires this exact dispatched material');
    const source=sourceById.get(material.sourceId);
    if(!source?.available||!sameScope(source.source,this.#scope)||source.source.deleted||source.source.excluded||source.source.use==='disabled'||source.source.type!=='qq'||source.source.revision!==material.revision)return undefined;
    return [...offeredAuthorities.values()].find(authority=>authority.kind==='PROGRAM_SOURCE_AUTHORITY'&&authority.targetSourceId===material.sourceId&&authority.targetRevision===material.revision&&authority.start===undefined)?.authorityRef;
   },
   authority:(ref,material,path='authorityRef')=>{
    requireCommit();const found=typeof ref==='string'&&offeredAuthorities.get(ref),bound=material&&materialBindings.get(material);
    if(!found)throw fail(path,'unknown_authority_reference','choose only an exact authorityRef offered in this HTTP request');
    if(!bound||bound.snapshot!==snapshot)throw fail(path,'material_reference_binding_invalid','authority requires the exact material choice from this HTTP request');
    if(found.kind==='PROGRAM_SOURCE_AUTHORITY'){
     if(found.targetSourceId!==material.sourceId||found.targetRevision!==material.revision||found.start!==undefined&&(found.start!==bound.metadata.start||found.end!==bound.metadata.end))
      throw fail(path,'authority_target_mismatch','program source authority applies only to its exact offered material target');
     return undefined;
    }
    const current=(found.currentInstruction||found.wholeOriginal)&&sourceById.get(found.sourceId);
    const permission=(found.currentInstruction||found.wholeOriginal)&&current?.available&&current.source.revision===found.revision
     ?{metadata:{sourceId:found.sourceId},text:current.text}:offeredMaterials.get(found.materialRef);
    if(!permission)throw fail(path,'unknown_authority_reference','the original user statement was not delivered in this request');
    return {permission:{sourceId:permission.metadata.sourceId,text:permission.text},referent:{sourceId:material.sourceId,text:material.text}};
   },
   currentDelivery:(value,path='requestDelivery')=>{
    requireCommit();
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['mode','blocker'].includes(key)))
     throw fail(path,'request_delivery_reference_invalid','use only mode and optional blocker; current input identity is program-bound');
    const current=sourceById.get(intentId),source=current?.source;
    if(!current?.available||source.role!=='user'||!['private','request','feedback'].includes(source.type)||!current.text.trim())
     throw fail(path,'request_delivery_reference_invalid','the captured current intent source is not delivered and usable');
    const start=current.text.search(/\S/u);let end=Math.min(start+1000,current.text.length);if(end>0&&/[\uD800-\uDBFF]/u.test(current.text[end-1]))end--;
    const quote=current.text.slice(start,end);
    if(!quote.trim())throw fail(path,'request_delivery_reference_invalid','the captured current input has no bounded nonempty text');
    return {mode:value.mode,sourceId:intentId,quote,...(Object.hasOwn(value,'blocker')?{blocker:clone(value.blocker)}:{})};
   },
   markCanonical:value=>{requireCommit();if(value&&typeof value==='object'){const old=canonical.get(value);if(old&&old!==snapshot)throw fail('$','primary_reference_binding_invalid','canonical result cannot be rebound to another HTTP offer');canonical.set(value,snapshot);}return value;},
   isCanonical:value=>{const bound=value&&typeof value==='object'&&canonical.get(value);if(bound&&bound!==snapshot)throw fail('$','primary_reference_binding_invalid','canonical result belongs to another HTTP offer');return bound===snapshot;}
  };
  return Object.freeze(snapshot);
 }
}
module.exports={PrimaryReferenceOwner,VERSION,SYSTEM};
