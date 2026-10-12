'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {postModel}=require('../src/model-http.cjs');
test('transient inference errors retry once with identical scoped payload, then stop',async()=>{
  const calls=[];let released=0;
  const request={method:'POST',body:'synthetic-scoped-context'};
  const result=await postModel('http://fixture.invalid/v1',request,async(url,body)=>{calls.push({url,body});return calls.length===1?{ok:false,status:500,body:{cancel:async()=>released++}}:{ok:true,status:200}},async()=>{});
  assert.equal(result.attempts,2);assert.equal(released,1);assert.deepEqual(calls[0],calls[1]);
  let failures=0;const failed=await postModel('http://fixture.invalid/v1',request,async()=>{failures++;return {ok:false,status:503}},async()=>{});
  assert.equal(failures,2);assert.equal(failed.response.status,503);
});
test('bad input, long retry-after and cancellation never cause automatic replay',async()=>{
  for(const response of [{ok:false,status:400},{ok:false,status:429,headers:{get:()=>60}}]){
    let calls=0;await postModel('http://fixture.invalid',{},async()=>{calls++;return response},async()=>{});assert.equal(calls,1);
  }
  const abort=new AbortController();abort.abort();let calls=0;
  await assert.rejects(postModel('http://fixture.invalid',{signal:abort.signal},async()=>{calls++;return {ok:true}},async()=>{}));assert.equal(calls,0);
});
