'use strict';
const SUBJECTS = ['self', 'contact', 'dyad'];
const ASSERTIONS = ['stated', 'reported', 'observed', 'inferred'];
const EPISTEMIC = ['supported', 'tentative', 'contested', 'undetermined'];
const LIFECYCLES = ['active', 'superseded', 'withdrawn'];
const EVENT_KINDS = ['invitation', 'acceptance', 'decline', 'reschedule', 'cancellation', 'occurred', 'interest_expression', 'boundary', 'sharing'];
const ASPECTS = ['interest', 'recent_context', 'stated_preference', 'boundary', 'mutual_knowledge', 'coordination', 'relationship_intent', 'interaction_hypothesis'];
const APPLICABILITY = ['local','temporary','recurring','conditional','unspecified'];
const ATTRIBUTION = ['speaker','user_report','third_party_report','hypothesis','unspecified'];
const TRANSITIONS = ['reaffirm','supersede','change_over_time','contest','merge'];
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function invalid(path, expectation) { throw new Error(`${path}: ${expectation}`); }
function text(value, path, max=1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(path, `expected nonempty text up to ${max} characters`);
  return value.trim();
}
function choice(value, allowed, path) { if (!allowed.includes(value)) invalid(path, `expected ${allowed.join('|')}`); return value; }
function list(value, path, max, {required=false}={}) {
  if (!Array.isArray(value) || value.length > max || required && !value.length) invalid(path, `expected ${required?'1':'0'}..${max} strings`);
  return [...new Set(value.map((v,i)=>text(v,`${path}[${i}]`,300)))];
}
function time(value,path) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(path,'expected an ISO date or datetime'); return new Date(value).toISOString(); }
function fields(value,allowed,path) {
  if(!object(value))invalid(path,'expected object');
  const unknown=Object.keys(value).filter(k=>!allowed.includes(k));if(unknown.length)invalid(path,`unsupported fields ${unknown.join(',')}`);
}
function common(value,path) {
  const out={text:text(value.text,`${path}.text`),sourceIds:list(value.sourceIds,`${path}.sourceIds`,64,{required:true})};
  if(value.id!==undefined){out.id=text(value.id,`${path}.id`,256);if(value.expectedVersion===undefined)invalid(`${path}.expectedVersion`,'required for an existing record');}
  if(value.expectedVersion!==undefined){if(!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1)invalid(`${path}.expectedVersion`,'expected positive integer');out.expectedVersion=value.expectedVersion;}
  if(value.topicKeys!==undefined)out.topicKeys=list(value.topicKeys,`${path}.topicKeys`,8).map((v,i)=>text(v,`${path}.topicKeys[${i}]`,80));
  return out;
}
function transition(value,out,path){
  if(value.transition!==undefined){
    fields(value.transition,['operation','targets'],`${path}.transition`);
    const targets=value.transition.targets;
    if(!Array.isArray(targets)||!targets.length||targets.length>8)invalid(`${path}.transition.targets`,'expected 1..8 existing versioned targets');
    out.transition={operation:choice(value.transition.operation,TRANSITIONS,`${path}.transition.operation`),targets:targets.map((target,index)=>{
      fields(target,['id','expectedVersion'],`${path}.transition.targets[${index}]`);
      if(!Number.isSafeInteger(target.expectedVersion)||target.expectedVersion<1)invalid(`${path}.transition.targets[${index}].expectedVersion`,'expected a captured positive version');
      return {id:text(target.id,`${path}.transition.targets[${index}].id`,256),expectedVersion:target.expectedVersion};
    })};
  }
}
function normalizeClaim(value,path) {
  fields(value,['id','expectedVersion','subject','aspect','text','assertionKind','epistemicStatus','lifecycle','validFrom','validUntil','context','sourceIds','topicKeys','applicabilityKind','condition','attribution','transition'],path);
  const out={...common(value,path),subject:choice(value.subject,SUBJECTS,`${path}.subject`),aspect:choice(value.aspect,ASPECTS,`${path}.aspect`),
    assertionKind:choice(value.assertionKind,ASSERTIONS,`${path}.assertionKind`),epistemicStatus:choice(value.epistemicStatus,EPISTEMIC,`${path}.epistemicStatus`),
    lifecycle:choice(value.lifecycle||'active',LIFECYCLES,`${path}.lifecycle`)};
  out.applicabilityKind=choice(value.applicabilityKind||'unspecified',APPLICABILITY,`${path}.applicabilityKind`);
  out.attribution=choice(value.attribution||'unspecified',ATTRIBUTION,`${path}.attribution`);
  if(value.condition!==undefined)out.condition=text(value.condition,`${path}.condition`,1000);
  if(out.applicabilityKind==='conditional'&&!out.condition)invalid(`${path}.condition`,'conditional understanding requires the original condition');
  if(out.attribution==='third_party_report'&&out.assertionKind==='stated')invalid(`${path}.assertionKind`,'third-party speech must remain reported, never a direct statement about this person');
  transition(value,out,path);
  if(out.assertionKind==='inferred'&&out.epistemicStatus==='supported')invalid(`${path}.epistemicStatus`,'inferred claims must remain tentative, contested, or undetermined');
  for(const key of ['validFrom','validUntil'])if(value[key]!==undefined&&value[key]!==null)out[key]=time(value[key],`${path}.${key}`);
  if(out.validFrom&&out.validUntil&&out.validFrom>out.validUntil)invalid(path,'validFrom must not follow validUntil');
  if(value.context!==undefined)out.context=text(value.context,`${path}.context`,500);
  return out;
}
function normalizeEvent(value,path) {
  fields(value,['id','expectedVersion','activityKey','eventKind','actor','text','occurredAt','sourceIds','topicKeys','transition'],path);
  const out={...common(value,path),activityKey:text(value.activityKey,`${path}.activityKey`,120),eventKind:choice(value.eventKind,EVENT_KINDS,`${path}.eventKind`),actor:choice(value.actor,['self','contact','both','unknown'],`${path}.actor`)};
  if(value.occurredAt!==undefined&&value.occurredAt!==null)out.occurredAt=time(value.occurredAt,`${path}.occurredAt`);
  transition(value,out,path);
  return out;
}
function normalizeRelationshipPatch(value) {
  fields(value,['claims','events','retire'],'relationshipPatch');const out={claims:[],events:[],retire:[]};
  for(const [key,max] of [['claims',24],['events',12],['retire',24]]) {
    const values=value[key]===undefined?[]:value[key];if(!Array.isArray(values)||values.length>max)invalid(`relationshipPatch.${key}`,`expected at most ${max} records`);
    out[key]=values.map((record,i)=>{
      const p=`relationshipPatch.${key}[${i}]`;
      if(key==='claims')return normalizeClaim(record,p);if(key==='events')return normalizeEvent(record,p);
      fields(record,['id','expectedVersion','sourceIds','lifecycle'],p);
      const r={id:text(record.id,`${p}.id`,256),sourceIds:list(record.sourceIds,`${p}.sourceIds`,64,{required:true}),lifecycle:choice(record.lifecycle,['superseded','withdrawn'],`${p}.lifecycle`)};
      if(record.expectedVersion===undefined)invalid(`${p}.expectedVersion`,'required for retirement');
      if(record.expectedVersion!==undefined){if(!Number.isSafeInteger(record.expectedVersion)||record.expectedVersion<1)invalid(`${p}.expectedVersion`,'expected positive integer');r.expectedVersion=record.expectedVersion;}
      return r;
    });
  }
  return out;
}
module.exports={normalizeRelationshipPatch,SUBJECTS,ASSERTIONS,EPISTEMIC,LIFECYCLES,EVENT_KINDS,ASPECTS,APPLICABILITY,ATTRIBUTION,TRANSITIONS};
