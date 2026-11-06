'use strict';
// Mechanical semantic projection of fields consumed by ui/app.js memory,
// relationship, notes, state and experience renderers. This is not DOM proof.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function literalMap(source,name,{optional=false}={}){
 const match=source.match(new RegExp('\\bconst '+name+'=(\\{[^;\\n]*\\});'));
 if(!match){if(optional)return null;throw Error(`Unsupported UI relationship literal: ${name}`);}
 const body=match[1].slice(1,-1),result={};let at=0;
 const pair=/\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*'([^'\\]*)'\s*(?:,|$)/y;
 while(at<body.length){pair.lastIndex=at;const item=pair.exec(body);if(!item)throw Error(`Unsupported UI relationship ${name} literal expression`);result[item[1]]=item[2];at=pair.lastIndex;}
 return result;
}
function compileUiRenderContract(source){
 const begin=source.indexOf('function renderRelationship(){'),end=source.indexOf('function openExperienceReview(',begin);
 if(begin<0||end<0)throw Error('Unsupported UI relationship renderer boundary');
 const render=source.slice(begin,end),labels=literalMap(render,'labels'),applicabilityLabels=literalMap(render,'applicabilityLabels',{optional:true});
 const groups=render.match(/const groups=understanding\?\.\[subject\]\?\[(.*?)\]\.map/);
 if(!groups)throw Error('Unsupported UI relationship groups consumer');
 const groupLabels={};for(const item of groups[1].matchAll(/\['(knownFacts|recentCircumstances|uncertainties|boundaries)','([^'\\]*)'\]/g))groupLabels[item[1]]=item[2];
 if(Object.keys(groupLabels).length!==4)throw Error('Unsupported UI relationship group labels');
 const separate=render.includes('const applicability=applicabilityLabels[claim.applicability]||labels[claim.applicability];')&&render.includes('适用情况：${applicability}');
 const inline=render.includes("labels[claim.applicability]||''");
 if(separate&&!applicabilityLabels||!separate&&!inline)throw Error('Unsupported UI applicability consumer');
 const hasEvidenceFields=render.includes('claim.firstEvidenceAt')||render.includes('claim.lastEvidenceAt');
 const evidenceDates=render.includes('const first=evidenceDate(claim.firstEvidenceAt),last=evidenceDate(claim.lastEvidenceAt);')&&render.includes('if(first||last)card.append')&&render.includes('原始依据：${first}')&&render.includes('last&&last!==first?`最近依据：${last}');
 if(hasEvidenceFields&&!evidenceDates)throw Error('Unsupported UI evidence-date consumer');
 return {version:'relationship-ui-consumer-contract-v1',labels,groupLabels,applicabilityLabels:applicabilityLabels||{},applicability_mode:separate?'separate_line':'inline_labels',evidence_dates:evidenceDates};
}
function readUiRenderContract({sourceRoot=ROOT,fallbackRoot=ROOT}={}){
 const wanted=path.join(sourceRoot,'ui/app.js'),fallback=path.join(fallbackRoot,'ui/app.js'),file=fs.existsSync(wanted)?wanted:fallback;
 if(!fs.existsSync(file))throw Error('No declared UI source is available for semantic projection');
 const bytes=fs.readFileSync(file);return {contract:compileUiRenderContract(bytes.toString('utf8')),source:{origin_path:path.resolve(file),requested_source_root:path.resolve(sourceRoot),fallback_used:path.resolve(file)!==path.resolve(wanted),sha256:digest(bytes)},bytes};
}
function sourceDescription(sourceId,state={}){
 const split=sourceId.indexOf(':'),kind=sourceId.slice(0,split),id=sourceId.slice(split+1);let item,label;
 if(kind==='qq'){item=(state.messages||[]).find(message=>message.messageId===id);label=item?.direction==='outgoing'?'我在 QQ 说':'对方在 QQ 说';}
 else if(kind==='private'){item=id.startsWith('feedback-')?state.companion?.feedback?.find(feedback=>feedback.id===id.slice(9)):state.companion?.turns?.find(turn=>turn.id===id);label=id.startsWith('feedback-')?'我对帮助的反馈':'我向助手说明';}
 else if(kind==='note'){item=state.companion?.notes?.find(note=>note.id===id);label='我补充的背景';}
 return item?`${label}：${item.text}\n来源：${sourceId}`:`来源 ${sourceId}（当前列表尚未载入原文）`;
}
function projectPublicMemory(view,state={},contract=readUiRenderContract().contract){
 const labels=contract.labels;
 const card=claim=>{
  const projected={text:claim.text||claim.statement||String(claim.value||''),labels:[labels[claim.assertionKind]||claim.assertionKind,contract.applicability_mode==='inline_labels'?labels[claim.applicability]||'':'',({tentative:'仍是暂定理解',contested:'存在不同说法',undetermined:'尚未确定'})[claim.epistemicStatus]||'',labels[claim.semanticReview?.status]||''].filter(Boolean),
   ...(claim.condition?{condition:claim.condition}:{}),sources:(claim.sourceIds||claim.sourceRefs?.map(ref=>typeof ref==='string'?ref:ref.sourceId)||Object.keys(claim.sourceRevisions||{})).map(id=>sourceDescription(id,state))};
  if(contract.applicability_mode==='separate_line'){
   const applicability=contract.applicabilityLabels[claim.applicability]||labels[claim.applicability];
   if(applicability)projected.applicability_text=`适用情况：${applicability}`;
  }
  if(contract.evidence_dates){
   const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN'):null;
   const first=date(claim.firstEvidenceAt),last=date(claim.lastEvidenceAt);
   if(first||last){projected.evidence_date_text=[first?`原始依据：${first}`:null,last&&last!==first?`最近依据：${last}`:null].filter(Boolean).join('；');
    if(first)projected.firstEvidenceAt=claim.firstEvidenceAt;
    if(last&&last!==first)projected.lastEvidenceAt=claim.lastEvidenceAt;
   }
  }
  return projected;
 };
 const relation=view.relationship||{},companion=view.companion||{},current=companion.state,status=view.memory_status||{},uncertaintyCount=(relation.activityUncertainties||state.relationship?.activityUncertainties||[]).length;
 const persons=Object.fromEntries(['self','contact','dyad'].map(subject=>{
  const groups=relation.understanding?.[subject]?Object.fromEntries(['knownFacts','recentCircumstances','uncertainties','boundaries'].map(key=>[key,(relation.understanding[subject][key]||[]).map(card)])):{legacy:(relation[subject]||[]).map(card)};
  return [subject,groups];
 }));
 const person_group_headings=Object.fromEntries(Object.entries(persons).map(([subject,groups])=>[subject,Object.fromEntries(Object.entries(groups).filter(([name,rows])=>rows.length&&contract.groupLabels[name]).map(([name])=>[name,contract.groupLabels[name]]))]));
 return {projection:'ui_visible_semantic_fields_not_rendered_dom',persons,person_group_headings,...(uncertaintyCount?{activity_uncertainty_message:`另有${uncertaintyCount}项旧活动的证据已失去，身份未能恢复，仍待确认。`}:{}),
  activities:(relation.activities||[]).map(item=>({label:item.activityId?item.activityKey||'活动身份待确认':item.text||'已有相关记录',status:item.status,
   ...(item.currentReportedState?{current_report:{origin:item.currentReportedState.origin,status:item.currentReportedState.status,as_of:item.currentReportedState.asOf}}:{}),historical_evidence_gap:!!item.historicalEvidenceGap,qualified:!!item.qualified})),
  goal:companion.goal?.text||'',
  current_state:current?{possibly_stale:!!current.possiblyStale,focus:current.focus||'',items:(current.items||[]).map(card),open_threads:(current.openThreads||[]).filter(item=>item.status!=='closed').map(card),unknowns:(current.unknowns||[]).map(item=>typeof item==='string'?item:item.text)}:null,
  notes:(companion.notes||[]).map(note=>({text:note.text,kind:note.kind,use:note.use})),
  pending_actions:(companion.pendingActions||[]).map(item=>({label:item.label||'确认这次记忆调整',reason:item.reason||'请确认具体内容。',preview:item.preview||item.action?.text||'',outbound_material:item.action?.use==='draft'})),
  action_receipts:(companion.actionReceipts||[]).slice(-5).map(item=>({status:item.status,label:item.label,reason:item.reason,...(item.status==='applied'&&item.text?{text:item.text}:{}),...(item.evidenceQuote?{evidence_quote:item.evidenceQuote}:{})})),
  experience:{cases:(view.experience?.cases||[]).map(item=>({heading:item.activityId?'共同事项：'+(item.activityLabel||item.observations?.filter(row=>row.kind==='activity_event').at(-1)?.text||'活动证据待确认'):item.actualActions?.length?'实际交流':'你补充的一次经历',
   ...(item.eventAt?{event_at:item.eventAt}:{}),status:item.status,current_report:item.activityState?.currentReportedState?{origin:item.activityState.currentReportedState.origin,status:item.activityState.status,as_of:item.activityState.currentReportedState.asOf}:null,
   activity_status:item.activityState?.status,actual_actions:(item.actualActions||[]).map(row=>({kind:row.kind,text:row.text||'内容当前不可用'})),
   links:(item.links||[]).map(row=>({status:row.status,artifacts:(row.artifacts||[]).map(artifact=>artifact.text||'原参考内容已移除')})),
   observations:(item.observations||[]).map(row=>({kind:row.kind,text:row.text||'内容已不可用'})),reviews:(item.reviews||[]).map(row=>row.text)})),
   adaptations:(view.experience?.adaptations||[]).map(item=>({text:item.text,applicability:item.applicability,status:item.status}))},
  memory_status:{pending:status.pendingCount??status.pending??null,semantic_pending:status.semanticPending||0,recovery_ready:status.recoveryReady||0,recovery_deferred:status.recoveryDeferred||0,busy:!!status.busy,
   message:status.message||null,phase:status.phase||status.status||null,issue:status.error||status.errors?.[0]?.message||status.errors?.[0]?.detail?String(status.error||status.errors?.[0]?.message||status.errors?.[0]?.detail):null},
  maintenance:view.maintenance_schedule?{pending:view.maintenance_schedule.pending||0,next_at:view.maintenance_schedule.nextAt||null}:null};
}
module.exports={projectPublicMemory,sourceDescription,compileUiRenderContract,readUiRenderContract};
