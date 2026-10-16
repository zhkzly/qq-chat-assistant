'use strict';
// Only normalized expression controls cross the private-to-wording boundary.
function wordingControls(preferences=[],responsePreference=''){
 const items=new Map();
 const add=(text,sourceId)=>{const item=items.get(text)||{text,sourceIds:[]};if(!item.sourceIds.includes(sourceId))item.sourceIds.push(sourceId);items.set(text,item);};
 const inputs=[...preferences.map(item=>({text:item.text,sourceId:item.sourceId})),{text:responsePreference,sourceId:'responsePreference'}];
 for(const input of inputs)for(const clause of String(input.text||'').split(/[，,。；;\n]/u)){
  if(/因为|原因|担心|害怕|我怕|为了让|PRIVATE_|仅供私下|不要告诉|别告诉|如果|除非|只有|时候|有时|偶尔/i.test(clause))continue;
  if(/短句|简短|简洁|少写|别.{0,5}长篇|不要.{0,5}长篇/.test(clause)&&!/(?:不要|不用|不想|别).{0,3}(?:短句|简短|简洁)/.test(clause))add('用简短句子，保留这次实际想表达的内容。',input.sourceId);
  if(/自然|口语|贴近.{0,8}说话|像我.{0,8}说话|我的说话方式/.test(clause)&&!/(?:不要|不用|不想|别).{0,3}(?:自然|口语|像我|贴近)/.test(clause))add('采用自然口语，贴近用户实际 QQ 表达习惯。',input.sourceId);
  if(/(?:不要|不用|不想|别|避免).{0,12}(?:点评员|评论员|客服|书面腔|说教|评价式)/.test(clause))add('避免点评和说教式措辞，用平常聊天的语气。',input.sourceId);
  for(const [pattern,text]of [[/含蓄|委婉/,'表达含蓄，保持用户此次已确认的意思。'],[/轻松|随意一点/,'语气轻松，不强加亲密程度。'],[/直接一点|直说|直接表达/,'直接表达用户此次已确认的意思。']])if(pattern.test(clause)&&!new RegExp(`(?:不要|不用|不想|别).{0,3}(?:${pattern.source})`).test(clause))add(text,input.sourceId);
  if(/(?:不要|不用|别|禁止).{0,6}(?:emoji|表情)|(?:emoji|表情).{0,4}(?:不要|不用|别用)/i.test(clause))add('不额外添加 emoji。',input.sourceId);
  else if(/(?:少用|少加).{0,4}(?:emoji|表情)|(?:emoji|表情).{0,5}(?:少用|少加|别太多)/i.test(clause))add('少用 emoji，仅在符合实际语气时使用。',input.sourceId);
  else if(/(?:允许|可以|可用|用点|加点|喜欢).{0,5}(?:emoji|表情)/i.test(clause))add('可以自然地使用少量 emoji，无需强加。',input.sourceId);
  if(/(?:不要|不用|别|避免).{0,10}(?:反问|追问|连问|尾问|查户口)/.test(clause))add('不机械追加尾问或连续追问；保留用户本来想问的具体内容。',input.sourceId);
 }
 return {version:1,authority:'expression_control_not_outbound_material',items:[...items.values()].slice(0,12)};
}
module.exports={wordingControls};
