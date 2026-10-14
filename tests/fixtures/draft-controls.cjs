'use strict';
// Upgrade old synthetic model responses to the new planning wire contract.
// These generic controls are for plumbing fixtures only. Goal semantics use
// separate predeclared scenarios with explicit task-specific controls.
function withCurrentDraftControls(plan,payload,overrides={}){
 if(!payload?.taskContext?.draftControlPolicy?.required||plan.clarification)return plan;
 const sourceId=payload.taskContext.draftControlPolicy.intentSourceId;
 const item=text=>({text,sourceIds:[sourceId]});
 const guidance=plan.guidance?structuredClone(plan.guidance):{objective:item(overrides.objective||'表达已选意思或回应实际QQ'),allowedApproach:item(overrides.allowedApproach||'依照已商量的分寸自然组织完整表达'),avoidances:(overrides.avoidances||[]).map(item)};
 const controls=[guidance.objective,guidance.allowedApproach,guidance.currentStep,...(guidance.avoidances||[])].filter(Boolean);
 if(!controls.some(control=>control.sourceIds?.includes(sourceId)))guidance.currentStep=item('按这次明确请求组织表达');
 return {...plan,guidance};
}
module.exports={withCurrentDraftControls};
