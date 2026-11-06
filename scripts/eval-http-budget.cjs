'use strict';
// Aggregate experiment accounting is independent of product request budgets.
const VERSION='explicit-experiment-http-budget-v1';
function httpBudget({unlimitedHttp=false,maxHttp,defaultCap=16,ceiling=512,label='Experiment HTTP'}={}){
 if(typeof unlimitedHttp!=='boolean')throw Error(`${label} unlimitedHttp must be boolean`);
 if(unlimitedHttp){
  if(maxHttp!==undefined&&maxHttp!==null)throw Error(`${label}: choose either --unlimited-http or a numeric --max-http`);
  return {cap:null,unlimited:true};
 }
 const cap=maxHttp===undefined?defaultCap:maxHttp;
 if(!Number.isSafeInteger(cap)||cap<1||cap>ceiling)throw Error(`${label} cap must be 1..${ceiling}; unbounded mode requires --unlimited-http`);
 return {cap,unlimited:false};
}
function exhausted(attempts,budget){return !budget.unlimited&&attempts>=budget.cap;}
function fields(budget){return {max_http:budget.cap,...(budget.unlimited?{unlimited_http:true}:{})};}
module.exports={VERSION,httpBudget,exhausted,fields};
