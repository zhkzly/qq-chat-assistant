'use strict';
const assert=require('node:assert/strict');
// Assert the newly authorized current-meaning lane before comparing the other
// serialized lanes. This never changes the request or hides other private data.
function withoutCurrentControl(payload,expectedWholeText){
 const control=payload.currentHumanControl;
 assert.ok(control,'the current original human statement must be provided separately');
 assert.equal(control.version,1);assert.equal(control.authority,'CONTROL_ONLY');
 assert.ok(['private','feedback'].includes(control.sourceType));
 assert.equal(control.text,expectedWholeText,'only the exact complete captured current statement may cross this lane');
 assert.equal(typeof control.sourceId,'string');
 const {currentHumanControl,...otherLanes}=payload;return otherLanes;
}
function requestWithoutCurrentControl(request,expectedWholeText){
 const view=structuredClone(request),message=view.messages[1],text=typeof message.content==='string'?message.content:message.content.find(item=>item.type==='text').text;
 let payload=JSON.parse(text);
 if(payload.originalInput)payload.originalInput=withoutCurrentControl(payload.originalInput,expectedWholeText);
 else payload=withoutCurrentControl(payload,expectedWholeText);
 if(typeof message.content==='string')message.content=JSON.stringify(payload);
 else message.content.find(item=>item.type==='text').text=JSON.stringify(payload);
 return view;
}
module.exports={withoutCurrentControl,requestWithoutCurrentControl};
