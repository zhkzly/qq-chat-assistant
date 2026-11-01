'use strict';
const {TOPIC_PROTOCOL}=require('./topic-schema.cjs');
const {SUBJECTS,ASSERTIONS,EPISTEMIC,LIFECYCLES,EVENT_KINDS,ASPECTS,APPLICABILITY,ATTRIBUTION,TRANSITIONS}=require('./relationship-schema.cjs');
const {auxiliaryReview}=require('./help-behavior.cjs');
// The lookup tool-schema fragment is compiled from the same wire contract as
// the deep validator and the protocol line (src/contracts/lookup.contract.json),
// so the provider schema cannot drift from validation.
const {compile}=require('./wire/compile.cjs');
const lookupSchemaShape=compile('lookup').schema();
const {candidatePaths}=require('./candidate-field-paths.cjs');
const string={type:'string'},integer={type:'integer'},boolean={type:'boolean'};
const array=items=>({type:'array',items}),strings=array(string),choice=values=>({type:'string',enum:values});
const object=(properties,required=[])=>({type:'object',properties,...(required.length?{required}:{}),additionalProperties:false});
const reference=object({text:string,sourceIds:strings},['text','sourceIds']);
const quote=object({materialRef:{...string,description:'Offered m# or m#@bSTART:bEND using displayed word boundaries only. Choose relevant outward material; never count offsets or copy bodies.'},authorityRef:{...string,description:'Choose the matching offered authority for this private material. currentPermission refers to the complete current human statement, a candidate NOT GRANT; do not slice negation or conditions.'},factQuote:{...string,description:'Optional exact narrower FACT span inside the selected materialRef; the fact is distinct from its permission sentence.'},permissionQuote:{...string,description:'Optional exact narrow permission from the selected authority original; full context, negation and conditions still apply.'}},['materialRef']);
const guidance=object({objective:reference,allowedApproach:reference,avoidances:array(reference),currentStep:reference});
const draftPlan=object({editingReference:object({choice:{...string,description:'Choose the offered short handle, such as e1. Do not reconstruct artifact IDs or versions.'},artifactId:string,version:integer}),quotes:array(quote),intent:choice(['reply']),style:choice(['natural','short','casual']),language:string,
 askFollowup:boolean,useEmoji:boolean,taskUse:choice(['continue','different','uncertain']),option:object({turnId:string,index:integer},['turnId','index']),guidance});
const stateItem=object({text:string,sourceIds:strings,status:choice(['open','resolved','cancelled'])},['text','sourceIds']);
const statePatch=object({focus:string,items:array(reference),openThreads:array(stateItem),unknowns:strings});
const action=object({type:choice(['set_goal','save_note','update_note','set_preference','correct_source','forget']),evidenceQuote:string,text:string,
 noteId:string,sourceId:string,targetQuote:string,use:choice(['discussion','draft','disabled'])},['type','evidenceQuote']);
const topicFields={operation:choice(TOPIC_PROTOCOL.operations),topicId:string,objective:string,direction:string,constraints:strings,stage:string,progress:strings,unknowns:strings,
 purposeSourceIds:strings,observationSourceIds:strings,intentQuote:string,interpretationStatus:choice(TOPIC_PROTOCOL.interpretationStatuses)};
const topicPatch=object(Object.fromEntries(TOPIC_PROTOCOL.patchFields.map(key=>[key,topicFields[key]])),['operation']);
const common={id:string,expectedVersion:integer,text:string,sourceIds:strings,topicKeys:strings};
const claim=object({...common,subject:choice(SUBJECTS),aspect:choice(ASPECTS),assertionKind:choice(ASSERTIONS),epistemicStatus:choice(EPISTEMIC),
 lifecycle:choice(LIFECYCLES),validFrom:string,validUntil:string,context:string,applicabilityKind:choice(APPLICABILITY),attribution:choice(ATTRIBUTION),condition:string,
 transition:object({operation:choice(TRANSITIONS),targets:array(object({id:string,expectedVersion:integer},['id','expectedVersion']))},['operation','targets'])},['text','sourceIds','subject','aspect','assertionKind','epistemicStatus']);
