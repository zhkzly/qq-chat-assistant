'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {extractMedia,publicRecord,readImage}=require('../src/media.cjs');
test('native PicElement and image FileElement retain scoped cached paths without exposing paths publicly',()=>{
 const media=extractMedia([{picElement:{sourcePath:'/synthetic/qq/original.png',thumbPath:new Map([[1,'/synthetic/qq/thumb.png']]),fileName:'photo.png'}},{fileElement:{fileName:'image.jpg',filePath:'/synthetic/qq/image.jpg'}},{fileElement:{fileName:'notes.txt',filePath:'/private/notes.txt'}}]);
 assert.equal(media.length,2);assert.equal(media[0].localPaths.length,2);assert.equal(JSON.stringify(publicRecord({media})).includes('/synthetic'),false);
});
test('only real image bytes inside approved roots can be served; path tricks and nonimages fail',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'qq-media-'));const good=path.join(folder,'picture.png');fs.writeFileSync(good,Buffer.from([137,80,78,71,13,10,26,10,0,0]));
 try{assert.equal(readImage({media:[{index:0,localPaths:[good]}]},0,{roots:[folder]}).type,'image/png');
  const text=path.join(folder,'fake.png');fs.writeFileSync(text,'not an image');assert.throws(()=>readImage({media:[{index:0,localPaths:[text]}]},0,{roots:[folder]}),/缓存/);
  assert.throws(()=>readImage({media:[{index:0,localPaths:[good]}]},0,{roots:[path.join(folder,'missing')]}),/缓存/);
  assert.throws(()=>readImage({media:[]},0,{roots:[folder]}),/没有/);
 }finally{fs.rmSync(folder,{recursive:true,force:true})}
});
