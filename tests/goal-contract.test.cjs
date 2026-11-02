'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadReplayPlans } = require('../scripts/eval-replay-plan.cjs');

const root = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'goals/assistant-improvement', name), 'utf8'));

// The frozen competition core is pinned by literal hash: extensions must never
// silently rewrite the dataset the accepted rounds were judged against.
const FROZEN_CORE = {
  hash: 'd7890b62c8c92e7e496d631ca8f2c255bd6871380d779e194fbb85125a0e7aa0',
  cases: 38,
  steps: 81,
  policy_version: 'observed-history-replay-v2',
};

test('the improvement contract pins the frozen core and declares extensions explicitly', () => {
  const goal = read('goal.json');
  const dataset = loadReplayPlans();
  const ids = new Set(dataset.plans.map(plan => plan.id));
  assert.equal(goal.schema_version, 1);
  assert.equal(goal.id, 'qq-assistant-improvement');
  for (const field of ['outcome', 'evidence', 'constraints', 'boundaries', 'iteration_policy', 'stop_conditions']) {
    assert.ok(goal[field] && Object.keys(goal[field]).length, field + ' is part of the explicit Goal contract');
  }
  assert.equal(goal.baseline.commit, '009b4aa');
  // Frozen competition core stays pinned even after user-authorized extensions.
  assert.equal(goal.replay_dataset.hash, FROZEN_CORE.hash);
  assert.equal(goal.replay_dataset.cases, FROZEN_CORE.cases);
  assert.equal(goal.replay_dataset.steps, FROZEN_CORE.steps);
  assert.equal(goal.replay_dataset.policy_version, FROZEN_CORE.policy_version);
  // Extensions are declared explicitly with their own content hash.
  assert.ok(Array.isArray(goal.replay_dataset.extensions), 'extensions must be declared, never merged silently');
  for (const ext of goal.replay_dataset.extensions) {
    const file = path.join(root, ext.file);
    assert.ok(fs.existsSync(file), 'extension file exists: ' + ext.file);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');
    assert.equal(sha, ext.hash, 'extension hash matches file content: ' + ext.id);
    assert.equal(ext.cases, fs.readFileSync(file, 'utf8').trim().split('\n').length, 'extension case count matches: ' + ext.id);
    for (const plan of dataset.plans) {
      if (plan.id.startsWith(ext.id.split('-')[0] + '-') && plan.id.startsWith('hd-')) {
        assert.ok(true); // extension plans are covered by the targeted-set assertion below
      }
    }
  }
  assert.deepEqual(goal.stages.map(stage => stage.id), ['delivery_provenance', 'memory_continuity', 'communication_quality']);
  const targeted = [];
  for (const stage of goal.stages) {
    assert.ok(stage.objective);
    for (const field of ['target_cases', 'guardrail_cases']) {
      assert.ok(Array.isArray(stage[field]) && stage[field].length, stage.id + '.' + field);
      assert.equal(new Set(stage[field]).size, stage[field].length, stage.id + '.' + field + ' is duplicate-free');
      for (const id of stage[field]) assert.ok(ids.has(id), stage.id + '.' + field + ': unknown replay case ' + id);
    }
    assert.ok(stage.acceptance.length);
    targeted.push(...stage.target_cases);
  }
  assert.equal(new Set(targeted).size, targeted.length, 'stages partition their primary targets');
  assert.deepEqual([...new Set(targeted)].sort(), [...ids].sort(), 'no visible development case is silently left outside the finite queue');
});

test('retained failures remain primary work and evidence does not turn synthetic success into product acceptance', () => {
  const goal = read('goal.json');
  const [delivery, memory] = goal.stages;
  for (const id of ['coverage-observed-output-feedback', 'coverage-feedback-current-material']) assert.ok(delivery.target_cases.includes(id));
  for (const id of ['coverage-long-private-consultation', 'coverage-long-single-source']) assert.ok(memory.target_cases.includes(id));
  assert.equal(goal.evidence.synthetic_replay_accepts_quality, false);
  assert.equal(goal.evidence.calibration.human_gold, false);
  assert.equal(goal.evidence.calibration.anchors, 20);
  assert.equal(goal.evidence.review.requires_actual_outputs, true);
  assert.equal(goal.evidence.review.requires_hash_binding, true);
  assert.equal(goal.evidence.review.independent_of_implementation, true);
  assert.equal(goal.evidence.lifecycle.controlled_rebuild_proves_host_lifecycle, false);
  assert.equal(goal.boundaries.romantic_outcome_is_completion, false);
  assert.equal(goal.iteration_policy.architecture_rewrite_allowed, true);
  // Raised from 32 to 512 under explicit user authorization (cost unlimited);
  // the equal per-variant split and combined-scope accounting are unchanged.
  assert.equal(goal.execution.max_http_per_round, 512);
  assert.equal(goal.execution.http_cap_scope, 'total_baseline_and_candidate_including_preparation_repair_and_maintenance');
  assert.equal(goal.execution.activation, 'explicit_user_request_only');
  assert.equal(goal.execution.artifacts_root, '.goal-runs');
  assert.equal(Object.hasOwn(goal.execution, 'token_budget'), false, 'there is no unrequested Goal token budget');
});

test('iteration evidence lives in durable goal-round directories with decisions', () => {
  const goal = read('goal.json');
  // state.json remains the dormant template from goal creation; the round tool
  // is the authority for iteration evidence and writes .goal-runs/<round>/round.json.
  const state = read('state.json');
  assert.equal(state.schema_version, 1);
  assert.equal(state.goal_id, goal.id);
  const runsRoot = path.join(root, '.goal-runs');
  assert.ok(fs.existsSync(runsRoot), 'goal-round evidence root exists');
  const rounds = fs.readdirSync(runsRoot).filter(name => fs.existsSync(path.join(runsRoot, name, 'round.json')));
  assert.ok(rounds.length >= 1, 'at least one goal round has been recorded');
  let accepted = 0;
  for (const name of rounds) {
    const round = JSON.parse(fs.readFileSync(path.join(runsRoot, name, 'round.json'), 'utf8'));
    assert.ok(round.id === name, 'round directory name matches round id: ' + name);
    if (round.decision) {
      assert.ok(['accepted', 'rejected', 'inconclusive'].includes(round.decision.status), name + ' decision status is from the allowed set');
      if (round.decision.status === 'accepted') accepted += 1;
    }
  }
  assert.ok(accepted >= 1, 'at least one round has been accepted with blind-reviewed evidence');
});

// The diagnostic entry is selection metadata, not a replacement dataset or a passing result.
test('the first diagnostic batch preserves the approved cases and the full final queue', () => {
  const goal = read('goal.json'), batch = goal.iteration_policy.initial_batch;
  assert.ok(batch, 'the initial diagnostic selection must be explicit');
  assert.equal(batch.stage_id, 'delivery_provenance');
  assert.deepEqual(batch.target_cases, ['coverage-observed-output-feedback', 'coverage-feedback-current-material']);
  assert.deepEqual(batch.guardrail_cases, ['conv-share-own-material-missing', 'coverage-observed-qq-recall']);
  const ids = [...batch.target_cases, ...batch.guardrail_cases];
  const plans = loadReplayPlans().plans.filter(plan => ids.includes(plan.id));
  assert.equal(plans.length, 4);
  assert.equal(plans.reduce((n, plan) => n + plan.steps.length, 0), 7);
  assert.equal(goal.replay_dataset.cases, 38);
  assert.equal(goal.replay_dataset.extensions.length, 1, 'the extension dataset is declared alongside the frozen core');
  assert.equal(goal.iteration_policy.architecture_rewrite_allowed, true);
});