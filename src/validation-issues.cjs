'use strict';
function validationError(path,code,message){const error=new Error(message);error.field=path;error.code=code;return error;}
class ValidationIssues {
 #items=[];#errors=[];
 mark(){return this.#items.length;}
 hasSince(mark){return this.#items.length>mark;}
 get issues(){return [...new Map(this.#items.map(item=>[JSON.stringify(item),item])).values()].sort((a,b)=>{const x=JSON.stringify([a.path,a.code,a.message]),y=JSON.stringify([b.path,b.code,b.message]);return x<y?-1:x>y?1:0;});}
 check(path,code,run){try{return {ok:true,value:run()};}catch(error){this.capture(path,code,error);return {ok:false};}}
 capture(path,code,error){
  if(error.issues){for(const issue of error.issues)this.add(issue,error);return;}
  const prefix=/^([A-Za-z][A-Za-z0-9_.\[\]]+):/.exec(String(error.message));
  this.add({path:error.field||prefix?.[1]||path,code:error.code||code,message:String(error.message)},error);
 }
 add(issue,error){
  if(!issue||typeof issue!=='object'||Array.isArray(issue)||Object.keys(issue).some(key=>!['path','code','message'].includes(key)))throw validationError('$','validation_feedback_invalid_shape','Validation issues allow only path/code/message strings; no partial result was admitted');
  if(typeof issue.path!=='string'||issue.path.length>256||typeof issue.code!=='string'||issue.code.length>100||typeof issue.message!=='string'||issue.message.length>4096||this.#items.length>=64)
   throw validationError('$','validation_feedback_overflow','Validation feedback exceeds its bounded shape; no partial result was admitted or issue silently discarded');
  this.#items.push(Object.freeze({path:issue.path,code:issue.code,message:issue.message}));this.#errors.push(error);
 }
 throwIfAny(){
  const issues=this.issues;if(!issues.length)return;
  const error=issues.length===1&&this.#errors[0]?this.#errors[0]:validationError('$','assistant_validation_failed',issues.map(issue=>`${issue.path} [${issue.code}] ${issue.message}`).join('\n'));
  const bound=this.#errors.find(item=>item?.requestDelivery!==undefined);
  if(bound)error.requestDelivery=bound.requestDelivery;
  error.issues=issues;throw error;
 }
}
module.exports={ValidationIssues,validationError};
