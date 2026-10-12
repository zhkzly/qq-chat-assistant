'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const folder of ['src', 'plugin', 'ui', 'scripts']) {
  for (const file of fs.readdirSync(path.join(root, folder))) {
    if (!/\.(cjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, folder, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
}
console.log('All application JavaScript parses.');
