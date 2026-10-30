'use strict';
// Program metadata/source-closure checks only, not model understanding, wording
// quality, or desktop integration. The original source and exact admitted
// fragment below derive from fictional actual021 long-history evidence:
// .goal-runs/context-021-candidate-live/coverage-long-private-consultation.run.json
// steps[0].diagnostics.snapshot.companion.runs[0].requests[1].payload.sources[0]
// and steps[1].diagnostics.snapshot.companion.runs[1].payload.outboundQuotes[0].
// Additional malformed, note and scope variants are explicit synthetic cases.
const test=require('node:test'),assert=require('node:assert/strict');
const {buildMaterialProvenance}=require('../src/context/material-provenance.cjs');
const {assertDraftSourcesCurrent}=require('../src/context/draft-material.cjs');
const {scope}=require('./fixtures/native.cjs');
const ACTUAL_OLD_SOURCE={"id":"private:lp-u0","type":"private","text":"我做的是给自己记读书笔记的小网页，不是公司项目，也没有替别人做商业网站。查找功能终于能按标题找回自己的摘记，这个小进展我愿意告诉她。我已经定下十月三日那个周六下午三点以后有空，也愿意在合适的时候让她看这个个人页面；之前的时段另有私事，不想解释给她。家里人的复查安排只在这里和你商量，不写进对外的话。平时可以直接说我自己的开心，不用把一个个人小项目包装成能力展示。","at":"2026-08-31T10:00:00.000Z","role":"user","use":"discussion","kind":"discussion","version":1,"revision":"cd55b0871967666658dfe29e12c36782df866a8d1a2fd264422207109c0b40a9","historicalOnly":true,"continuationCoverage":"later_private_sources_omitted"};
const FRAGMENT='查找功能终于能按标题找回自己的摘记',NOW='2026-10-01T10:25:00.000Z',OLD='2026-08-31T10:00:00.000Z';
const clone=value=>structuredClone(value);
function source(id,overrides={}){return {id,type:'private',role:'user',text:FRAGMENT+' SOURCE_BODY_SENTINEL '+id,at:OLD,revision:'revision-'+id,use:'discussion',...overrides};}
function note(id,parents=[],overrides={}){return source(id,{type:'note',role:undefined,at:NOW,text:FRAGMENT+' NOTE_BODY_SENTINEL '+id,
 evidenceSourceIds:parents.map(parent=>parent.id),evidenceRevisions:Object.fromEntries(parents.map(parent=>[parent.id,parent.revision])),...overrides});}
function prepared(sources,all=sources){return {payload:{sources:clone(sources),asOf:NOW,goal:'PRIVATE_GOAL_SENTINEL',userRequest:{sourceId:'private:permission',text:'PERMISSION_TEXT_SENTINEL'}},
 fullAvailableSources:clone(all),manifest:{scope:clone(scope),sourceRevisions:Object.fromEntries(all.map(item=>[item.id,item.revision]))}};}
const quote=(sourceId,text=FRAGMENT)=>({sourceId,text});
function project(input,quotes){return buildMaterialProvenance(input,quotes,{scope});}
const metadataKeys=['sourceId','revision','type','role','recordedAt','timeStatus','timeMeaning'];
function noPrivateBodies(result,allowed=FRAGMENT){
 const serialized=JSON.stringify(result.quotes);
 for(const value of ['SOURCE_BODY_SENTINEL','NOTE_BODY_SENTINEL','PERMISSION_TEXT_SENTINEL','PRIVATE_GOAL_SENTINEL'])assert.equal(serialized.includes(value),false,value);
 for(const item of result.quotes){for(const metadata of [item.provenance.source,...item.provenance.roots])assert.deepEqual(Object.keys(metadata).sort(),[...metadataKeys].sort());assert.equal(item.text,allowed);}
}

