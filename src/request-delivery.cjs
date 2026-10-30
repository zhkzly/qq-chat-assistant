'use strict';
const {createHash}=require('node:crypto');

// This is a fallible, request-local interpretation, never durable intent,
// factual evidence, disclosure permission, or proof of semantic correctness.
const VERSION = 1;
const editable = delivery => ['editable_message','both'].includes(delivery?.mode);
function failure(message, delivery,field='requestDelivery') {
 const error=new Error(`requestDelivery: ${message}`);error.code='request_delivery_unfulfilled';error.field=field;
 if(delivery)error.requestDelivery=delivery;
 return error;
}
function parseDeliveryBlocker(blocker,value,delivery) {
 if(!blocker||typeof blocker!=='object'||Array.isArray(blocker)||Object.keys(blocker).some(key=>!['kind','missing','question'].includes(key))||
  !['missing_fact','missing_authorization'].includes(blocker.kind)||['missing','question'].some(key=>typeof blocker[key]!=='string'||!blocker[key].trim()||blocker[key].length>1000)||
  !(value.kind==='question'&&typeof value.text==='string'&&value.text.includes(blocker.question)||value.draftPlan?.clarification===blocker.question)||value.draftPlan&&!value.draftPlan.clarification||value.lookup||value.suggestions?.length)
  throw failure('a blocker must identify the specific missing fact/permission and a private question in kind:question/text',delivery);
 return {kind:blocker.kind,missing:blocker.missing,question:blocker.question};
}
// Rendering uses the structured question as the single display value. The
// unchanged shared validator still checks its complete blocker shape first.
function normalizeBlockerQuestion(value,rawResponse,diagnostics,purpose) {
 const blocker=purpose==='draft'?value?.deliveryBlocker:value?.requestDelivery?.blocker;
 if(value?.kind!=='question'||typeof value.text!=='string'||!value.text.trim()||value.text.length>6000||!blocker||value.text===blocker.question)return {value};
 const candidate={...value,text:blocker.question};
 try{parseDeliveryBlocker(blocker,candidate,value.requestDelivery);}catch{return {value};}
 const rendering={rawResponse:structuredClone(rawResponse),question:blocker.question,originalText:value.text};
 if(diagnostics)diagnostics.blockerRendering=rendering;
 return {value:candidate,explanation:{kind:'discussion',text:value.text}};
}
function blockerRenderingWitness(rendering) {
 if(!rendering)return undefined;
 const raw=typeof rendering.rawResponse==='string'?rendering.rawResponse:JSON.stringify(rendering.rawResponse);
 return {question:rendering.question,rawResponseSha256:createHash('sha256').update(raw).digest('hex')};
}
function validateTerminalDelivery(value,delivery) {
 if(!editable(delivery))return;
 const blocker=value.deliveryBlocker||value.requestDelivery?.blocker;
 if(blocker){parseDeliveryBlocker(blocker,value,delivery);return;}
 if(value.kind==='draft'&&Array.isArray(value.suggestions)&&value.suggestions.length&&value.suggestions.every(item=>typeof item.text==='string'&&item.text.trim()))return;
 throw failure('terminal editable-message delivery missing: return complete suggestions or a necessary specific private blocker; a plan, strategy, generic question or lookup is not a terminal result',delivery);
}
function parseRequestDelivery(value,payload) {
 if(!payload?.requestDeliveryPolicy)return undefined;
 const policy=payload.requestDeliveryPolicy;
 if(policy.version!==VERSION)throw failure('unsupported policy');
 const intentSourceId=payload.intentAuthority?.sourceId||payload.userRequest?.sourceId;
 const delivery=value?.requestDelivery;
 if(!delivery||typeof delivery!=='object'||Array.isArray(delivery)||Object.keys(delivery).some(key=>!['mode','sourceId','quote','blocker'].includes(key))||
  !['private_help','editable_message','both'].includes(delivery.mode))throw failure('required current-request interpretation is missing or invalid');
 const source=payload.sources?.find(item=>item.id===intentSourceId);
 if(delivery.sourceId!==intentSourceId||!source||source.role!=='user'||!['private','request','feedback'].includes(source.type)||source.deleted||source.excluded||source.use==='disabled'||
  typeof delivery.quote!=='string'||!delivery.quote.trim()||delivery.quote.length>1000||!source.text.includes(delivery.quote))
  throw failure('sourceId/quote must reference the CURRENT intent source, never older controls');
 const parsed={mode:delivery.mode,sourceId:delivery.sourceId,quote:delivery.quote};
 if(parsed.mode==='both'&&(!['discussion','question','options','review','acknowledgment'].includes(value.kind)||typeof value.text!=='string'||!value.text.trim()||value.text.length>6000))throw failure('both requires a readable private explanation as well as the editable-message path',parsed);
 if(editable(policy.obligation)&&!editable(parsed))throw failure('an already declared editable-message obligation cannot be downgraded during this request',policy.obligation);
 if(delivery.blocker!==undefined){
  if(!editable(parsed))throw failure('private_help cannot declare an editable-message blocker',parsed);
  parsed.blocker=parseDeliveryBlocker(delivery.blocker,value,parsed);
 }
 if(value.lookup&&editable(parsed)&&policy.lookupExhausted)throw failure('lookup limit reached; supply a source-bound plan or a necessary specific private blocker rather than another lookup',parsed);

 if(!editable(parsed)&&value.draftPlan)throw failure('private_help must stay private; choose both only when the current request also wants wording',parsed,'requestDelivery.mode');
 if(editable(parsed)&&!value.lookup&&(!value.draftPlan||value.draftPlan.clarification)&&!parsed.blocker)
  throw failure('editable message still missing: supply a source-bound draftPlan, an actual lookup, or a necessary specific private blocker; strategy alone is not fulfillment',parsed);
 return parsed;
}
function deliveryStatus(delivery,result,{restricted=false}={}) {
 if(!delivery)return undefined;
 if(result.lookup)return 'looking_up';
 if(result.deliveryBlocker||result.requestDelivery?.blocker||result.draftPlan?.clarification)return 'blocked';
 if(result.draftPlan)return 'planned';
 if(restricted)return result.kind==='draft'&&result.suggestions?.some(item=>item.text?.trim())?'delivered':'unfulfilled';
 return editable(delivery)?'unfulfilled':'private_help';
}
module.exports={VERSION,editable,parseRequestDelivery,parseDeliveryBlocker,normalizeBlockerQuestion,blockerRenderingWitness,validateTerminalDelivery,deliveryStatus};
