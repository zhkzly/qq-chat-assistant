'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {contextFor,generate,parseAdvice}=require('../src/model.cjs');
const {normalize}=require('../src/messages.cjs');const {scope,raw}=require('./fixtures/native.cjs');
test('model context strips concrete credential patterns while preserving original local records',async()=>{
 const secret='hf_'+'A'.repeat(32);const query='token='+'B'.repeat(32);
 const record=normalize(raw(undefined,false,{elements:[{textElement:{content:`API ${secret} https://example.test/sub?${query} 我今天很累`}}]}),scope);
 const projected=contextFor([record],'自然');assert.equal(projected[0].text.includes(secret),false);assert.equal(projected[0].text.includes(query),false);assert.match(projected[0].text,/今天很累/);assert.equal(record.text.includes(secret),true);
 let body;await generate({apiKey:'synthetic',baseUrl:'http://fixture.invalid/v1',model:'synthetic'},[record],secret,undefined,async(_,request)=>{body=request.body;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({analysis:'测试',suggestions:[1,2,3].map(n=>({style:String(n),text:'可以休息一下'}))})}}]})}});
 assert.equal(body.includes(secret),false);
});
test('advice cannot leave QQ media placeholders as literal reply text',()=>{
 const parsed=parseAdvice(JSON.stringify({analysis:'测试',suggestions:[1,2,3].map(n=>({style:String(n),text:'今天辛苦了[表情]🙂'}))}));
 assert.equal(parsed.suggestions.some(x=>x.text.includes('[表情]')),false);assert.equal(parsed.suggestions[0].text,'今天辛苦了🙂');
});
