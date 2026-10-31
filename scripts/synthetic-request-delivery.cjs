'use strict';
// Synthetic producer wire compatibility only; no semantic intent inference.
function withRequestDelivery(value,payload){
 if(!payload?.requestDeliveryPolicy||payload.purpose==='draft'||!value||typeof value!=='object'||Array.isArray(value)||value.requestDelivery||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return value;
 const sourceId=payload.intentAuthority?.sourceId||payload.userRequest?.sourceId,source=payload.sources?.find(s=>s.id===sourceId);
 if(!source)return value;
 const obligation=payload.requestDeliveryPolicy.obligation;
 const editable=!!value.draftPlan||!!obligation;
 const question=value.draftPlan?.clarification;
 return {...value,requestDelivery:{mode:obligation?.mode||(editable?'editable_message':'private_help'),...(!payload.primaryReferenceProtocol?{sourceId,quote:source.text.slice(0,1000)}:{}),
  ...(question?{blocker:{kind:'missing_fact',missing:question,question}}:{})}};
}
// Explicit opt-in in positive synthetic producers, never the live transport or
// a global response upgrader. A current statement is a candidate, not a grant.
function withCurrentStatementAuthority(value,payload){
 if(!payload.primaryReferenceProtocol||!value?.draftPlan?.quotes?.length)return value;
 if(payload.currentPermission&&payload.userRequest?.sourceId===payload.intentAuthority?.sourceId)return value;
 const id=payload.intentAuthority?.sourceId,source=payload.sources?.find(item=>item.id===id);
 if(!source||source.role!=='user'||!['private','feedback'].includes(source.type)||['user_control','feedback_continue'].includes(source.kind))throw new Error('Synthetic positive statement requires an original current user source');
 const atoms=[],bounds=new Map();let offset=0,body='';
 for(const segment of source.segments){const start=offset;
  if(typeof segment.text==='string'){body+=segment.text;offset+=segment.text.length;}
  else for(const [boundary,part]of segment.parts){if(boundary)bounds.set(offset,boundary);body+=part;offset+=part.length;}
  if(segment.endBoundary)bounds.set(offset,segment.endBoundary);atoms.push({ref:segment.materialRef,start,end:offset});
 }
 const parents=[...atoms,...source.materialChoices.map(choice=>({ref:choice.materialRef,start:atoms.find(atom=>atom.ref===choice.from)?.start,end:atoms.find(atom=>atom.ref===choice.to)?.end}))];
 const whole=parents.find(parent=>parent.start===0&&parent.end===body.length),authority=source.authorityChoices?.originalUserStatementCandidates?.find(choice=>choice.materialRef===whole?.ref);
 return {...value,draftPlan:{...value.draftPlan,quotes:value.draftPlan.quotes.map(quote=>{
  if(quote.sourceId!==id||quote.authorization!==undefined)return quote;
  if(!authority||typeof quote.text!=='string'||!quote.text)throw new Error('Synthetic positive statement candidate is not offered');
  for(let start=body.indexOf(quote.text);start>=0;start=body.indexOf(quote.text,start+1)){
   const end=start+quote.text.length,exact=parents.find(parent=>parent.start===start&&parent.end===end),parent=parents.find(parent=>parent.start<=start&&parent.end>=end);
   const materialRef=exact?.ref||(parent&&bounds.get(start)&&bounds.get(end)?`${parent.ref}@${bounds.get(start)}:${bounds.get(end)}`:undefined);
   if(materialRef)return {materialRef,authorityRef:authority.authorityRef};
  }
  throw new Error('Synthetic positive fact has no exact offered selector');
 })}};
}
// Used only by explicit default synthetic producers, never custom negative
// responders or the live provider forwarding path.
function withPrimaryOperation(value,payload){
 if(!payload.operationProtocol||!value||typeof value!=='object'||Array.isArray(value)||Object.hasOwn(value,'operation')||Object.hasOwn(value,'continuation')||Object.hasOwn(value,'blocker'))return value;
 const delivery=value.requestDelivery;
 if(delivery&&Object.keys(delivery).some(key=>!['mode','blocker'].includes(key)))return value;
 if(value.kind!==undefined&&!['discussion','question','options','review','acknowledgment'].includes(value.kind))return value;
 if(delivery&&!['private_help','editable_message','both'].includes(delivery.mode))return value;
 const {kind,requestDelivery,replyDisposition,...fields}=value;
 if(replyDisposition!==undefined&&!['wait','clarify','unavailable'].includes(replyDisposition))return value;
 if(delivery?.mode==='private_help'&&value.draftPlan)return {operation:'advise',...fields};
 if(value.lookup)return {operation:'lookup',continuation:delivery?.mode==='private_help'?'advise':'prepare_message',...fields};
 const question=value.draftPlan?.clarification;
 if(delivery?.blocker||question){
  if(value.draftPlan&&Object.keys(value.draftPlan).some(key=>key!=='clarification'))return {operation:'clarify',...fields,blocker:delivery?.blocker};
  const {text,draftPlan,...aux}=fields;
  return {operation:'clarify',...aux,blocker:delivery?.blocker||{kind:'missing_fact',missing:question,question}};
 }
 if(value.draftPlan||delivery&&delivery.mode!=='private_help'){
  const {text,draftPlan,...answer}=fields;
  if(!draftPlan||typeof draftPlan!=='object'||Array.isArray(draftPlan))return {operation:'prepare_message',...answer,...(draftPlan!==undefined?{draftPlan}:{})};
  const currentFacts=[],materials=[],currentId=payload.intentAuthority?.sourceId;
  for(const quote of draftPlan.quotes||[]){
   if(quote?.sourceId===currentId&&typeof quote.text==='string'&&quote.text&&payload.userRequest?.text.includes(quote.text)){currentFacts.push(quote.text);continue;}
   const source=payload.sources?.find(source=>source.id===quote?.sourceId);
   if(source?.type==='qq'&&typeof quote.text==='string'&&quote.text&&source.text?.includes(quote.text))continue;
   materials.push(quote);
  }
  return {operation:'prepare_message',...answer,...(currentFacts.length?{currentFacts}:{}),...(materials.length?{materials}:{}),...(draftPlan.editingReference!==undefined?{editingReference:draftPlan.editingReference}:{})};
 }
 return {operation:'advise',...fields};
}
module.exports={withRequestDelivery,withCurrentStatementAuthority,withPrimaryOperation};
