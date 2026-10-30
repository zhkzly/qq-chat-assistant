'use strict';
// Exact content from sequences 1 and 2 of the preserved actual012 transport.
// The development conversation is fictional; these are actual model outputs,
// not behavioral references or expected answers. Do not rewrite the raw text.

const firstResponseContent = "{\"kind\":\"discussion\",\"text\":\"可以先用一两句说清这个网页对你有什么用，再把话题递给她，听起来自然也能让她了解一点你的真实进展。\",\"requestDelivery\":{\"mode\":\"editable_message\",\"sourceId\":\"private:ee130189-780a-4ce9-b70f-aa8afcd39566\",\"quote\":\"帮我接她这个问题，给我能改着发的表达。\"},\"draftPlan\":{\"quotes\":[{\"sourceId\":\"private:p1\",\"text\":\"这是我给自己记读书笔记的小网页。\"},{\"sourceId\":\"private:p1\",\"text\":\"昨天第一次把查找功能弄好了，我挺开心。\"},{\"sourceId\":\"private:p1\",\"text\":\"也想听她平时怎么留住读到的东西。\",\"authorization\":{\"permission\":{\"sourceId\":\"private:p1\",\"text\":\"想告诉她这个小进展，也想听她平时怎么留住读到的东西。\"},\"referent\":{\"sourceId\":\"private:p1\",\"text\":\"也想听她平时怎么留住读到的东西。\"}}}],\"taskUse\":\"continue\",\"intent\":\"reply\",\"style\":\"natural\",\"language\":\"zh-CN\",\"askFollowup\":true,\"guidance\":{\"objective\":{\"text\":\"接她关于做网页有什么意思的问题，并让她了解一点真实的小进展。\",\"sourceIds\":[\"private:ee130189-780a-4ce9-b70f-aa8afcd39566\",\"private:p1\"]},\"allowedApproach\":{\"text\":\"简短说网页是用来记读书笔记的，提到刚做好的查找功能和自己的开心，再问她平时怎么留存读到的内容。\",\"sourceIds\":[\"private:p1\"]},\"avoidances\":[]}}}";
const repairResponseContent = "{\"kind\":\"question\",\"text\":\"你想告诉她这个网页是用来记读书笔记的；我需要确认这点是否也可以对她说。你明确说想分享的小进展是“昨天第一次把查找功能弄好了”，但“这是我给自己记读书笔记的小网页”不一定包含在这个分享许可里。\",\"requestDelivery\":{\"mode\":\"editable_message\",\"sourceId\":\"private:ee130189-780a-4ce9-b70f-aa8afcd39566\",\"quote\":\"帮我接她这个问题，给我能改着发的表达。\",\"blocker\":{\"kind\":\"missing_authorization\",\"missing\":\"确认是否可以告诉她这个网页是用来记读书笔记的。\",\"question\":\"可以把“这是我给自己记读书笔记的小网页”也告诉她吗？\"}}}";
const firstResponse=JSON.parse(firstResponseContent);
const repairResponse=JSON.parse(repairResponseContent);
const firstResponseSha256 = "4f25f18b85c32cef8d6590fca47da41a6e528b7a57e83419a07e455de9ef25ea";
const repairResponseSha256 = "b08223d3851c27e231124f722adb0bb33c74bccd23a99a1aef10274cb6d8d81b";
const rawContentSha256={first:firstResponseSha256,repair:repairResponseSha256};
const currentSourceId="private:ee130189-780a-4ce9-b70f-aa8afcd39566";
const currentRequestText="帮我接她这个问题，给我能改着发的表达。";
module.exports={firstResponse,repairResponse,firstResponseContent,repairResponseContent,firstResponseSha256,repairResponseSha256,rawContentSha256,currentSourceId,currentRequestText};
