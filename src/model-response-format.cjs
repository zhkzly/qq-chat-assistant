'use strict';
const {TOPIC_PROTOCOL}=require('./topic-schema.cjs');
const {SUBJECTS,ASSERTIONS,EPISTEMIC,LIFECYCLES,EVENT_KINDS,ASPECTS}=require('./relationship-schema.cjs');
const {auxiliaryReview}=require('./help-behavior.cjs');
const string={type:'string'},integer={type:'integer'},boolean={type:'boolean'};
const array=items=>({type:'array',items}),strings=array(string),choice=values=>({type:'string',enum:values});
const object=(properties,required=[])=>({type:'object',properties,...(required.length?{required}:{}),additionalProperties:false});
const reference=object({text:string,sourceIds:strings},['text','sourceIds']);
const quote=object({sourceId:string,text:string},['sourceId','text']);
const guidance=object({objective:reference,allowedApproach:reference,avoidances:array(reference),currentStep:reference});
const draftPlan=object({quotes:array(quote),intent:choice(['reply']),authorizationQuote:string,style:choice(['natural','short','casual']),language:string,
 askFollowup:boolean,useEmoji:boolean,clarification:string,option:object({turnId:string,index:integer},['turnId','index']),guidance});
const stateItem=object({text:string,sourceIds:strings,status:choice(['open','resolved','cancelled'])},['text','sourceIds']);
const statePatch=object({focus:string,items:array(reference),openThreads:array(stateItem),unknowns:strings});
const action=object({type:choice(['set_goal','save_note','update_note','set_preference','correct_source','forget']),evidenceQuote:string,text:string,
 noteId:string,sourceId:string,targetQuote:string,use:choice(['discussion','draft','disabled'])},['type','evidenceQuote']);
const topicFields={operation:choice(TOPIC_PROTOCOL.operations),topicId:string,objective:string,direction:string,constraints:strings,stage:string,progress:strings,unknowns:strings,
 purposeSourceIds:strings,observationSourceIds:strings,intentQuote:string,interpretationStatus:choice(TOPIC_PROTOCOL.interpretationStatuses)};
const topicPatch=object(Object.fromEntries(TOPIC_PROTOCOL.patchFields.map(key=>[key,topicFields[key]])),['operation']);
const common={id:string,expectedVersion:integer,text:string,sourceIds:strings,topicKeys:strings};
const claim=object({...common,subject:choice(SUBJECTS),aspect:choice(ASPECTS),assertionKind:choice(ASSERTIONS),epistemicStatus:choice(EPISTEMIC),
 lifecycle:choice(LIFECYCLES),validFrom:string,validUntil:string,context:string},['text','sourceIds','subject','aspect','assertionKind','epistemicStatus']);
const event=object({...common,activityKey:string,eventKind:choice(EVENT_KINDS),actor:choice(['self','contact','both','unknown']),occurredAt:string},['text','sourceIds','activityKey','eventKind','actor']);
const retirement=object({id:string,expectedVersion:integer,sourceIds:strings,lifecycle:choice(['superseded','withdrawn'])},['id','expectedVersion','sourceIds','lifecycle']);
const relationshipPatch=object({claims:array(claim),events:array(event),retire:array(retirement)});
const expressionOption=object({label:string,quotes:array(quote),style:string},['label','quotes']);
const experienceProposal=object({text:string,applicability:string,methodId:string,sourceIds:strings,caseIds:strings},['text','applicability','methodId','sourceIds','caseIds']);
const quoteRef=object({turnId:string,role:choice(['user','assistant']),field:choice(['text','discussionExplanation','suggestions','expressionOptions']),index:integer,quoteIndex:integer,text:string,
 artifactRef:object({artifactId:string,version:integer},['artifactId','version']),sourceIds:strings},['turnId','role','text']);
const memoryItem=object({id:string,kind:choice(['fact','preference','commitment','uncertainty']),text:string,sourceIds:strings,topicKeys:strings,
 status:choice(['active','resolved','cancelled','superseded']),certainty:choice(['stated','tentative']),explicitPreference:boolean},['kind','text','sourceIds','status','certainty']);
const episode=object({id:string,text:string,sourceIds:strings,topicKeys:strings},['text','sourceIds']);
const memoryRetirement=object({id:string,sourceIds:strings,status:choice(['resolved','cancelled','superseded'])},['id','sourceIds','status']);
const schemas={
 assistant_result:object({kind:choice(['discussion','question','options','review','acknowledgment']),text:string,methodIds:strings,draftPlan,replyDisposition:choice(['wait','clarify','unavailable']),
 lookup:object({query:string,discussionTurnIds:strings,before:string,after:string,types:array(choice(['qq','private','note','feedback']))}),
    actions:array(action),stateReview:choice(['no_change']),statePatch,topicPatch,relationshipPatch,experienceProposals:array(experienceProposal),expressionOptions:array(expressionOption)},['kind','text']),
 draft_result:object({kind:choice(['draft','discussion','question']),text:string,suggestions:array(object({style:string,text:string},['style','text'])),methodIds:strings,replyDisposition:choice(['wait','clarify','unavailable'])},['kind','text']),
 discussion_compaction_result:object({summary:string,reviewedTurnIds:strings,quoteRefs:array(quoteRef)},['summary','reviewedTurnIds','quoteRefs']),
 memory_result:object({batchId:string,reviewedAll:boolean,items:array(memoryItem),episodes:array(episode),retire:array(memoryRetirement),relationshipPatch},['batchId','reviewedAll','items','episodes','retire'])
};
function responseEnvelope(settings,purpose,payload) {
 if(settings.modelResponseMode==='plain_text')return {};
 // These are result envelopes, never executable tools. The local proxy's
 // Claude adapter maps named tool_choice; json_object is not mapped there.
 // Restrict the automatic choice to verified non-thinking 4.6 models.
 const useTool=settings.modelResponseMode==='result_tool'||settings.modelResponseMode!=='json_object'&&/^claude-(?:sonnet|opus)-4-6$/.test(settings.model||'');
 if(!useTool)return {response_format:{type:'json_object'}};
 const name=purpose==='draft'?'draft_result':purpose==='discussion_compaction'?'discussion_compaction_result':purpose==='memory'?'memory_result':'assistant_result';
 let schema=schemas[name];
 if(name==='assistant_result'&&payload){
  const taskPayload=payload.originalInput||payload;
  const properties={...schema.properties};
  if(!auxiliaryReview({...taskPayload,purpose}))delete properties.relationshipPatch;
  if(taskPayload.experienceProposalPolicy?.enabled!==true)delete properties.experienceProposals;
  if(taskPayload.generationOrigin==='qq_observation')delete properties.actions;
  schema={...schema,properties};
 }
 return {tools:[{type:'function',function:{name,description:'Return readable kind/text for this phase, with only useful optional data. This function is not executed and performs no external action. Follow source and phase rules.',parameters:schema}}],
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
module.exports={responseEnvelope,normalizeResultPadding};
