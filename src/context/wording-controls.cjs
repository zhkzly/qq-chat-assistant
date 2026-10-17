'use strict';
const {sourceClosure,assertPreferenceAuthority}=require('../provenance.cjs');
const {sameScopeIfPresent}=require('./source-snapshot.cjs');
const reportMarker=/(?:她|他|对方|朋友|同事)(?:说|希望|喜欢|偏好|要求)|转述|引用|原话/u;
const thirdPartyReport=text=>reportMarker.test(String(text||''));
function preferenceEvidenceText(text){
 const value=String(text||''),report=value.search(reportMarker);if(report<0)return value;
 const reason=value.search(/因为|原因|担心|害怕|我怕|为了让/u);
 // A report owns its later clauses, even across commas. Only an earlier,
 // separate direct instruction can survive a private causal explanation.
 return reason>=0&&reason<report?value.slice(0,reason):'';
}
function expressionClause(text){
 if(thirdPartyReport(text))return false;
 return /回复|回话|回答|说话|表达|措辞|语气|口吻|emoji|表情|书面腔|点评员|评论员|客服/i.test(text)||
  /^(?:(?:以后|今后|请|尽量|优先|要|用|采用|保持|不要|别|少用)\s*)*(?:短句|简短|简洁|自然|口语|含蓄|委婉|轻松|直接)(?:一点|一些|些|点)?$/u.test(text.trim());
}
// Only normalized expression controls cross the private-to-wording boundary.
function rawWordingControls(preferences=[],responsePreference=''){
 const items=new Map();
 const add=(text,sourceIds)=>{const item=items.get(text)||{text,sourceIds:[]};for(const id of sourceIds)if(typeof id==='string'&&!item.sourceIds.includes(id))item.sourceIds.push(id);items.set(text,item);};
 const inputs=[...preferences.map(item=>({text:item.text,sourceIds:item.sourceIds||[item.sourceId],strictExpression:item.strictExpression})),{text:responsePreference,sourceIds:['responsePreference']}];
 for(const input of inputs)for(const clause of String(input.text||'').split(/[，,。；;\n]/u)){
  if(/因为|原因|担心|害怕|我怕|为了让|PRIVATE_|仅供私下|不要告诉|别告诉|如果|除非|只有|时候|有时|偶尔/i.test(clause))continue;
  if(input.strictExpression&&!expressionClause(clause))continue;
  if(/短句|简短|简洁|少写|别.{0,5}长篇|不要.{0,5}长篇/.test(clause)&&!/(?:不要|不用|不想|别).{0,3}(?:短句|简短|简洁)/.test(clause))add('用简短句子，保留这次实际想表达的内容。',input.sourceIds);
  if(/自然|口语|贴近.{0,8}说话|像我.{0,8}说话|我的说话方式/.test(clause)&&!/(?:不要|不用|不想|别).{0,3}(?:自然|口语|像我|贴近)/.test(clause))add('采用自然口语，贴近用户实际 QQ 表达习惯。',input.sourceIds);
  if(/(?:不要|不用|不想|别|避免).{0,12}(?:点评员|评论员|客服|书面腔|说教|评价式)/.test(clause))add('避免点评和说教式措辞，用平常聊天的语气。',input.sourceIds);
  if(/(?:不要|别|不想|避免)(?:说得|写得|显得|表达得)?(?:太|那么|这么|过于)?(?:直白|直接|露骨)/u.test(clause))add('表达含蓄，保持用户此次已确认的意思。',input.sourceIds);
  for(const [pattern,text]of [[/含蓄|委婉/,'表达含蓄，保持用户此次已确认的意思。'],[/轻松|随意一点/,'语气轻松，不强加亲密程度。'],[/直接一点|直说|直接表达/,'直接表达用户此次已确认的意思。']])if(pattern.test(clause)&&!new RegExp(`(?:不要|不用|不想|别).{0,3}(?:${pattern.source})`).test(clause))add(text,input.sourceIds);
  if(/(?:不要|不用|别|禁止).{0,6}(?:emoji|表情)|(?:emoji|表情).{0,4}(?:不要|不用|别用)/i.test(clause))add('不额外添加 emoji。',input.sourceIds);
  else if(/(?:少用|少加).{0,4}(?:emoji|表情)|(?:emoji|表情).{0,5}(?:少用|少加|别太多)/i.test(clause))add('少用 emoji，仅在符合实际语气时使用。',input.sourceIds);
  else if(/(?:允许|可以|可用|用点|加点|喜欢).{0,5}(?:emoji|表情)/i.test(clause))add('可以自然地使用少量 emoji，无需强加。',input.sourceIds);
  if(/(?:不要|不用|别|避免).{0,10}(?:反问|追问|连问|尾问|查户口)/.test(clause))add('不机械追加尾问或连续追问；保留用户本来想问的具体内容。',input.sourceIds);
 }
 return {version:1,authority:'expression_control_not_outbound_material',items:[...items.values()].slice(0,12)};
}
// Resolve only the existing, identifiable dimensions. A clear removes a default;
// it does not manufacture the opposite style or interpret the communication act.
function dimension(text){
 if(text.startsWith('用简短句子'))return 'length';
 if(text.startsWith('表达含蓄')||text.startsWith('直接表达用户'))return 'directness';
 if(/emoji/.test(text))return 'emoji';
 return null;
}
function currentExpressionInstruction(clause){
 const value=clause.trim().replace(/^(?:(?:这次|这轮|这句|这条|本次|本轮|现在|以后|今后|请|尽量|也|还是|再|就)\s*)+/u,'')
  .replace(/^(?:(?:回复|回话|回答)(?:她|对方)?|表达|措辞|语气|口吻)(?:要|得)?\s*/u,'');
 // Deliberately bounded imperative forms: a description of her expression or
 // the user's day is material, not authority to change the user's style.
 return /^(?:(?:不要|不用|不想|别|避免|用|采用|保持)(?:说得|写得|显得|表达得)?(?:太|那么|这么|过于)?)*(?:用)?(?:短句|简短|简洁|含蓄|委婉|直白|直接|露骨|直说|直接表达)(?:一点|一些|些|点)?(?:就好|即可)?$/u.test(value)||
  /^(?:不要|不用|别|禁止|少用|少加|允许|可以|可用|用点|加点|喜欢).{0,5}(?:emoji|表情)(?:就好|即可)?$/iu.test(value)||
  /^(?:emoji|表情).{0,5}(?:不要|不用|别用|少用|少加|别太多)$/iu.test(value);
}
function expressionChanges(text,sourceIds,currentInstruction=false){
 const changes=new Map();
 let safe=String(text||'').replace(/^[ \t]*>.*$/gmu,'').replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`/gu,'');
 if(/如果|除非|只有|时候|有时|偶尔/u.test(safe))return changes;
 safe=preferenceEvidenceText(safe).split(/因为|原因|担心|害怕|我怕|为了让|PRIVATE_|仅供私下|不要告诉|别告诉/u)[0];
 for(const clause of safe.split(/[，,。；;\n]/u)){
  if(currentInstruction&&!currentExpressionInstruction(clause))continue;
  const found=new Set();
  for(const item of rawWordingControls([{text:clause,sourceIds}]).items){const key=dimension(item.text);if(key){changes.set(key,item);found.add(key);}}
  if(!found.has('length')&&/(?:不要|不用|不想|别).{0,3}(?:短句|简短|简洁)/u.test(clause))changes.set('length',null);
  if(!found.has('directness')&&/(?:不要|不用|不想|别).{0,3}(?:含蓄|委婉|直接一点|直说|直接表达)/u.test(clause))changes.set('directness',null);
 }
 return changes;
}
function resolveControls(items,changes){
 const merged=new Map();
 for(const item of [...items.filter(item=>!changes.has(dimension(item.text))),...[...changes.values()].filter(Boolean)]){
  const previous=merged.get(item.text)||{text:item.text,sourceIds:[]};
  for(const id of item.sourceIds||[])if(typeof id==='string'&&!previous.sourceIds.includes(id))previous.sourceIds.push(id);
  merged.set(item.text,previous);
 }
 return [...merged.values()].slice(0,12);
}
function wordingControls(preferences=[],responsePreference=''){
 const controls=rawWordingControls(preferences,responsePreference);
 controls.items=resolveControls(controls.items,expressionChanges(responsePreference,['responsePreference']));
 return controls;
}
function wordingControlsForContext(prepared,info={}){
 const payload=prepared.payload,scope=info.scope||prepared.manifest.scope,asOf=Date.parse(payload.asOf);
 const live=new Map((info.availableSources||info.store?.memorySources(scope)||prepared.fullAvailableSources||payload.sources).map(source=>[source.id,source]));
 const inventory=info.coreMemory||info.store?._memoryRecords(scope),currentRecords=Array.isArray(inventory)?new Map(inventory.map(record=>[record.id,record])):null;
 const expected=new Map([...Object.entries(prepared.manifest.sourceRevisions||{}),...(prepared.manifest.contextSelection?.coreSourceRefs||[]).map(ref=>[ref.sourceId,ref.revision])]);
 const supported=ids=>{
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!expected.has(id)||live.get(id)?.revision!==expected.get(id)))return null;
  try{const closure=sourceClosure(live,ids);return closure.every(source=>!source.deleted&&!source.excluded&&source.use!=='disabled'&&sameScopeIfPresent(source,scope))?closure:null;}catch{return null;}
 };
 const preferences=[];
 for(const preference of payload.preferences||[]){
  const id=preference.sourceId,source=live.get(id);
  if(source?.type==='note'&&source.kind==='preference'&&supported([id]))preferences.push({text:source.text,sourceIds:[id]});
 }
 const preferenceRefs=[],coreControls=[];
 for(const record of payload.coreMemory?.items||[]){
  // A caller supplying a live store must not replay a retired/replaced memory
  // from an otherwise unchanged prepared source snapshot.
  if(currentRecords&&currentRecords.get(record.id)?.version!==record.version)continue;
  const typed=record.subject!==undefined;
  const userPreference=typed?record.subject==='self'&&record.aspect==='stated_preference'&&record.lifecycle==='active'&&record.assertionKind==='stated'&&record.epistemicStatus==='supported':
   record.kind==='preference'&&record.status==='active'&&record.certainty==='stated';
  if(!userPreference||record.reviewComplete!==true||record.use==='disabled'||record.context||/如果|除非|只有|时候|有时|偶尔/.test(record.text)||
    ['inactive','needs_review','expired','not_yet_valid'].includes(record.currentApplicability||record.applicability)||
    record.validFrom&&Date.parse(record.validFrom)>asOf||record.validUntil&&Date.parse(record.validUntil)<asOf)continue;
  const evidence=supported(record.sourceIds);if(!evidence)continue;
  // Missing item.subject is resolved only from unambiguous user-owned roots.
  // A contact statement or ordinary material note cannot establish user style.
  const userOwned=source=>(source.type==='note'&&source.kind==='preference'||source.role==='user'&&
   (source.type==='private'||source.type==='qq'&&source.direction==='outgoing'||source.type==='feedback'&&source.kind==='recurring_authorized'));
  if(!evidence.every(userOwned))continue;
  try{assertPreferenceAuthority(live,record.sourceIds);}catch{continue;}
  const supportedControls=new Set(wordingControls(evidence.map(source=>({text:preferenceEvidenceText(source.text),sourceIds:[source.id],strictExpression:true}))).items.map(item=>item.text));
  const safe=wordingControls([{text:record.text,sourceIds:record.sourceIds,strictExpression:true}]).items.filter(item=>supportedControls.has(item.text));
  coreControls.push(...safe);
  if(safe.length)preferenceRefs.push({id:record.id,version:record.version,sourceIds:[...record.sourceIds]});
 }
 const controls=wordingControls(preferences,payload.taskContext?.responsePreference);
 // Core controls are already normalized. Re-parsing their prose can lose a
 // negative instruction (for example "do not add emoji"). Merge operations.
 const changes=expressionChanges(payload.taskContext?.responsePreference,['responsePreference']);
 const id=payload.intentAuthority?.sourceId||payload.userRequest?.sourceId;
 const source=live.get(id);
 const current=payload.generationOrigin!=='qq_observation'&&source?.role==='user'&&
  (source.type==='private'&&!['feedback','feedback_ref','feedback_continue'].includes(source.kind)||
   source.type==='feedback'&&source.canonicalFeedbackId&&id===`private:feedback-${source.canonicalFeedbackId}`)&&supported([id]);
 const localChanges=current?expressionChanges(source.text,[id],true):new Map();
 for(const [key,item]of localChanges)changes.set(key,item);
 controls.items=resolveControls([...controls.items,...coreControls],changes);
 const plan=info.expressionPlan||{},presentation={
  ...(typeof plan.askFollowup==='boolean'?{askFollowup:plan.askFollowup}:{}),
  ...(typeof plan.useEmoji==='boolean'?{useEmoji:plan.useEmoji}:{})};
 if(controls.items.some(item=>item.text==='不额外添加 emoji。'))presentation.useEmoji=false;
 const style=changes.has('length')&&changes.get('length')===null&&plan.style==='short'?'natural':plan.style;
 // A clear has no replacement item, but its authority still belongs in CAS.
 const sourceIds=[...new Set([...controls.items.flatMap(item=>item.sourceIds),...(localChanges.size?[id]:[])])].filter(id=>expected.has(id)&&live.get(id)?.revision===expected.get(id));
 return {controls,sourceRefs:sourceIds.map(id=>({sourceId:id,revision:expected.get(id)})),preferenceRefs:preferenceRefs.filter(ref=>ref.sourceIds.some(id=>sourceIds.includes(id))),presentation,style};
}
module.exports={wordingControls,wordingControlsForContext};