test('the actual August source retains its recording date under October permission and request time',()=>{
 const permission=source('private:permission',{at:NOW,text:'PERMISSION_TEXT_SENTINEL: this fragment may be used now.'});
 const input=prepared([ACTUAL_OLD_SOURCE,permission]),before=clone(input),result=project(input,[quote(ACTUAL_OLD_SOURCE.id)]),p=result.quotes[0].provenance;
 assert.deepEqual(p.source,{sourceId:ACTUAL_OLD_SOURCE.id,revision:ACTUAL_OLD_SOURCE.revision,type:'private',role:'user',recordedAt:OLD,timeStatus:'known',timeMeaning:'private_statement_recorded'});
 assert.equal(p.timeSemantics,'recording_not_occurrence');assert.deepEqual(p.roots,[]);assert.equal(p.rootCount,0);assert.equal(p.metadataCompleteness,'complete');
 assert.deepEqual(result.dependencies,[{sourceId:ACTUAL_OLD_SOURCE.id,revision:ACTUAL_OLD_SOURCE.revision}]);
 assert.equal(result.quotes[0].text,FRAGMENT);assert.deepEqual(input,before);
 assert.equal(JSON.stringify(result).includes('家里人的复查安排'),false);assert.equal(JSON.stringify(result).includes('PERMISSION_TEXT_SENTINEL'),false);
});

test('model-authored provenance cannot replace the program source and exact admitted text',()=>{
 const original=source('private:spoof'),input=prepared([original]),selected={...quote(original.id),provenance:{source:{sourceId:'fake',recordedAt:NOW,eventAt:NOW},authorization:'SPOOFED_GRANT'},at:NOW,sourceAt:NOW,eventAt:NOW};
 const before=clone(selected),result=project(input,[selected]);
 assert.deepEqual(Object.keys(result.quotes[0]).sort(),['provenance','sourceId','text']);assert.equal(result.quotes[0].text,FRAGMENT);
 assert.equal(result.quotes[0].provenance.source.recordedAt,OLD);assert.equal(result.quotes[0].provenance.source.sourceId,original.id);
 assert.equal(JSON.stringify(result).includes('SPOOFED_GRANT'),false);assert.equal(JSON.stringify(result).includes('eventAt'),false);assert.deepEqual(selected,before);noPrivateBodies(result);
});

test('a current statement about last year records when it was stated without inventing an occurrence date',()=>{
 const text='今天想起去年去过那家书店。',original=source('private:reported-past',{at:NOW,text}),result=project(prepared([original]),[quote(original.id,text)]),p=result.quotes[0].provenance;
 assert.equal(p.source.recordedAt,NOW);assert.equal(p.source.timeMeaning,'private_statement_recorded');assert.equal(p.timeSemantics,'recording_not_occurrence');
 assert.equal(JSON.stringify(p).includes('eventAt'),false);assert.equal(JSON.stringify(p).includes('occurredAt'),false);assert.equal(result.quotes[0].text,text);
});

test('a genuinely current statement keeps its current qualifier and recording date unchanged',()=>{
 const text='今天我刚把查找功能弄好了。',original=source('private:current-progress',{at:NOW,text}),result=project(prepared([original]),[quote(original.id,text)]);
 assert.equal(result.quotes[0].text,text);assert.equal(result.quotes[0].provenance.source.recordedAt,NOW);assert.equal(result.quotes[0].provenance.source.timeStatus,'known');
});

test('unknown or invalid recording dates stay explicitly unknown rather than falling back to request time',()=>{
 for(const at of [undefined,null,'','not-a-date','2026-02-30T10:00:00.000Z','2026-10-01T25:00:00Z',0]){
  const original=source('private:unknown-time',{at}),result=project(prepared([original]),[quote(original.id)]),metadata=result.quotes[0].provenance.source;
  assert.equal(metadata.recordedAt,null,String(at));assert.equal(metadata.timeStatus,'unknown',String(at));assert.notEqual(metadata.recordedAt,NOW);
 }
});

