'use strict';
const path = require('node:path');
const { activate, failure, reportFailure } = require('./launcher.cjs');
(async () => {
  if (process.argv.includes('--runtime-missing')) throw failure('RUNTIME_MISSING');
  await activate({ root: path.resolve(__dirname, '..') });
})().catch(error => { reportFailure(error); process.exitCode = 2; });
