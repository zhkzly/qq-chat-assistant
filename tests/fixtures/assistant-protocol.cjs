'use strict';
// Mechanical wire upgrade for legacy synthetic plumbing producers. This does
// not interpret task meaning or supply case answers. New delivery-contract
// tests import production modules directly, including missing-contract tests.
const model=require('../../src/assistant-model.cjs');
const {parseModelJson}=require('../../src/model-json.cjs');
const {Controller:ProductController}=require('../../src/controller.cjs');
const {withRequestDelivery}=require('../../scripts/synthetic-request-delivery.cjs');

class Controller extends ProductController {
 get assistantModel(){return this.fixtureModel;}
 set assistantModel(producer){this.fixtureModel=producer&& (async(...args)=>withRequestDelivery(await producer(...args),args[1].payload));}

}
function parseAssistant(value,purpose,input,...args){
 let data=value;
 if(typeof data==='string'){try{data=parseModelJson(data);}catch{ /* Preserve malformed JSON. */ }}
 return model.parseAssistant(withRequestDelivery(data,input?.payload||input),purpose,input,...args);
}
async function assistModel(settings,context,signal,fetchImpl=fetch){
 return model.assistModel(settings,context,signal,async(url,args)=>{
  const response=await fetchImpl(url,args);
  if(!response.ok)return response;
  const json=await response.json(),request=JSON.parse(args.body),content=request.messages[1].content;
  const wrapper=JSON.parse(typeof content==='string'?content:content.find(item=>item.type==='text').text),payload=wrapper.originalInput||wrapper;
  const upgrade=text=>{try{const data=JSON.parse(text);return JSON.stringify(withRequestDelivery(data,payload));}catch{return text;}};
  for(const choice of json.choices||[]){
   if(typeof choice.message?.content==='string')choice.message.content=upgrade(choice.message.content);
   for(const call of choice.message?.tool_calls||[])if(typeof call.function?.arguments==='string')call.function.arguments=upgrade(call.function.arguments);
  }
  return {ok:response.ok,status:response.status,json:async()=>json};
 });
}
module.exports={...model,Controller,parseAssistant,assistModel,withRequestDelivery};