test('valid ISO offsets retain the original instant in normalized recording metadata',()=>{
 const original=source('private:offset',{at:'2026-08-31T18:00:00+08:00'}),result=project(prepared([original]),[quote(original.id)]);
 assert.equal(result.quotes[0].provenance.source.recordedAt,OLD);
});

test('a current note edit carries the old root statement time with distinct metadata meanings',()=>{
 const root=source('private:old-root'),derived=note('note:current-edit',[root]),input=prepared([derived],[root,derived]),before=clone(input),result=project(input,[quote(derived.id)]),p=result.quotes[0].provenance;
 assert.equal(p.source.recordedAt,NOW);assert.equal(p.source.timeMeaning,'note_edited');assert.equal(p.source.role,'unknown');
 assert.equal(p.roots[0].sourceId,root.id);assert.equal(p.roots[0].recordedAt,OLD);assert.equal(p.roots[0].timeMeaning,'private_statement_recorded');
 assert.equal(p.rootCount,1);assert.equal(p.metadataCompleteness,'complete');assert.deepEqual(new Set(result.dependencies.map(item=>item.sourceId)),new Set([root.id,derived.id]));
 noPrivateBodies(result);assert.deepEqual(input,before);
});

test('an authored note without declared parents has complete edit metadata without inventing original occurrence',()=>{
 for(const parents of [undefined,null,[]]){
  const original=note('note:authored');original.evidenceSourceIds=parents;delete original.evidenceRevisions;
  const result=project(prepared([original]),[quote(original.id)]),p=result.quotes[0].provenance;
  assert.equal(p.metadataCompleteness,'complete');assert.equal(p.rootCount,0);assert.deepEqual(p.roots,[]);assert.equal(p.source.timeMeaning,'note_edited');assert.equal(p.timeSemantics,'recording_not_occurrence');
  assert.deepEqual(result.dependencies,[{sourceId:original.id,revision:original.revision}]);
 }
});

test('unknown root times stay unknown even when the note was edited today',()=>{
 const root=source('private:undated-root',{at:null}),derived=note('note:dated-edit',[root]),result=project(prepared([derived],[root,derived]),[quote(derived.id)]),p=result.quotes[0].provenance;
 assert.equal(p.source.recordedAt,NOW);assert.equal(p.roots[0].recordedAt,null);assert.equal(p.roots[0].timeStatus,'unknown');assert.equal(p.metadataCompleteness,'complete');
});

test('a legacy note without saved root revisions cannot bind a current parent date as original provenance',()=>{
 const root=source('private:legacy-root'),derived=note('note:legacy-unbound',[root]);delete derived.evidenceRevisions;
 for(const currentRoot of [root,{...root,revision:'a-later-live-parent-revision',at:NOW}]){
  const result=project(prepared([derived],[currentRoot,derived]),[quote(derived.id)]),p=result.quotes[0].provenance;
  assert.equal(p.source.timeMeaning,'note_edited');assert.equal(p.source.recordedAt,NOW);
  assert.equal(p.metadataCompleteness,'roots_unknown','unversioned root identity cannot establish bound root recording metadata');
  for(const metadata of p.roots){assert.equal(metadata.recordedAt,null);assert.equal(metadata.timeStatus,'unknown');}
  assert.deepEqual(result.dependencies,[{sourceId:derived.id,revision:derived.revision}],'unknown initial ancestry adds no temporal root dependency');
  noPrivateBodies(result);
 }
});

test('root metadata has an explicit cap while all leaf and intermediate dependencies remain available privately',()=>{
 const roots=Array.from({length:10},(_,index)=>source(`private:root-${index}`)),intermediate=note('note:intermediate',roots),derived=note('note:derived',[intermediate]);
 const result=project(prepared([derived],[...roots,intermediate,derived]),[quote(derived.id)]),p=result.quotes[0].provenance;
 assert.equal(p.roots.length,8);assert.equal(p.rootCount,10);assert.equal(p.metadataCompleteness,'roots_summarized');
 assert.deepEqual(p.roots.map(item=>item.sourceId),roots.slice(0,8).map(item=>item.id));
 assert.equal(result.dependencies.length,12);assert.deepEqual(new Set(result.dependencies.map(item=>item.sourceId)),new Set([...roots.map(item=>item.id),intermediate.id,derived.id]));
 for(const dependency of result.dependencies)assert.deepEqual(Object.keys(dependency).sort(),['revision','sourceId']);
 assert.equal(Object.hasOwn(result.quotes[0],'dependencies'),false);assert.equal(Object.hasOwn(p,'dependencies'),false);noPrivateBodies(result);
});

