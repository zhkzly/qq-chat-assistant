'use strict';

const TOPIC_LIMITS = Object.freeze({objective:800,direction:800,constraints:8,constraintText:300,stage:300,progress:8,progressText:500,unknowns:8,unknownText:300,intentQuote:500,sources:16,retained:3});
const TOPIC_PROTOCOL = Object.freeze({
  patchFields:['operation','topicId','objective','direction','constraints','stage','progress','unknowns','purposeSourceIds','observationSourceIds','intentQuote','interpretationStatus'],
  operations:['create','update','pause','complete','cancel','resume'],
  interpretationStatuses:['tentative','user_stated'],limits:TOPIC_LIMITS,
  guidance:'A topic is the sole persisted ConsultationTask owner for a bounded current private purpose, never a permanent preference or authorization to disclose/send. Preserve it on vague continuation. Change purpose/direction/local constraints/lifecycle only with current explicit private user intent and an exact intentQuote. Verified current private purposeSourceIds plus intentQuote may bind stage/unknowns and empty progress when observationSourceIds is empty, including a stage-only update; these become private_task_state, not QQ facts. Nonempty external progress requires explicit observationSourceIds and cannot use local feedback or its copies as fact authority. Clearing empty observation fields needs no fabricated fact: private clears bind the current private actor; QQ clears still require observationSourceIds including the current actual QQ source. QQ observations may update stage/progress/unknowns or complete an active local topic, never rewrite its purpose or reactivate it. Completion of a local topic does not complete the broader romantic goal. Turn-only output requests belong to current response/guidance, not persistent topic constraints; keep only constraints that still apply to this local conversational purpose.'
});
const plain = value => !!value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
function text(value,name,max,{empty=false}={}) {
  if(typeof value!=='string'||value.length>max||!empty&&!value.trim())throw new Error(`Invalid topic ${name}: expected ${empty?'':'nonempty '}string of at most ${max} characters`);
  return value;
}
function ids(value,name) {
  if(!Array.isArray(value)||value.length>TOPIC_LIMITS.sources||value.some(id=>typeof id!=='string'||id.length>300||!/^(qq|private|note):.+$/.test(id)))throw new Error(`Invalid topic ${name}: at most ${TOPIC_LIMITS.sources} source identifiers required`);
  return [...new Set(value)];
}
function normalizeTopicPatch(input) {
  if(!plain(input)||Object.keys(input).some(key=>!TOPIC_PROTOCOL.patchFields.includes(key)))throw new Error('Topic patch has unauthorized fields');
  if(!TOPIC_PROTOCOL.operations.includes(input.operation))throw new Error('Unknown topic operation');
  const patch={operation:input.operation};
  if(input.operation==='create'&&input.topicId!==undefined)throw new Error('Topic creation cannot choose an existing identifier');
  if(input.operation!=='create')patch.topicId=text(input.topicId,'id',256);
  for(const field of ['objective','direction','stage','intentQuote'])if(input[field]!==undefined)patch[field]=text(input[field],field,TOPIC_LIMITS[field],{empty:field==='direction'||field==='stage'});
  for(const field of ['constraints','progress','unknowns'])if(input[field]!==undefined){
    const max=TOPIC_LIMITS[field],size=TOPIC_LIMITS[{constraints:'constraintText',progress:'progressText',unknowns:'unknownText'}[field]];
    if(!Array.isArray(input[field])||input[field].length>max)throw new Error(`Invalid topic ${field}: at most ${max} entries required`);
    patch[field]=input[field].map(value=>text(value,field,size));
  }
  for(const field of ['purposeSourceIds','observationSourceIds'])if(input[field]!==undefined)patch[field]=ids(input[field],field);
  if(input.interpretationStatus!==undefined){
    if(!TOPIC_PROTOCOL.interpretationStatuses.includes(input.interpretationStatus))throw new Error('Invalid topic interpretation status');
    patch.interpretationStatus=input.interpretationStatus;
  }
  if(input.operation==='create'&&patch.objective===undefined)throw new Error('Topic creation requires a grounded objective');
  return patch;
}
module.exports={TOPIC_LIMITS,TOPIC_PROTOCOL,normalizeTopicPatch};
