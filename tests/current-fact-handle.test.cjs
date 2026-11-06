'use strict';
// Handle-based currentFact citation: the model may cite '@r<n>' (the n-th
// delivered span of the current human statement) and the program resolves the
// exact verbatim text — citation exactness no longer depends on model
// character-copying. Verbatim spans stay accepted and containment-validated.
const test=require('node:test'),assert=require('node:assert/strict');
const {currentFactQuotes}=require('../src/context/current-human-control.cjs');
const {scope}=require('./fixtures/native.cjs');
const TEXT='她最近恢复正常下班了，刚过去的周末又去跑了一次。';
function prepared({delivery}={}){
 const source={id:'private:h1',type:'private',role:'user',kind:'discussion',revision:'r1',at:'2026-09-01T10:00:00.000Z',text:TEXT,use:'discussion',...(delivery?{delivery}:{})};
 return {payload:{purpose:'discussion',intentAuthority:{sourceId:source.id},userRequest:{sourceId:source.id,text:TEXT},sources:[source]},manifest:{scope,requestId:'handle-test',sourceRevisions:{[source.id]:'r1'}},fullAvailableSources:[source]};
}
const info={scope,settings:{assistantRequestBytes:64000}};
test('range handle resolves the delivered span verbatim with the full control contract',t=>{
 const p=prepared();
 const facts=currentFactQuotes(p,['@r1'],info);
 assert.equal(facts.length,1);assert.equal(facts[0].sourceId,'private:h1');
 assert.equal(facts[0].text,TEXT);
 assert.deepEqual(facts[0].authorization.permission,{sourceId:'private:h1',text:TEXT});
});
test('invalid handle indexes are rejected without invention',t=>{
 const p=prepared();
 assert.throws(()=>currentFactQuotes(p,['@r5'],info),/range handle/);
});
test('verbatim spans stay accepted and paraphrases stay rejected',t=>{
 const p=prepared();
 const facts=currentFactQuotes(p,[TEXT],info);
 assert.equal(facts[0].text,TEXT);
 let caught=null;try{currentFactQuotes(p,['她说最近恢复正常下班了，并在刚过去的周末又去跑了一次。'],info);}catch(e){caught=e;}
 assert.ok(caught,'paraphrase must be rejected');assert.equal(caught.code,'current_fact_span_invalid');
});
