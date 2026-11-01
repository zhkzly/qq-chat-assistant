'use strict';
// The frozen baseline is read only and is used solely to create a fictional
// pre-upgrade database. No actual user database or model transport is opened.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
module.exports=function baseline038(){
 const root=path.resolve(__dirname,'../..'),marker=path.join(root,'.git'),gitdir=fs.statSync(marker).isDirectory()?marker:path.resolve(root,fs.readFileSync(marker,'utf8').trim().replace(/^gitdir: /,'')),common=fs.existsSync(path.join(gitdir,'commondir'))?path.resolve(gitdir,fs.readFileSync(path.join(gitdir,'commondir'),'utf8').trim()):gitdir;
 const base=path.join(path.dirname(common),'.worktrees/memory-episode-target-038'),file=path.join(base,'src/store.cjs');
 assert.equal(require(path.join(base,'scripts/eval-qq-adapter.cjs')).implementationIdentity({sourceRoot:base}).hash,'3f32757ba4318c3bd35dc58d7f9dcb7984e0ffdef609cd1af5abecb0e21f6658','baseline038 source must remain frozen');
 return {Store:require(file).Store,writeRelationshipRecords:require(path.join(base,'src/relationship-store.cjs')).writeRelationshipRecords,relationshipProtocol:require(path.join(base,'src/assistant-model.cjs')).RELATIONSHIP_PROTOCOL,storeSha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
};
