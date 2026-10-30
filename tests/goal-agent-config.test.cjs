'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const generator = path.join(root, 'scripts/goal-agent-config.py');
const manifestPath = 'goals/assistant-improvement/roles.json';
const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
function command(directory, action) {
  const result = spawnSync('python3', [generator, action, '--root', directory], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  assert.ifError(result.error);
  return result;
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-goal-agents-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const files = [manifestPath, manifest.coordinator.skill, ...Object.values(manifest.agents).map(agent => agent.skill)];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), {recursive: true});
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  return directory;
}
function parseToml(file) {
  const result = spawnSync('python3', ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', file], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('committed native profiles are current and each consumes its own canonical skill', () => {
  const result = command(root, 'check');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'current');
  assert.equal(report.agents.length, 4);
  for (const [name, agent] of Object.entries(manifest.agents)) {
    const profile = parseToml(path.join(root, agent.config));
    assert.equal(profile.name, name);
    assert.equal(typeof profile.description, 'string');
    assert.ok(profile.developer_instructions.includes(`Canonical skill: ${agent.skill}`));
    const {createHash} = require('node:crypto');
    const skill = fs.readFileSync(path.join(root, agent.skill));
    assert.ok(profile.developer_instructions.includes(createHash('sha256').update(skill).digest('hex')));
    const body = skill.toString('utf8').split('\n---\n').slice(1).join('\n---\n').trim();
    assert.ok(body && profile.developer_instructions.includes(body));
    for (const sibling of Object.values(manifest.agents).filter(other => other.skill !== agent.skill)) {
      assert.ok(!profile.developer_instructions.includes(`Canonical skill: ${sibling.skill}`));
    }
    assert.equal(profile.skills.include_instructions, false);
    assert.equal(profile.skills.bundled.enabled, false);
    for (const key of ['model', 'approval_policy', 'sandbox_mode', 'model_provider', 'mcp_servers', 'permissions']) {
      assert.ok(!Object.hasOwn(profile, key), `${name} must inherit ${key}`);
    }
  }
  const evaluator = parseToml(path.join(root, manifest.agents.qq_evaluator.config));
  for (const key of ['shell_tool', 'apps', 'plugins', 'memories', 'request_permissions_tool']) assert.equal(evaluator.features[key], false);
  const diagnostician = parseToml(path.join(root, manifest.agents.qq_diagnostician.config));
  assert.equal(diagnostician.features.shell_tool, true);
  for (const key of ['apps', 'plugins', 'memories', 'request_permissions_tool']) assert.equal(diagnostician.features[key], false);
  assert.match(diagnostician.developer_instructions, /read-only role contract, not an operating-system sandbox guarantee/);
  assert.ok(!Object.hasOwn(parseToml(path.join(root, manifest.agents.qq_implementer.config)), 'features'));
  const architectureReviewer = parseToml(path.join(root, manifest.agents.qq_architecture_reviewer.config));
  assert.ok(!Object.hasOwn(architectureReviewer, 'features'), 'architecture research tools must inherit parent enablement');
  assert.ok(!Object.hasOwn(architectureReviewer, 'apps'));
  assert.ok(!Object.hasOwn(architectureReviewer, 'plugins'));
  assert.ok(!Object.hasOwn(architectureReviewer, 'memories'));
  assert.ok(!Object.hasOwn(architectureReviewer, 'web_search'));
});
for (const role of ['qq_evaluator', 'qq_architecture_reviewer']) test(`generation detects stale ${role} canonical instructions and regenerates a parseable full body`, t => {
  const directory = fixture(t);
  assert.equal(command(directory, 'generate').status, 0);
  const skill = path.join(directory, manifest.agents[role].skill);
  const addition = '\nLiteral triple quotes """, backslashes \\, and Unicode 评价 stay intact.\n';
  fs.appendFileSync(skill, addition);
  const stale = command(directory, 'check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, new RegExp(`${role}.*stale`));
  assert.equal(command(directory, 'generate').status, 0);
  assert.equal(command(directory, 'check').status, 0);
  assert.ok(parseToml(path.join(directory, manifest.agents[role].config)).developer_instructions.includes(addition.trim()));
});
test('checks reject invalid native TOML and forbidden permission/provider overrides', t => {
  const directory = fixture(t);
  assert.equal(command(directory, 'generate').status, 0);
  const file = path.join(directory, manifest.agents.qq_evaluator.config);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, 'developer_instructions = "unterminated\n');
  let result = command(directory, 'check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid TOML.*qq_evaluator/);
  for (const key of ['sandbox_mode', 'approval_policy', 'model_provider', 'mcp_servers', 'approvals_reviewer']) {
    fs.writeFileSync(file, `${key} = "do-not-override"\n${original}`);
    result = command(directory, 'check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Forbidden inherited setting.*${key}`));
  }
});
test('manifest rejects ignored keys and paths escaping the selected project', t => {
  const directory = fixture(t);
  const file = path.join(directory, manifestPath);
  const altered = structuredClone(manifest);
  altered.agents.qq_evaluator.sandbox_mode = 'read-only';
  fs.writeFileSync(file, JSON.stringify(altered));
  let result = command(directory, 'generate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /qq_evaluator.*unknown.*sandbox_mode/);
  altered.agents.qq_evaluator = {...manifest.agents.qq_evaluator, skill: '../outside/SKILL.md'};
  fs.writeFileSync(file, JSON.stringify(altered));
  result = command(directory, 'generate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /canonical skill path/);
  fs.writeFileSync(file, JSON.stringify(manifest));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-goal-outside-'));
  t.after(() => fs.rmSync(outside, {recursive: true, force: true}));
  fs.mkdirSync(path.join(directory, '.codex'), {recursive: true});
  fs.symlinkSync(outside, path.join(directory, '.codex/agents'));
  result = command(directory, 'generate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /escapes project root/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
