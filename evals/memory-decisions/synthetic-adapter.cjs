'use strict';
// Integration fixture only. These placeholders are not judgments of the supplied facts.
exports.createDecisionAdapter=async({live=false,maxCalls=16}={})=>{
 if(live)throw Error('The synthetic component fixture cannot run in live mode');
 let calls=0;
 return {identity:{mode:'synthetic',model:'synthetic-decision-placeholder-v1',provider:'none',version:'1'},
  async decide(input,{signal}={}){
   signal?.throwIfAborted();if(++calls>maxCalls)throw Object.assign(Error('Synthetic adapter call cap reached'),{code:'component_call_limit'});
   return {axes:{same_subject:'uncertain',time_scope:'unknown',relationships:['uncertain'],evidence_sufficiency:input.availability_updates.length?'unavailable':'insufficient'},
    evidence_ids:[...input.prior_evidence,...input.new_evidence,...input.availability_updates].map(item=>item.id),
    reason:'Synthetic placeholder based on delivered evidence handles and availability lane. This verifies the component execution boundary only; no semantic decision or product quality has been evaluated.'};
  },
  async summary(){return {adapter_calls:calls,provider_http_requests:0,evidence:'synthetic_contract_integration_only',semantic_evaluation:'not_run'};},
  async close(){}
 };
};
