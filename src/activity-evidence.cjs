'use strict';
// Activity identity and evidence-loss state are local program data. Neither an
// original-span match nor a model's world-statement choice proves entailment.
const {randomUUID,createHash}=require('node:crypto');
const {ValidationIssues}=require('./validation-issues.cjs');
const {assertSpeechActClock}=require('./speaker-identity.cjs');
const {redact}=require('./model.cjs');
const PROTOCOL='activity-original-evidence-v1';
const LOSS_RULE='evidenceLosses use a separate loss: namespace, never source handles, citations, sharing permission or new event evidence. They describe prior derived understanding, not current facts: only a statement dependency identifies what the unavailable original previously served as evidence for; definition/time/support loss does not establish the original message meaning. Original author and prior event actor are distinct; a native recall does not identify its operator. invalidatedOriginal.sourceTime is only previousRevision\'s saved original timestamp, not world occurrence. status:unknown means no original time; never substitute affectedWorldAt (affected prior world/state time), knowledgeChangedAt (evidence loss) or plannedFor (planned activity time). Missing/omitted loss details stay unknown. Historical gaps do not negate separately supported newer world or current-state reports.';
const speechActs=new Set(['invitation','acceptance','decline','reschedule','cancellation','interest_expression','boundary','sharing']);
const statuses={invitation:'invited',acceptance:'accepted',decline:'declined',reschedule:'rescheduled',cancellation:'cancelled',occurred:'occurred'};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
const fail=(field,message)=>Object.assign(new Error(`${field}: ${message}`),{code:'invalid_activity_event',field,allowedShape:'Choose an offered activity ref or explicit NEW with an exact original definition; supply original statement and explicit/QQ-statement/unknown time evidence. Source loss is already program-owned uncertainty; events:[] is valid no-change.'});
function keys(value,allowed,field){if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail(field,'unexpected activity evidence fields');}
function iso(value,field){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw fail(field,'expected an explicit ISO date/time');return new Date(value).toISOString();}
function echoActual(value){const text=redact(JSON.stringify(value)??String(value));return text.length<=800?text:`${text.slice(0,800)}… (${text.length} characters; full actual value remains at this field in invalidResponse)`;}
function reference(value,field){
 keys(value,['sourceId','revision','start','end'],field);
 if(typeof value.sourceId!=='string'||typeof value.revision!=='string'||!Number.isSafeInteger(value.start)||!Number.isSafeInteger(value.end)||value.start<0||value.end<=value.start)throw fail(field,'invalid original range identity');
 return {...value};
}
function referenceText(ref,originals){const source=originals.get(ref?.sourceId);return source&&source.revision===ref.revision&&ref.start>=0&&ref.end<=source.text.length?source.text.slice(ref.start,ref.end):null;}
function activityReferences(record){
 const refs=[record.activityDefinition,record.statementEvidence,record.timeEvidence?.evidence,record.plannedEvidence].filter(Boolean);
 return Object.fromEntries(refs.map(ref=>[ref.sourceId,ref.revision]));
}
function evidenceViewRecord(record){
 if(!record.activityId)return record;
 const dependencies=activityReferences(record);
 return {...record,sourceIds:[...new Set([...(record.sourceIds||[]),...Object.keys(dependencies)])],sourceRevisions:{...record.sourceRevisions,...dependencies}};
}
function readState(records,gaps,originals){
 const byId=new Map();
 const include=(id,definition)=>{if(!byId.has(id))byId.set(id,{id,definitions:[],events:[],stateClaims:[],gaps:[]});const item=byId.get(id);if(definition&&!item.definitions.some(ref=>JSON.stringify(ref)===JSON.stringify(definition)))item.definitions.push(clone(definition));return item;};
 for(const record of records.filter(record=>record.recordType==='relationship_event'&&record.activityId)){const item=include(record.activityId,record.activityDefinition);item.events.push(record);}
 for(const record of records.filter(record=>record.recordType==='claim'&&record.activityId&&record.currentActivityState)){include(record.activityId,record.activityDefinition).stateClaims.push(record);}
 for(const gap of gaps)if(gap.activityId){const item=include(gap.activityId,gap.activityDefinition);item.gaps.push(gap);}
 const activities=[...byId.values()].map(item=>{
  const definition=item.definitions.find(ref=>referenceText(ref,originals)!==null)||item.definitions[0]||null;
  return {...item,definition,label:definition?referenceText(definition,originals):null};
 });
 return {activities,legacyUncertainties:gaps.filter(gap=>!gap.activityId).map(gap=>({id:gap.id,status:'needs_review',identityStatus:'legacy_unresolved',affectedWorldAt:null,legacyOrderAt:gap.orderAt||null,knowledgeChangedAt:gap.knowledgeChangedAt||null,reason:'withdrawn_evidence_identity_unavailable'}))};
}
function storedState(store,scope,originals=new Map(store._rawMemorySources(scope).map(source=>[source.id,source]))){
 const gaps=store.db.prepare('SELECT record FROM memory_gaps WHERE scope_key=?').all(store.scopeKey(scope)).map(row=>JSON.parse(row.record));
 return readState(store._memoryRecords(scope),gaps,originals);
}
function worldClock(event){return event.occurredAt||event.reportedAt||event.lastEvidenceAt||'';}
function lossView(gap){
 const loss=gap.evidenceLoss;if(!loss||loss.namespace!=='historical_evidence_loss_v1')return null;
 // Deliberately avoid sourceId/sourceIds/sourceRevisions: those names mint
 // evidence handles in foreground consumers, including for unavailable bodies.
 const original=clone(loss.invalidatedOriginal),time=original.sourceTime;
 // Old losses remain explicitly unknown; never consult today's same-ID source.
 original.sourceTime=time?.status==='known'&&time.basis==='saved_original_source_at'&&typeof time.at==='string'&&Number.isFinite(Date.parse(time.at))?{status:'known',at:time.at,basis:time.basis}:{status:'unknown'};
 return {...clone(loss),invalidatedOriginal:original,knowledgeChangedAt:gap.knowledgeChangedAt||null,affectedWorldAt:gap.affectedWorldAt||null};
}
function evidenceLosses(gaps){return gaps.map(lossView).filter(Boolean);}
function trimContextLoss(context){const item=context?.activities?.findLast(activity=>activity.evidenceLosses?.length);if(!item)return false;item.evidenceLosses.pop();item.omittedEvidenceLossCount=(item.omittedEvidenceLossCount||0)+1;return true;}
const lossFingerprint=loss=>createHash('sha256').update(JSON.stringify(loss)).digest('hex');
function lossReferences(scope,losses){return losses.map(loss=>({scope:{...scope},lossRef:loss.lossRef,fingerprint:lossFingerprint(loss)}));}
function assertLossReferences(store,scope,refs=[]){
 if(!Array.isArray(refs)||refs.length>128)throw new Error('Invalid historical evidence loss dependencies');
 if(!refs.length)return [];
 const gaps=store.db.prepare('SELECT record FROM memory_gaps WHERE scope_key=?').all(store.scopeKey(scope)).map(row=>JSON.parse(row.record)),current=new Map(evidenceLosses(gaps).map(loss=>[loss.lossRef,loss]));
 return refs.map(ref=>{const loss=current.get(ref?.lossRef);if(!ref?.scope||!['accountUid','accountUin','peerUid','peerUin'].every(key=>ref.scope[key]===scope[key])||!loss||lossFingerprint(loss)!==ref.fingerprint)throw new Error('Historical evidence loss dependency changed before publication');return {scope:{...scope},lossRef:ref.lossRef,fingerprint:ref.fingerprint};});
}
function publicActivities(records,gaps,originals){
 const state=readState(records,gaps,originals),activities=state.activities.map(item=>{
  const originalsCurrent=record=>Object.entries(record.sourceRevisions||{}).every(([id,revision])=>originals.get(id)?.revision===revision);
  const events=item.events.filter(event=>event.lifecycle==='active'&&originalsCurrent(event)).sort((a,b)=>worldClock(a).localeCompare(worldClock(b))||a.id.localeCompare(b.id));
  const current=events.filter(event=>statuses[event.eventKind]).at(-1)||events.at(-1);
  const unresolved=item.gaps.some(gap=>!gap.affectedWorldAt||!current?.occurredAt||gap.affectedWorldAt>=current.occurredAt);
  const unknownOrder=current&&statuses[current.eventKind]&&current.eventKind!=='occurred'&&!current.occurredAt;
  const identityProvisional=item.events.some(event=>event.activityProvisional)||item.stateClaims.some(claim=>claim.activityProvisional);
  const oldOnlyWorld=identityProvisional&&state.legacyUncertainties.some(gap=>!gap.legacyOrderAt||!current?.occurredAt||gap.legacyOrderAt>=current.occurredAt);
  const provisional=current?.activityProvisional===true||oldOnlyWorld;
  const needsReview=unresolved||item.label===null||!current||current.reviewComplete===false||unknownOrder||provisional;
  const stateClaim=item.stateClaims.filter(claim=>claim.lifecycle==='active'&&claim.reviewComplete&&claim.epistemicStatus==='supported'&&originalsCurrent(claim)).sort((a,b)=>a.currentActivityState.asOf.localeCompare(b.currentActivityState.asOf)).at(-1);
  const reported=stateClaim?.currentActivityState,changedAt=item.gaps.map(gap=>gap.knowledgeChangedAt).filter(Boolean).sort().at(-1);
  const undatedContrary=reported&&events.some(event=>!event.occurredAt&&statuses[event.eventKind]&&statuses[event.eventKind]!==reported.status&&(event.reportedAt||event.lastEvidenceAt)>reported.asOf);
  const oldOnlyClaim=stateClaim?.activityProvisional&&state.legacyUncertainties.some(gap=>!gap.legacyOrderAt||gap.legacyOrderAt>=reported.asOf);
  const useReported=item.label!==null&&reported&&!undatedContrary&&!oldOnlyClaim&&(!changedAt||reported.asOf>changedAt)&&(!current?.occurredAt||reported.asOf>=current.occurredAt);
  const reportView=reported?{status:reported.status,asOf:reported.asOf,origin:reported.origin,sourceIds:[...new Set([...stateClaim.sourceIds,...Object.keys(activityReferences(stateClaim))])],sourceRevisions:{...stateClaim.sourceRevisions,...activityReferences(stateClaim)},claimId:stateClaim.id}:null;
  return {activityId:item.id,activityKey:item.label,definitionAvailable:item.label!==null,identityStatus:'anchored',status:useReported?reported.status:needsReview?'needs_review':statuses[current.eventKind]||'observed',
   authority:useReported?reported.origin==='qq_observation'?'source_backed_current_statement':'user_reported_current_state':unresolved?'withdrawn_evidence_gap':item.label===null?'activity_definition_unavailable':provisional?'unresolved_prior_activity_scope':current?.origin==='user_report'?'user_reported':'source_backed_statement',
   historicalEvidenceGap:unresolved,evidenceLosses:evidenceLosses(item.gaps),qualified:identityProvisional||state.legacyUncertainties.length>0,currentReportedState:useReported?reportView:null,priorCurrentReportedState:reported&&!useReported?{...reportView,qualification:undatedContrary?'later_undated_contrary_evidence':oldOnlyClaim?'legacy_activity_identity_unresolved':'historical_report'}:null,
   eventIds:events.map(event=>event.id),latestEventId:current?.id||null,claimIds:item.stateClaims.map(claim=>claim.id),sourceIds:[...new Set([...events.flatMap(event=>evidenceViewRecord(event).sourceIds),...(useReported?reportView.sourceIds:[])])],definitionEvidence:item.label!==null?{sourceIds:[item.definition.sourceId],sourceRevisions:{[item.definition.sourceId]:item.definition.revision}}:{sourceIds:[],sourceRevisions:{}},
   knowledgeChangedAt:item.gaps.map(gap=>gap.knowledgeChangedAt).filter(Boolean).sort().at(-1)||null,affectedWorldAt:item.gaps.map(gap=>gap.affectedWorldAt).filter(Boolean).sort().at(-1)||null,
   lastEvidenceAt:current?.lastEvidenceAt||null,occurredAt:current?.occurredAt||null,plannedFor:current?.plannedFor||null,occurrenceTimeStatus:current?.occurrenceTimeStatus||'unknown'};
 });
 return {activities,activityUncertainties:state.legacyUncertainties};
}
function makeGap(prior,{changedAt,basis='detected_source_change',legacyDigest,invalidatedOriginal,operation,retainInterpretation=false}){
 const affectedAt=prior.currentActivityState?.asOf||prior.occurredAt||null;
 const common={id:prior.id,activityDigest:legacyDigest,orderAt:affectedAt||prior.lastEvidenceAt,reason:'support_changed_or_withdrawn'};
 if(!prior.activityId)return common; // Legacy hash-only rows have no recoverable knowledge clock.
 const gap={...common,activityId:prior.activityId,...(prior.activityDefinition?{activityDefinition:clone(prior.activityDefinition)}:{}),affectedWorldAt:affectedAt,worldTimeStatus:prior.currentActivityState?'observed_state_as_of':prior.occurrenceTimeStatus||'unknown',knowledgeChangedAt:changedAt,knowledgeTimeBasis:basis};
 if(retainInterpretation&&invalidatedOriginal?.id&&invalidatedOriginal.revision){
  const same=ref=>ref?.sourceId===invalidatedOriginal.id&&ref.revision===invalidatedOriginal.revision;
  const roles=[['statement',prior.statementEvidence],['definition',prior.activityDefinition],['time',prior.timeEvidence?.evidence],['planned_time',prior.plannedEvidence]].filter(([,ref])=>same(ref)).map(([role])=>role);
  if(!roles.length)roles.push('support');
  const revisions=[prior.sourceRevisions?.[invalidatedOriginal.id],...[prior.statementEvidence,prior.activityDefinition,prior.timeEvidence?.evidence,prior.plannedEvidence].filter(ref=>ref?.sourceId===invalidatedOriginal.id).map(ref=>ref.revision)].filter(revision=>revision!==undefined);
  const timeBound=revisions.length>0&&revisions.every(revision=>revision===invalidatedOriginal.revision)&&typeof invalidatedOriginal.at==='string'&&Number.isFinite(Date.parse(invalidatedOriginal.at));
  const sourceTime=timeBound?{status:'known',at:invalidatedOriginal.at,basis:'saved_original_source_at'}:{status:'unknown'};
  gap.evidenceLoss={namespace:'historical_evidence_loss_v1',lossRef:`loss:${prior.id}`,authority:'historical_derived_interpretation_not_current_fact_or_evidence',invalidatedOriginal:{canonicalId:invalidatedOriginal.id,previousRevision:invalidatedOriginal.revision,type:invalidatedOriginal.type,authorRole:invalidatedOriginal.role||'unknown',sourceTime},operation,operationActor:'unknown',dependencyRoles:roles,priorInterpretation:{recordType:prior.recordType,...(prior.recordType==='relationship_event'?{eventKind:prior.eventKind,eventActor:prior.actor}:{}),...(prior.currentActivityState?{currentState:prior.currentActivityState.status}:{})}};
  // Internal privacy dependencies are never projected as delivered originals.
  gap.lossDependencyIds=[...new Set([...Object.keys(prior.sourceRevisions||{}),...Object.keys(activityReferences(prior))])];
 }
 return gap;
}
function memoryContext(store,scope,originals){
 const state=storedState(store,scope,originals);
 const projected=publicActivities(store._memoryRecords(scope),store.db.prepare('SELECT record FROM memory_gaps WHERE scope_key=?').all(store.scopeKey(scope)).map(row=>JSON.parse(row.record)),originals),reports=new Map(projected.activities.map(item=>[item.activityId,item.currentReportedState]));
 const ordered=state.activities.sort((a,b)=>Number(!!b.gaps.length)-Number(!!a.gaps.length)||String(b.gaps.at(-1)?.knowledgeChangedAt||b.events.at(-1)?.lastEvidenceAt||'').localeCompare(String(a.gaps.at(-1)?.knowledgeChangedAt||a.events.at(-1)?.lastEvidenceAt||'')));
 return {protocol:PROTOCOL,activities:ordered.slice(0,6).map(item=>({id:item.id,definition:item.definition,label:item.label,currentReportedState:reports.get(item.id)||null,evidenceLosses:evidenceLosses(item.gaps).slice(0,4),omittedEvidenceLossCount:Math.max(0,evidenceLosses(item.gaps).length-4),gaps:item.gaps.length?[{affectedWorldAt:item.gaps.every(gap=>gap.affectedWorldAt)?item.gaps.map(gap=>gap.affectedWorldAt).sort().at(-1):null,knowledgeChangedAt:item.gaps.map(gap=>gap.knowledgeChangedAt).filter(Boolean).sort().at(-1)||null,worldTimeStatus:item.gaps.every(gap=>gap.affectedWorldAt)?'known':'unknown'}]:[]})),legacyUncertainties:state.legacyUncertainties.slice(0,4),omittedLegacyGapCount:Math.max(0,state.legacyUncertainties.length-4),omittedActivityCount:Math.max(0,ordered.length-6)};
}
function wireContext(context,sourceAliases,delivered){
 const aliases=new Map(),sources=new Map(delivered.map(source=>[source.id,source]));
 const activities=(context?.activities||[]).map((item,index)=>{
  const ref=`v${index+1}`;aliases.set(ref,item);
  const source=item.definition&&sources.get(item.definition.sourceId),available=source&&source.revision===item.definition.revision&&!source.deleted&&!source.segment&&!source.delivery;
  const report=item.currentReportedState;
  return {ref,state:item.gaps.length?'historical_evidence_gap':'known_activity',definition:available?{sourceId:sourceAliases.get(source.id),quote:source.text.slice(item.definition.start,item.definition.end)}:{available:false},gaps:item.gaps,evidenceLosses:item.evidenceLosses||[],omittedEvidenceLossCount:item.omittedEvidenceLossCount||0,currentReportedState:report?{status:report.status,asOf:report.asOf,origin:report.origin,sourceIds:report.sourceIds.filter(id=>sourceAliases.has(id)).map(id=>sourceAliases.get(id)),originalsDelivered:report.sourceIds.every(id=>sources.has(id))}:null};
 });
 return {aliases,input:{protocol:PROTOCOL,activities,legacyUncertainties:(context?.legacyUncertainties||[]).map(({id,...gap},index)=>({uncertaintyRef:`u${index+1}`,...gap})),omittedLegacyGapCount:context?.omittedLegacyGapCount||0,omittedActivityCount:context?.omittedActivityCount||0,rule:'Evidence loss is knowledge state, not a new world event. Empty events are a completed no-change decision. Labels do not define identity.'}};
}
function decodeEvent(record,field,{sourceIds,delivered,activityAliases}){
 if(!plain(record))throw fail(field,'expected a world-event object');
 const issues=new ValidationIssues(),check=(path,run)=>issues.check(path,'invalid_activity_event',run).value;
 const canonicalFields=['id','expectedVersion','text','sourceIds','topicKeys','transition','activityKey','eventKind','actor'];
 check(field,()=>keys(record,[...canonicalFields,'activity','evidence'],field));
 const sources=new Map(delivered.map(source=>[source.id,source]));
 const witness=(value,path)=>{
  keys(value,['sourceId','quote'],path);const id=sourceIds.get(value.sourceId),source=sources.get(id);
  if(!source||source.deleted||typeof value.quote!=='string'||!value.quote.trim()||value.quote.length>4000)throw fail(path,'select a supplied original and its exact nonempty statement span');
  if(!(source.type==='qq'||['private','feedback'].includes(source.type)&&source.role==='user'||source.type==='note')||source.evidenceSourceIds?.length)throw fail(path,'generated/derived material is not an original world statement');
  const offset=source.text.indexOf(value.quote);if(offset<0||source.text.indexOf(value.quote,offset+1)>=0)throw fail(path,'quote must identify one continuous supplied original range; add original context to disambiguate');
  const start=(source.segment?.offset??source.delivery?.start??0)+offset;
  return {ref:{sourceId:id,revision:source.revision,start,end:start+value.quote.length},source};
 };
 const activity=check(`${field}.activity`,()=>{keys(record.activity,['ref','definition'],`${field}.activity`);return record.activity;});
 let selected,definition;
 if(activity){
  if(activity.ref==='NEW')check(`${field}.activity.definition`,()=>{if(!activity.definition)throw fail(`${field}.activity.definition`,'NEW requires an explicit original activity definition');});
  else selected=check(`${field}.activity.ref`,()=>{const found=activityAliases.get(activity.ref);if(!found)throw fail(`${field}.activity.ref`,'choose an activity ref offered in this request, or explicit NEW');return found;});
  if(activity.definition)definition=check(`${field}.activity.definition`,()=>witness(activity.definition,`${field}.activity.definition`).ref);
  if(selected&&!definition)check(`${field}.activity.definition`,()=>{const ref=selected.definition,source=ref&&sources.get(ref.sourceId),start=source?.segment?.offset??source?.delivery?.start??0,end=source?.segment?.end??source?.delivery?.end??source?.text.length;if(!source||source.deleted||source.revision!==ref.revision||start>ref.start||end<ref.end)throw fail(`${field}.activity.definition`,'the old definition original is unavailable; explicitly rebind this ref to surviving original proof or use no-change');});
  if(activity.ref==='NEW'&&definition)check(`${field}.activity.ref`,()=>{if([...activityAliases.values()].some(item=>item.definition&&item.definition.sourceId===definition.sourceId&&item.definition.start<definition.end&&definition.start<item.definition.end))throw fail(`${field}.activity.ref`,'this original range already defines an offered activity; select that persisted ref, not a new label/identity');});
 }
 check(`${field}.evidence`,()=>keys(record.evidence,['statement','time','plannedFor'],`${field}.evidence`));
 const evidence=plain(record.evidence)?record.evidence:{},statement=check(`${field}.evidence.statement`,()=>witness(evidence.statement,`${field}.evidence.statement`));
 const time=plain(evidence.time)?evidence.time:undefined;
 check(`${field}.evidence.time`,()=>{keys(evidence.time,['basis','at','sourceId','quote'],`${field}.evidence.time`);if(!['unknown','qq_statement','explicit'].includes(evidence.time.basis))throw fail(`${field}.evidence.time.basis`,'choose qq_statement, explicit, or unknown; record time is never a private world-event default');});
 let occurrence;
 if(time?.basis==='unknown'){
  for(const key of ['at','sourceId','quote'])if(Object.hasOwn(time,key))check(`${field}.evidence.time.${key}`,()=>{throw fail(`${field}.evidence.time.${key}`,`expected absent for unknown occurrence; actual ${echoActual(time[key])}. Legal undated form: {basis:"unknown"}.`);});
  occurrence={basis:'unknown'};
 }
 if(time?.basis==='qq_statement'){
  const legal='Legal minimal form: {basis:"qq_statement"}; optional echoes never choose the canonical clock.';
  if(statement){
   check(`${field}.evidence.time.basis`,()=>{if(statement.source.type!=='qq'||!speechActs.has(record.eventKind))throw fail(`${field}.evidence.time.basis`,`expected an actual QQ speech act; actual source type ${statement.source.type}, eventKind ${record.eventKind}. Use explicit original time evidence or unknown for private reports/questions and physical occurrences.`);});
   // Speech-act speaker entailment (M3): a QQ statement clock can only back
   // a speech act by the party who actually sent that message.
   check(`${field}.evidence.time.basis`,()=>assertSpeechActClock({actor:record.actor,eventKind:record.eventKind,isSpeechAct:kind=>speechActs.has(kind)},statement.source,`${field}.evidence.time.basis`));
   // Speech-act speaker entailment (M3): a QQ statement clock can only back
   // a speech act by the party who actually sent that message.
   check(`${field}.evidence.time.basis`,()=>assertSpeechActClock({actor:record.actor,eventKind:record.eventKind,isSpeechAct:kind=>speechActs.has(kind)},statement.source,field));
   if(Object.hasOwn(time,'at'))check(`${field}.evidence.time.at`,()=>{if(typeof time.at!=='string'||!Number.isFinite(Date.parse(time.at))||new Date(time.at).toISOString()!==statement.source.at)throw fail(`${field}.evidence.time.at`,`expected actual QQ statement time ${statement.source.at}; actual ${echoActual(time.at)}. ${legal}`);});
   if(Object.hasOwn(time,'sourceId'))check(`${field}.evidence.time.sourceId`,()=>{if(time.sourceId!==evidence.statement.sourceId)throw fail(`${field}.evidence.time.sourceId`,`expected bound statement source ${evidence.statement.sourceId}; actual ${echoActual(time.sourceId)}. ${legal}`);});
   if(Object.hasOwn(time,'quote'))check(`${field}.evidence.time.quote`,()=>{try{witness({sourceId:evidence.statement.sourceId,quote:time.quote},`${field}.evidence.time.quote`);}catch{throw fail(`${field}.evidence.time.quote`,`expected one exact original quote span from bound QQ statement source ${evidence.statement.sourceId}; actual ${echoActual(time.quote)}. ${legal}`);}});
   occurrence={basis:'qq_statement',at:statement.source.at,evidence:statement.ref};
  }
 }
 if(time?.basis==='explicit'){
  const at=check(`${field}.evidence.time.at`,()=>iso(time.at,`${field}.evidence.time.at`)),proof=check(`${field}.evidence.time`,()=>witness({sourceId:time.sourceId,quote:time.quote},`${field}.evidence.time`));
  if(at&&statement)check(`${field}.evidence.time.at`,()=>{if(at>statement.source.at)throw fail(`${field}.evidence.time.at`,'a planned future activity time is not an already occurred world event; use plannedFor separately');});
  if(at&&proof)occurrence={basis:'explicit',at,evidence:proof.ref};
 }
 let planned;
 if(evidence.plannedFor){const value=evidence.plannedFor;check(`${field}.evidence.plannedFor`,()=>keys(value,['at','sourceId','quote'],`${field}.evidence.plannedFor`));if(plain(value)){const at=check(`${field}.evidence.plannedFor.at`,()=>iso(value.at,`${field}.evidence.plannedFor.at`)),proof=check(`${field}.evidence.plannedFor`,()=>witness({sourceId:value.sourceId,quote:value.quote},`${field}.evidence.plannedFor`));if(at&&proof)planned={at,evidence:proof.ref};}}
 const declared=check(`${field}.sourceIds`,()=>{if(!Array.isArray(record.sourceIds)||!record.sourceIds.length||record.sourceIds.length>64||record.sourceIds.some(alias=>!sourceIds.has(alias)))throw fail(`${field}.sourceIds`,'cite 1..64 original aliases offered in this request');return new Set(record.sourceIds.map(alias=>sourceIds.get(alias)));});
 if(declared&&[statement?.ref,occurrence?.evidence,planned?.evidence].filter(Boolean).some(ref=>!declared.has(ref.sourceId)))check(`${field}.sourceIds`,()=>{throw fail(`${field}.sourceIds`,'statement/time witnesses must be among this event\'s cited originals');});
 try{issues.throwIfAny();}catch(error){error.code='invalid_activity_event';error.field=error.issues[0].path;error.allowedShape=fail(field,'').allowedShape;throw error;}
 const event=Object.fromEntries(canonicalFields.filter(key=>record[key]!==undefined).map(key=>[key,clone(record[key])]));
 event.activityProof={protocol:PROTOCOL,...(selected?{activityId:selected.id}:{create:true}),...(definition?{definition}:{}),statement:statement.ref,occurrence,...(planned?{planned}:{})};
 return event;
}
function decodeClaim(record,field,options){
 if(plain(record)&&(record.activityProof!==undefined||record.currentStateProof!==undefined))throw fail(field,'program-owned activity proof cannot be supplied on model wire');
 if(!plain(record)||record.activity===undefined&&record.currentState===undefined)return record;
 const issues=new ValidationIssues();issues.check(`${field}.currentState`,'invalid_activity_event',()=>{if(record.aspect!=='coordination')throw fail(`${field}.aspect`,'activity-associated current state belongs to coordination');keys(record.currentState,['status','statement'],`${field}.currentState`);if(!['invited','accepted','declined','rescheduled','cancelled','unknown'].includes(record.currentState.status))throw fail(`${field}.currentState.status`,'choose the current state actually asserted in the original');});
 const dummy={text:record.text,sourceIds:record.sourceIds,activityKey:'current state association',eventKind:'sharing',actor:'unknown',activity:record.activity,evidence:{statement:record.currentState?.statement,time:{basis:'unknown'}}};
 let proof;try{proof=decodeEvent(dummy,field,options).activityProof;}catch(error){if(error.issues)error.issues=error.issues.map(issue=>({...issue,path:issue.path.replace('.evidence.statement','.currentState.statement'),message:issue.message.replaceAll('.evidence.statement','.currentState.statement')}));issues.capture(field,'invalid_activity_event',error);}
 try{issues.throwIfAny();}catch(error){error.code='invalid_activity_event';error.field=error.issues[0].path;throw error;}
 const {activity,currentState,...claim}=record;
 return {...claim,activityProof:proof,currentStateProof:{status:currentState.status}};
}
function normalizeProof(value,field){
 keys(value,['protocol','activityId','create','definition','statement','occurrence','planned'],field);if(value.protocol!==PROTOCOL||value.create!==true&&typeof value.activityId!=='string'||value.create===true&&value.activityId!==undefined)throw fail(field,'invalid program activity selection');
 const out={protocol:PROTOCOL,...(value.create?{create:true}:{activityId:value.activityId}),statement:reference(value.statement,`${field}.statement`)};
 if(value.definition)out.definition=reference(value.definition,`${field}.definition`);
 keys(value.occurrence,['basis','at','evidence'],`${field}.occurrence`);if(!['unknown','explicit','qq_statement'].includes(value.occurrence.basis))throw fail(field,'invalid occurrence basis');out.occurrence={basis:value.occurrence.basis};
 if(value.occurrence.at!==undefined)out.occurrence.at=iso(value.occurrence.at,`${field}.occurrence.at`);if(value.occurrence.evidence)out.occurrence.evidence=reference(value.occurrence.evidence,`${field}.occurrence.evidence`);
 if(value.planned){keys(value.planned,['at','evidence'],`${field}.planned`);out.planned={at:iso(value.planned.at,`${field}.planned.at`),evidence:reference(value.planned.evidence,`${field}.planned.evidence`)};}
 if(out.occurrence.basis==='unknown'&&(out.occurrence.at||out.occurrence.evidence)||out.occurrence.basis!=='unknown'&&(!out.occurrence.at||!out.occurrence.evidence))throw fail(field,'occurrence fields must match their basis');
 return out;
}
function resolveProof(store,scope,value,{raw,delivered,old,state,minted,offeredIds,field='relationshipPatch.events'}){
 const proof=value.activityProof;if(!proof)return null;
 const read=ref=>{const original=raw.get(ref.sourceId);if(!original||original.revision!==ref.revision||referenceText(ref,raw)===null||original.evidenceSourceIds?.length)throw fail(field,'activity original revision/range is unavailable or derived rather than original');const shown=delivered.find(source=>source.id===ref.sourceId&&source.revision===ref.revision&&(source.segment?.offset??source.delivery?.start??0)<=ref.start&&(source.segment?.end??source.delivery?.end??source.text.length)>=ref.end);if(!shown)throw fail(field,'necessary activity statement/definition original range was not delivered');return original;};
 const statement=read(proof.statement);let id,definition=proof.definition;
 if(proof.create){
  if(!definition)throw fail(field,'NEW activity requires an original definition');read(definition);
  const existing=state.activities.find(item=>item.definitions.some(ref=>ref.sourceId===definition.sourceId&&ref.start===definition.start&&ref.end===definition.end));
  if(existing)throw fail(field,'this original definition already has an activity identity; select the offered existing ref instead of NEW');
  const key=JSON.stringify([definition.sourceId,definition.revision,definition.start,definition.end]);if(!minted.has(key))minted.set(key,`activity:${randomUUID()}`);id=minted.get(key);
 }else{
  const item=state.activities.find(item=>item.id===proof.activityId);if(!item||offeredIds&&!offeredIds.has(proof.activityId))throw fail(field,'activity identity was not captured for this account/contact');id=item.id;definition=definition||item.definition;if(!definition)throw fail(field,'existing activity needs a new explicit surviving definition');read(definition);
 }
 if(old?.activityId&&old.activityId!==id)throw fail(field,'an existing event cannot switch activity identity');
 if(proof.occurrence.evidence)read(proof.occurrence.evidence);if(proof.planned)read(proof.planned.evidence);
 if(proof.occurrence.basis==='qq_statement'&&(statement.type!=='qq'||!speechActs.has(value.eventKind)||proof.occurrence.at!==statement.at))throw fail(field,'invalid QQ speech-act clock');
 if(proof.occurrence.basis==='unknown'&&proof.occurrence.at)throw fail(field,'unknown occurrence cannot carry a date');
 if(proof.occurrence.basis!=='unknown'&&!proof.occurrence.at)throw fail(field,'known occurrence requires its explicit basis');
 if(proof.occurrence.at&&proof.occurrence.at>statement.at)throw fail(field,'world occurrence cannot be the future planned time');
 const priorUncertainties=[...state.legacyUncertainties,...state.activities.flatMap(item=>item.gaps)];
 const evidenceAt=value.currentStateProof?statement.at:proof.occurrence.at;
 const provisional=proof.create&&priorUncertainties.some(gap=>!(gap.affectedWorldAt||gap.legacyOrderAt)||!evidenceAt||(gap.affectedWorldAt||gap.legacyOrderAt)>=evidenceAt);
 return {fields:{activityId:id,activityDefinition:clone(definition),statementEvidence:clone(proof.statement),timeEvidence:clone(proof.occurrence),...(proof.planned?{plannedFor:proof.planned.at,plannedEvidence:clone(proof.planned.evidence)}:{}),activityProvisional:provisional,occurredAt:proof.occurrence.at||null},statementAt:statement.at,origin:statement.type==='qq'?'qq_observation':'user_report',identitySourceIds:[definition.sourceId]};
}
module.exports={PROTOCOL,LOSS_RULE,evidenceLosses,trimContextLoss,lossReferences,assertLossReferences,activityReferences,evidenceViewRecord,readState,storedState,publicActivities,makeGap,memoryContext,wireContext,decodeEvent,decodeClaim,normalizeProof,resolveProof,referenceText};
