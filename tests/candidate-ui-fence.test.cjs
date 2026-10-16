'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../ui/app.js'),'utf8');
const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const elements={'assistant-input':{value:'太直白了，换含蓄一点。',focus(){}},'assistant-tools':{open:true},draft:{value:'Independent unsent draft'}};
 const sandbox={Date,Set,elements};vm.createContext(sandbox);
 const withdrawal=source.includes('function withdrawCurrentCandidate(')?between('function withdrawCurrentCandidate(', 'function currentCandidate('):'';
 vm.runInContext(`let state={scope:{accountUid:'owner',accountUin:'11111',peerUid:'contact',peerUin:'22222'},revision:9,modelConsent:true,advice:{requestId:'previous',scope:{accountUid:'owner',accountUin:'11111',peerUid:'contact',peerUin:'22222'},revision:9,expiresAt:new Date(Date.now()+60000).toISOString()}};
 let scopeKey='selected',assistantPending=false,historyEpoch=0,composerEditVersion=0,selectedDiscussion=null,nextPurpose='discussion',draftMaterialIds=new Set(),locallyWithdrawnCandidate=null;
 const $=id=>elements[id];const keyOf=()=>scopeKey;function showWorkspace(){}function renderCompanion(){}function companionError(){}function companionAction(){return new Promise(()=>{})}function saveOptions(){return new Promise(()=>{})}
 ${withdrawal}
 ${between('function currentCandidate(', 'function userRequestBusy(')}
 ${between('function userRequestBusy(', 'function renderCurrentCandidates(')}
 ${between('async function submitAssistant(', 'function initializeCompanion(')}
 ${between('async function requestCurrentCandidates(', "$('generate').onclick")}`,sandbox);
 assert.ok(vm.runInContext('currentCandidate()',sandbox),'the source-shaped current candidate must be available before an explicit new request');return sandbox;
}
test('submitting a private correction immediately fences the old candidate before any API response',()=>{
 const sandbox=fixture();vm.runInContext("submitAssistant('discussion')",sandbox);
 assert.equal(vm.runInContext('assistantPending',sandbox),true);assert.equal(vm.runInContext('currentCandidate()',sandbox),null);
 assert.equal(sandbox.elements.draft.value,'Independent unsent draft');
 vm.runInContext('assistantPending=false',sandbox);assert.equal(vm.runInContext('currentCandidate()',sandbox),null,'a failed request or stale poll cannot resurrect the explicitly withdrawn candidate');
});
test('requesting another opening fences the old candidate before options and suggestion dispatch',()=>{
 const sandbox=fixture();vm.runInContext('requestCurrentCandidates({alternative:true})',sandbox);assert.equal(vm.runInContext('currentCandidate()',sandbox),null);assert.equal(sandbox.elements.draft.value,'Independent unsent draft');
});
test('typing and automatic progress do not themselves withdraw an otherwise current candidate',()=>{
 const sandbox=fixture();vm.runInContext("elements['assistant-input'].value='A thought still being typed';state.assistantBusy=true;state.assistantOrigin='automatic'",sandbox);assert.equal(vm.runInContext('currentCandidate()?.requestId',sandbox),'previous');
});