const event=object({...common,activityKey:string,eventKind:choice(EVENT_KINDS),actor:choice(['self','contact','both','unknown']),occurredAt:string,transition:claim.properties.transition},['text','sourceIds','activityKey','eventKind','actor']);
const activityWitness=object({sourceId:string,quote:string},['sourceId','quote']);
const activityTimeProperties={basis:choice(['qq_statement','explicit','unknown']),at:{...string,description:'Explicit occurrence time, or an optional qq_statement echo denoting the same instant as the actual bound QQ statement at. Forbidden for unknown.'},sourceId:{...string,description:'Required original time-witness source for explicit; optional qq_statement echo must equal the statement source. Forbidden for unknown.'},quote:{...string,description:'Required original time witness for explicit; optional qq_statement echo must be an exact original span from the same statement source. Forbidden for unknown.'}};
const activityTime={...object(activityTimeProperties,['basis']),anyOf:[
 object({basis:choice(['unknown'])},['basis']),
 object({...activityTimeProperties,basis:choice(['qq_statement'])},['basis']),
 object({...activityTimeProperties,basis:choice(['explicit'])},['basis','at','sourceId','quote'])
]};
const activitySelection=object({ref:{...string,description:'Choose an offered persisted activity ref; NEW requires one exact unique original definition. Display activityKey is not identity.'},definition:activityWitness},['ref']);
const activityEvidence=object({statement:activityWitness,time:activityTime,plannedFor:object({at:string,sourceId:string,quote:string},['at','sourceId','quote'])},['statement','time']);
const activityCurrentState=object({status:choice(['invited','accepted','declined','rescheduled','cancelled','unknown']),statement:activityWitness},['status','statement']);
const memoryEventProperties={...event.properties,activity:activitySelection,evidence:activityEvidence};delete memoryEventProperties.occurredAt;
const memoryEvent=object(memoryEventProperties,[...event.required,'activity','evidence']);
const memoryClaim={...claim,properties:{...claim.properties,activity:activitySelection,currentState:activityCurrentState}};
const retirement=object({id:{...string,description:'Offered prior typed record or legacy item; retire unsupported understanding without inventing a successor.'},expectedVersion:integer,sourceIds:strings,lifecycle:choice(['superseded','withdrawn'])},['id','expectedVersion','sourceIds','lifecycle']);
const relationshipPatch=object({claims:array(claim),events:array(event),retire:array(retirement)});
const memoryRelationshipPatch=object({claims:array(memoryClaim),events:array(memoryEvent),retire:array(retirement)});
const expressionOption=object({label:string,quotes:{...array(quote),description:'Optional historical private fact quotes for THIS option only; with currentFacts combined at most 8.'},currentFacts:{...strings,description:'Optional exact current human fact spans for THIS option only. With quotes combined at most 8; source binding is not disclosure permission.'},style:string},['label']);
const experienceProposal=object({text:string,applicability:string,methodId:string,sourceIds:strings,caseIds:strings},['text','applicability','methodId','sourceIds','caseIds']);
const quoteRef=object({turnId:string,role:choice(['user','assistant']),field:choice(['text','discussionExplanation','suggestions','expressionOptions']),index:integer,quoteIndex:integer,text:string,
 artifactRef:object({artifactId:string,version:integer},['artifactId','version']),sourceIds:strings},['turnId','role','text']);
const memoryItem=object({id:string,kind:choice(['fact','preference','commitment','uncertainty']),text:string,sourceIds:strings,topicKeys:strings,
 status:choice(['active','resolved','cancelled','superseded']),certainty:choice(['stated','tentative']),
 explicitPreference:{...boolean,description:'Deprecated no-op. Preference classification is program/user-owned: a kind=preference proposal is filed as a candidate pending user attestation, never committed as a stable record. Prefer a sourced fact/uncertainty.'}},['kind','text','sourceIds','status','certainty']);
const episode=object({id:{...string,description:'Choose NEW for a genuine new navigation record with eligible reviewed evidence, or an offered writable episode m# for that exact existing target. Use [] for no episode change.'},text:string,sourceIds:strings,topicKeys:strings},['id','text','sourceIds']);
const memoryRetirement=object({id:string,sourceIds:strings,status:choice(['resolved','cancelled','superseded'])},['id','sourceIds','status']);
// Wire admission shares these producer-declared legacy field sets. Typed
// relationship records retain their separate versioned patch contract.
const memoryRecordFields=Object.freeze(Object.fromEntries(Object.entries({items:memoryItem,episodes:episode,retire:memoryRetirement})
 .map(([name,schema])=>[name,Object.freeze(Object.keys(schema.properties))])));
