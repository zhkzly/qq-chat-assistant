'use strict';
// Source-shaped synthetic media only. Injected reads never access image caches.
const test=require('node:test'),assert=require('node:assert/strict');
const {selectVisionContext}=require('../src/vision-context.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const NOW=Date.parse('2026-10-14T04:00:00Z'),DAY=24*60*60*1000;
function picture(id,at=NOW-1000,own=false,count=1,extra={}){
 return normalize(raw(String(id),own,{msgTime:String(Math.floor(at/1000)),elements:[{textElement:{content:'Synthetic image context'}},
  ...Array.from({length:count},(_,index)=>({picElement:{sourcePath:`/synthetic/qq/${id}-${index}.png`,fileName:'synthetic.png'}}))],...extra}),scope);
}
const sources=records=>records.map(record=>({id:`qq:${record.messageId}`,type:'qq',text:record.text}));
function reader(missing=[]){const calls=[],blocked=new Set(missing);return {calls,readImageFn:(record,index)=>{
 calls.push({messageId:record.messageId,index});if(blocked.has(record.messageId))throw new Error('/synthetic/private/cache/missing');
 return {type:'image/png',data:Buffer.from('synthetic bytes, no image pixels')};
}};}
test('off never reads, while explicit manual selection overrides automatic and deduplicates exact indices',()=>{
 const records=[picture('90071992547409999001',NOW-3*DAY,true),picture('90071992547409999002')],read=reader();
 const before=JSON.stringify(records),options={records,availableSources:sources(records),now:NOW,...read};
 assert.deepEqual(selectVisionContext({...options,automatic:false}),{mode:'off',images:[],omitted:[]});assert.equal(read.calls.length,0);
 const selection={messageId:records[0].messageId,index:1},result=selectVisionContext({...options,automatic:true,selectedImages:[selection,selection]});
 assert.equal(result.mode,'manual');assert.equal(result.images.length,1);assert.equal(result.images[0].messageId,selection.messageId);
 assert.equal(result.images[0].speaker,'me');assert.equal(result.images[0].at,records[0].timestamp);assert.equal(read.calls.length,1);
 assert.match(result.images[0].url,/^data:image\/png;base64,/);assert.equal(result.images[0].bytes,Buffer.byteLength('synthetic bytes, no image pixels'));
 assert.deepEqual(result.omitted,[]);assert.equal(JSON.stringify(records),before);
});
test('automatic takes the newest three images from the fixed latest twenty records and emits chronology',()=>{
 const records=Array.from({length:25},(_,index)=>picture(String(910000000000000000n+BigInt(index)),NOW-(25-index)*1000,index%2===0)),read=reader();
 const result=selectVisionContext({records:records.slice().reverse(),availableSources:sources(records),automatic:true,now:NOW,...read});
 assert.equal(result.mode,'automatic');assert.deepEqual(result.images.map(image=>image.messageId),records.slice(-3).map(record=>record.messageId));
 assert.equal(read.calls.length,3);assert.deepEqual(result.images.map(image=>image.speaker),['me','contact','me']);
 const latestText=Array.from({length:20},(_,index)=>normalize(raw(String(920000000000000000n+BigInt(index)),false,{msgTime:String(NOW/1000+index),elements:[{textElement:{content:'Synthetic text only'}}]}),scope));
 const outside=reader();const fixed=selectVisionContext({records:[records[0],...latestText],availableSources:sources([records[0],...latestText]),automatic:true,now:NOW+20000,...outside});
 assert.equal(fixed.images.length,0);assert.equal(outside.calls.length,0,'no image history walk beyond the twenty-record window');
});
test('twenty-four-hour boundaries exclude old/future images while older explicit reply focus has priority',()=>{
 const records=[picture('930000000000000001',NOW-2*DAY),picture('930000000000000002',NOW-2*60*60*1000),
  picture('930000000000000003',NOW-60*60*1000),picture('930000000000000004',NOW-1000),picture('930000000000000005',NOW+1000)];
 const result=selectVisionContext({records,availableSources:sources(records),automatic:true,now:NOW,replyMessageIds:[records[0].messageId],...reader()});
 assert.deepEqual(result.images.map(image=>image.messageId),[records[0].messageId,records[2].messageId,records[3].messageId]);
 const boundary=[picture('930000000000000006',NOW-DAY),picture('930000000000000007',NOW-DAY-1000)];
 assert.deepEqual(selectVisionContext({records:boundary,availableSources:sources(boundary),automatic:true,now:NOW,...reader()}).images.map(image=>image.messageId),[boundary[0].messageId]);
});
test('automatic reports only available-source cache misses and skips unavailable sources without references',()=>{
 const records=[picture('940000000000000001',NOW-5000),picture('940000000000000002',NOW-4000),picture('940000000000000003',NOW-3000),
  picture('940000000000000004',NOW-2000,false,1,{recallTime:'1791950399'}),picture('940000000000000005',NOW-1000)];
 const available=sources(records).filter(source=>source.id!==`qq:${records[1].messageId}`).map(source=>source.id===`qq:${records[2].messageId}`?{...source,excluded:true}:source);
 const read=reader([records[0].messageId]),result=selectVisionContext({records,availableSources:available,automatic:true,now:NOW,...read});
 assert.deepEqual(result.images.map(image=>image.messageId),[records[4].messageId]);
 assert.deepEqual(result.omitted,[{sourceId:`qq:${records[0].messageId}`,index:1,reason:'cache_unavailable'}]);
 assert.deepEqual(read.calls.map(call=>call.messageId),[records[4].messageId,records[0].messageId]);
 for(const record of records.slice(1,4))assert.equal(JSON.stringify(result).includes(record.messageId),false);
});
test('manual missing, recalled, excluded or wrong-index selections fail before cache reads; cache errors remain clear',()=>{
 const record=picture('950000000000000001'),recalled=picture('950000000000000002',NOW-1000,false,1,{recallTime:'1791950399'}),read=reader();
 const base={records:[record,recalled],availableSources:sources([record,recalled]),automatic:true,now:NOW,...read};
 for(const choice of [{messageId:'missing',index:1},{messageId:recalled.messageId,index:1},{messageId:record.messageId,index:0},{messageId:record.messageId,index:-1}])
  assert.throws(()=>selectVisionContext({...base,selectedImages:[choice]}),/来源已撤回或不再用于助手|没有所选图片|索引不合法/);
 assert.throws(()=>selectVisionContext({...base,availableSources:[],selectedImages:[{messageId:record.messageId,index:1}]}),/来源已撤回或不再用于助手/);
 assert.equal(read.calls.length,0);
 const cache=reader([record.messageId]);assert.throws(()=>selectVisionContext({...base,...cache,selectedImages:[{messageId:record.messageId,index:1}]}),error=>{
  assert.equal(error.code,'vision_cache_unavailable');assert.match(error.message,/QQ缓存/);assert.equal(error.message.includes('/synthetic/'),false);return true;
 });
});
test('manual image order is chronological and more than three distinct selections fail clearly',()=>{
 const records=[picture('960000000000000001',NOW-2000,false,2),picture('960000000000000002',NOW-1000,true,2)],read=reader();
 const base={records,availableSources:sources(records),now:NOW,...read};
 const result=selectVisionContext({...base,selectedImages:[{messageId:records[1].messageId,index:2},{messageId:records[0].messageId,index:2},{messageId:records[0].messageId,index:1}]});
 assert.deepEqual(result.images.map(image=>[image.messageId,image.index]),[[records[0].messageId,1],[records[0].messageId,2],[records[1].messageId,2]]);
 assert.throws(()=>selectVisionContext({...base,selectedImages:records.flatMap(record=>record.media.map(media=>({messageId:record.messageId,index:media.index})))}),/最多选择三张/);
});
test('cache-miss candidate iteration is bounded even for a large media burst',()=>{
 const record=picture('970000000000000001',NOW-1000,false,150),read=reader([record.messageId]);
 const result=selectVisionContext({records:[record],availableSources:sources([record]),automatic:true,now:NOW,...read});
 assert.equal(result.images.length,0);assert.equal(read.calls.length,60);assert.equal(result.omitted.length,60);
 assert.equal(new Set(read.calls.map(call=>call.index)).size,60);
});
