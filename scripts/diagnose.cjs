'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const filename of ['data/integration-status.json']) {
  if (fs.existsSync(path.join(root, filename))) console.log(fs.readFileSync(path.join(root, filename), 'utf8'));
  else console.log('No native integration status yet. Launch the verified QQ runtime first.');
}
console.log('Diagnostics omit message text, QQ credentials and model API keys.');
