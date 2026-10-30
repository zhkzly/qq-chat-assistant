'use strict';
const {redact}=require('../model.cjs');
const {discussionTurnFingerprint}=require('../discussion-compaction-store.cjs');
const {boundedSource}=require('./source-delivery.cjs');
const {bytes,pick}=require('./shared.cjs');
const BODY_VIEW='discussion-body-v1';
function discussionReadBody(turn,{store,scope}={}){
 if(store?.experiences&&turn.role==='assistant'){turn=store.experiences.projectGeneratedTurns(scope,[turn])[0];if(!turn)return {text:'',parts:[]};}
 const fields=[['text',turn.text],['discussionExplanation.text',turn.discussionExplanation?.text],
  ...(turn.suggestions||[]).map((item,index)=>[`suggestions[${index}].text`,item.text]),
  ...(turn.expressionOptions||[]).map((item,index)=>[`expressionOptions[${index}].label`,item.label])];
 const parts=[];let text='';
 for(const [field,value] of fields){
  if(typeof value!=='string'||!value)continue;
  text+=`${text?'\n\n':''}[${field}]\n`;const start=text.length;text+=redact(value);parts.push({field,start,end:text.length});
 }
 return {text,parts};
}
function projectDiscussionReads(items,{sources=new Map(),byteBudget=48000,store,scope}={}){
 const entries=[],omittedTurnIds=[];let used=0;
 const limit=Math.min(8000,Math.floor(byteBudget/4));
 const available=store?.experiences?store.experiences.projectGeneratedTurns(scope,items):items;
 for(const item of available){
  const {requestedOffset=0,requestedMaxChars=4000,...original}=item;
  if(!['user','assistant'].includes(original.role)||original.memoryExcluded)continue;
  if(original.role==='user'){
   const sourceId=`private:${original.id}`,source=sources.get(sourceId);
   const ref={id:original.id,originalTurnId:original.id,role:'user',kind:original.kind,at:original.createdAt,sourceId,sourceTextLocation:'sources',
    authority:'original_private_source_reference_not_new_permission',availability:source?(source.delivery?.status||'delivered'):'needs_lookup'};
   if(used+bytes(ref)>limit){omittedTurnIds.push(original.id);continue;}
   entries.push(ref);used+=bytes(ref);continue;
  }
  const body=discussionReadBody(original),revision=discussionTurnFingerprint(original);
  const source=boundedSource({id:original.id,revision,text:body.text},{start:requestedOffset,maxChars:requestedMaxChars,maxBytes:Math.min(4000,limit-used-900)});
  if(!source){omittedTurnIds.push(original.id);continue;}
  const start=source.delivery?.start||0,end=source.delivery?.end??body.text.length;
  const lookup={discussionTurnIds:[original.id],offset:end,maxChars:Math.min(8000,requestedMaxChars)};
  const entry={...pick(original,['id','role','kind','artifactRef','artifactAvailability']),originalTurnId:original.id,at:original.createdAt,turnFingerprint:revision,bodyView:BODY_VIEW,
   text:source.text,lookupHint:{bodyView:BODY_VIEW,offsetUnit:'utf16_redacted_discussion_body_v1'},authority:'generated_discussion_not_factual_evidence_or_outbound_authorization',
   delivery:{status:source.delivery?.status||'delivered',start,end,originalCharLength:body.text.length,offsetUnit:'utf16_redacted_discussion_body_v1',
    requestedRange:{offset:requestedOffset,maxChars:requestedMaxChars},continuationAvailable:end<body.text.length,lookup},
   deliveredFields:body.parts.filter(part=>part.end>start&&part.start<end).map(part=>({...part,coverage:part.start>=start&&part.end<=end?'complete':'partial'}))};
  if(used+bytes(entry)>limit){omittedTurnIds.push(original.id);continue;}
  entries.push(entry);used+=bytes(entry);
 }
 return {entries,omittedTurnIds,bodyView:BODY_VIEW,offsetUnit:'utf16_redacted_discussion_body_v1',byteLimit:limit};
}
module.exports={BODY_VIEW,discussionReadBody,projectDiscussionReads};
