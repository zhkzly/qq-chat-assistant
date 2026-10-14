'use strict';
const {compare}=require('./messages.cjs');
const {readImage}=require('./media.cjs');

const DAY_MS=24*60*60*1000,MAX_IMAGES=3,MAX_AUTO_CANDIDATES=60,MAX_FOCUS_MESSAGES=12;
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp']);
function selectionError(code,message){const error=new Error(message);error.code=code;return error;}
function selectVisionContext({records=[],availableSources=[],selectedImages=[],replyMessageIds=[],automatic=false,now=Date.now(),readImageFn=readImage}={}){
 const manual=Array.isArray(selectedImages)&&selectedImages.length>0;
 const mode=manual?'manual':automatic===true?'automatic':'off';
 if(mode==='off')return {mode,images:[],omitted:[]};
 if(!Number.isFinite(now)||typeof readImageFn!=='function')throw selectionError('vision_selection_invalid','图片上下文参数不合法');
 const available=new Set(availableSources.filter(source=>source?.type==='qq'&&!source.deleted&&!source.excluded&&source.use!=='disabled').map(source=>source.id));
 const actual=records.filter(record=>record?.kind==='actual'&&typeof record.messageId==='string'&&Number.isFinite(record.timestamp)).sort(compare);
 const byId=new Map(actual.map(record=>[record.messageId,record]));
 const allowed=record=>record&&!record.recalled&&record.text!=='[已撤回]'&&available.has(`qq:${record.messageId}`);
 const imageAt=(record,index)=>record.media?.some(media=>media.kind==='image'&&media.index===index);
 const candidates=[],seen=new Set();
 const add=(record,index)=>{const key=`${record.messageId}:${index}`;if(!seen.has(key)){seen.add(key);candidates.push({record,index});}};
 if(manual){
  for(const selected of selectedImages){
   if(!selected||typeof selected.messageId!=='string'||!Number.isSafeInteger(selected.index)||selected.index<0)
    throw selectionError('vision_selection_invalid','所选图片标识或索引不合法');
   const record=byId.get(selected.messageId);
   if(!allowed(record))throw selectionError('vision_source_unavailable','所选图片来源已撤回或不再用于助手，请重新选择');
   if(!imageAt(record,selected.index))throw selectionError('vision_selection_invalid','当前消息没有所选图片，请重新选择');
   add(record,selected.index);
   if(candidates.length>MAX_IMAGES)throw selectionError('vision_selection_limit','一次最多选择三张图片');
  }
 }else{
  // The recent window is fixed before availability filtering: removing a source
  // never silently expands automatic access farther into conversation history.
  const recent=new Set(actual.slice(-20).filter(record=>record.timestamp>=now-DAY_MS&&record.timestamp<=now).map(record=>record.messageId));
  const requestedFocus=new Set(Array.isArray(replyMessageIds)?replyMessageIds.filter(id=>typeof id==='string'):[]);
  const focus=new Set(actual.filter(record=>requestedFocus.has(record.messageId)).slice(-MAX_FOCUS_MESSAGES).map(record=>record.messageId));
  const prioritized=actual.filter(record=>allowed(record)&&(focus.has(record.messageId)||recent.has(record.messageId)))
   .sort((a,b)=>Number(focus.has(b.messageId))-Number(focus.has(a.messageId))||compare(b,a));
  for(const record of prioritized){
   const media=(record.media||[]).filter(item=>item.kind==='image'&&Number.isSafeInteger(item.index)&&item.index>=0).sort((a,b)=>b.index-a.index);
   for(const item of media){add(record,item.index);if(candidates.length>=MAX_AUTO_CANDIDATES)break;}
   if(candidates.length>=MAX_AUTO_CANDIDATES)break;
  }
 }
 const images=[],omitted=[];
 for(const {record,index} of candidates){
  if(images.length>=MAX_IMAGES)break;
  let image;
  try{
   image=readImageFn(record,index);
   if(!IMAGE_TYPES.has(image?.type)||!Buffer.isBuffer(image.data)||!image.data.length||image.data.length>8*1024*1024)throw new Error('Invalid cached image');
  }catch{
   if(manual)throw selectionError('vision_cache_unavailable','所选图片尚未在QQ缓存，请先在QQ查看原图后重试');
   omitted.push({sourceId:`qq:${record.messageId}`,index,reason:'cache_unavailable'});continue;
  }
  images.push({url:`data:${image.type};base64,${image.data.toString('base64')}`,messageId:record.messageId,index,bytes:image.data.length,
   speaker:record.direction==='outgoing'?'me':'contact',at:record.timestamp});
 }
 images.sort((a,b)=>compare(byId.get(a.messageId),byId.get(b.messageId))||a.index-b.index);
 return {mode,images,omitted};
}
module.exports={selectVisionContext};
