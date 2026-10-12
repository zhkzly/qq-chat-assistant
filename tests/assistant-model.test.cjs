'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {assistModel,parseAssistant}=require('../src/assistant-model.cjs');
const settings={baseUrl:'http://synthetic.invalid/v1',model:'synthetic',apiKey:'fixture'};
const response=content=>({ok:true,json:async()=>({choices:[{message:{content}}]})});
test('restricted draft formatting normalizes cosmetic labels without changing meaning',()=>{
  const result=parseAssistant({analysis:'分享近况',suggestions:[{text:'今天种的番茄发芽了。'}]},'draft');
  assert.equal(result.kind,'draft');assert.deepEqual(result.suggestions,[{style:'自然',text:'今天种的番茄发芽了。'}]);
  assert.equal(parseAssistant({kind:'draft',text:'她已经明确要休息，这次可以不补发。',suggestions:[]},'draft').kind,'discussion');
  assert.throws(()=>parseAssistant({kind:'draft',text:'',suggestions:[]},'draft'));
});
test('malformed output gets one bounded format repair and preserves its actual request trace',async()=>{
  const context={payload:{purpose:'discussion',sources:[],userRequest:{text:'想聊聊近况'}},manifest:{}};const calls=[];
  const result=await assistModel(settings,context,undefined,async(_,request)=>{
    calls.push(JSON.parse(request.body));return response(calls.length===1?'not-json':JSON.stringify({kind:'question',text:'最近哪件事是你自己最想分享的？'}));
  });
  assert.equal(calls.length,2);assert.equal(result.kind,'question');assert.equal(context.manifest.formatRepair.attempts,1);
  assert.equal(context.extraRequests[0].payload.invalidResponse,'not-json');
});
test('format errors never become empty success or an unbounded retry loop',async()=>{
  let calls=0;await assert.rejects(assistModel(settings,{payload:{purpose:'discussion'},manifest:{}},undefined,async()=>{calls++;return response('broken-private-content')}),/未能返回/);
  assert.equal(calls,2);
});
