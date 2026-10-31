'use strict';
// Explicit opt-in by positive legacy transport producers only. This records
// their existing interpretation; it is not a production permission inference.
const {createHash}=require('node:crypto');
const digest=text=>createHash('sha256').update(JSON.stringify(text)).digest('hex');
function materialRefForText(source,text){
 const atoms=[],bounds=new Map();let offset=0,body='';
 for(const segment of source.segments||[]){
  const start=offset;
  if(typeof segment.text==='string'){body+=segment.text;offset+=segment.text.length;}
  else for(const [boundary,part]of segment.parts||[]){if(boundary)bounds.set(offset,boundary);body+=part;offset+=part.length;}
  if(segment.endBoundary)bounds.set(offset,segment.endBoundary);
  atoms.push({ref:segment.materialRef,start,end:offset});
 }
 const parents=[...atoms,...(source.materialChoices||[]).map(choice=>({ref:choice.materialRef,start:atoms.find(atom=>atom.ref===choice.from)?.start,end:atoms.find(atom=>atom.ref===choice.to)?.end}))];
 for(let start=body.indexOf(text);start>=0&&text;start=body.indexOf(text,start+1)){
  const end=start+text.length,exact=parents.find(parent=>parent.start===start&&parent.end===end);
  if(exact?.ref)return exact.ref;
  const parent=parents.find(parent=>parent.start<=start&&parent.end>=end);
  if(parent?.ref&&bounds.get(start)&&bounds.get(end))return `${parent.ref}@${bounds.get(start)}:${bounds.get(end)}`;
 }
 throw new Error('Positive fixture material tuple has no exact offered span or readable endpoint selector');
}
function withCurrentStatementAuthority(value,payload,receipt){
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 const id=payload.intentAuthority?.sourceId,source=payload.sources?.find(item=>item.id===id);
 if(!source||source.role!=='user'||!['private','feedback'].includes(source.type)||['user_control','feedback_continue'].includes(source.kind)||source.deleted||source.excluded||source.use==='disabled')
  throw new Error('Positive fixture authority requires the captured original current user source');
 if(payload.primaryReferenceProtocol){
  const body=(source.segments||[]).map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
  const whole=materialRefForText(source,body),authority=source.authorityChoices?.originalUserStatementCandidates?.find(item=>item.materialRef===whole);
  const quote=item=>{
   if(!item||typeof item!=='object'||item.sourceId!==id||item.authorization!==undefined)return item;
   if(!authority)throw new Error('Positive fixture current tuple lacks its exact offered whole statement candidate');
   return {materialRef:materialRefForText(source,item.text),authorityRef:authority.authorityRef};
  };
  return {...value,...(value.draftPlan?.quotes?{draftPlan:{...value.draftPlan,quotes:value.draftPlan.quotes.map(quote)}}:{}),
   ...(Array.isArray(value.expressionOptions)?{expressionOptions:value.expressionOptions.map(option=>({...option,quotes:option.quotes?.map(quote)}))}:{})};
 }
 const start=source.delivery?.start||0,material=receipt?.materials?.find(item=>item.sourceId===id&&item.revision===source.revision&&item.start===start&&item.end===start+source.text.length&&item.bodyDigest===digest(source.text));
 const authority=receipt?.authorities.find(item=>item.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&(material&&item.materialRef===material.materialRef||item.currentInstruction&&item.sourceId===id&&item.revision===source.revision));
 const quote=item=>{
  if(!item||typeof item!=='object'||item.sourceId!==id||item.authorization!==undefined)return item;
  if(!authority||typeof item.text!=='string'||!source.text.includes(item.text))throw new Error('Positive fixture current tuple lacks its exact offered whole statement candidate');
  return {...item,authorization:{permission:{sourceId:id,text:source.text},referent:{sourceId:id,text:item.text}}};
 };
 return {...value,...(value.draftPlan?.quotes?{draftPlan:{...value.draftPlan,quotes:value.draftPlan.quotes.map(quote)}}:{}),
  ...(Array.isArray(value.expressionOptions)?{expressionOptions:value.expressionOptions.map(option=>({...option,quotes:option.quotes?.map(quote)}))}:{})};
}
module.exports={withCurrentStatementAuthority,materialRefForText};
