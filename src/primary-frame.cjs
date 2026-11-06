'use strict';
const {PrimaryReferenceOwner}=require('./primary-reference-registry.cjs');
const {ValidationIssues,validationError}=require('./validation-issues.cjs');
const {parseRequestDelivery,editable}=require('./request-delivery.cjs');

// A foreground task already owns the source namespace. The independent span
// namespace shares that lifetime without storing bodies on the task owner.
const owners=new WeakMap();
function preparePrimaryFrame(payload,sourceOwner,{capturedSources,sourceRevisions}={}){
 const original=payload?.originalInput||payload;
 if(!original||['draft','memory','discussion_compaction','plain_help_recovery','plain_draft_recovery','fidelity_check'].includes(payload.purpose)||
  ['draft','memory','discussion_compaction'].includes(original.purpose))return undefined;
 let owner=owners.get(sourceOwner);
 if(!owner){owner=new PrimaryReferenceOwner(sourceOwner.taskBinding);owners.set(sourceOwner,owner);}
 return owner.preview(payload,{foreground:true,capturedSources,sourceRevisions});
}
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function compilePrimaryFrame(raw,snapshot,payload){
 if(!snapshot||snapshot.isCanonical(raw))return raw;
 if(!plain(raw))return raw;
 const value=structuredClone(raw),issues=new ValidationIssues();
 if(value.requestDelivery!==undefined){
  const delivery=issues.check('requestDelivery','primary_delivery_reference_invalid',()=>snapshot.currentDelivery(value.requestDelivery));
  if(delivery.ok)value.requestDelivery=delivery.value;
 }
 const quote=(item,path)=>{
  if(!plain(item)||Object.keys(item).some(key=>!['materialRef','authorityRef','factQuote','permissionQuote'].includes(key)))
   throw validationError(path,'primary_material_reference_shape',`${path}: choose only materialRef and authorityRef from this request; do not copy source text or legacy authorization fields`);
  if(typeof item.materialRef!=='string'||!item.materialRef)throw validationError(`${path}.materialRef`,'primary_material_reference_missing',`${path}.materialRef: choose a delivered material reference`);
  const material=snapshot.material(item.materialRef,`${path}.materialRef`,item.factQuote);
  // B9 executable repair: authorityRef selection for private material is a
  // semantic judgment (an ORIGINALUSERSTATEMENTCANDIDATE is not a grant), so
  // it is never auto-completed; but the failure must be repairable in ONE
  // round by copying, so the error quotes every applicable offered
  // authorityRef for this exact material instead of a generic complaint.
  const authorityRef=Object.hasOwn(item,'authorityRef')?item.authorityRef:snapshot.publicAuthority(material,`${path}.authorityRef`);
  if(typeof authorityRef!=='string'||!authorityRef){
   const candidates=snapshot.authorityCandidates(item.materialRef,material).map(authority=>authority.authorityRef);
   const error=validationError(`${path}.authorityRef`,'primary_authority_reference_missing',
    `${path}.authorityRef: private material requires an applicable offered authority; only exact public QQ material may omit it${candidates.length?`; 可照抄authorityRef: ${[...new Set(candidates)].join('、')}`:''}`);
   error.handles=[...new Set(candidates)];
   throw error;
  }
  const authorization=snapshot.authority(authorityRef,material,`${path}.authorityRef`,item.permissionQuote);
  return {sourceId:material.sourceId,text:material.text,...(authorization?{authorization}:{})};
 };
 const quotes=(items,path)=>{
  if(!Array.isArray(items))return items; // The shared parent-shape validator owns this error.
  return items.map((item,index)=>issues.check(`${path}[${index}]`,'primary_material_reference_invalid',()=>quote(item,`${path}[${index}]`)).value);
 };
 if(plain(value.draftPlan)){
  if(Object.hasOwn(value.draftPlan,'authorizationQuote'))issues.capture('draftPlan.authorizationQuote','primary_legacy_authorization_field',validationError('draftPlan.authorityRef','primary_legacy_authorization_field','Use each material choice\'s authorityRef; a global authorizationQuote is not supported'));
  if(value.draftPlan.quotes!==undefined)value.draftPlan.quotes=quotes(value.draftPlan.quotes,'draftPlan.quotes');
 }
 if(Array.isArray(value.expressionOptions))for(let index=0;index<value.expressionOptions.length;index++){
  const option=value.expressionOptions[index];
  if(plain(option)&&option.quotes!==undefined)option.quotes=quotes(option.quotes,`expressionOptions[${index}].quotes`);
 }
 if(value.materials!==undefined)value.materials=quotes(value.materials,'materials');
 try{issues.throwIfAny();}catch(error){
  // Reuse the existing delivery validator: only an already valid current
  // interpretation can carry the sticky same-task editable obligation.
  try{const delivery=parseRequestDelivery(value,payload);if(editable(delivery))error.requestDelivery=delivery;}catch(bound){if(editable(bound.requestDelivery))error.requestDelivery=bound.requestDelivery;}
  throw error;
 }
 return value;
}
function primaryValidationFeedback(error,snapshot){
 if(!snapshot||!error.issues)return error;
 const mapped=error.issues.map(issue=>{
  const match=/^((?:draftPlan|expressionOptions\[\d+\])\.quotes\[\d+\])(?:\.(authorization)(?:\..*)?)?$/.exec(issue.path);
  if(!match)return issue;
  const path=`${match[1]}.${match[2]?'authorityRef':'materialRef'}`;
  const message=issue.code==='draft_material_authorization_missing'
   ?'Choose an applicable offered authorityRef for this material; an original user statement candidate is not a grant. If context lacks permission, ask a specific private blocker.'
   :issue.message.split(issue.path).join(path);
  return {path,code:issue.code,message};
 });
 error.issues=[...new Map(mapped.map(issue=>[JSON.stringify(issue),issue])).values()].sort((a,b)=>{
  const left=JSON.stringify([a.path,a.code,a.message]),right=JSON.stringify([b.path,b.code,b.message]);return left<right?-1:left>right?1:0;
 });
 return error;
}
module.exports={preparePrimaryFrame,compilePrimaryFrame,primaryValidationFeedback};
