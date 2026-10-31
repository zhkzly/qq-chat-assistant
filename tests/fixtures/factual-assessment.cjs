'use strict';
// Explicit synthetic review formatting only. Callers own all statement kinds,
// support findings and verdicts; this helper never interprets or grants facts.
function factualReview(input,statementsByPath){
 const payload=input?.payload||input,paths=payload?.candidatePaths;
 if(!Array.isArray(paths)||!paths.every(path=>typeof path==='string')||new Set(paths).size!==paths.length)throw new Error('A factual fixture requires actual offered candidate paths');
 if(!statementsByPath||typeof statementsByPath!=='object'||Array.isArray(statementsByPath))throw new Error('Explicit statement decisions are required for a factual fixture');
 if(Object.keys(statementsByPath).some(path=>!paths.includes(path)))throw new Error('A factual fixture cannot add an unoffered candidate field');
 return paths.map(path=>{
  const statements=Object.hasOwn(statementsByPath,path)?statementsByPath[path]:[];
  if(!Array.isArray(statements))throw new Error('Factual fixture statements must be arrays');
  return {path,statements:structuredClone(statements)};
 });
}
module.exports={factualReview};
