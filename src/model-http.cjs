'use strict';
const {setTimeout:pause}=require('node:timers/promises');
// Inference is side-effect free for QQ and persistence only happens after a
// validated response. Retry transport/server failures once at the same endpoint.
async function postModel(url,request,fetchImpl=fetch,wait=pause) {
  for(let attempt=1;attempt<=2;attempt++) {
    if(request.signal?.aborted)throw request.signal.reason;
    try {
      const response=await fetchImpl(url,request);
      const retryable=response.status===429||response.status>=500;
      const delay=Number(response.headers?.get?.('retry-after'));
      if(response.ok||!retryable||attempt===2||delay>5)return {response,attempts:attempt};
      await response.body?.cancel();
      await wait(Number.isFinite(delay)&&delay>0?delay*1000:1000,undefined,{signal:request.signal});
    } catch(error) {
      if(request.signal?.aborted||error?.name==='AbortError'||error?.name==='TimeoutError'||attempt===2)throw error;
      await wait(1000,undefined,{signal:request.signal});
    }
  }
}
module.exports={postModel};
