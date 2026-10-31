'use strict';

// Coordinates describe only the visible candidate, never evidence or authority.
// Every consumer uses these exact field names; no arbitrary JSONPath is read.
function candidateFields(candidate={}) {
 const fields=[];
 const add=(path,value)=>{if(typeof value==='string')fields.push(Object.freeze({path,value}));};
 add('text',candidate.text);
 add('discussionExplanation.text',candidate.discussionExplanation?.text);
 if(Array.isArray(candidate.suggestions))candidate.suggestions.forEach((item,index)=>{
  add(`suggestions[${index}].text`,item?.text);add(`suggestions[${index}].style`,item?.style);
 });
 if(Array.isArray(candidate.expressionOptions))candidate.expressionOptions.forEach((item,index)=>add(`expressionOptions[${index}].label`,item?.label));
 return Object.freeze(fields);
}
function candidatePaths(candidate){return Object.freeze(candidateFields(candidate).map(field=>field.path));}
function normalizeCandidatePath(path,offeredPaths){
 if(typeof path!=='string')return undefined;
 if(offeredPaths.includes(path))return path;
 if(path.startsWith('candidate.')&&offeredPaths.includes(path.slice('candidate.'.length)))return path.slice('candidate.'.length);
 return undefined;
}
module.exports={candidateFields,candidatePaths,normalizeCandidatePath};
