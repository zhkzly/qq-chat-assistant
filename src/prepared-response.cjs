'use strict';

const {validationError}=require('./validation-issues.cjs');

// Final ownership is private: provider fields cannot assert or copy this mark.
const preparedResponses=new WeakMap();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=message=>validationError('privateExplanation','prepared_explanation_invalid',message);

function validateExplanation(explanation,result) {
  if(typeof explanation!=='string'||!explanation.trim()||explanation.length>6000)
    throw invalid('privateExplanation must be a nonempty string of at most 6000 characters');
  if(!object(result)||result.kind!=='draft'||result.deliveryBlocker!==undefined||result.blocker!==undefined||result.requestDelivery?.blocker!==undefined)
    throw invalid('privateExplanation belongs only to a final draft; a private question or blocker owns its own explanation');
  return explanation;
}

function readPreparedExplanation(value,result,binding) {
  if(object(value)&&preparedResponses.has(value)) {
    const captured=preparedResponses.get(value);
    if(captured.binding!==binding)throw invalid('A final prepared response cannot be read under another binding');
    return captured.explanation;
  }
  if(!object(value)||!Object.hasOwn(value,'privateExplanation'))return undefined;
  if(value.privateExplanation==null||typeof value.privateExplanation==='string'&&!value.privateExplanation.trim())return undefined;
  return validateExplanation(value.privateExplanation,result);
}

function rememberPreparedResponse(result,explanation,binding) {
  if(!object(result))throw invalid('A final prepared response must be an object');
  if(explanation!==undefined)validateExplanation(explanation,result);
  if(preparedResponses.has(result)) {
    const captured=preparedResponses.get(result);
    if(captured.binding!==binding||captured.explanation!==explanation)
      throw invalid('A final prepared response cannot be rebound or have its explanation replaced');
    return;
  }
  preparedResponses.set(result,Object.freeze({explanation,binding}));
}

module.exports={readPreparedExplanation,rememberPreparedResponse};
