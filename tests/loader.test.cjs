'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('the pinned loader scans plugins when Dirent.path is absent in current Node', () => {
  const filename = path.resolve(__dirname, '../data/runtime/LiteLoaderQQNT/src/main/store.js');
  if (!fs.existsSync(filename)) return;
  const exports = {}, pluginPath = '/synthetic/plugin-profile';
  const mockFs = { mkdirSync() {}, readdirSync() { return [{ name: 'qq-chat-assistant' }]; },
    existsSync(value) { return value === `${pluginPath}/qq-chat-assistant/manifest.json`; },
    readFileSync() { return JSON.stringify({ slug: 'qq-chat-assistant' }); } };
  const context = { exports, module: { exports: {} }, LiteLoader: { path: { plugins: pluginPath } },
    process: { resourcesPath: '/synthetic/QQ/resources' }, console,
    require(name) { if (name === 'path') return path; if (name === 'fs') return mockFs;
      if (name === 'electron') return { app: { isReady: () => false, once() {} }, dialog: {} };
      if (name.endsWith('major.node')) return { load(_, module) { module.exports.admZip = { default: class {} }; } };
      if (name.endsWith('config.json')) return {}; throw new Error(`Unexpected import ${name}`); } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const plugins = exports.scanPluginDirectory();
  assert.equal(plugins.length, 1); assert.equal(plugins[0].path, `${pluginPath}/qq-chat-assistant`);
});
