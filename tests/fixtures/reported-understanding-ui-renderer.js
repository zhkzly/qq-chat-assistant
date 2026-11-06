// Frozen consumer excerpt for projection tests, copied from the isolated candidate.
// Full UI SHA-256: 6f23cabb794d82bffda4790cfecdb6cda49caeb5d53dcf4be28dd67ab038c000
// This fixture is parsed as source text and is never executed.
function renderRelationship(){
 const view=state.relationship||{},understanding=view.understanding,key=JSON.stringify([understanding,view.claims,view.events,view.activities,view.activityUncertainties,view.coverage]);if(key===relationshipViewKey)return;relationshipViewKey=key;const opened=new Set([...$('relationship-view').querySelectorAll('details[data-subject][open]')].map(el=>el.dataset.subject)),fragment=document.createDocumentFragment(),expected=scopeKey,epoch=historyEpoch;
 const labels={stated:'明确说过',reported:'用户补述',observed:'行为观察',hypothesis:'暂定解释',tentative:'暂定解释',inferred:'暂定解释',expired:'已过期',not_yet_valid:'尚未到适用时间',needs_review:'需要核查',inactive:'已停用',legacy_unreviewed:'旧记录，尚待原文核查',partial_originals:'原文尚未读全',pending:'尚待核查'};
 const applicabilityLabels={unspecified:'适用期限未确认，不代表当前仍适用',conditional:'仅在所述条件下适用',local:'局部适用',dated_context:'有日期的情况',recurring:'有据的重复适用',current:'在已知有效期内'};
 const cardFor=claim=>{const card=document.createElement('article');card.className='relationship-claim';card.dataset.claimId=claim.id;card.append(paragraph(claim.text||claim.statement||String(claim.value||'')),paragraph([labels[claim.assertionKind]||claim.assertionKind,({tentative:'仍是暂定理解',contested:'存在不同说法',undetermined:'尚未确定'})[claim.epistemicStatus]||'',labels[claim.semanticReview?.status]||''].filter(Boolean).join(' · '),'muted'));
  const applicability=applicabilityLabels[claim.applicability]||labels[claim.applicability];
  if(applicability)card.append(paragraph(`适用情况：${applicability}`,'muted'));
  // These are source-evidence clocks, never review time or event occurrence.
  const evidenceDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN'):null;
  const first=evidenceDate(claim.firstEvidenceAt),last=evidenceDate(claim.lastEvidenceAt);
  if(first||last)card.append(paragraph([first?`原始依据：${first}`:null,last&&last!==first?`最近依据：${last}`:null].filter(Boolean).join('；'),'muted'));
  if(claim.condition)card.append(paragraph(`适用条件：${claim.condition}`,'muted'));
  const refs=document.createElement('details'),caption=document.createElement('summary'),sourceIds=claim.sourceIds||claim.sourceRefs?.map(ref=>typeof ref==='string'?ref:ref.sourceId)||Object.keys(claim.sourceRevisions||{});caption.textContent='查看来源';refs.append(caption,...sourceIds.map(id=>paragraph(sourceDescription(id),'muted')));card.append(refs);
  card.append(button('围绕这点继续',()=>{if(expected===scopeKey&&epoch===historyEpoch)attachDiscussionContext(`关于这条认识「${claim.text||claim.statement||''}」，`)}),button('更正这点',()=>{if(expected===scopeKey&&epoch===historyEpoch)attachDiscussionContext(`更正这条认识「${claim.text||claim.statement||''}」：`)}),button('不再采用',()=>{if(expected===scopeKey&&epoch===historyEpoch)experienceAction('/api/claim-action',{id:claim.id,expectedVersion:claim.version,operation:'withdraw'})}));return card;
 };
 for(const [subject,title]of [['self','我'],['contact','她'],['dyad','我们']]){const section=document.createElement('details');section.className='relationship-group';section.dataset.subject=subject;section.open=opened.has(subject);const summary=document.createElement('summary');
  // The server owns classification and evidence validity. This is only a read
  // projection; older backends retain their original flat public view.
  const groups=understanding?.[subject]?[['knownFacts','已核对的认识'],['recentCircumstances','近期处境／有据报告'],['uncertainties','仍待核对的理解或适用情况'],['boundaries','条件与边界']].map(([name,label])=>({label,claims:understanding[subject][name]||[]})):[{label:null,claims:view[subject]||[]}];
  const count=groups.reduce((total,group)=>total+group.claims.length,0);summary.textContent=`${title} · ${count} 项`;section.append(summary);
  if(!count)section.append(paragraph('暂无可核对的认识。可以直接在对话中补充，不必先填写档案。','muted'));
  for(const group of groups)if(group.claims.length){if(group.label)section.append(paragraph(group.label,'state-heading'));section.append(...group.claims.map(cardFor));}fragment.append(section);
 }
 for(const activity of view.activities||[]){
  const latest=(view.events||[]).filter(event=>activity.activityId?event.activityId===activity.activityId:event.activityKey===activity.activityKey).at(-1);
  const label=activity.activityId?activity.activityKey||'活动身份待确认':latest?.text||'已有相关记录';
  const report=activity.currentReportedState,wording=report?`${report.origin==='user_report'?'用户当前报告':'当前原话'}：${{accepted:'又约好了',cancelled:'已取消',declined:'已拒绝',invited:'已邀请',rescheduled:'已调整',unknown:'仍待确认'}[report.status]||'有新情况'}（截至${new Date(report.asOf).toLocaleString('zh-CN')}）`:
   {invited:'已提出邀请',accepted:'现有记录曾答应',declined:'已拒绝',rescheduled:'时间有变更',cancelled:'已取消',occurred:'有发生过的报告',needs_review:'既有证据不足，仍待确认'}[activity.status]||'有相关记录';
  fragment.append(paragraph(`共同事项：${label} · ${wording}${report&&activity.historicalEvidenceGap?'；旧证据缺口仍保留':''}${activity.qualified?'；按既有记录理解，未新增核对':''}`,'muted'));
 }
 if(view.activityUncertainties?.length)fragment.append(paragraph(`另有${view.activityUncertainties.length}项旧活动的证据已失去，身份未能恢复，仍待确认。`,'muted'));
 $('relationship-view').replaceChildren(fragment);
}
function openExperienceReview() {}
