'use strict';
// Public compatibility facade. Selection and stage projections have one live implementation.
const {buildContext}=require('./context/planning-view.cjs');
const {buildDraftContext,expressionOptionsFor}=require('./context/wording-view.cjs');
const {sourcesFor}=require('./context/source-snapshot.cjs');
const {PROMPT_VERSION,METHODS,digest}=require('./context/shared.cjs');
module.exports={buildContext,buildDraftContext,expressionOptionsFor,sourcesFor,PROMPT_VERSION,METHODS,digest};
