'use strict';
// The planner judges meaning in complete source context. This resolver checks
// the evidence handoff; a matching string alone is not a semantic permission.
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const usable=source=>source&&!source.deleted&&!source.excluded&&source.use!=='disabled';
const originalUser=source=>usable(source)&&source.role==='user'&&['private','feedback'].includes(source.type)&&source.kind!=='feedback_continue';
const DRAFT_MATERIAL_PROTOCOL='旧私下quote附authorization:{permission:{sourceId,text},referent:{sourceId,text}}。permission取用户愿向当前联系人分享此事的原话，referent逐字取素材sourceId且包含quote。按完整上下文、指代、已满足条件及最新限制判断；转述、引用、否定、假设、未满足条件不授权，不将“这些”移给别的材料。同源逐片分开判断；商量进guidance。撤回优先，旧permission为historicalOnly时先lookup/clarification；遗漏既非撤回也非许可。selectedOption限其原素材，authorizationQuote/生成回答不授全局许可；不明私下核对，明确分享/邀请可用。';
const MATERIAL_POLICY={version:1};
function resolveDraftMaterial(payload,plan,{restrictions=payload.privateRestrictions||[]}={}){
 if(payload.draftMaterialPolicy&&payload.draftMaterialPolicy.version!==1)throw new Error('Unsupported draft material authorization policy');
 const byId=new Map((payload.sources||[]).map(source=>[source.id,source]));
 const restricted=restrictions.map(item=>({...item,text:item.text||byId.get(item.sourceId)?.text}));
 const optionRef=payload.selectedOption||plan?.option;
 const option=optionRef&&(payload.expressionOptions||[]).find(item=>item.turnId===optionRef.turnId&&item.index===optionRef.index);
 if(optionRef&&!option)throw new Error('先前选择的方向已变化，请重新选择');
 if(option&&!Array.isArray(option.quotes))throw new Error('已选表达的原始素材已变化，请重新选择');
 // A model can resolve a natural-language option reference, but that selection
 // is not a UI authorization. Reattach only its exact fragment decisions.
 const planned=option?option.quotes.map(quote=>{
  const decision=Array.isArray(plan?.quotes)&&plan.quotes.find(item=>item.sourceId===quote.sourceId&&item.text===quote.text);
  const {authorization,...material}=quote;
  return {...material,...(decision?.authorization?{authorization:decision.authorization}:{})};
 }):plan?.quotes;
 if(!plan||!Array.isArray(planned)||planned.length>8||!planned.length&&!(plan.intent==='reply'&&(payload.sources||[]).some(s=>s.type==='qq')))
  throw new Error('需要明确这次想表达的内容，才能组织草稿');
 const intentSourceId=payload.intentAuthority?.sourceId||payload.userRequest?.sourceId;
 const allowed=new Set([payload.userRequest?.sourceId,intentSourceId,...(payload.allowedMaterialIds||payload.selectedMaterialIds||[])]);
 const bindings=[],sourceIds=new Set();
 const reference=(ref,label)=>{
  const source=plain(ref)&&byId.get(ref.sourceId);
  if(!source||!usable(source)||Object.keys(ref).some(key=>!['sourceId','text'].includes(key))||typeof ref.text!=='string'||!ref.text.trim()||ref.text.length>4000||!source.text.includes(ref.text))
   throw new Error(`draftPlan.quotes.authorization.${label}: 披露依据必须逐字对应本次提供的原始来源`);
  return source;
 };
 const quotes=planned.map(q=>{
  const source=plain(q)&&byId.get(q.sourceId);
  if(!usable(source)||!['private','request','feedback','note','qq'].includes(source.type)||
   ['private','request','feedback'].includes(source.type)&&source.role!=='user'||typeof q.text!=='string'||!q.text.trim()||q.text.length>4000||!source.text.includes(q.text))
   throw new Error('拟表达内容未能对应本次明确请求或已选分享素材，请具体说明想说哪件事');
  if(restricted.some(r=>r.sourceId===q.sourceId||r.text?.length>2&&q.text.length>2&&(q.text.includes(r.text)||r.text.includes(q.text))))
   throw new Error('拟表达内容未能对应已选分享素材：这段内容仍标记为仅供私下讨论，请先明确更改它的分享范围');
  const selected=!!payload.selectedOption&&option?.quotes.some(item=>item.sourceId===q.sourceId&&item.text===q.text&&item.revision===source.revision);
  if(payload.selectedOption&&option&&!selected)throw new Error('已选表达的原始素材或版本已变化，请重新选择');
  if(q.authorization!==undefined){
   const auth=q.authorization;
   if(!plain(auth)||Object.keys(auth).some(key=>!['permission','referent'].includes(key)))throw new Error('draftPlan.quotes.authorization: use permission and referent original references');
   const permission=reference(auth.permission,'permission'),referent=reference(auth.referent,'referent');
   if(!originalUser(permission)||referent.id!==source.id||!auth.referent.text.includes(q.text))
    throw new Error('draftPlan.quotes.authorization.referent: 披露依据必须指向这一素材片段，不能将其他材料的许可转移过来');
   if(permission.id!==intentSourceId&&permission.historicalOnly)
    throw new Error('披露依据的后续私下来源未完整提供；请检索核对后续限制或由用户明确本次分享范围');
   sourceIds.add(permission.id);sourceIds.add(referent.id);
   bindings.push({material:{sourceId:source.id,text:q.text,revision:source.revision},
    permission:{sourceId:permission.id,text:auth.permission.text,revision:permission.revision},
    referent:{sourceId:referent.id,text:auth.referent.text,revision:referent.revision},intentSourceId,
    authority:'model_interpreted_original_user_permission_not_a_persistent_grant'});
  }else if(!allowed.has(source.id)&&source.type!=='qq'&&!selected){
   throw new Error('draftPlan.quotes.authorization: 拟表达内容未能对应本次明确请求或已选分享素材；旧私下素材需要逐片段的披露依据和material referent，不可用全局authorizationQuote代替');
  }
  sourceIds.add(source.id);
  return {sourceId:source.id,text:q.text};
 });
 return {quotes,sourceIds:[...sourceIds],bindings};
}
function assertDraftSourcesCurrent(prepared,ids,info){
 const current=info.availableSources||info.store?.memorySources(info.scope);
 if(!current)return;
 const live=new Map(current.map(source=>[source.id,source]));
 for(const id of ids){
  const source=live.get(id),expected=prepared.manifest.sourceRevisions[id];
  if(id.startsWith('request:'))continue;
  if(!usable(source)||source.revision!==expected||source.scope&&typeof source.scope==='object'&&
   ['accountUid','accountUin','peerUid','peerUin'].some(key=>source.scope[key]!==info.scope[key]))throw new Error('拟表达素材或披露依据的来源版本已变化，请按当前资料重新确认');
 }
}
module.exports={MATERIAL_POLICY,DRAFT_MATERIAL_PROTOCOL,resolveDraftMaterial,assertDraftSourcesCurrent};
