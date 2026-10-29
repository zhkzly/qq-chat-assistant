'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
for(const [name,body]of [['reject',"throw Error('Cannot create implementation')"],['hang','await new Promise(()=>{})']]){
 test(`CLI finalizes incomplete artifacts when an adapter factory ${name}s`,t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-replay-cli-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const adapter=path.join(directory,'adapter.cjs'),out=path.join(directory,'artifacts');
  fs.writeFileSync(adapter,`module.exports={createAdapterFactory:()=>({create:async()=>{${body}}})};`);
  const result=spawnSync(process.execPath,[path.join(root,'scripts/eval-replay-cli.cjs'),'--adapter',adapter,'--id','conv-reconnect-no-anchor','--out',out,'--timeout-ms','30'],{cwd:root,encoding:'utf8',timeout:10000});
  assert.ifError(result.error);assert.equal(result.status,1,result.stderr);
  const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));
  assert.equal(manifest.status,'incomplete');assert.equal(manifest.episodes.length,1);assert.equal(manifest.episodes[0].status,'incomplete');
  const review=JSON.parse(fs.readFileSync(path.join(out,'conv-reconnect-no-anchor.review.json')));
  assert.equal(review.review.status,'not_run');assert.equal(review.review.overall,null);assert.ok(review.error);
 });
}