const deliveryBlocker=object({kind:choice(['missing_fact','missing_authorization']),missing:string,question:{...string,description:'The sole canonical private clarification question.'},explanation:{...string,description:'Optional explicit why-only explanation, at most 1000 characters; do not repeat or paraphrase the question here.'}},['kind','missing','question']);
const evidenceWitness=object({sourceId:string,quote:string},['sourceId','quote']),candidateReference=object({path:string,quote:string},['path','quote']);
const outwardActions=['invitation','commitment','user_disclosure','topic_content'];
const factualStatement=object({quote:{...string,description:'Exact continuous text from this candidate path only; never paraphrase evidence into candidate text.'},kind:{...choice(['assertion','intent','opinion','question','private_conditional','advice','inspection']),description:'assertion: world claim or concrete premise, including an already established plan or commitment. intent: newly proposed wish/action, not evidence an event occurred. commitment is an outwardAction, never a kind.'},support:{...choice(['supported','unsupported','unverifiable']),description:'For assertions only. unverifiable remains targeted uncertainty; do not add defect basis/qualification or treat it as permission.'},
 evidence:{...array(evidenceWitness),maxItems:4},basis:choice(['no_support_in_supplied_evidence','source_contradiction','necessary_factual_qualification','candidate_fact_conflict']),qualification:choice(['time','frequency','degree','subject','negation','condition','scope']),related:candidateReference,reference:candidateReference,
 disclosure:{...array(evidenceWitness),maxItems:4},outwardAction:choice(outwardActions),condition:string,contextQuote:string,reason:string},['quote','kind']);
