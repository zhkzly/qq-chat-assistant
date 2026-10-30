'use strict';
// Synthetic producer wire compatibility only; no semantic intent inference.
function withRequestDelivery(value,payload){
 if(!payload?.requestDeliveryPolicy||payload.purpose==='draft'||!value||typeof value!=='object'||Array.isArray(value)||value.requestDelivery||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return value;
 const sourceId=payload.intentAuthority?.sourceId||payload.userRequest?.sourceId,source=payload.sources?.find(s=>s.id===sourceId);
 if(!source)return value;
 const obligation=payload.requestDeliveryPolicy.obligation;
 const editable=!!value.draftPlan||!!obligation;
 const question=value.draftPlan?.clarification;
 return {...value,requestDelivery:{mode:obligation?.mode||(editable?'editable_message':'private_help'),sourceId,quote:source.text.slice(0,1000),
  ...(question?{blocker:{kind:'missing_fact',missing:question,question}}:{})}};
}
module.exports={withRequestDelivery};
