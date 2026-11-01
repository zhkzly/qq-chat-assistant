'use strict';
const {editable,parseDeliveryBlocker,clarificationBody}=require('./request-delivery.cjs');
const {validationError}=require('./validation-issues.cjs');
const {parseWholeAnswer}=require('./whole-answer-fidelity.cjs');
// Operation choices and the lookup selector allowlist are compiled from the
// versioned wire contract (src/contracts/assistant-result.contract.json +
// lookup.contract.json), so this module cannot drift from the deep validator
// or the prompt protocol line.
const {compile}=require('./wire/compile.cjs');
const {lookupFieldNames}=require('./wire/lookup.cjs');

const assistantContract=compile('assistant-result').contract;
const VERSION='primary-operation-v2';
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const clone=value=>value===undefined?undefined:structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const excluded=new Set(['draft','memory','discussion_compaction','plain_help_recovery','plain_draft_recovery','fidelity_check']);
const auxiliary=['methodIds','actions','stateReview','statePatch','topicPatch','relationshipPatch','experienceProposals','expressionOptions'];
const lookupFields=new Set(lookupFieldNames);
const receipts=new WeakMap();
const fail=(field,code,message)=>validationError(field,code,`${field}: ${message}`);

function projectPrimaryOperationInput(payload){
 const original=payload?.originalInput||payload;
 if(!plain(payload)||!plain(original)||excluded.has(payload.purpose)||excluded.has(original.purpose))return payload;
 const projected=clone(payload),input=projected.originalInput||projected,policy=original.requestDeliveryPolicy;
 delete input.requestDeliveryPolicy;
 if(input.taskContext)delete input.taskContext.draftControlPolicy;
 // Method output-kind metadata belongs to the canonical client contract,
 // not the new primary producer language. Source/record kinds stay intact.
 for(const card of input.methodCards||[])delete card.outputKinds;
 input.operationProtocol={version:VERSION,...(editable(policy?.obligation)?{requiredArtifact:'message'}:{}),...(policy?.lookupExhausted?{lookupExhausted:true}:{})};
 return projected;
}

function normalizePrimaryOperation(raw,payload={}){
 if(!plain(raw))throw fail('operation','primary_operation_shape_invalid','return one operation object');
 const operation=raw.operation;
 if(!assistantContract.operations.includes(operation))
  throw fail('operation','primary_operation_invalid','choose '+assistantContract.operations.slice(0,-1).join(', ')+' or '+assistantContract.operations.at(-1));
 const allowed=new Set(['operation']);
 if(operation==='advise'||operation==='lookup')allowed.add('text');
 for(const key of auxiliary)allowed.add(key);
 if(operation==='prepare_message')allowed.add('answer');
 // MQA consumption field (assistant-result contract + mqa-registry
 // arrangement-handling-v1): the arrangement disposition travels only with
 // message deliveries that adopted (or declined) a delivered arrangement.
 if(operation==='prepare_message')allowed.add('arrangementHandling');
 if(operation==='advise'||operation==='prepare_message'){allowed.add('materials');allowed.add('currentFacts');}
 if(operation==='prepare_message')allowed.add('editingReference');
 if(operation==='lookup'){allowed.add('lookup');allowed.add('continuation');}
 if(operation==='clarify')allowed.add('blocker');
 for(const key of Object.keys(raw))if(!allowed.has(key))
  throw fail(key,'primary_operation_inactive_payload',`${key} is not active for ${operation}; return only this operation's payload`);
 const hasText=own(raw,'text');
 if((operation==='advise'||hasText)&&(typeof raw.text!=='string'||!raw.text.trim()||raw.text.length>6000))
  throw fail('text','primary_operation_text_invalid','use nonempty private text of at most 6000 characters');
 if(own(raw,'currentFacts')&&(!Array.isArray(raw.currentFacts)||raw.currentFacts.length>8||raw.currentFacts.some(text=>typeof text!=='string'||!text.trim()||text.length>4000)))
  throw fail('currentFacts','current_fact_span_invalid','Use at most eight exact current human fact spans, only when used; instruction binding is not disclosure permission');
 if(Array.isArray(raw.materials)&&(raw.materials.length+(raw.currentFacts?.length||0)>8))
  throw fail('materials','answer_material_limit','currentFacts and materials together allow at most eight used private fact fragments; remove unused facts rather than changing their scope');
 if(operation==='lookup'){
  if(!plain(raw.lookup))throw fail('lookup','primary_operation_lookup_invalid','lookup requires a lookup object');
  for(const key of Object.keys(raw.lookup))if(!lookupFields.has(key))
   throw fail(`lookup.${key}`,'primary_operation_lookup_invalid','only lookup selectors are active');
  // B9: when this request already requires a message artifact, the only
  // legal continuation is prepare_message -- program knowledge, completed
  // here instead of failing the delivery and burning a repair call.
  const completed=require('./wire/rules.cjs').RULES['continuation-completion'].apply(raw,
   {requestState:{requiredArtifact:editable(payload.requestDeliveryPolicy?.obligation)}});
  if(completed)raw.continuation=completed.continuation;
  if(!['advise','prepare_message'].includes(raw.continuation))
   throw fail('continuation','primary_operation_continuation_invalid','declare advise or prepare_message as the lookup continuation');
 }
 const required=editable(payload.requestDeliveryPolicy?.obligation);
 if(required&&(operation==='advise'||operation==='lookup'&&raw.continuation==='advise'))
  throw fail(operation==='lookup'?'continuation':'operation','primary_operation_artifact_required','this current request still requires a message artifact; use prepare_message, lookup continuing prepare_message, or a necessary specific clarify blocker');
 if(operation==='lookup'&&payload.requestDeliveryPolicy?.lookupExhausted)
  throw fail('operation','primary_operation_lookup_exhausted','lookup allowance is exhausted; complete the continuation or use a necessary specific clarify blocker');
 const establishesMessage=operation==='prepare_message'||operation==='lookup'&&raw.continuation==='prepare_message';
 const messageRequired=required||establishesMessage;
 const state={operation,contractVersion:VERSION,...(operation==='lookup'?{continuation:raw.continuation}:{}),messageRequired,establishesMessage};
 if(operation==='prepare_message')state.answer=parseWholeAnswer(raw.answer);
 let value;
 if(operation==='clarify'){
  let blocker;
  try{
   if(!plain(raw.blocker))throw new Error('not a blocker object');
   blocker=parseDeliveryBlocker(raw.blocker,{kind:'question',text:clarificationBody(raw.blocker)});
  }catch{
   throw fail('blocker','primary_operation_blocker_invalid','provide kind, specific missing fact or permission, question, and optional why-only explanation');
  }
  state.blocker=blocker;
  value={kind:'question',text:clarificationBody(blocker),replyDisposition:'clarify'};
 }else{
  value={kind:'discussion',...(hasText?{text:raw.text}:{})};
  if(operation==='prepare_message')value.editingReference=clone(raw.editingReference);
  if(operation==='prepare_message'&&own(raw,'arrangementHandling'))value.arrangementHandling=clone(raw.arrangementHandling);
  if((operation==='advise'||operation==='prepare_message')&&own(raw,'materials'))value.materials=clone(raw.materials);
  if((operation==='advise'||operation==='prepare_message')&&own(raw,'currentFacts'))value.currentFacts=clone(raw.currentFacts);
  if(operation==='lookup')value.lookup=clone(raw.lookup);
 }
 // Shared proposals are not an alternate core branch. The existing domain
 // validators still decide authorization and staging for every operation.
 for(const key of auxiliary)if(own(raw,key))value[key]=clone(raw[key]);
 if(payload.requestDeliveryPolicy)value.requestDelivery={mode:messageRequired?'editable_message':'private_help',...(operation==='clarify'&&messageRequired?{blocker:clone(state.blocker)}:{})};
 return {value,state:freeze(state)};
}