test('initially unverifiable declared note ancestry is unknown with note-only temporal dependencies',()=>{
 const root=source('private:required-root'),derived=note('note:required',[root]);
 const cycle=clone(derived);cycle.evidenceSourceIds=[cycle.id];cycle.evidenceRevisions={[cycle.id]:cycle.revision};
 const inputs=[prepared([derived],[derived]),prepared([derived],[{...root,revision:'new-root-revision'},derived]),prepared([cycle]),
  ...[{deleted:true},{excluded:true},{use:'disabled'}].map(patch=>prepared([derived],[{...root,...patch},derived]))];
 for(const input of inputs){const result=project(input,[quote(derived.id)]),p=result.quotes[0].provenance;
  assert.equal(p.metadataCompleteness,'roots_unknown');assert.deepEqual(p.roots,[]);assert.equal(p.source.recordedAt,NOW);
  assert.deepEqual(result.dependencies,[{sourceId:derived.id,revision:derived.revision}]);noPrivateBodies(result);
 }
});

test('direct QQ, private and feedback records use only their own recording metadata despite irrelevant parent links',()=>{
 for(const type of ['qq','private','feedback'])for(const parentKind of ['missing','cycle','foreign','excluded']){
  const id=`${type}:direct-${parentKind}`,parent=source('private:irrelevant-parent',{scope:{...scope,peerUid:'foreign-contact'},excluded:parentKind==='excluded'});
  const direct=source(id,{type,role:type==='qq'?'contact':'user',evidenceSourceIds:[parentKind==='cycle'?id:parent.id],evidenceRevisions:{[parent.id]:'unavailable-old-revision'}});
  const input=prepared([direct],parentKind==='missing'?[direct]:[direct,parent]),result=project(input,[quote(id)]),p=result.quotes[0].provenance;
  assert.equal(p.source.recordedAt,OLD);assert.equal(p.source.timeStatus,'known');assert.equal(p.metadataCompleteness,'complete');assert.deepEqual(p.roots,[]);
  assert.deepEqual(result.dependencies,[{sourceId:id,revision:direct.revision}]);noPrivateBodies(result);
 }
});

test('an unavailable or manifest-changed admitted source is still denied independently of ancestry metadata policy',()=>{
 for(const type of ['private','qq','feedback','note'])for(const patch of [{deleted:true},{excluded:true},{use:'disabled'}]){
  const original=source(`${type}:own-unavailable`,{type,...patch});assert.throws(()=>project(prepared([original]),[quote(original.id)]),/Unavailable|admitted/i);
 }
 const original=source('private:own-manifest-bound'),input=prepared([original]);input.manifest.sourceRevisions[original.id]='older-captured-revision';
 assert.throws(()=>project(input,[quote(original.id)]),/changed|revision/i);
});

test('an assistant-authored root is labeled as generated recording metadata rather than a user statement',()=>{
 const root=source('private:assistant-root',{role:'assistant'}),derived=note('note:assistant-derived',[root]),result=project(prepared([derived],[root,derived]),[quote(derived.id)]),p=result.quotes[0].provenance;
 assert.equal(p.roots[0].role,'assistant');assert.equal(p.roots[0].timeMeaning,'assistant_generated_recorded');assert.equal(p.roots[0].recordedAt,OLD);
 assert.equal(p.roleSemantics,'record_author_not_fact_subject');assert.equal(p.timeSemantics,'recording_not_occurrence');noPrivateBodies(result);
});

