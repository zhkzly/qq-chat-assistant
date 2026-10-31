'use strict';
const {createHash}=require('node:crypto');
const {parseModelJson}=require('./model-json.cjs');
const {validationError}=require('./validation-issues.cjs');
const {sameScopeIfPresent}=require('./context/source-snapshot.cjs');
const {sourceClosure}=require('./provenance.cjs');
const {candidateFields,candidatePaths,normalizeCandidatePath}=require('./candidate-field-paths.cjs');
const VERSION='whole-answer-fidelity-v4';
const marks=new WeakMap(),clone=value=>structuredClone(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const fail=(field,code,message)=>validationError(field,code,message);
const original=source=>source&&!source.deleted&&!source.excluded&&source.use!=='disabled'&&
 ['qq','private','feedback','note'].includes(source.type)&&source.role!=='assistant'&&
 !['feedback_continue','user_control'].includes(source.kind);
const continuity=source=>({...(source?.historicalOnly?{historicalOnly:true}:{}),
 ...(source?.continuationCoverage?.startsWith('later_')?{continuationCoverage:source.continuationCoverage}:{})});
const withContinuity=(body,latest)=>{
 const {historicalOnly,continuationCoverage,...rest}=body;
 return {...rest,...(continuationCoverage&&!continuationCoverage.startsWith('later_')?{continuationCoverage}:{}),...continuity(latest)};
};

function visibleCandidate(result,options=result?.expressionOptions||[]){
 return {text:typeof result?.text==='string'?result.text:'',
  ...(result?.discussionExplanation?{discussionExplanation:{kind:'discussion',text:result.discussionExplanation.text}}:{}),
  suggestions:(result?.suggestions||[]).map(item=>({style:item.style||'自然',text:item.text})),
  expressionOptions:options.map(item=>({label:item.label}))};
}
function parseWholeAnswer(answer){
 if(!plain(answer)||Object.keys(answer).some(key=>!['privateExplanation','suggestions'].includes(key))||
  !Array.isArray(answer.suggestions)||answer.suggestions.length<1||answer.suggestions.length>3)
  throw fail('answer','whole_answer_invalid','prepare_message requires answer with 1..3 complete suggestions and optional privateExplanation');
 const suggestions=answer.suggestions.map((item,index)=>{
  if(!plain(item)||Object.keys(item).some(key=>!['style','text'].includes(key))||typeof item.text!=='string'||!item.text.trim()||item.text.length>1200||
   item.style!==undefined&&(typeof item.style!=='string'||!item.style.trim()||item.style.length>40))
   throw fail(`answer.suggestions[${index}]`,'whole_answer_invalid','Use complete outward text (1..1200) and an optional bounded style');
  return {style:item.style||'自然',text:item.text};
 });
 const why=answer.privateExplanation;
 if(why!=null&&typeof why!=='string'||typeof why==='string'&&why.length>6000)
  throw fail('answer.privateExplanation','whole_answer_invalid','Final privateExplanation is optional text of at most 6000 characters');
 // Outward bodies belong to their individually revocable suggestion leaves.
 // The parent has only independently authored private explanation, never a
 // second copy of the first leaf that could outlive that leaf's withdrawal.
 return {kind:'draft',text:'',suggestions,
  ...(typeof why==='string'&&why.trim()?{discussionExplanation:{kind:'discussion',text:why}}:{})};
}

function buildFidelityContext(prepared,result,info={}){
 const scope=info.scope||prepared.manifest?.scope;
 if(!sameScopeIfPresent({scope:prepared.manifest?.scope},scope))throw fail('scope','fidelity_binding_invalid','Fidelity scope changed');
 const options=info.expressionOptions||result.expressionOptions||[],candidate=visibleCandidate(result,options);
 const optionMaterials=info.optionAdmission?.groups||options.map((option,index)=>({index,fragments:option.quotes||[]}));
 const revisions={...prepared.manifest?.sourceRevisions,...info.admittedContext?.manifest?.sourceRevisions,...info.optionAdmission?.sourceRevisions};
 const intentId=prepared.payload.intentAuthority?.sourceId;
 const required=new Set([intentId,...(prepared.essentialSourceIds||[]),
  ...(info.admittedContext?.payload.outboundQuotes||[]).map(item=>item.sourceId),
  ...optionMaterials.flatMap(option=>option.fragments.map(fragment=>fragment.sourceId)),...Object.keys(info.optionAdmission?.sourceRevisions||{}),
  ...(prepared.payload.topicContext?.controlRefs||[]).map(item=>item.sourceId)]);
 const sourceMap=new Map(),contexts=[...(info.sourceContexts||[]),prepared];
 const captured=new Map((prepared.fullAvailableSources||prepared.payload.sources||[]).map(source=>[source.id,source]));
 for(const context of contexts)for(const source of context.payload?.sources||[]){
  if(!original(source)||typeof source.text!=='string')continue;
  if(!sameScopeIfPresent(source,scope))throw fail('evidence','fidelity_binding_invalid','Original evidence belongs to another account or contact');
  // Earlier reads remain evidence only at the exact version captured for that
  // request and still present in this terminal snapshot. Never upgrade an old
  // body to a later revision, or silently omit its late-source fence.
  const expected=context.manifest?.sourceRevisions?.[source.id],live=captured.get(source.id);
  if(expected!==source.revision||!live||live.revision!==source.revision)continue;
  if(revisions[source.id]!==undefined&&source.revision!==revisions[source.id])continue;
  const prior=sourceMap.get(source.id);
  const body=!prior||prior.delivery?.status==='partial'&&source.delivery?.status!=='partial'?source:prior;
  sourceMap.set(source.id,withContinuity(body,source));revisions[source.id]=source.revision;
 }
 // The checker may inspect the captured complete original underlying an
 // admitted fragment. This read-only expansion grants no new material choice.
 for(const id of [...required]){
  const source=captured.get(id);
  if(original(source)&&(!revisions[id]||revisions[id]===source.revision)){
   if(!sameScopeIfPresent(source,scope))throw fail('evidence','fidelity_binding_invalid','Captured original belongs to another scope');
   sourceMap.set(id,{...source,...continuity(sourceMap.get(id))});revisions[id]=source.revision;
  }
 }
 const unavailableRoots=[];
 for(const quote of [...(info.admittedContext?.payload.outboundQuotes||[]),...optionMaterials.flatMap(option=>option.fragments)]){
  const note=captured.get(quote.sourceId);if(note?.type!=='note'||!note.evidenceSourceIds?.length)continue;
  try{
   const closure=sourceClosure(captured,[note.id]);
   if(closure.some(source=>(source.evidenceSourceIds||[]).some(id=>!source.evidenceRevisions||!Object.hasOwn(source.evidenceRevisions,id))))throw new Error('Unbound note lineage');
   for(const source of closure){
    if(!original(source)||!sameScopeIfPresent(source,scope))throw new Error('Unavailable note lineage');
    sourceMap.set(source.id,{...source,...continuity(sourceMap.get(source.id))});revisions[source.id]=source.revision;required.add(source.id);
   }
  }catch{unavailableRoots.push(note.id);}
 }
 // Retained controls are source-bound human statements, not generated topic
 // summaries. A missing original remains a coverage gap, never a new fact.
 for(const ref of prepared.payload.topicContext?.controlRefs||[]){
  const source=(prepared.fullAvailableSources||[]).find(item=>item.id===ref.sourceId&&item.revision===ref.revision);
  if(original(source)){if(!sameScopeIfPresent(source,scope))throw fail('evidence','fidelity_binding_invalid','Retained human control belongs to another scope');sourceMap.set(source.id,{...source,...continuity(sourceMap.get(source.id))});revisions[source.id]=source.revision;}
 }
 // Recent human statements were already selected as the current private
 // conversation. Their boundaries matter even without a persisted topic.
 for(const turn of (prepared.payload.privateConversation||[]).filter(item=>item.role==='user').slice(-4)){
  const id=turn.sourceId||`private:${turn.id}`,source=(prepared.fullAvailableSources||[]).find(item=>item.id===id);
  if(original(source)&&source.type!=='note'){if(!sameScopeIfPresent(source,scope))throw fail('evidence','fidelity_binding_invalid','Recent human control belongs to another scope');sourceMap.set(id,{...source,...continuity(sourceMap.get(id))});revisions[id]=source.revision;required.add(id);}
 }
 for(const source of sourceMap.values())if(source.role==='user'&&['private','feedback'].includes(source.type))required.add(source.id);
 const evidence=[...sourceMap.values()].map(source=>({sourceId:source.id,type:source.type,role:source.role||'unknown',at:source.at||null,text:source.text,...continuity(source),
  ...(source.type==='note'?{authority:'note_context_not_original_human_statement',lineage:source.evidenceSourceIds?.length?'derived':'authored_or_unattributed',evidenceSourceIds:source.evidenceSourceIds||[]}:{}),
  ...(source.delivery?.status==='partial'?{delivery:clone(source.delivery)}:{})}));
 const admitted=info.admittedContext?.payload.outboundQuotes||[];
 const payload={purpose:'fidelity_check',version:VERSION,checkRef:'c1',asOf:prepared.payload.asOf||null,
  ...(prepared.payload.goal!==undefined?{goal:clone(prepared.payload.goal)}:{}),
  ...(prepared.payload.viewerTimeZone?{viewerTimeZone:prepared.payload.viewerTimeZone}:{}),
  ...(prepared.payload.taskContext?.timeContext?{timeContext:clone(prepared.payload.taskContext.timeContext)}:{}),
  ...(prepared.payload.actionReceipts?.length?{actionReceipts:clone(prepared.payload.actionReceipts)}:{}),
  candidate:freeze(clone(candidate)),candidatePaths:candidatePaths(candidate),evidence,
  ...(intentId?{intentAuthority:{sourceId:intentId}}:{}),
  admittedFragments:admitted.map(({sourceId,text})=>({sourceId,text})),
  ...(optionMaterials.some(option=>option.fragments.length)?{optionMaterials:clone(optionMaterials)}:{}),
  ...(info.admittedContext?.payload.currentHumanControl?{currentHumanControl:{sourceId:info.admittedContext.payload.currentHumanControl.sourceId,authority:'CONTROL_ONLY',bodyLocation:'evidence'}}:{}),
  ...(info.admittedContext?.payload.selectedDirectionControl?{selectedDirectionControl:clone(info.admittedContext.payload.selectedDirectionControl)}:{}),
  ...(info.admittedContext?.payload.editingReference?{priorArtifact:clone(info.admittedContext.payload.editingReference)}:{}),
  coverage:{omittedSourceIds:[],partialSourceIds:evidence.filter(item=>item.delivery).map(item=>item.sourceId),unavailableRootSourceIds:unavailableRoots,
   rule:'Only supplied original bodies are read evidence. Summaries and missing lineage are navigation, not proof of absence or permission.'}};
 const images=freeze(clone(prepared.images||[]));
 if(images.length){
  for(const image of images)required.add(`qq:${image.messageId}`);
  payload.sources=evidence.filter(source=>source.type==='qq').map(source=>({id:source.sourceId,type:'qq',role:source.role,at:source.at}));
  payload.imageContext=require('./assistant-model.cjs').imageContextFor(payload,images,prepared.mediaContext||prepared.payload.imageContext);
 }
 const settings=info.settings||{},limit=Math.max(8000,Math.min(256000,Number(settings.assistantRequestBytes)||prepared.manifest?.requestByteBudget||64000));
 const measure=info.requestMeasure||((value)=>require('./assistant-model.cjs').prepareAssistantRequest(settings,value,images,{sourceRevisions:revisions}).requestBytes);
 while(measure(payload)>limit){
  const index=payload.evidence.findIndex(source=>!required.has(source.sourceId));
  if(index<0)throw fail('evidence','fidelity_context_budget','Complete candidate and required original controls/evidence exceed the fidelity request budget; input retained');
  payload.coverage.omittedSourceIds.push(payload.evidence[index].sourceId);payload.evidence.splice(index,1);
 }
 // This is a new invocation, not a continuation of the producer's result or
 // bookkeeping review. Carry only mechanical binding metadata; its own trace
 // must describe the evidence and instructions actually sent to the checker.
 const inherited=Object.fromEntries(['promptVersion','contextRevision','stateVersion','goalVersion','topicVersion','historyCoverage','candidateSession']
  .filter(key=>prepared.manifest[key]!==undefined).map(key=>[key,clone(prepared.manifest[key])]));
 const checkerSources=payload.evidence.map(source=>({id:source.sourceId,revision:revisions[source.sourceId],text:source.text,...(source.delivery?{delivery:source.delivery}:{})}));
 const sourceIds=checkerSources.map(source=>source.id),manifest={...inherited,requestId:info.requestId||prepared.manifest.requestId,purpose:'fidelity_check',scope:clone(scope),
  // Transient request controls stay hash/revision-bound, but are not durable
  // memory sources and cannot become an assistant turn's source dependencies.
  sourceIds:[...new Set([...sourceIds,...Object.keys(revisions)])].filter(id=>!id.startsWith('request:')),sourceRevisions:revisions,
  sourceDelivery:require('./context/source-delivery.cjs').sourceDeliveryManifest([...captured.values()],checkerSources),coverage:clone(payload.coverage),
  requestByteBudget:limit,tokenizerVerified:false,
  methodTrace:{purpose:'fidelity_check',delivered:[],catalog:[],operationalDelivery:{location:'none',ids:[]},reported:null},
  inputArtifactRefs:clone(info.admittedContext?.manifest.inputArtifactRefs||prepared.manifest.inputArtifactRefs||[]),createdAt:new Date().toISOString()};
 freeze(payload);
 const evidenceHash=hash(payload);
 let context;
 const binding=()=>hash({scope,requestId:info.requestId||prepared.manifest.requestId,intentId,
  primaryRevisions:prepared.manifest.sourceRevisions,admittedRevisions:info.admittedContext?.manifest.sourceRevisions,
  asOf:prepared.payload.asOf,goal:prepared.payload.goal,goalVersion:prepared.manifest.goalVersion,
  admitted:info.admittedContext?.payload.outboundQuotes,currentHuman:info.admittedContext?.payload.currentHumanControl,selectedDirection:info.admittedContext?.payload.selectedDirectionControl,
  revisions:context?.manifest.sourceRevisions||revisions,artifacts:(context?.manifest||manifest).inputArtifactRefs||[],
  evidenceHash:hash(context?.payload||payload),optionWitness:options.map(option=>({label:option.label,style:option.style,quotes:option.quotes||[]})),authorizedImages:prepared.images||[],images:context?.images||images,sourceWitness:[...sourceMap.values()].map(source=>[source.id,source.revision,source.type,source.role,source.at,source.text,source.delivery,source.evidenceRevisions])});
 const bound=binding(),candidateHash=hash(candidate),fields=new Map(candidateFields(candidate).map(field=>[field.path,field.value])),paths=new Set(payload.candidatePaths);
 const bodyAt=path=>fields.get(path);
 const frame=Object.freeze({candidateHash,bindingHash:bound,paths,sourceIds:new Set(sourceIds),bodyAt,evidenceAt:id=>payload.evidence.find(source=>source.sourceId===id),
  assert(){if(binding()!==bound||hash(visibleCandidate(result,options))!==candidateHash||hash(payload.candidate)!==candidateHash||hash(payload)!==evidenceHash)throw fail('candidate','fidelity_binding_invalid','The candidate or captured evidence binding changed after checking');}});
 manifest.fidelity={version:VERSION,candidateHash,bindingHash:bound,evidenceHash,status:'pending'};
 context={payload,manifest,images};Object.defineProperty(context,'fidelityFrameSnapshot',{value:frame});
 Object.defineProperty(context,'sourceReferenceRevisions',{value:revisions});
 Object.defineProperty(context,'sourceHandleOwner',{value:prepared.sourceHandleOwner||settings.sourceHandleOwner,writable:true,configurable:true});
 return context;
}

function parseFidelityResult(value,input){
 const frame=input?.fidelityFrameSnapshot;if(!frame)throw fail('checkRef','fidelity_binding_invalid','A checker result requires its private captured frame');frame.assert();
 if(plain(value)&&marks.has(value)){if(marks.get(value).frame!==frame||marks.get(value).hash!==hash(value))throw fail('checkRef','fidelity_binding_invalid','Checker result belongs to another candidate or was modified');return value;}
 let data=typeof value==='string'?parseModelJson(value):value;
 if(!plain(data)||Object.keys(data).some(key=>!['checkRef','verdict','issues','concerns'].includes(key))||data.checkRef!=='c1'||
  !['allow','reject','uncertain'].includes(data.verdict)||!Array.isArray(data.issues)||data.issues.length>12)
  throw fail('checkRef','fidelity_result_invalid','Return only this checkRef, allow/reject/uncertain and bounded issues; never rewrite or execute');
 const softCodes=['current_boundary','pragmatic_ambiguity','style','helpfulness','coverage_gap'];
 const concerns=[],issues=[],unusableAdvisory=[];
 const unusableSoft=new Set();
 if(input.sourceWireSnapshot&&!input.sourceWireSnapshot.isCanonical?.(data)){
  const wire=input.sourceWireSnapshot,original=data,hard=original.issues.filter(issue=>!softCodes.includes(issue?.code));
  data=wire.decode({...original,issues:hard,concerns:undefined});
  const optionalDecode=(raw,field)=>{
   let failed=false;const decoded=wire.decode({concerns:[raw]},{isolateFields:['concerns'],onRejected:(_field,error)=>{failed=true;unusableAdvisory.push({field,code:error.code,message:error.message.slice(0,700),raw:String(JSON.stringify(raw)).slice(0,1600)});}});
   return {failed,value:failed?raw:decoded.concerns[0]};
  };
  let hardIndex=0;data.issues=original.issues.map((raw,index)=>{
   if(!softCodes.includes(raw?.code))return data.issues[hardIndex++];
   const decoded=optionalDecode(raw,`issues[${index}]`);if(decoded.failed)unusableSoft.add(index);return decoded.value;
  });
  if(Array.isArray(original.concerns))data.concerns=original.concerns.slice(0,12).flatMap((raw,index)=>{const decoded=optionalDecode(raw,`concerns[${index}]`);return decoded.failed?[]:[decoded.value];});
  else data.concerns=original.concerns;
  if(Array.isArray(original.concerns)&&original.concerns.length>12)unusableAdvisory.push({field:'concerns',code:'advisory_limit',omittedCount:original.concerns.length-12});
 }
 const address=(path,field)=>{
  const canonical=normalizeCandidatePath(path,input.payload.candidatePaths);
  if(canonical===undefined)throw fail(field,'fidelity_candidate_path_invalid',`${field}: received ${JSON.stringify(path)}; choose an offered candidate-relative path: ${input.payload.candidatePaths.join(', ')}`);
  if(canonical!==path&&input.manifest){
   input.manifest.fidelity ||= {};
   input.manifest.fidelity.addressNormalizations=[...(input.manifest.fidelity.addressNormalizations||[]),{field,received:path,canonical}];
  }
  return canonical;
 };
 const quoted=(path,quote)=>typeof quote==='string'&&quote.trim()&&quote.length<=1200&&typeof frame.bodyAt(path)==='string'&&frame.bodyAt(path).includes(quote);
 const concern=(raw,index,field=`concerns[${index}].path`)=>{
  const item=plain(raw)?{...raw,path:address(raw.path,field)}:raw;
  if(!plain(item)||Object.keys(item).some(key=>!['path','code','quote','sourceIds','evidence','reason'].includes(key))||typeof item.code!=='string'||!item.code.trim()||item.code.length>80||
   typeof item.reason!=='string'||!item.reason.trim()||item.reason.length>500||item.quote!==undefined&&!quoted(item.path,item.quote))
   throw fail(`concerns[${index}]`,'fidelity_result_invalid','Nonblocking concerns cite a visible path; they are private diagnostics, not new facts or warnings');
  if(item.sourceIds!==undefined&&(!Array.isArray(item.sourceIds)||item.sourceIds.some(id=>!frame.sourceIds.has(id)))||item.evidence!==undefined&&(!Array.isArray(item.evidence)||item.evidence.length>8||item.evidence.some(ref=>!plain(ref)||Object.keys(ref).some(key=>!['sourceId','quote'].includes(key))||typeof ref.quote!=='string'||!ref.quote.trim()||!frame.evidenceAt(ref.sourceId)?.text.includes(ref.quote))))throw fail(`concerns[${index}].evidence`,'fidelity_result_invalid','Private concerns cannot invent evidence witnesses');
  concerns.push(clone(item));
 };
 const optionalConcern=(raw,index,field)=>{
  try{concern(raw,index,field);}catch(error){unusableAdvisory.push({field:field||`concerns[${index}]`,code:error.code||'invalid_advisory',message:error.message,raw:String(JSON.stringify(raw)).slice(0,1600)});}
 };
 for(const [index,raw]of data.issues.entries()){
  if(unusableSoft.has(index))continue;
  if(softCodes.includes(raw?.code)){optionalConcern(raw,index,`issues[${index}].path`);continue;}
  const issue=plain(raw)?{...raw,path:address(raw.path,`issues[${index}].path`),...(Object.hasOwn(raw,'relatedPath')?{relatedPath:address(raw.relatedPath,`issues[${index}].relatedPath`)}:{})}:raw;
  if(!plain(issue)||Object.keys(issue).some(key=>!['path','code','quote','sourceIds','evidence','basis','relatedPath','relatedQuote','reason'].includes(key))||
   !['unsupported_fact','private_disclosure','omitted_qualifier','evidence_mismatch','internal_conflict'].includes(issue.code)||!quoted(issue.path,issue.quote)||
   typeof issue.reason!=='string'||!issue.reason.trim()||issue.reason.length>500||
   issue.sourceIds!==undefined&&(!Array.isArray(issue.sourceIds)||issue.sourceIds.length>16||issue.sourceIds.some(id=>!frame.sourceIds.has(id))))
   throw fail(`issues[${index}]`,'fidelity_result_invalid','A blocking defect requires an exact visible claim and captured evidence grounding, not reviewer confidence');
  const evidence=issue.evidence||[];
  if(!Array.isArray(evidence)||evidence.length>8||evidence.some(ref=>!plain(ref)||Object.keys(ref).some(key=>!['sourceId','quote'].includes(key))||typeof ref.quote!=='string'||!ref.quote.trim()||ref.quote.length>1200||!frame.evidenceAt(ref.sourceId)?.text.includes(ref.quote)))
   throw fail(`issues[${index}].evidence`,'fidelity_result_invalid','Defect evidence must quote only an original body actually supplied to this checker');
  if(['private_disclosure','current_boundary','omitted_qualifier','evidence_mismatch'].includes(issue.code)&&!evidence.length||
   issue.code==='current_boundary'&&!evidence.some(ref=>['qq','private','feedback'].includes(frame.evidenceAt(ref.sourceId)?.type)&&['user','contact'].includes(frame.evidenceAt(ref.sourceId)?.role))||
   issue.code==='unsupported_fact'&&issue.basis!=='no_support_in_supplied_evidence'||
   issue.code==='internal_conflict'&&(!quoted(issue.relatedPath,issue.relatedQuote)||issue.relatedPath===issue.path&&issue.relatedQuote===issue.quote))
   throw fail(`issues[${index}]`,'fidelity_grounding_missing','Ground a concrete original conflict, unsupported factual assertion, or exact other candidate statement; social/style readings alone cannot veto');
  issues.push(clone(issue));
 }
 if(Array.isArray(data.concerns))for(const [index,item]of data.concerns.slice(0,12).entries())optionalConcern(item,index);
 else if(data.concerns!==undefined)unusableAdvisory.push({field:'concerns',code:'invalid_advisory_container',raw:JSON.stringify(data.concerns).slice(0,1600)});
 if(Array.isArray(data.concerns)&&data.concerns.length>12)unusableAdvisory.push({field:'concerns',code:'advisory_limit',omittedCount:data.concerns.length-12});
 if(data.verdict==='allow'&&issues.length||data.verdict==='reject'&&!issues.length&&!concerns.length&&!unusableAdvisory.length)throw fail('issues','fidelity_result_invalid','Allow has no blocking defect; rejection needs one, and concerns never block');
 // A malformed optional diagnostic neither vetoes a valid core decision nor
 // supplies the missing proof needed to turn an unsupported rejection into allow.
 const verdict=data.verdict==='reject'&&!issues.length&&concerns.length?'allow':data.verdict==='reject'&&!issues.length?'uncertain':data.verdict;
 if(input.manifest)input.manifest.fidelity={...input.manifest.fidelity,reportedVerdict:data.verdict,...(unusableAdvisory.length?{unusableAdvisory}:{})};
 const result=freeze({checkRef:'c1',verdict,issues,...(concerns.length?{concerns}:{})});marks.set(result,{frame,hash:hash(result)});input.sourceWireSnapshot?.markCanonical(result);return result;
}
function buildFidelityRepairContext(prepared,checkedInput){
 const frame=checkedInput?.fidelityFrameSnapshot;if(!frame)throw fail('evidence','fidelity_binding_invalid','Regeneration requires its captured fidelity frame');frame.assert();
 const retry=Object.create(Object.getPrototypeOf(prepared),Object.getOwnPropertyDescriptors(prepared));
 retry.payload=clone(prepared.payload);retry.images=prepared.images;
 // Reuse the original input's capabilities and version fences, not the last
 // producer's result/repair/transport diagnostics. This invocation validates
 // its own output; earlier errors remain on their original captured request.
 const bindings=['requestId','scope','purpose','promptVersion','contextRevision','stateVersion','goalVersion','topicVersion',
  'sourceIds','sourceRevisions','sourceDelivery','completeReview','omittedSourceCount','historyCoverage','byteBudget','tokenizerVerified',
  'requestByteBudget','requestModel','budgetMethod','contextSelection','optionalRawRetrieval','recentQQContext',
  'discussionCompaction','discussionReads','discussionReadCoverage','inputArtifactRefs','selectedDirectionControl','candidateSession'];
 retry.manifest=Object.fromEntries(bindings.filter(key=>prepared.manifest[key]!==undefined).map(key=>[key,clone(prepared.manifest[key])]));
 retry.manifest.methodTrace={...require('./context/budget-manifest.cjs').methodTrace(retry.payload),purpose:'delivery_repair'};
 retry.manifest.createdAt=new Date().toISOString();
 const captured=new Map((prepared.fullAvailableSources||prepared.payload.sources||[]).map(source=>[source.id,source]));
 const sources=new Map(retry.payload.sources.map(source=>[source.id,source])),restored=[];
 for(const evidence of checkedInput.payload.evidence){
  const source=captured.get(evidence.sourceId),revision=checkedInput.manifest.sourceRevisions[evidence.sourceId];
  // Restore only original bodies the checker actually received at this exact
  // version. A reason string, summary or omitted remainder is not evidence.
  if(!original(source)||source.revision!==revision||source.text!==evidence.text||!sameScopeIfPresent(source,retry.manifest.scope))continue;
  if(!sources.has(source.id)||sources.get(source.id).text!==source.text||sources.get(source.id).delivery?.status==='partial'){
   sources.set(source.id,{...clone(source),...continuity(evidence)});restored.push(source.id);
  }
  retry.manifest.sourceRevisions[source.id]=revision;
 }
 retry.payload.sources=[...sources.values()];
 retry.manifest.sourceIds=[...new Set([...retry.manifest.sourceIds,...restored])].filter(id=>!id.startsWith('request:'));
 const delivery=require('./context/source-delivery.cjs').sourceDeliveryManifest([...captured.values()],retry.payload.sources,prepared.manifest.sourceDelivery?.explicitLookups||[]);
 retry.manifest.sourceDelivery=delivery;
 if(retry.payload.evidenceDelivery)retry.payload.evidenceDelivery={...retry.payload.evidenceDelivery,...delivery};
 retry.manifest.fidelityRestoration={sourceIds:restored,rule:'exact_checker_originals_without_new_disclosure_authority'};
 return retry;
}
function approvalFor(result,input){
 const frame=input?.fidelityFrameSnapshot;
 if(!frame||marks.get(result)?.frame!==frame||marks.get(result)?.hash!==hash(result)||result.verdict!=='allow')return undefined;
 frame.assert();return Object.freeze({version:VERSION,candidateHash:frame.candidateHash,bindingHash:frame.bindingHash});
}
module.exports={VERSION,visibleCandidate,parseWholeAnswer,buildFidelityContext,buildFidelityRepairContext,parseFidelityResult,approvalFor};
