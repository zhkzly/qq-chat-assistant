'use strict';
const {randomUUID}=require('node:crypto');
const {sourceClosure,isLocalFeedback}=require('./provenance.cjs');
const {normalizeTopicPatch,TOPIC_LIMITS,TOPIC_PROTOCOL}=require('./topic-schema.cjs');

const PRIVATE_ORIGINS=new Set(['private_discussion','user_control','user_feedback','private_feedback']);
const PURPOSE_FIELDS=['objective','direction','constraints','interpretationStatus'];
const OBSERVATION_FIELDS=['stage','progress','unknowns'];
const emptyTopics=()=>({version:0,activeId:null,items:[]});
const validRevisions=(refs,live)=>Object.entries(refs||{}).every(([id,revision])=>live.get(id)?.revision===revision);
function aggregate(topic) {
  topic.sourceRevisions={...topic.purposeSourceRevisions,...topic.observationSourceRevisions,...topic.lifecycleSourceRevisions};
  topic.sourceIds=[...new Set([...topic.purposeSourceIds,...topic.observationSourceIds,...(topic.lifecycleSourceIds||[]),...Object.keys(topic.sourceRevisions)])];
  return topic;
}
function bindFields(topic,kind,fields,patch,sourceIds,sourceRevisions,authorities={},clearBinding=null) {
  const idsKey=`${kind}SourceIds`,revisionsKey=`${kind}SourceRevisions`,bindingsKey=`${kind}Bindings`;
  const previous=topic[bindingsKey]||Object.fromEntries(fields.filter(field=>topic[field]!==undefined).map(field=>[field,{sourceIds:topic[idsKey]||[],sourceRevisions:topic[revisionsKey]||{}}]));
  topic[bindingsKey]={...previous};
  for(const field of fields)if(Object.hasOwn(patch,field)){
    const cleared=kind==='observation'&&(typeof patch[field]==='string'?!patch[field].trim():!patch[field].length);
    const support=cleared&&clearBinding?clearBinding:{sourceIds,sourceRevisions};
    topic[bindingsKey][field]={sourceIds:cleared&&!clearBinding?[]:[...support.sourceIds],sourceRevisions:cleared&&!clearBinding?{}:{...support.sourceRevisions},...(kind==='observation'?{authority:cleared?'cleared':authorities[field]||'source_backed_observation'}:{})};
  }
  topic[idsKey]=[...new Set(Object.values(topic[bindingsKey]).flatMap(binding=>binding.sourceIds))];
  topic[revisionsKey]=Object.assign({},...Object.values(topic[bindingsKey]).map(binding=>binding.sourceRevisions));
  if(kind==='observation')topic.observationAuthorities=Object.fromEntries(Object.entries(topic[bindingsKey]).map(([field,binding])=>[field,binding.authority||'source_backed_observation']));
  if(topic[idsKey].length>64)throw new Error('Topic current support is full; create a new bounded topic');
}
function bound(topics) {
  const active=topics.items.find(topic=>topic.id===topics.activeId&&topic.lifecycle==='active');
  // Read views are bounded; persistence retains source-valid task history.
  topics.activeId=active?.id||null;
  return topics;
}
function pruneTopics(record,sources) {
  if(!record.topics){record.topics=emptyTopics();return false;}
  const live=new Map(sources.map(source=>[source.id,source])),topics=record.topics;
  let changed=false;
  topics.items=topics.items.filter(topic=>{
    // Keep neither a purpose nor its verbatim private copy after its grounding
    // is changed or forgotten. Partial purpose replacement remains conservative.
    const valid=topic.purposeSourceIds?.length&&validRevisions(topic.purposeSourceRevisions,live);
    if(!valid)changed=true;
    return valid;
  }).map(topic=>{
    let revised=false;
    if(!validRevisions(topic.observationSourceRevisions,live)){
      topic={...topic,stage:'',progress:[],unknowns:[],observationSourceIds:[],observationSourceRevisions:{},observationBindings:{},observationAuthorities:{}};revised=true;
    }
    if(!validRevisions(topic.lifecycleSourceRevisions,live)){
      // A recalled completion cannot silently become an active purpose again.
      topic={...topic,lifecycle:'paused',lifecycleSourceIds:[],lifecycleSourceRevisions:{},lifecycleEvidenceStatus:'needs_review'};revised=true;
    }
    if(revised){changed=true;topic={...topic,version:topic.version+1,updatedAt:new Date().toISOString()};}
    return aggregate(topic);
  });
  const active=topics.items.find(topic=>topic.id===topics.activeId&&topic.lifecycle==='active');
  if(!active&&topics.activeId){topics.activeId=null;changed=true;}
  if(changed)topics.version++;
  bound(topics);
  return changed;
}
function topicView(scope,topics=emptyTopics()) {
  const state=JSON.parse(JSON.stringify(topics));
  const active=state.items.find(topic=>topic.id===state.activeId&&topic.lifecycle==='active')||null;
  const history=state.items.filter(topic=>topic.id!==active?.id),retained=history.slice(-TOPIC_LIMITS.retained);
  return {...state,items:active?[...retained,active]:retained,scope:{...scope},active,retained,
    retainedCount:history.length,authority:'private_direction_not_outbound_authorization',semanticOwner:'consultation_task'};
}
function directPrivate(source) {
  return source?.type==='private'&&source.role==='user'||source?.type==='feedback'&&source.role==='user'&&source.kind==='local'&&!!source.canonicalFeedbackId;
}
function currentActor(record,live,options) {
  const source=live.get(options.currentSourceId);
  if(!directPrivate(source))throw new Error('Topic purpose requires a current private user source');
  if(!PRIVATE_ORIGINS.has(options.origin))throw new Error('Topic purpose cannot be changed by QQ observations');
  const eligible=record.turns.filter(turn=>turn.role==='user'&&!turn.memoryExcluded&&live.has(turn.kind==='feedback_ref'?`private:feedback-${turn.feedbackId}`:`private:${turn.id}`));
  const latest=eligible.at(-1),sourceId=latest&&(latest.kind==='feedback_ref'?`private:feedback-${latest.feedbackId}`:`private:${latest.id}`);
  if(options.origin==='user_feedback'){
    if(source.type!=='feedback'||source.canonicalFeedbackId!==options.currentFeedbackId)throw new Error('Current feedback actor does not match its canonical source');
    if(options.canonicalActorId!==undefined&&options.canonicalActorId!==source.id)throw new Error('Current feedback actor identifier is inconsistent');
    // An explicit continue click may append a neutral current request rather
    // than duplicate the feedback body as a second factual user source.
    if(!latest||latest.kind!=='feedback_continue'||latest.requestId!==options.requestId)throw new Error('Current feedback continuation request is unavailable');
  }else if(sourceId!==options.currentSourceId||latest?.requestId!==options.requestId){
    throw new Error('Topic purpose requires the latest current private request');
  }
  return source;
}
function prepareTopicPatch(record,sources,input,options={}) {
  const patch=normalizeTopicPatch(input),topics=record.topics||emptyTopics(),live=new Map(sources.map(source=>[source.id,source]));
  if(!Array.isArray(options.sourceIds)||!options.sourceRevisions||typeof options.sourceRevisions!=='object')throw new Error('Topic patches require delivered revision-bound sources');
  if(typeof options.requestId!=='string'||!options.requestId||options.requestId.length>256)throw new Error('Invalid topic request identifier');
  const allowed=new Set(options.sourceIds);
  const revisions=ids=>{
    if(!ids?.length)throw new Error('Topic changes require nonempty source evidence');
    if(ids.some(id=>!allowed.has(id)||!live.has(id)))throw new Error('Unavailable or undelivered topic evidence');
    const closure=sourceClosure(live,ids);
    if(closure.some(source=>!allowed.has(source.id)||options.sourceRevisions[source.id]!==source.revision))throw new Error('Stale or undelivered topic source revision');
    return Object.fromEntries(closure.map(source=>[source.id,source.revision]));
  };
  const old=patch.topicId&&topics.items.find(topic=>topic.id===patch.topicId);
  if(patch.operation!=='create'&&!old)throw new Error('Unknown topic update target');
  if(patch.operation==='update'&&old.lifecycle!=='active')throw new Error('Closed topics require an explicit resume operation');
  if(patch.operation==='resume'&&old.lifecycle==='active')throw new Error('Topic is already active');
  if(['pause','complete','cancel'].includes(patch.operation)&&old.lifecycle!=='active')throw new Error('Only an active topic may be closed');
  const purposeChanged=patch.operation==='create'||PURPOSE_FIELDS.some(field=>patch[field]!==undefined&&JSON.stringify(patch[field])!==JSON.stringify(old?.[field]));
  const lifecycleChanged=patch.operation!=='update';
  const qqCompletion=patch.operation==='complete'&&options.origin==='qq_observation';
  const privateChange=purposeChanged||lifecycleChanged&&!qqCompletion;
  const observationsChanged=OBSERVATION_FIELDS.some(field=>patch[field]!==undefined);
  const nonemptyObservations=OBSERVATION_FIELDS.some(field=>patch[field]!==undefined&&(typeof patch[field]==='string'?!!patch[field].trim():patch[field].length>0));
  const privateTaskChange=!privateChange&&observationsChanged&&PRIVATE_ORIGINS.has(options.origin)&&!!patch.purposeSourceIds?.length;
  const privateControlChange=privateChange||privateTaskChange;
  let purposeRevisions={},observationRevisions={},lifecycleRevisions={};
  if(privateControlChange){
    const current=currentActor(record,live,options);
    if(!patch.intentQuote?.trim()||!current.text.includes(patch.intentQuote))throw new Error('Topic intentQuote must be an exact excerpt of the current private user source');
    if(!patch.purposeSourceIds?.includes(options.currentSourceId)||patch.purposeSourceIds.some(id=>!directPrivate(live.get(id))))throw new Error('Topic purpose evidence must include the current direct private user source');
    purposeRevisions=revisions(patch.purposeSourceIds);
  }else if(patch.purposeSourceIds?.length||patch.intentQuote!==undefined){
    throw new Error('Observation-only updates cannot alter topic purpose evidence');
  }
  let observationIds=patch.observationSourceIds||[],observationAuthorities={},clearBinding=null;
  if(observationsChanged||qqCompletion){
    const hasClears=OBSERVATION_FIELDS.some(field=>patch[field]!==undefined&&(typeof patch[field]==='string'?!patch[field].trim():!patch[field].length));
    if(hasClears&&PRIVATE_ORIGINS.has(options.origin)){
      currentActor(record,live,options);
      clearBinding={sourceIds:[options.currentSourceId],sourceRevisions:revisions([options.currentSourceId])};
    }
    if(!observationIds.length&&!qqCompletion&&nonemptyObservations){
      // Private planning stages and uncertainty are user task controls. They
      // need no invented QQ message when current private intent is verified.
      if(!privateControlChange||!PRIVATE_ORIGINS.has(options.origin)||patch.progress?.length)throw new Error('Nonempty topic progress requires explicit observation evidence; private task state requires current private intent');
      observationIds=patch.purposeSourceIds;observationRevisions=purposeRevisions;
    }else if(observationIds.length||qqCompletion)observationRevisions=revisions(observationIds);
    if(options.origin==='qq_observation'){
      if(!observationIds.includes(options.currentSourceId)||observationIds.some(id=>live.get(id)?.type!=='qq'))throw new Error('QQ observations require current actual QQ evidence');
      if(purposeChanged)throw new Error('QQ evidence cannot rewrite private purpose');
      if(hasClears)clearBinding={sourceIds:[options.currentSourceId],sourceRevisions:revisions([options.currentSourceId])};
    }else if(!PRIVATE_ORIGINS.has(options.origin))throw new Error('Unknown topic observation origin');
    if(patch.progress?.length&&sourceClosure(live,observationIds).some(source=>isLocalFeedback(source)||source.kind==='feedback_continue'))throw new Error('Local feedback and its copies cannot establish external topic progress');
    if(qqCompletion)lifecycleRevisions=observationRevisions;
    const privateTaskSources=observationIds.length&&observationIds.every(id=>directPrivate(live.get(id)));
    if(privateTaskSources&&['stage','unknowns'].some(field=>patch[field]!==undefined&&(typeof patch[field]==='string'?!!patch[field].trim():patch[field].length))){
      currentActor(record,live,options);
      if(!observationIds.includes(options.currentSourceId))throw new Error('Private task state requires the current private actor source');
    }
    observationAuthorities={stage:privateTaskSources?'private_task_state':'source_backed_observation',unknowns:privateTaskSources?'private_task_state':'source_backed_observation',progress:privateTaskSources?'user_reported_progress':'source_backed_observation'};
    const at=observationIds.map(id=>live.get(id).at).sort().at(-1);
    if((qqCompletion||patch.progress?.length||observationIds.some(id=>live.get(id)?.type==='qq'))&&old?.lastObservationAt&&at<old.lastObservationAt)throw Object.assign(new Error('Older backfill cannot replace later topic progress'),{code:'topic_proposal_inapplicable',field:'topicPatch.observationSourceIds'});
  }else if(patch.observationSourceIds?.length)throw new Error('Topic evidence cannot be changed without an observation');
  const now=new Date().toISOString();
  let topic=old?{...old}:{id:randomUUID(),version:0,lifecycle:'active',objective:'',direction:'',constraints:[],interpretationStatus:'tentative',stage:'',progress:[],unknowns:[],purposeSourceIds:[],purposeSourceRevisions:{},observationSourceIds:[],observationSourceRevisions:{},lifecycleSourceIds:[],lifecycleSourceRevisions:{},createdAt:now};
  for(const field of [...PURPOSE_FIELDS,...OBSERVATION_FIELDS])if(patch[field]!==undefined)topic[field]=patch[field];
  if(privateControlChange){
    // Replacing a direction must not pin every obsolete correction forever.
    // Unchanged fields retain their support; changed fields take current support.
    bindFields(topic,'purpose',[...PURPOSE_FIELDS,'intent'],{...patch,intent:true},patch.purposeSourceIds,purposeRevisions);
    topic.intentQuote=patch.intentQuote;topic.intentSourceId=options.currentSourceId;
  }
  if(observationsChanged){
    bindFields(topic,'observation',OBSERVATION_FIELDS,patch,observationIds,observationRevisions,observationAuthorities,clearBinding);
  }
  if(qqCompletion||nonemptyObservations&&(patch.progress?.length||observationIds.some(id=>live.get(id)?.type==='qq')))topic.lastObservationAt=observationIds.map(id=>live.get(id).at).sort().at(-1);
  const lifecycle={create:'active',resume:'active',pause:'paused',complete:'completed',cancel:'cancelled'}[patch.operation];
  if(lifecycle){
    topic.lifecycle=lifecycle;
    topic.lifecycleSourceIds=qqCompletion?[...patch.observationSourceIds]:[];
    topic.lifecycleSourceRevisions=lifecycleRevisions;topic.lifecycleEvidenceStatus='valid';
  }
  const comparable=value=>JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key])=>!['version','updatedAt','lastRequestId','origin'].includes(key))));
  aggregate(topic);
  if(old&&comparable(old)===comparable(topic))return {topics,changes:0,topicId:old.id};
  topic.version++;topic.updatedAt=now;topic.lastRequestId=options.requestId;topic.origin=options.origin;
  let items=topics.items.filter(item=>item.id!==topic.id).map(item=>({...item}));
  if(topic.lifecycle==='active')items=items.map(item=>item.lifecycle==='active'?aggregate({...item,lifecycle:'paused',version:item.version+1,updatedAt:now,lastRequestId:options.requestId,origin:options.origin,lifecycleSourceIds:[...patch.purposeSourceIds],lifecycleSourceRevisions:{...purposeRevisions},lifecycleEvidenceStatus:'replaced_by_current_private_intent'}):item);
  items.push(topic);
  const next=bound({version:topics.version+1,activeId:topic.lifecycle==='active'?topic.id:topics.activeId===topic.id?null:topics.activeId,items});
  return {topics:next,changes:1,topicId:topic.id,invalidateDiscussion:privateControlChange||lifecycleChanged||observationsChanged&&PRIVATE_ORIGINS.has(options.origin)};
}
module.exports={emptyTopics,pruneTopics,topicView,prepareTopicPatch,normalizeTopicPatch,TOPIC_LIMITS,TOPIC_PROTOCOL};