function rememberPrimaryOperation(result,state,snapshot){
 if(!result||typeof result!=='object'||!state)return result;
 const previous=receipts.get(result);
 if(previous&&(previous.snapshot!==snapshot||JSON.stringify(previous.state)!==JSON.stringify(state)))
  throw fail('operation','primary_operation_binding_invalid','canonical operation cannot be rebound to another HTTP result');
 receipts.set(result,Object.freeze({snapshot,state:freeze(clone(state))}));return result;
}
function primaryOperationFor(result){return result&&typeof result==='object'?receipts.get(result)?.state:undefined;}

function operationValidationFeedback(error,state){
 if(!error||typeof error!=='object')return error;
 const translate=issue=>{
  if(!/^requestDelivery(?:\.|$)/.test(issue.path))return issue;
  const binding=/sourceId\/quote|CURRENT intent|unsupported policy/.test(issue.message);
  return {path:'operation',code:binding?'primary_operation_binding_invalid':state?.messageRequired?'primary_operation_artifact_required':'primary_operation_invalid_payload',message:binding
   ?'The captured current request binding is unavailable; do not reconstruct its identity or original text.'
   :state?.messageRequired?'A message artifact is still required for this current request. Return prepare_message, lookup with continuation:prepare_message, or a necessary specific clarify blocker.'
   :'Return only the payload active for the selected operation; use clarify for a specific missing fact or permission.'};
 };
 const scalar=typeof error.field==='string'&&/^requestDelivery(?:\.|$)/.test(error.field)
  ?translate({path:error.field,code:error.code,message:String(error.message)}):undefined;
 if(Array.isArray(error.issues)){
  const mapped=error.issues.map(translate);
  if(mapped.some((item,index)=>item!==error.issues[index])){
   error.issues=[...new Map(mapped.map(item=>[JSON.stringify(item),item])).values()].sort((a,b)=>{const left=JSON.stringify(a),right=JSON.stringify(b);return left<right?-1:left>right?1:0;});
   error.message=error.issues.map(item=>`${item.path} [${item.code}] ${item.message}`).join('\n');
  }
 }
 if(scalar){
  error.field=scalar.path;error.code=scalar.code;if(!error.issues)error.message=scalar.message;
 }
 return error;
}

module.exports={VERSION,projectPrimaryOperationInput,normalizePrimaryOperation,rememberPrimaryOperation,primaryOperationFor,operationValidationFeedback};
