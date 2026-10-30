'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {resolveDraftMaterial,assertDraftSourcesCurrent}=require('../src/context/draft-material.cjs');
// Actual producer responses from fictional actual013 guard transport sequences7/8.
// Preserve exact content and original allow-list metadata; these are protocol
// regression inputs, never expected behavioral answers or permission inference.
const actualResponseContents=["{\"kind\":\"discussion\",\"text\":\"可以接住她舍不得换的感觉，再顺带说你以前补过旧帆布包内衬的小经历。这样既是在回应她，也自然带出你自己的真实经历；不说成你修过她的包，也不装作很懂修包。\",\"requestDelivery\":{\"mode\":\"editable_message\",\"sourceId\":\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\",\"quote\":\"她说这个，我想接一句，帮我想想。\"},\"draftPlan\":{\"quotes\":[{\"sourceId\":\"note:n1\",\"text\":\"我以前给一个旧帆布包补过内衬，最难的是把里面的布角对齐。\",\"authorization\":{\"permission\":{\"sourceId\":\"note:n1\",\"text\":\"我愿意把这件小经历告诉她\"},\"referent\":{\"sourceId\":\"note:n1\",\"text\":\"我以前给一个旧帆布包补过内衬，最难的是把里面的布角对齐。\"}}}],\"taskUse\":\"continue\",\"intent\":\"reply\",\"style\":\"natural\",\"language\":\"zh-CN\",\"guidance\":{\"objective\":{\"text\":\"接住她舍不得换包的心情，并接一句自己的旧帆布包经历。\",\"sourceIds\":[\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\",\"qq:72057594049927937001\"]},\"allowedApproach\":{\"text\":\"先回应她的包外面还好、舍不得换，再自然分享补内衬的小经历。\",\"sourceIds\":[\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\",\"qq:72057594049927937001\",\"note:n1\"]},\"avoidances\":[{\"text\":\"不说成修过她的包，也不自称专业裁缝。\",\"sourceIds\":[\"note:n1\"]}],\"currentStep\":{\"text\":\"给出一句自然、可修改后发送的回应。\",\"sourceIds\":[\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\"]}}}}", "{\"kind\":\"discussion\",\"text\":\"她说包外面还好、舍不得换，可以先顺着这个说，再自然带出你自己的小经历。\",\"requestDelivery\":{\"mode\":\"editable_message\",\"sourceId\":\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\",\"quote\":\"她说这个，我想接一句，帮我想想。\"},\"draftPlan\":{\"quotes\":[{\"sourceId\":\"note:n1\",\"text\":\"我以前给一个旧帆布包补过内衬，最难的是把里面的布角对齐。\",\"authorization\":{\"permission\":{\"sourceId\":\"note:n1\",\"text\":\"我愿意把这件小经历告诉她\"},\"referent\":{\"sourceId\":\"note:n1\",\"text\":\"我以前给一个旧帆布包补过内衬，最难的是把里面的布角对齐。\"}}}],\"taskUse\":\"continue\",\"intent\":\"reply\",\"style\":\"natural\",\"language\":\"zh-CN\",\"guidance\":{\"objective\":{\"text\":\"接住她舍不得换包的话，并分享自己的旧帆布包经历。\",\"sourceIds\":[\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\",\"qq:72057594049927937001\"]},\"allowedApproach\":{\"text\":\"先回应包外面还好、舍不得换，再顺带提到自己以前补过内衬。\",\"sourceIds\":[\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\",\"qq:72057594049927937001\",\"note:n1\"]},\"avoidances\":[{\"text\":\"不说成修过她的包，也不自称专业裁缝。\",\"sourceIds\":[\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\",\"note:n1\"]}],\"currentStep\":{\"text\":\"给出一句自然、可修改后发送的回应。\",\"sourceIds\":[\"private:21d32652-b4ad-497e-bd0f-eab48d2948b8\"]}}}}"];
const actualResponseHashes=["9077fe7e32ed86b42bfb3f167a97158d63b5bbb5509b65ceef1bdb2d961b6694", "15ed370e8c8f13f851d3662ac833b192e0c6621d7ef3192efb84cc82675b321c"];
const actualPayload={"purpose": "discussion", "intentAuthority": {"sourceId": "private:21d32652-b4ad-497e-bd0f-eab48d2948b8"}, "userRequest": {"sourceId": "private:21d32652-b4ad-497e-bd0f-eab48d2948b8", "text": "她说这个，我想接一句，帮我想想。"}, "allowedMaterialIds": ["note:n1"], "selectedMaterialIds": [], "privateRestrictions": [], "draftMaterialPolicy": {"version": 1}, "sources": [{"id": "qq:72057594049927937001", "type": "qq", "text": "我的帆布包里面开线了，外面倒还挺好的，有点舍不得换。", "at": "2026-10-29T10:00:00.000Z", "role": "contact", "direction": "incoming", "use": "discussion", "messageId": "72057594049927937001", "sequence": "1", "senderUid": "eval_replay_contact", "senderUin": "3333333333", "revision": "5651e2a059bd448da157fa52bb7dffbdad0ebc3edc7e1e7a334d19365ad71384", "speaker": "对方"}, {"id": "note:n1", "type": "note", "text": "我以前给一个旧帆布包补过内衬，最难的是把里面的布角对齐。我愿意把这件小经历告诉她，但没有修过她的包，也不是专业裁缝。", "at": "2026-10-29T10:01:00.000Z", "use": "draft", "kind": "material", "version": 1, "revision": "c7d90be4732ebcc0ba82fe661f947203b403a4665507686bd9a8a3f6a3a51932"}, {"id": "private:21d32652-b4ad-497e-bd0f-eab48d2948b8", "type": "private", "text": "她说这个，我想接一句，帮我想想。", "at": "2026-10-29T10:10:00.000Z", "role": "user", "use": "discussion", "kind": "discussion", "version": 1, "revision": "f6b6a7af83afc59dd3e91765195c5563a1fd8be4b85228266c9b7d1a9ee5341b"}]};
const clone=value=>structuredClone(value),sha=text=>createHash('sha256').update(text).digest('hex');
const actualPlans=actualResponseContents.map(content=>JSON.parse(content).draftPlan);
const fact=actualPlans[0].quotes[0].text;
function fixture(){return {payload:clone(actualPayload),plan:clone(actualPlans[0])};}
test('actual013 note responses and supplied authorization metadata remain hash-bound',()=>{
 assert.deepEqual(actualResponseContents.map(sha),actualResponseHashes);
 assert.deepEqual(actualPayload.allowedMaterialIds,['note:n1']);assert.deepEqual(actualPayload.selectedMaterialIds,[]);
 assert.equal(actualPayload.sources.find(source=>source.id==='note:n1').use,'draft');assert.deepEqual(actualPayload.privateRestrictions,[]);
 assert.equal(actualPlans[0].quotes[0].authorization.permission.sourceId,'note:n1');
});
for(const [index,actualPlan]of actualPlans.entries())test(`actual013 sequence${index+7} uses its program-authorized note despite redundant note permission metadata`,()=>{
 const payload=clone(actualPayload),plan=clone(actualPlan),without=clone(plan);delete without.quotes[0].authorization;
 const canonical=resolveDraftMaterial(payload,without),resolved=resolveDraftMaterial(payload,plan);
 assert.deepEqual(resolved.quotes,canonical.quotes);assert.deepEqual(resolved.sourceIds,canonical.sourceIds);assert.deepEqual(resolved.bindings,canonical.bindings);
 assert.deepEqual(resolved.quotes,[{sourceId:'note:n1',text:fact}]);assert.deepEqual(resolved.sourceIds,['note:n1']);assert.deepEqual(resolved.bindings,[]);
 assert.deepEqual(resolved.ignoredAuthorizations,[{path:'draftPlan.quotes[0].authorization',sourceId:'note:n1',authority:'program_authorized_material'}]);
 assert.equal(canonical.ignoredAuthorizations,undefined);
});
for(const authorization of [null,'unneeded malformed metadata',{},
 {permission:{sourceId:'private:missing',text:'not supplied'},referent:{sourceId:'private:other',text:'not this fact'}},
 {permission:{sourceId:'note:n1',text:'not an original substring'},referent:{sourceId:'note:n1',text:fact},extra:'not an authority'}
])test(`already permitted note ignores optional authorization shape ${JSON.stringify(authorization).slice(0,70)}`,()=>{
 const {payload,plan}=fixture();plan.quotes[0].authorization=authorization;
 const resolved=resolveDraftMaterial(payload,plan);assert.deepEqual(resolved.quotes,[{sourceId:'note:n1',text:fact}]);
 assert.deepEqual(resolved.sourceIds,['note:n1']);assert.deepEqual(resolved.bindings,[],'ignored metadata cannot create additional authority bindings or dependencies');
 assert.deepEqual(resolved.ignoredAuthorizations,[{path:'draftPlan.quotes[0].authorization',sourceId:'note:n1',authority:'program_authorized_material'}]);
 assert.equal(JSON.stringify(resolved.ignoredAuthorizations).includes('not supplied'),false);
});
for(const authority of ['current_request','actual_qq','exact_selected_tuple'])test(`${authority} authority is unchanged by a redundant malformed authorization carrier`,()=>{
 const {payload}=fixture();let quote;
 if(authority==='current_request')quote={sourceId:payload.userRequest.sourceId,text:payload.userRequest.text};
 else if(authority==='actual_qq'){const source=payload.sources.find(source=>source.type==='qq');quote={sourceId:source.id,text:source.text};}
 else{
  const source={id:'private:selected',type:'private',role:'user',use:'discussion',text:'SELECTED_EXACT_FACT',revision:'selected-v1'};payload.sources.push(source);
  payload.selectedOption={turnId:'selected-option',index:0};payload.expressionOptions=[{turnId:'selected-option',index:0,quotes:[{sourceId:source.id,text:source.text,revision:source.revision}]}];quote={sourceId:source.id,text:source.text};
 }
 const canonical=resolveDraftMaterial(payload,{quotes:[quote]}),resolved=resolveDraftMaterial(payload,{quotes:[{...quote,authorization:{invalid:'metadata'}}]});
 assert.deepEqual(resolved.quotes,canonical.quotes);assert.deepEqual(resolved.sourceIds,canonical.sourceIds);assert.deepEqual(resolved.bindings,canonical.bindings);
});
for(const change of ['deleted','excluded','disabled','withdrawn','private_restriction','wrong_quote','request_control'])test(`hard ${change} rejection precedes any program-authorization shortcut`,()=>{
 const {payload,plan}=fixture(),source=payload.sources.find(item=>item.id==='note:n1');plan.quotes[0].authorization={invalid:'metadata'};
 if(change==='deleted')source.deleted=true;
 if(change==='excluded')source.excluded=true;
 if(change==='disabled')source.use='disabled';
 if(change==='withdrawn')payload.sources=payload.sources.filter(item=>item.id!==source.id);
 if(change==='private_restriction'){source.use='discussion';payload.privateRestrictions=[{sourceId:source.id,text:source.text}];}
 if(change==='wrong_quote')plan.quotes[0].text='UNSUPPORTED_FACT_NOT_IN_SOURCE';
 if(change==='request_control')source.type='request';
 assert.throws(()=>resolveDraftMaterial(payload,plan),/未能对应|私下讨论|task control/);
});
test('a draft-usable note without program selection cannot authorize itself through note text',()=>{
 const {payload,plan}=fixture();payload.allowedMaterialIds=[];
 assert.throws(()=>resolveDraftMaterial(payload,plan),/authorization\.referent/);
 delete plan.quotes[0].authorization;assert.throws(()=>resolveDraftMaterial(payload,plan),error=>error.code==='draft_material_authorization_missing');
});
test('an authorized note fragment cannot transfer a grant to an unselected second source',()=>{
 const {payload,plan}=fixture();payload.sources.push({id:'private:unrelated',type:'private',role:'user',text:'UNRELATED_PRIVATE_FACT',revision:'unrelated-v1'});
 plan.quotes.push({sourceId:'private:unrelated',text:'UNRELATED_PRIVATE_FACT'});
 assert.throws(()=>resolveDraftMaterial(payload,plan),error=>error.code==='draft_material_authorization_missing'&&error.missingAuthorizations.length===1&&error.missingAuthorizations[0].path==='draftPlan.quotes[1].authorization');
 plan.quotes[1].authorization=clone(plan.quotes[0].authorization);
 assert.throws(()=>resolveDraftMaterial(payload,plan),/authorization\.referent/,'the first note authorization cannot bind a different fragment');
});
test('unselected old private material keeps exact original-user authorization and referent validation',()=>{
 const {payload}=fixture(),source={id:'private:older',type:'private',role:'user',use:'discussion',text:'OLDER_FACT. 我愿意把这件事告诉她。',revision:'older-v1'};payload.sources.push(source);
 const quote={sourceId:source.id,text:'OLDER_FACT.',authorization:{permission:{sourceId:source.id,text:'我愿意把这件事告诉她。'},referent:{sourceId:source.id,text:'OLDER_FACT.'}}};
 const resolved=resolveDraftMaterial(payload,{quotes:[quote]});assert.equal(resolved.bindings.length,1);assert.equal(resolved.bindings[0].permission.sourceId,source.id);
 for(const mutate of [q=>delete q.authorization,q=>q.authorization.permission={sourceId:'note:n1',text:'我愿意把这件小经历告诉她'},q=>q.authorization.referent={sourceId:'note:n1',text:fact}]){
  const invalid=clone(quote);mutate(invalid);assert.throws(()=>resolveDraftMaterial(payload,{quotes:[invalid]}),/authorization/);
 }
 source.historicalOnly=true;assert.throws(()=>resolveDraftMaterial(payload,{quotes:[quote]}),/后续私下来源/);delete source.historicalOnly;
 source.delivery={status:'partial'};assert.throws(()=>resolveDraftMaterial(payload,{quotes:[quote]}),/部分原文/);
});
test('exact selected tuples still reject version drift before ignoring optional metadata',()=>{
 const {payload}=fixture(),source={id:'private:selected',type:'private',role:'user',text:'SELECTED_FACT',revision:'current-v2'};payload.sources.push(source);
 payload.selectedOption={turnId:'old-option',index:0};payload.expressionOptions=[{turnId:'old-option',index:0,quotes:[{sourceId:source.id,text:source.text,revision:'old-v1'}]}];
 assert.throws(()=>resolveDraftMaterial(payload,{quotes:[{sourceId:source.id,text:source.text,authorization:{invalid:'metadata'}}]}),/版本已变化/);
});
test('authorized quote dependencies still require current source revision and scope at the restricted handoff',()=>{
 const {payload,plan}=fixture(),resolved=resolveDraftMaterial(payload,{...plan,quotes:plan.quotes.map(({authorization,...quote})=>quote)}),source=payload.sources.find(item=>item.id==='note:n1');
 const scope={accountUid:'owner',accountUin:'1111111111',peerUid:'contact',peerUin:'3333333333'},prepared={manifest:{sourceRevisions:{[source.id]:source.revision}}};
 assert.doesNotThrow(()=>assertDraftSourcesCurrent(prepared,resolved.sourceIds,{scope,availableSources:[source]}));
 assert.throws(()=>assertDraftSourcesCurrent(prepared,resolved.sourceIds,{scope,availableSources:[{...source,revision:'changed'}]}),/来源版本已变化/);
 assert.throws(()=>assertDraftSourcesCurrent(prepared,resolved.sourceIds,{scope,availableSources:[]}),/来源版本已变化/);
 assert.throws(()=>assertDraftSourcesCurrent(prepared,resolved.sourceIds,{scope,availableSources:[{...source,scope:{...scope,peerUin:'other'}}]}),/来源版本已变化/);
});
