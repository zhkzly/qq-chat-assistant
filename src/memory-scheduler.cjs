'use strict';
// These are workload controls, not interpretations of a person's reply timing.
function maintenanceDecision(status,settings={},options={}) {
 const now=options.now??Date.now(),pending=Number(status?.pending||status?.pendingCount||0);
 const threshold=Math.max(1,Math.min(100,Number(settings.memoryBatchThreshold)||8));
 const idleMs=Math.max(1000,Math.min(86400000,Number(settings.memoryIdleMs)||600000));
 const sourceAt=Date.parse(status?.lastEventAt||status?.oldestPendingAt||'')||now;
 const lastActivityAt=Math.max(Number(options.lastActivityAt)||0,sourceAt);
 const requestsInWindow=Number(options.requestsInWindow)||0,windowLimit=Math.max(1,Math.min(100,Number(settings.memoryWindowRequests)||6));
 const windowUntil=Number(options.windowUntil)||now;
 const base={pending,threshold,idleMs,requestsInWindow,windowLimit};
 if(!pending)return {...base,ready:false,reason:'up_to_date',nextAt:null};
 if(requestsInWindow>=windowLimit)return {...base,ready:false,reason:'rate_limited',nextAt:Math.max(now+1000,windowUntil)};
 if(options.draining||pending>=threshold)return {...base,ready:true,reason:options.draining?'continuing_batch':'batch_ready',nextAt:now};
 const due=lastActivityAt+idleMs;
 return {...base,ready:now>=due,reason:now>=due?'idle_ready':'waiting_for_batch',nextAt:Math.max(now,due)};
}
module.exports={maintenanceDecision};
