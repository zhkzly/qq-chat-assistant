'use strict';
const fs=require('node:fs');const path=require('node:path');
const IMAGE_NAME=/\.(?:png|jpe?g|gif|webp)$/i;
function pathValues(value){if(value instanceof Map)return [...value.values()];if(Array.isArray(value))return value.flatMap(v=>Array.isArray(v)?v.slice(1):v);if(value&&typeof value==='object')return Object.values(value);return []}
function extractMedia(elements){const result=[];
 for(const [index,element] of (elements||[]).entries()){
  const pic=element.picElement,file=element.fileElement;
  if(!pic && !(file&&IMAGE_NAME.test(file.fileName||'')))continue;
  const data=pic||file;const candidates=[data.sourcePath,data.filePath,...pathValues(data.thumbPath),...pathValues(data.picThumbPath)].filter(p=>typeof p==='string'&&path.isAbsolute(p));
  result.push({index,kind:'image',name:String(data.fileName||'图片').slice(0,180),width:Number(data.picWidth)||null,height:Number(data.picHeight)||null,localPaths:[...new Set(candidates)]});
 }return result;
}
function publicRecord(message){const copy={...message};if(message.media)copy.media=message.media.map(({localPaths,...data})=>data);return copy}
function mime(data){if(data.length>=8&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';if(data.subarray(0,6).toString().match(/^GIF8[79]a$/))return 'image/gif';if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return 'image/webp';return null}
function readImage(message,index,{roots}={}){
 const media=message?.media?.find(m=>m.index===Number(index));if(!media)throw new Error('当前消息没有这张图片');
 const allowed=(roots||[path.join(process.env.HOME,'.config/QQ'),path.join(process.env.HOME,'Downloads')]).filter(fs.existsSync).map(p=>fs.realpathSync(p));
 for(const candidate of media.localPaths||[]){try{
  const real=fs.realpathSync(candidate);if(!allowed.some(root=>real===root||real.startsWith(root+path.sep)))continue;
  const stat=fs.statSync(real);if(!stat.isFile()||stat.size>8*1024*1024)continue;
  const data=fs.readFileSync(real);const type=mime(data);if(type)return {data,type};
 }catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error}}
 throw new Error('QQ 尚未缓存可显示的图片，请先在 QQ 查看原图后重试');
}
module.exports={extractMedia,publicRecord,readImage,mime};
