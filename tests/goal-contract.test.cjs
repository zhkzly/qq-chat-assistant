'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadReplayPlans } = require('../scripts/eval-replay-plan.cjs');

const root = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'goals/assistant-improvement', name), 'utf8'));

test('the improvement contract freezes real replay coverage and finite staged targets', () => {
  const goal = read('goal.json');
  const dataset = loadReplayPlans();
  const ids = new Set(dataset.plans.map(plan => plan.id));
  assert.equal(goal.schema_version, 1);
  assert.equal(goal.id, 'qq-assistant-improvement');
  for (const field of ['outcome', 'evidence', 'constraints', 'boundaries', 'iteration_policy', 'stop_conditions']) {
    assert.ok(goal[field] && Object.keys(goal[field]).length, `${field} is part of the explicit Goal contract`);
  }
  assert.equal(goal.baseline.commit, '009b4aa');
  assert.equal(goal.replay_dataset.hash, dataset.datasetHash);
  assert.equal(goal.replay_dataset.cases, dataset.plans.length);
  assert.equal(goal.replay_dataset.steps, dataset.plans.reduce((sum, plan) => sum + plan.steps.length, 0));
  assert.equal(goal.replay_dataset.policy_version, dataset.policyVersion);
  assert.deepEqual(goal.stages.map(stage => stage.id), ['delivery_provenance', 'memory_continuity', 'communication_quality']);
  const targeted = [];
  for (const stage of goal.stages) {
    assert.ok(stage.objective);
    for (const field of ['target_cases', 'guardrail_cases']) {
      assert.ok(Array.isArray(stage[field]) && stage[field].length, `${stage.id}.${field}`);
      assert.equal(new Set(stage[field]).size, stage[field].length, `${stage.id}.${field} is duplicate-free`);
      for (const id of stage[field]) assert.ok(ids.has(id), `${stage.id}.${field}: unknown replay case ${id}`);
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
  assert.equal(goal.execution.max_http_per_round, 32);
  assert.equal(goal.execution.http_cap_scope, 'total_baseline_and_candidate_including_preparation_repair_and_maintenance');
  assert.equal(goal.execution.activation, 'explicit_user_request_only');
  assert.equal(goal.execution.artifacts_root, '.goal-runs');
  assert.equal(Object.hasOwn(goal.execution, 'token_budget'), false, 'there is no unrequested Goal token budget');
});

test('the committed state is an unstarted queue without invented rounds, ratings or completed stages', () => {
  const goal = read('goal.json');
  const state = read('state.json');
  assert.equal(state.schema_version, 1);
  assert.equal(state.goal_id, goal.id);
  assert.equal(state.goal_version, goal.version);
  assert.equal(state.status, 'not_started');
  assert.equal(state.current_stage, null);
  assert.equal(state.current_hypothesis, null);
  assert.deepEqual(state.rounds, []);
  assert.deepEqual(state.stages, goal.stages.map(stage => ({ id: stage.id, status: 'pending', accepted_round: null })));
  for (const field of ['rating', 'overall', 'completed_at', 'active_goal_id']) assert.equal(Object.hasOwn(state, field), false, field);
});
