'use strict';
// Unicode words plus Han bigrams support ordinary Chinese queries without an
// external tokenizer. This is lexical retrieval, not semantic equivalence.
function terms(text) {
  const result=[];
  for(const token of String(text||'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]) {
    const runs=token.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu)||[];
    for(const run of runs) {
      if(!/\p{Script=Han}/u.test(run)) { if(run.length>1)result.push(run);continue; }
      const chars=[...run]; if(chars.length===1)result.push(chars[0]);
      else for(let i=0;i<chars.length-1;i++)result.push(chars[i]+chars[i+1]);
    }
  }
  return result;
}
function rank(records,query,{limit=12,before,after,types}={}) {
  const end=before===undefined?Infinity:new Date(before).getTime(),start=after===undefined?-Infinity:new Date(after).getTime();
  const pool=records.filter(r=>!r.deleted&&(!types||types.includes(r.type)||types.includes(r.kind))&&Date.parse(r.at||r.lastEvidenceAt||r.createdAt||0)<=end&&Date.parse(r.at||r.lastEvidenceAt||r.createdAt||0)>=start);
  const wanted=[...new Set(terms(query))].slice(0,96), docs=pool.map(r=>({r,words:terms(`${r.text} ${(r.topicKeys||[]).join(' ')}`)}));
  const df=new Map(wanted.map(w=>[w,0]));
  for(const d of docs)for(const word of new Set(d.words))if(df.has(word))df.set(word,df.get(word)+1);
  const avg=docs.reduce((n,d)=>n+d.words.length,0)/Math.max(1,docs.length)||1;
  for(const d of docs) {
    const counts=new Map();for(const w of d.words)counts.set(w,(counts.get(w)||0)+1);
    d.score=wanted.reduce((score,w)=>{const f=counts.get(w)||0;if(!f)return score; const idf=Math.log(1+(docs.length-df.get(w)+0.5)/(df.get(w)+0.5));return score+idf*(f*2.2)/(f+1.2*(0.25+0.75*d.words.length/avg));},0);
    if(query&&d.r.text.toLowerCase().includes(query.toLowerCase()))d.score+=2;
  }
  return docs.filter(d=>!wanted.length||d.score>0).sort((a,b)=>b.score-a.score||Date.parse(b.r.at||b.r.lastEvidenceAt||0)-Date.parse(a.r.at||a.r.lastEvidenceAt||0)).slice(0,Math.max(1,Math.min(200,limit))).map(d=>({...d.r,retrievalScore:Number(d.score.toFixed(4))}));
}
module.exports={terms,rank};