test('scope fences cover the prepared request, admitted source and every transitive root',()=>{
 const root=source('private:scoped-root',{scope:clone(scope)}),derived=note('note:scoped',[root],{scope:clone(scope)}),input=prepared([derived],[root,derived]);
 assert.doesNotThrow(()=>project(input,[quote(derived.id)]));
 for(const key of ['accountUid','accountUin','peerUid','peerUin']){
  assert.throws(()=>buildMaterialProvenance(input,[quote(derived.id)],{scope:{...scope,[key]:'other'}}),/scope|foreign/i);
  assert.throws(()=>project(prepared([derived],[{...root,scope:{...scope,[key]:'other'}},derived]),[quote(derived.id)]),/scope|foreign/i);
  const foreign={...derived,scope:{...scope,[key]:'other'}};assert.throws(()=>project(prepared([foreign],[root,foreign]),[quote(foreign.id)]),/scope|foreign/i);
 }
});

test('a changed admitted source cannot borrow metadata from a different captured revision',()=>{
 const original=source('private:revision-bound'),input=prepared([original],[{...original,revision:'changed-captured-version'}]);
 assert.throws(()=>project(input,[quote(original.id)]),/changed|revision/i);
 assert.throws(()=>project(prepared([original],[]),[quote(original.id)]),/changed|source/i);
});

test('all closure dependencies support the existing late revision, withdrawal and scope fence',()=>{
 const roots=Array.from({length:10},(_,index)=>source(`private:late-root-${index}`)),derived=note('note:late',roots),all=[...roots,derived];
 const result=project(prepared([derived],all),[quote(derived.id)]),handoff={manifest:{sourceRevisions:Object.fromEntries(result.dependencies.map(item=>[item.sourceId,item.revision]))}},ids=result.dependencies.map(item=>item.sourceId);
 assert.doesNotThrow(()=>assertDraftSourcesCurrent(handoff,ids,{scope,availableSources:all}));
 // The last root is outside the public metadata cap and still binds validity.
 const outside=roots.at(-1);assert.equal(result.quotes[0].provenance.roots.some(item=>item.sourceId===outside.id),false);
 for(const patch of [{revision:'late-root-change'},{deleted:true},{excluded:true},{use:'disabled'},{scope:{...scope,peerUid:'other'}}]){
  const live=all.map(item=>item.id===outside.id?{...item,...patch}:item);assert.throws(()=>assertDraftSourcesCurrent(handoff,ids,{scope,availableSources:live}),/来源版本已变化/);
 }
 assert.throws(()=>assertDraftSourcesCurrent(handoff,ids,{scope,availableSources:all.filter(item=>item.id!==outside.id)}),/来源版本已变化/);
});

test('similar statements with different identity, speaker, date, negation or details remain separate exact fragments',()=>{
 const sources=[source('private:same-a',{text:'我做了读书笔记网页。',at:OLD}),source('private:same-b',{text:'我做了读书笔记网页。',at:NOW}),
  source('qq:same-contact',{type:'qq',role:'contact',text:'我做了读书笔记网页。',at:OLD}),source('private:negated',{text:'我没有做读书笔记网页。',at:OLD}),
  source('private:detail',{text:'我给朋友做了读书笔记网页。',at:OLD})];
 const selected=sources.map(item=>quote(item.id,item.text)),result=project(prepared(sources),selected);
 assert.equal(result.quotes.length,5);assert.deepEqual(result.quotes.map(({sourceId,text})=>({sourceId,text})),selected);
 assert.equal(result.quotes[0].provenance.source.recordedAt,OLD);assert.equal(result.quotes[1].provenance.source.recordedAt,NOW);
 assert.equal(result.quotes[2].provenance.source.role,'contact');assert.equal(result.quotes[2].provenance.source.timeMeaning,'qq_message_recorded');assert.equal(result.dependencies.length,5);
});
