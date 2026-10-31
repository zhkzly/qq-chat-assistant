'use strict';
// Actual UI function with a minimal DOM fixture; synthetic UI evidence only.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8');
const body=source.slice(source.indexOf('function renderMemoryStatus(){'),source.indexOf('function renderActionPanels('));
function view(memoryStatus,scope={peerUid:'fictional-contact'}){
 const nodes=new Map(),state={scope,memoryStatus,modelConsent:true,assistantBusy:false};
 const render=vm.runInNewContext('('+body+')',{state,memoryRetryPending:false,$:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}});render();return nodes;
}
test('finished source cursors cannot display semantic completion while review work remains ready or deferred',()=>{
 const nodes=view({pending:0,semanticPending:2,recoveryReady:1,recoveryDeferred:1,status:'complete'}),text=nodes.get('memory-status').textContent;
 assert.match(text,/部分理解仍待核对/);assert.match(text,/2 条理解待核对/);assert.match(text,/可复核 1，暂缓 1/);assert.doesNotMatch(text,/记忆已更新/);
});
test('status remains a read projection for completed or older backends and clears when no contact is selected',()=>{
 assert.doesNotMatch(view({pending:0}).get('memory-status').textContent,/NaN|undefined|理解待核对/);
 assert.equal(view({pending:0,semanticPending:1,recoveryReady:0,recoveryDeferred:1},null).get('memory-status').textContent,'');
});
