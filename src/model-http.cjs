'use strict';
const {setTimeout:pause}=require('node:timers/promises');
// One configured model-call timeout across the assistant, memory and compaction
// transports: settings.modelTimeoutMs when set (bounded 1s..600s), else 60s.
const modelTimeoutSignal=settings=>AbortSignal.timeout(Math.max(1000,Math.min(600000,Number(settings?.modelTimeoutMs)||60000)));
// Inference is side-effect free for QQ and persistence only happens after a
// validated response. Retry transport/server failures once at the same endpoint.
async function postModel(url,request,fetchImpl=fetch,wait=pause,budget=null,options={}) {
  const maxAttempts=options?.maxAttempts===1?1:2;
  for(let attempt=1;attempt<=maxAttempts;attempt++) {
    if(request.signal?.aborted)throw request.signal.reason;
    const reservation=budget?.reserveAttempt({attempt,inputBytes:Buffer.byteLength(typeof request.body==='string'?request.body:'','utf8')});
    try {
      const response=await fetchImpl(url,request);
      if(reservation)budget.finishAttempt(reservation,{status:response.status});
      const retryable=response.status===429||response.status>=500;
      const delay=Number(response.headers?.get?.('retry-after'));
      if(response.ok||!retryable||attempt===maxAttempts||delay>5)return {response,attempts:attempt};
      await response.body?.cancel();
      await wait(Number.isFinite(delay)&&delay>0?delay*1000:1000,undefined,{signal:request.signal});
    } catch(error) {
      if(reservation)budget.finishAttempt(reservation,{errorCode:request.signal?.aborted?'cancelled':'transport_failure'});
      if(request.signal?.aborted||error?.name==='AbortError'||error?.name==='TimeoutError'||attempt===maxAttempts)throw error;
      await wait(1000,undefined,{signal:request.signal});
    }
  }
}
async function modelFailure(response,label='Model') {
  let data;
  try {
    if(response.body?.getReader){
      const reader=response.body.getReader();let text='',length=0;
      for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>8192){await reader.cancel();break;}text+=new TextDecoder().decode(part.value);}
      data=JSON.parse(text);
    } else if(response.json)data=await response.json();
  }catch{await response.body?.cancel?.().catch(()=>{});}
  const detail=String(data?.error?.message||data?.message||(typeof data?.error==='string'?data.error:''));
  const category=/TLS|handshake|EOF|socket|ECONN|connection|network|fetch failed/i.test(detail)?'connection':
    /quota|rate.?limit|too many|capacity/i.test(detail)?'capacity':
    /context.{0,40}(?:length|limit)|token.{0,30}limit|too long/i.test(detail)?'context':
    /unauthorized|authentication|invalid.{0,15}key/i.test(detail)?'authentication':'provider';
  // Preserve actionable status/category without copying a provider echo of
  // private prompts, credentials or generated text into logs and diagnostics.
  const error=new Error(`${label} HTTP ${response.status} (${category})`);
  error.code=`model_http_${response.status}_${category}`;error.status=response.status;return error;
}
module.exports={postModel,modelFailure,modelTimeoutSignal};
