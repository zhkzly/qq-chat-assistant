'use strict';
// Pure test-fixture representation changes using only the actual HTTP receipt.
// No producer input, text, entity ID, unknown reference or validation changes.
const {mapSourceReferences}=require('../../src/source-handles.cjs');
function canonicalSourceView(value,receipt){
 const refs=new Map((receipt?.bindings||[]).map(item=>[item.handle,item.sourceId]));
 const result=mapSourceReferences(value,id=>refs.get(id)||id);
 if(result&&typeof result==='object')delete result.sourceReferenceProtocol;
 return result;
}
function wireSourceView(value,receipt){
 const refs=new Map((receipt?.bindings||[]).map(item=>[item.sourceId,item.handle]));
 return mapSourceReferences(value,id=>refs.get(id)||id);
}
module.exports={canonicalSourceView,wireSourceView};
