'use strict';
const {createHash}=require('node:crypto');
const {parseModelJson}=require('./model-json.cjs');
const {validationError}=require('./validation-issues.cjs');
const {sameScopeIfPresent}=require('./context/source-snapshot.cjs');
const {sourceClosure}=require('./provenance.cjs');
const {candidateFields,candidatePaths,candidateScopes,normalizeCandidatePath}=require('./candidate-field-paths.cjs');
const VERSION='whole-answer-fidelity-v6';
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
 const admission=info.admittedContext?.manifest;
 if(admission?.scope&&!sameScopeIfPresent({scope:admission.scope},scope))throw fail('scope','fidelity_binding_invalid','Disclosure admission belongs to another account/contact');
 const disclosureFragments=admitted.filter(quote=>{
  const source=captured.get(quote.sourceId);return source&&typeof quote.text==='string'&&quote.text.trim()&&source.text.includes(quote.text)&&revisions[source.id]===source.revision&&admission?.sourceRevisions?.[source.id]===source.revision;
 }).map(({sourceId,text})=>({sourceId,text}));
 const programDisclosureSources=new Set([...sourceMap.values()].filter(source=>source.type==='qq'||source.type==='note'&&source.use==='draft'&&!(source.evidenceSourceIds||[]).length).map(source=>source.id));
 const assistantHuman=source=>original(source)&&source.role==='user'&&(source.type==='private'&&!['feedback','feedback_ref','feedback_continue','user_control'].includes(source.kind)||source.type==='feedback'&&!!source.canonicalFeedbackId);
 const currentHumanId=assistantHuman(sourceMap.get(intentId))?intentId:null;
 const instructionSelections=new Map(),inactiveControls=new Set((prepared.payload.topicContext?.retained||[]).filter(topic=>topic.lifecycle!=='active').flatMap(topic=>topic.sourceIds||[]));
 const offerInstruction=(id,selection)=>{
  const source=sourceMap.get(id);if(!source||!assistantHuman(source)&&!(selection==='standing_preference'&&source.type==='note'&&source.kind==='preference'&&source.use!=='disabled'))return;
  if(id!==currentHumanId&&inactiveControls.has(id)&&selection!=='standing_preference')return;
  if(!instructionSelections.has(id))instructionSelections.set(id,selection);required.add(id);
 };
 if(currentHumanId)offerInstruction(currentHumanId,'current_request');
 for(const ref of prepared.payload.topicContext?.controlRefs||[])if(prepared.payload.topicContext?.active?.lifecycle==='active')offerInstruction(ref.sourceId,'active_task');
 for(const ref of prepared.payload.taskContext?.recentHumanContext||[])offerInstruction(ref.sourceId,'recent_consultation');
 for(const ref of prepared.payload.preferences||[])offerInstruction(ref.sourceId,'standing_preference');
 const originalOrder=new Map((prepared.fullAvailableSources||[...sourceMap.values()]).map((source,index)=>[source.id,index]));
 const humanInstructions=[...instructionSelections].map(([sourceId,selection])=>({sourceId,selection,at:sourceMap.get(sourceId).at||null,bodyLocation:'evidence'}));
 const payload={purpose:'fidelity_check',version:VERSION,checkRef:'c1',asOf:prepared.payload.asOf||null,
  ...(prepared.payload.goal!==undefined?{goal:clone(prepared.payload.goal)}:{}),
  ...(prepared.payload.viewerTimeZone?{viewerTimeZone:prepared.payload.viewerTimeZone}:{}),
  ...(prepared.payload.taskContext?.timeContext?{timeContext:clone(prepared.payload.taskContext.timeContext)}:{}),
  ...(prepared.payload.actionReceipts?.length?{actionReceipts:clone(prepared.payload.actionReceipts)}:{}),
  candidate:freeze(clone(candidate)),candidatePaths:candidatePaths(candidate),candidateScopes:candidateScopes(candidate),evidence,
  ...(intentId?{intentAuthority:{sourceId:intentId}}:{}),
  admittedFragments:admitted.map(({sourceId,text})=>({sourceId,text})),
  disclosureAuthority:{programSources:[...programDisclosureSources].map(sourceId=>({sourceId})),rule:'Truth support is not sharing authority. Private outward assertions require an admitted fragment; a narrower disclosure witness may select one.'},
  humanInstructions,...(currentHumanId?{currentInstruction:{sourceId:currentHumanId}}:{}),
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
 const binding=()=>hash({scope,primaryScope:prepared.manifest.scope,admittedScope:admission?.scope,requestId:info.requestId||prepared.manifest.requestId,intentId,taskControl:prepared.payload.topicContext,
  primaryRevisions:prepared.manifest.sourceRevisions,admittedRevisions:info.admittedContext?.manifest.sourceRevisions,
  asOf:prepared.payload.asOf,goal:prepared.payload.goal,goalVersion:prepared.manifest.goalVersion,
  admitted:info.admittedContext?.payload.outboundQuotes,currentHuman:info.admittedContext?.payload.currentHumanControl,selectedDirection:info.admittedContext?.payload.selectedDirectionControl,
  revisions:context?.manifest.sourceRevisions||revisions,artifacts:(context?.manifest||manifest).inputArtifactRefs||[],
  evidenceHash:hash(context?.payload||payload),optionWitness:options.map(option=>({label:option.label,style:option.style,quotes:option.quotes||[]})),authorizedImages:prepared.images||[],images:context?.images||images,sourceWitness:[...sourceMap.values()].map(source=>[source.id,source.revision,source.type,source.role,source.at,source.text,source.delivery,source.evidenceRevisions])});
 const bound=binding(),candidateHash=hash(candidate),fields=new Map(candidateFields(candidate).map(field=>[field.path,field.value])),paths=new Set(payload.candidatePaths),frameSourceIds=new Set(sourceIds);
 const bodyAt=path=>fields.get(path),scopes=new Map(payload.candidateScopes.map(field=>[field.path,field.scope]));
 const sameSet=(actual,expected)=>actual.size===expected.length&&expected.every(value=>actual.has(value));
 const instructions=new Map(humanInstructions.map(instruction=>[instruction.sourceId,instruction]));
 const frame=Object.freeze({candidateHash,bindingHash:bound,paths,sourceIds:frameSourceIds,bodyAt,scopeAt:path=>scopes.get(path),evidenceAt:id=>payload.evidence.find(source=>source.sourceId===id),currentHumanId,
  instructionAt:id=>instructions.get(id),
  canDisclose:ref=>programDisclosureSources.has(ref.sourceId)||disclosureFragments.some(fragment=>fragment.sourceId===ref.sourceId&&fragment.text.includes(ref.quote)),
  laterInstruction:(later,earlier)=>{
   if(!instructions.has(later.sourceId)||!instructions.has(earlier.sourceId))return false;
   if(later.sourceId===earlier.sourceId){const text=sourceMap.get(later.sourceId).text;return text.indexOf(later.quote)>=text.indexOf(earlier.quote)+earlier.quote.length;}
   const after=Date.parse(sourceMap.get(later.sourceId).at),before=Date.parse(sourceMap.get(earlier.sourceId).at);
   return Number.isFinite(after)&&Number.isFinite(before)&&after!==before?after>before:(originalOrder.get(later.sourceId)??-1)>(originalOrder.get(earlier.sourceId)??-1);
  },
  assert(){if(!sameSet(paths,payload.candidatePaths)||!sameSet(frameSourceIds,sourceIds)||binding()!==bound||hash(visibleCandidate(result,options))!==candidateHash||hash(payload.candidate)!==candidateHash||hash(payload)!==evidenceHash)throw fail('candidate','fidelity_binding_invalid','The candidate or captured evidence binding changed after checking');}});
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
 if(!plain(data)||Object.keys(data).some(key=>!['checkRef','verdict','issues','factual','concerns'].includes(key))||data.checkRef!=='c1'||!Array.isArray(data.issues)||data.issues.length>12)throw fail('checkRef','fidelity_result_invalid','Return this checkRef, mandatory factual assessment, bounded issues and optional diagnostics; never rewrite or execute');
 if(!Array.isArray(data.factual))throw fail('factual','factual_assessment_missing','Assess every offered visible field; a reported verdict cannot replace the factual core');
 const softCodes=['current_boundary','pragmatic_ambiguity','style','helpfulness','coverage_gap'],legacyFacts=['unsupported_fact','omitted_qualifier','evidence_mismatch','internal_conflict'];
 const kinds=['assertion','intent','opinion','question','private_conditional','advice','inspection'],actions=['invitation','commitment','user_disclosure','topic_content'],qualifications=['time','frequency','degree','subject','negation','condition','scope'];
 const concerns=[],pendingConcerns=[],issues=[],unusableAdvisory=[],legacyFindings=[],reasonMap=new Map();let reasonBytes=0;
 const diagnostic=(field,code,raw,message)=>unusableAdvisory.push({field,code,...(message?{message:String(message).slice(0,700)}:{}),raw:String(JSON.stringify(raw)).slice(0,1600)});
 const reasonFor=(key,field)=>{const raw=reasonMap.get(key);if(raw===undefined)return undefined;if(typeof raw==='string'&&raw.trim()&&raw.length<=500&&reasonBytes+Buffer.byteLength(raw,'utf8')<=6000){reasonBytes+=Buffer.byteLength(raw,'utf8');return raw;}diagnostic(field,'invalid_explanatory_reason',raw);return undefined;};
 const sourceCanonical=input.sourceWireSnapshot?.isCanonical?.(data),reported=data.verdict;
 if(reported!==undefined&&!['allow','reject','uncertain'].includes(reported))diagnostic('verdict','invalid_reported_verdict',reported);
 const stripReason=(object,key)=>{if(!plain(object))return object;const {reason,...core}=object;if(Object.hasOwn(object,'reason'))reasonMap.set(key,reason);return core;};
 data={...data,verdict:undefined,issues:data.issues.map((issue,index)=>stripReason(issue,`issue:${index}`)),factual:data.factual.map((field,index)=>!plain(field)||!Array.isArray(field.statements)?field:{...field,statements:field.statements.map((statement,position)=>{
  const core=stripReason(statement,`fact:${index}:${position}`);if(!plain(core)||core.kind==='assertion'||!kinds.includes(core.kind))return core;
  const result={...core};for(const key of ['support','evidence','basis','qualification','related','disclosure'])if(Object.hasOwn(result,key)){diagnostic(`factual[${index}].statements[${position}].${key}`,'nonassertion_truth_diagnostic',result[key]);delete result[key];}return result;
 })})};
 const unusableIssues=new Set();
 if(input.sourceWireSnapshot&&!sourceCanonical){
  const wire=input.sourceWireSnapshot,original=data,isDiagnostic=issue=>softCodes.includes(issue?.code)||legacyFacts.includes(issue?.code);
  data=wire.decode({...original,issues:original.issues.filter(issue=>!isDiagnostic(issue)),concerns:undefined});
  const optionalDecode=(raw,field)=>{let failed=false;const decoded=wire.decode({concerns:[raw]},{isolateFields:['concerns'],onRejected:(_field,error)=>{failed=true;diagnostic(field,error.code,raw,error.message);}});return {failed,value:failed?raw:decoded.concerns[0]};};
  let strictIndex=0;data.issues=original.issues.map((issue,index)=>{if(!isDiagnostic(issue))return data.issues[strictIndex++];const decoded=optionalDecode(issue,`issues[${index}]`);if(decoded.failed)unusableIssues.add(index);return decoded.value;});
  if(Array.isArray(original.concerns))data.concerns=original.concerns.slice(0,12).flatMap((item,index)=>{const decoded=optionalDecode(item,`concerns[${index}]`);return decoded.failed?[]:[decoded.value];});else data.concerns=original.concerns;
  if(Array.isArray(original.concerns)&&original.concerns.length>12)diagnostic('concerns','advisory_limit',{omitted:original.concerns.length-12});
 }
 const address=(path,field)=>{const canonical=normalizeCandidatePath(path,input.payload.candidatePaths);if(canonical===undefined)throw fail(field,'fidelity_candidate_path_invalid',`${field}: received ${JSON.stringify(path)}; choose an offered candidate-relative path: ${input.payload.candidatePaths.join(', ')}`);if(canonical!==path&&input.manifest){input.manifest.fidelity ||= {};input.manifest.fidelity.addressNormalizations=[...(input.manifest.fidelity.addressNormalizations||[]),{field,received:path,canonical}];}return canonical;};
 const quoted=(path,quote)=>typeof quote==='string'&&quote.trim()&&quote.length<=1200&&typeof frame.bodyAt(path)==='string'&&frame.bodyAt(path).includes(quote);
 const originalWitness=(ref,field,full=false)=>{
  const source=plain(ref)&&frame.evidenceAt(ref.sourceId);
  if(!plain(ref)||Object.keys(ref).some(key=>!['sourceId','quote'].includes(key))||typeof ref.sourceId!=='string'||!frame.sourceIds.has(ref.sourceId)||typeof ref.quote!=='string'||!ref.quote.trim()||ref.quote.length>1200||!source?.text.includes(ref.quote))throw fail(field,'factual_evidence_invalid','Quote only original bodies actually offered in this frame');
  if(full&&(!['qq','private','feedback','note'].includes(source.type)||source.role==='assistant'||source.delivery?.status==='partial'||!input.manifest?.sourceRevisions?.[ref.sourceId]||input.payload.coverage?.unavailableRootSourceIds?.includes(ref.sourceId)))throw fail(field,'factual_support_unverifiable','A factual witness needs the complete original body and captured source revision');
  return source;
 };
 const reference=(raw,field)=>{if(!plain(raw)||Object.keys(raw).some(key=>!['path','quote'].includes(key)))throw fail(field,'factual_reference_invalid','Use an exact candidate path and quote');const path=address(raw.path,`${field}.path`);if(!quoted(path,raw.quote))throw fail(field,'factual_reference_invalid','The referenced statement is not in this candidate');return {path,quote:raw.quote};};
 const factual=[],seenFields=new Set(),assertions=new Map(),allStatements=[];let count=0,uncertain=false;
 let bytes;try{bytes=Buffer.byteLength(JSON.stringify(data.factual),'utf8');}catch{throw fail('factual','factual_assessment_invalid','Factual assessment must be bounded JSON');}
 if(data.factual.length!==input.payload.candidatePaths.length||bytes>24000)throw fail('factual','factual_coverage_invalid','Assess every visible path exactly once without repeating whole answers');
 for(const [index,raw]of data.factual.entries()){
  if(!plain(raw)||Object.keys(raw).some(key=>!['path','statements'].includes(key))||!Array.isArray(raw.statements)||raw.statements.length>12)throw fail(`factual[${index}]`,'factual_assessment_invalid','Use one path and a bounded statements array');
  const path=address(raw.path,`factual[${index}].path`);if(seenFields.has(path))throw fail('factual','factual_coverage_invalid','A visible path was assessed twice');seenFields.add(path);const statements=[];
  for(const [position,rawStatement]of raw.statements.entries()){
   const field=`factual[${index}].statements[${position}]`,reason=reasonFor(`fact:${index}:${position}`,`${field}.reason`),statement={...rawStatement};
   if(++count>32||!plain(rawStatement)||Object.keys(statement).some(key=>!['quote','kind','support','evidence','basis','condition','contextQuote','qualification','related','reference','outwardAction','disclosure'].includes(key))||!kinds.includes(statement.kind)||!quoted(path,statement.quote))throw fail(field,'factual_statement_invalid','Classify an exact proposition or speech act; inspect concrete presuppositions separately');
   if(statement.outwardAction!==undefined&&!actions.includes(statement.outwardAction))throw fail(field,'factual_action_invalid','Use only a recognized offered outward action');
   if(['inspection','private_conditional','opinion'].includes(statement.kind)&&statement.outwardAction!==undefined){diagnostic(`${field}.outwardAction`,'nonacting_statement',statement.outwardAction);delete statement.outwardAction;}
   if(statement.kind==='assertion'){
    const evidence=statement.evidence||[];if(!Array.isArray(evidence)||evidence.length>4)throw fail(field,'factual_evidence_invalid','Use at most four exact original witnesses');for(const ref of evidence)originalWitness(ref,`${field}.evidence`,statement.support!=='unverifiable');
    if(!['supported','unsupported','unverifiable'].includes(statement.support)||statement.condition!==undefined||statement.contextQuote!==undefined||statement.reference!==undefined)throw fail(field,'factual_support_invalid','An asserted proposition needs a truth finding, not a speech-act exemption');
    if(statement.support==='supported'&&(!evidence.length||statement.basis!==undefined||statement.qualification!==undefined||statement.related!==undefined))throw fail(field,'factual_support_invalid','Supported assertions require original support without conflicting defect metadata');
    if(statement.support==='unverifiable'){if(statement.basis!==undefined||statement.qualification!==undefined||statement.related!==undefined)throw fail(field,'factual_support_invalid','Unverifiable is targeted unresolved support');uncertain=true;}
    if(statement.support==='unsupported'){
     if(!['no_support_in_supplied_evidence','source_contradiction','necessary_factual_qualification','candidate_fact_conflict'].includes(statement.basis))throw fail(field,'factual_basis_missing','Unsupported assertions need a typed factual defect basis');
     if(['source_contradiction','necessary_factual_qualification'].includes(statement.basis)&&!evidence.length)throw fail(field,'factual_basis_missing','A source contradiction or missing factual qualification requires its original witness');
     if(statement.basis==='necessary_factual_qualification'&&!qualifications.includes(statement.qualification)||statement.qualification!==undefined&&!qualifications.includes(statement.qualification))throw fail(field,'factual_qualification_invalid','Qualify the world proposition, not a focus, style or social instruction');
     if(statement.basis==='candidate_fact_conflict')statement.related=reference(statement.related,`${field}.related`);else if(statement.related!==undefined)throw fail(field,'factual_reference_invalid','A related candidate belongs only to a factual-conflict finding');
    }
    const disclosure=statement.disclosure||[];if(!Array.isArray(disclosure)||disclosure.length>4)throw fail(field,'factual_disclosure_invalid','Select only narrow admitted fragments when private outward support needs them');for(const ref of disclosure){originalWitness(ref,`${field}.disclosure`,true);if(!frame.canDisclose(ref))throw fail(field,'factual_disclosure_invalid','The selected disclosure witness is not an admitted fragment');}
    const outward=frame.scopeAt(path)==='copyable'||statement.outwardAction==='user_disclosure';
    if(statement.support==='supported'&&outward){const unadmitted=evidence.filter(ref=>!frame.canDisclose(ref)&&!disclosure.some(permission=>permission.sourceId===ref.sourceId&&(ref.quote.includes(permission.quote)||permission.quote.includes(ref.quote))));if(unadmitted.length)issues.push({path,quote:statement.quote,code:'private_disclosure',evidence:clone(unadmitted),reason:'Truth support does not grant outward use: these private witnesses have no scoped admitted disclosure fragment.'});}
    const assertionKey=JSON.stringify([path,statement.quote]);if(assertions.has(assertionKey))throw fail(field,'factual_duplicate_assertion','One proposition must have one normalized factual assessment');assertions.set(assertionKey,{path,statement,reason});
   }else if(statement.kind==='private_conditional'){
    if(frame.scopeAt(path)!=='private'||typeof statement.condition!=='string'||!statement.condition.trim()||statement.condition.length>1200||typeof statement.contextQuote!=='string'||!statement.contextQuote.trim()||statement.contextQuote.length>6000||!frame.bodyAt(path).includes(statement.contextQuote)||!statement.contextQuote.includes(statement.condition)||!statement.contextQuote.includes(statement.quote)||statement.condition===statement.quote||statement.reference!==undefined)throw fail(field,'factual_conditional_scope','A hypothetical example and complete condition must coexist in the same private field');
   }else if(statement.kind==='inspection'){
    if(frame.scopeAt(path)!=='private')throw fail(field,'factual_inspection_scope','Inspection comments are private, not copyable world assertions');if(statement.reference!==undefined)statement.reference=reference(statement.reference,`${field}.reference`);
   }else if(statement.condition!==undefined||statement.contextQuote!==undefined||statement.reference!==undefined)throw fail(field,'factual_kind_conflict','A speech act is not a private conditional example or candidate inspection');
   const normalized={...statement,...(reason?{reason}:{})};statements.push(normalized);allStatements.push({path,statement:normalized});
  }
  factual.push({path,statements});
 }
 if(input.payload.candidatePaths.some(path=>!seenFields.has(path)))throw fail('factual','factual_coverage_invalid','A candidate field lacks assessment');
 for(const {path,statement,reason}of assertions.values())if(statement.support==='unsupported'){
  const code={no_support_in_supplied_evidence:'unsupported_fact',source_contradiction:'evidence_mismatch',necessary_factual_qualification:'omitted_qualifier',candidate_fact_conflict:'internal_conflict'}[statement.basis];
  if(statement.basis==='candidate_fact_conflict'&&(!assertions.has(JSON.stringify([statement.related.path,statement.related.quote]))||statement.related.path===path&&statement.related.quote===statement.quote))throw fail('factual.related','factual_reference_invalid','A factual conflict must name a distinct assessed assertion, never an opinion, intention or inspection');
  issues.push({path,quote:statement.quote,code,basis:statement.basis,...(statement.evidence?.length?{evidence:clone(statement.evidence)}:{}),...(statement.qualification?{qualification:statement.qualification}:{}),...(statement.related?{relatedPath:statement.related.path,relatedQuote:statement.related.quote}:{}),reason:reason||'The assessed world proposition lacks the required factual support or qualification.'});
 }
 const outwardTarget=(path,quote,action)=>frame.scopeAt(path)==='copyable'||/^expressionOptions\[\d+\]\.label$/.test(path)||allStatements.some(item=>item.path===path&&item.statement.quote.includes(quote)&&item.statement.outwardAction===action);
 const humanWitness=(raw,field)=>{originalWitness(raw,field,true);if(!frame.instructionAt(raw.sourceId))throw fail(field,'prohibition_authority_invalid','Only an offered assistant-control human directive can prohibit outward content; QQ authorship is not such authority');return raw;};
 for(const [index,raw]of data.issues.entries()){
  if(unusableIssues.has(index))continue;const field=`issues[${index}]`,reason=reasonFor(`issue:${index}`,`${field}.reason`);
  if(legacyFacts.includes(raw?.code)){legacyFindings.push({...clone(raw),...(reason?{reason}:{})});diagnostic(field,'legacy_fact_channel',raw,'Factual defects belong to the assessed assertion, not an independent issue veto');continue;}
  if(softCodes.includes(raw?.code)){pendingConcerns.push({...clone(raw),reason:reason||'Nonbinding social or style diagnostic.'});continue;}
  if(!plain(raw)||Object.keys(raw).some(key=>!['path','code','quote','evidence','sourceIds','prohibition'].includes(key))||!['private_disclosure','explicit_outward_prohibition'].includes(raw.code))throw fail(field,'fidelity_result_invalid','Strict issues are separate disclosure or applicable explicit human-prohibition findings');
  const path=address(raw.path,`${field}.path`);if(!quoted(path,raw.quote))throw fail(field,'fidelity_result_invalid','The outward content witness must be in the exact candidate');
  if(raw.sourceIds!==undefined&&(!Array.isArray(raw.sourceIds)||raw.sourceIds.length>16||raw.sourceIds.some(id=>!frame.sourceIds.has(id))))throw fail(field,'fidelity_result_invalid','A strict finding cannot cite an unoffered source');
  if(raw.code==='private_disclosure'){
   if(!Array.isArray(raw.evidence)||!raw.evidence.length||raw.evidence.length>8||raw.prohibition!==undefined)throw fail(field,'fidelity_grounding_missing','A disclosure finding requires its original private restriction or material witness');for(const ref of raw.evidence)originalWitness(ref,`${field}.evidence`,true);
   if(!outwardTarget(path,raw.quote,'user_disclosure')){diagnostic(field,'non_outward_privacy_target',raw);continue;}issues.push({...clone(raw),path,reason:reason||'The offered outward content conflicts with its disclosure authority.'});continue;
  }
  const rule=raw.prohibition;
  if(!plain(rule)||Object.keys(rule).some(key=>!['sourceId','quote','action','applicability','current','override'].includes(key))||!actions.includes(rule.action)||!['active','overridden','unresolved'].includes(rule.applicability))throw fail(field,'prohibition_witness_invalid','Bind a specific human prohibition, action and applicability');
  humanWitness({sourceId:rule.sourceId,quote:rule.quote},`${field}.prohibition`);
  if(rule.current!==undefined){humanWitness(rule.current,`${field}.current`);if(rule.current.sourceId!==frame.currentHumanId)throw fail(field,'prohibition_scope_invalid','The applicability witness must be the actual current human request');}
  if(rule.override!==undefined){humanWitness(rule.override,`${field}.override`);if(!frame.laterInstruction(rule.override,rule)||frame.currentHumanId&&rule.override.sourceId!==frame.currentHumanId)throw fail(field,'prohibition_override_invalid','An override must be a later applicable human instruction');}
  if(rule.applicability==='overridden'){if(!rule.override)throw fail(field,'prohibition_override_invalid','An overridden instruction needs its later explicit human witness');diagnostic(field,'overridden_prohibition',raw);continue;}
  if(rule.applicability==='unresolved'){diagnostic(field,'unresolved_prohibition_applicability',raw);continue;}
  if(rule.sourceId!==frame.currentHumanId&&frame.currentHumanId&&!rule.current)throw fail(field,'prohibition_scope_invalid','An older prohibition needs a current applicable continuation witness');
  if(rule.override)throw fail(field,'prohibition_override_invalid','An active prohibition cannot also claim an overriding instruction');
  if(!outwardTarget(path,raw.quote,rule.action)){diagnostic(field,'non_outward_prohibition_target',raw);continue;}
  issues.push({...clone(raw),path,reason:reason||'The offered outward content violates an applicable explicit human prohibition.'});
 }
 const optionalConcern=(raw,index)=>{try{if(!plain(raw)||Object.keys(raw).some(key=>!['path','code','quote','sourceIds','evidence','reason'].includes(key))||typeof raw.code!=='string'||!raw.code.trim()||raw.code.length>80||typeof raw.reason!=='string'||!raw.reason.trim()||raw.reason.length>500)throw fail('concerns','fidelity_result_invalid','Use a bounded nonbinding diagnostic');const path=address(raw.path,`concerns[${index}].path`);if(raw.quote!==undefined&&!quoted(path,raw.quote))throw fail('concerns','fidelity_result_invalid','Quote only that visible field');for(const ref of raw.evidence||[])originalWitness(ref,'concerns.evidence');if(raw.sourceIds!==undefined&&(!Array.isArray(raw.sourceIds)||raw.sourceIds.some(id=>!frame.sourceIds.has(id))))throw fail('concerns','fidelity_result_invalid','Unknown diagnostic source');concerns.push({...clone(raw),path});}catch(error){diagnostic(`concerns[${index}]`,error.code||'invalid_advisory',raw,error.message);}};
 pendingConcerns.forEach(optionalConcern);
 if(Array.isArray(data.concerns))data.concerns.slice(0,12).forEach(optionalConcern);else if(data.concerns!==undefined)diagnostic('concerns','invalid_advisory_container',data.concerns);
 if(Array.isArray(data.concerns)&&data.concerns.length>12)diagnostic('concerns','advisory_limit',{omitted:data.concerns.length-12});
 const verdict=issues.length?'reject':uncertain?'uncertain':'allow';
 if(input.manifest)input.manifest.fidelity={...input.manifest.fidelity,reportedVerdict:['allow','reject','uncertain'].includes(reported)?reported:null,derivedVerdict:verdict,factual:{fields:clone(factual),assessedPaths:[...seenFields],offeredPaths:[...input.payload.candidatePaths],statementCount:count,complete:true},...(legacyFindings.length?{legacyFactIssues:legacyFindings}:{}),...(unusableAdvisory.length?{unusableAdvisory}:{})};
 const result=freeze({checkRef:'c1',verdict,issues,factual,...(concerns.length?{concerns}:{})});marks.set(result,{frame,hash:hash(result)});input.sourceWireSnapshot?.markCanonical(result);return result;
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
