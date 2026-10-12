'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Direct invocation avoids the host's nested test-runner output suppression.
for (const name of fs.readdirSync(path.join(root, 'tests')).filter(n => n.endsWith('.test.cjs')).sort()) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', name)], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