const factualField=object({path:string,statements:{...array(factualStatement),maxItems:12}},['path','statements']);
const schemas={
 assistant_result:object({operation:choice(['advise','prepare_message','lookup','clarify']),
 answer:{...object({privateExplanation:string,suggestions:array(object({style:string,text:string},['text']))},['suggestions']),description:'Only prepare_message: COMPLETE outward suggestions and its sole optional privateExplanation. No outer text, planning handoff or later composer.'},materials:{...array(quote),description:'Only actually used historical private facts; currentFacts plus materials total at most 8. Public QQ/control needs no material selector. Source/permission candidates are not new sharing grants.'},
 text:{...string,description:'Complete private coaching for advise; optional lookup audit note. Forbidden for prepare_message: answer.privateExplanation is the sole private explanation.'},
 currentFacts:{...strings,description:'Only actually used private facts, including task dates/items or personal events: exact spans from this current complete human statement, not control/reasons. currentFacts plus materials total at most 8. Binding is NOT blanket sharing permission; interpret full negation, quotations and conditions.'},
 editingReference:object({choice:string},['choice']),
 draftPlan:{...draftPlan,description:'Only prepare_message: material choices and proposed controls; no clarification.'},
 lookup:{...lookupSchemaShape,description:'Continuation reads and retrieval. Range reads may omit target IDs when exactly one delivered range covers them; batch reads fetch several ranges in one round trip.'},
 continuation:{...choice(['advise','prepare_message']),description:'Only lookup: workflow to continue after reading.'},
 blocker:{...deliveryBlocker,description:'Only clarify: specific missing fact/permission question and optional why-only explanation.'},
 methodIds:strings,actions:array(action),stateReview:choice(['no_change']),statePatch,topicPatch,relationshipPatch,experienceProposals:array(experienceProposal),expressionOptions:array(expressionOption)},['operation']),
 draft_result:object({kind:choice(['draft','discussion','question']),text:{...string,description:'For kind=draft, only the complete outward message body, 1..1200 characters; keep private reasoning in privateExplanation. For kind=question, the blocker owns its canonical body.'},privateExplanation:{...string,description:'Optional FINAL private explanation for kind=draft, at most 6000 characters; omitted or blank means absent. Own its factual reasoning together with the outward message; a primary planning comment is not verified truth.'},deliveryBlocker,suggestions:array(object({style:string,text:string},['style','text'])),methodIds:strings,replyDisposition:choice(['wait','clarify','unavailable'])},['kind','text']),
 fidelity_result:object({checkRef:string,verdict:choice(['allow','reject','uncertain']),factual:array(factualField),issues:array(object({path:string,code:choice(['private_disclosure']),quote:string,sourceIds:strings,evidence:array(evidenceWitness),reason:string},['path','code','quote'])),concerns:array(object({path:string,code:string,quote:string,sourceIds:strings,evidence:array(evidenceWitness),reason:string},['path','code','reason']))},['checkRef','factual','issues']),
 discussion_compaction_result:object({summary:string,reviewedTurnIds:strings,quoteRefs:array(quoteRef)},['summary','reviewedTurnIds','quoteRefs']),
 memory_result:object({batchId:string,reviewedAll:boolean,episodes:array(episode),relationshipPatch:memoryRelationshipPatch},['batchId','reviewedAll','episodes','relationshipPatch'])
};
function responseEnvelope(settings,purpose,payload) {
 if(settings.modelResponseMode==='plain_text')return {};
 // These are inert result envelopes. The native Codex translator forwards
 // function tools and named choice; json_object is not an equivalent carrier.
 const autoTool=/^claude-(?:sonnet|opus)-4-6$/.test(settings.model||'')||/^gpt-(?:4o|4\.1|5|6)(?:[-.]|$)/.test(settings.model||'');
 const useTool=settings.modelResponseMode==='result_tool'||settings.modelResponseMode!=='json_object'&&autoTool;
 if(!useTool)return {response_format:{type:'json_object'}};
 const name=purpose==='fidelity_check'?'fidelity_result':purpose==='draft'?'draft_result':purpose==='discussion_compaction'?'discussion_compaction_result':purpose==='memory'?'memory_result':'assistant_result';
 let schema=schemas[name];
 if(name==='memory_result'){
  const input=payload?.originalInput||payload,refs=(input?.activityContext?.activities||[]).map(item=>item.ref),properties={...memoryEvent.properties};
  properties.activity={...activitySelection,properties:{...activitySelection.properties,ref:{...activitySelection.properties.ref,...(input?{enum:['NEW',...refs]}:{})}}};properties.evidence=activityEvidence;
  const nativeClaim={...memoryClaim,properties:{...memoryClaim.properties,activity:properties.activity}};
  schema={...schema,properties:{...schema.properties,relationshipPatch:{...relationshipPatch,properties:{...relationshipPatch.properties,claims:array(nativeClaim),events:array(object(properties,[...event.required,'activity','evidence']))}}}};
 }
 if(name==='memory_result'&&payload){
  const input=payload.originalInput||payload,targets=(input.priorMemory?.episodes||[]).filter(record=>record.updateAuthority==='requires_original_read_proof').map(record=>record.id);
  const canCreate=input.review?.purpose!=='semantic_recovery'&&(input.sources||[]).some(source=>!source.deleted),ids=[...(canCreate?['NEW']:[]),...targets];
  schema={...schema,properties:{...schema.properties,episodes:{...schema.properties.episodes,...(!ids.length?{maxItems:0}:{}),items:{...episode,properties:{...episode.properties,id:{...episode.properties.id,...(ids.length?{enum:ids}:{})}}}}}};
 }
 if(name==='assistant_result'){const properties={...schema.properties};delete properties.draftPlan;schema={...schema,properties};}
 if(name==='fidelity_result'&&(payload?.originalInput||payload)?.auditProtocol==='sparse-defects-v1')schema=object({
  checkRef:choice(['c1']),auditProtocol:choice(['sparse-defects-v1']),
  issues:array(object({path:string,code:choice(['unsupported_fact','evidence_mismatch','omitted_qualifier','internal_conflict','private_disclosure']),quote:string,reason:string,evidence:array(evidenceWitness),related:candidateReference},['path','code','quote','reason'])),
  concerns:array(object({path:string,code:string,reason:string,quote:string},['path','code','reason']))
 },['checkRef','auditProtocol','issues']);
 if(name==='fidelity_result'&&(payload?.originalInput||payload)?.candidate){
  const paths=candidatePaths((payload.originalInput||payload).candidate),properties=structuredClone(schema.properties);
  const withPaths=rule=>({...rule,items:{...rule.items,properties:{...rule.items.properties,path:choice([...paths]),
    ...(rule.items.properties.relatedPath?{relatedPath:choice([...paths])}:{})}}});
  properties.issues=withPaths(properties.issues);properties.concerns=withPaths(properties.concerns);
  if(properties.factual){
   properties.factual={...withPaths(properties.factual),minItems:paths.length,maxItems:paths.length};
   const statementProperties=properties.factual.items.properties.statements.items.properties;
   for(const field of ['related','reference'])statementProperties[field]={...statementProperties[field],properties:{...statementProperties[field].properties,path:choice([...paths])}};
  }
  if(properties.issues.items.properties.related)properties.issues.items.properties.related.properties.path=choice([...paths]);
  properties.concerns={...properties.concerns,items:{...properties.concerns.items,properties:{...properties.concerns.items.properties,code:string}}};
  schema={...schema,properties};
 }
 if(name==='draft_result'&&(payload?.originalInput||payload)?.requestDeliveryObligation){
  // Keep the provider envelope flat; the local terminal validator owns the
  // conditional contract across providers and program-generated fallbacks.
  schema={...schema,properties:{...schema.properties,kind:choice(['draft','question']),
    suggestions:{...schema.properties.suggestions,description:'Optional legacy candidates for kind=draft; if nonempty they are authoritative. Otherwise draft.text is the complete outward body.'},
    deliveryBlocker:{...deliveryBlocker,description:'Required for kind=question: identify the specific missing fact or authorization and the matching private question.'}}};
 }
 if(name==='assistant_result'&&payload){
  const taskPayload=payload.originalInput||payload;
  const properties={...schema.properties};
  if(taskPayload.workingState?.ownership==='evidence_only_task_controls_in_topicContext')properties.statePatch=object({items:array(reference)});
  // The foreground is responsive help, not a parallel semantic profile writer.
  // Legacy decoded proposals may queue for the background original-evidence pass.
  delete properties.relationshipPatch;
  if(taskPayload.experienceProposalPolicy?.enabled!==true)delete properties.experienceProposals;
  if(taskPayload.generationOrigin==='qq_observation')delete properties.actions;
  schema={...schema,properties};
 }
 return {tools:[{type:'function',function:{name,description:name==='assistant_result'?'Select exactly one primary operation and only its active core payload. Optional independently supported proposals are not executed by this inert result tool.':name==='fidelity_result'?'Report only concrete source-bound defects in this exact candidate. No exhaustive proposition census or global pass certificate. Read-only; cannot rewrite, execute or grant facts/permission.':name==='memory_result'?'Return the captured batch receipt, original-backed logical understanding and explicit navigation choices. Historical knowledge gaps permit completed no-change; world events require their activity, statement and time evidence. This inert tool performs no external action.':'Return readable kind/text for this phase, with only useful optional data. This function is not executed and performs no external action. Follow source and phase rules.',parameters:schema}}],
  tool_choice:{type:'function',function:{name}},parallel_tool_calls:false};
}
function normalizeResultPadding(value,name) {
 const schema=schemas[name];
 function visit(item,rule,legacyRoot=false){
  // The result-tool adapter may serialize a declared container one extra time.
  // Decode only an exact JSON object/array of the expected type. Scalar prose,
  // unknown schema paths and malformed or wrong-type strings remain untouched.
  if(typeof item==='string'&&['object','array'].includes(rule?.type)){
   try{const parsed=JSON.parse(item),matches=rule.type==='array'?Array.isArray(parsed):parsed&&typeof parsed==='object'&&!Array.isArray(parsed);
    if(matches)item=parsed;
   }catch{ /* The local phase validator still rejects malformed containers. */ }
  }
  if(Array.isArray(item)&&rule?.items)return item.map(child=>visit(child,rule.items));
  if(!item||typeof item!=='object'||Array.isArray(item)||rule?.type!=='object')return item;
  return Object.fromEntries(Object.entries(item).filter(([key,data])=>!(key==='_'&&typeof data==='boolean'&&!rule.properties?._&&(!rule.required?.length||legacyRoot)))
   .map(([key,data])=>[key,visit(data,rule.properties?.[key])]));
 }
 // This normalizer is called only for named result-tool arguments by the reader.
 // Preserve replay compatibility with the formerly all-optional result root.
 // Other padding is stripped only at all-optional nested schema paths; retain
 // every other field and all original string content.
 return schema?visit(value,schema,name==='assistant_result'):value;
}
module.exports={responseEnvelope,normalizeResultPadding,memoryRecordFields};
