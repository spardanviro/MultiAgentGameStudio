const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReworkPrompt,
  evaluateReviewReport,
  extractReworkItems,
  isBlockingReworkItem,
  waiveGate,
} = require('../src/reworkGate');

const REPORT_WITH_BLOCKER = `# Module Review

Player health mostly works.

\`\`\`yaml
rework_items:
  - issue_id: MR-1
    severity: high
    task_id: player-health
    agent_owner: player-health-agent
    owned_script: src/player/player_health.gd
    problem: Damage ignores armor
    expected_behavior: armor reduces damage
    actual_behavior: raw damage applied
    evidence: tests/player/test_player_health.gd
    recommended_action: reassign_to_same_agent
    blocks_integration: true
  - issue_id: MR-2
    severity: low
    task_id: player-health
    problem: Naming nit
    blocks_integration: false
\`\`\`
`;

test('extractReworkItems reads the rework_items YAML block', () => {
  const result = extractReworkItems(REPORT_WITH_BLOCKER);
  assert.equal(result.found, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].issue_id, 'MR-1');
});

test('extractReworkItems accepts a bare list labelled rework_items and an empty list', () => {
  const labelled = extractReworkItems('## rework_items\n\n```yaml\n- issue_id: SR-1\n  blocks_release: yes\n```\n');
  assert.equal(labelled.items[0].issue_id, 'SR-1');

  const empty = extractReworkItems('```yaml\nrework_items: []\n```');
  assert.deepEqual(empty, { found: true, items: [], error: null });
});

test('extractReworkItems ignores unrelated code blocks and reports invalid YAML', () => {
  assert.equal(extractReworkItems('```gdscript\nvar rework_items = []\n```').found, false);
  const invalid = extractReworkItems('```yaml\nrework_items: [unclosed\n```');
  assert.equal(invalid.found, false);
  assert.match(invalid.error, /invalid/);
});

test('isBlockingReworkItem uses explicit blocks flags and critical severity', () => {
  assert.equal(isBlockingReworkItem({ blocks_integration: true }), true);
  assert.equal(isBlockingReworkItem({ blocks_release: 'yes' }), true);
  assert.equal(isBlockingReworkItem({ severity: 'Critical' }), true);
  assert.equal(isBlockingReworkItem({ severity: 'high', blocks_integration: false }), false);
});

test('evaluateReviewReport distinguishes passed, rework, missing, and unparsed reports', () => {
  assert.equal(evaluateReviewReport(REPORT_WITH_BLOCKER).outcome, 'rework_required');
  assert.equal(evaluateReviewReport(REPORT_WITH_BLOCKER).blockingItems.length, 1);
  assert.equal(evaluateReviewReport('```yaml\nrework_items: []\n```').outcome, 'passed');
  assert.equal(evaluateReviewReport(null).outcome, 'report_missing');
  assert.equal(evaluateReviewReport('Looks good to me.').outcome, 'unparsed');
});

test('waiveGate opens a review gate or a failed diagnostics stage', () => {
  const state = {
    workflow: {
      reviewGates: { 'module-review': { taskId: 'module-review', outcome: 'rework_required', waived: false } },
      diagnostics: { afterModules: 'failed' },
    },
  };
  waiveGate(state, 'module-review', 'false positive');
  waiveGate(state, 'diagnostics:afterModules');

  assert.equal(state.workflow.reviewGates['module-review'].waived, true);
  assert.equal(state.workflow.reviewGates['module-review'].waiveNote, 'false positive');
  assert.equal(state.workflow.diagnostics.afterModules, 'waived');
  assert.throws(() => waiveGate(state, 'diagnostics:afterIntegration'), /has not failed/);
  assert.throws(() => waiveGate(state, 'missing-gate'), /not found/);
  assert.throws(() => waiveGate(state, '__proto__'), /not found/);
  assert.throws(() => waiveGate(state, 'diagnostics:__proto__'), /Unknown diagnostics stage/);
  assert.equal({}.waived, undefined);
});

test('buildReworkPrompt embeds blocking items, output paths, and the next run id', () => {
  const prompt = buildReworkPrompt({
    projectRoot: 'C:\\game',
    runId: 'run-001',
    round: 1,
    nextRunId: 'run-001-rework-1',
    previousManifestPath: 'tasks/task_manifest.yaml',
    manifestPath: 'tasks/task_manifest.run-001-rework-1.yaml',
    decisionsPath: 'reports/rework/run-001-rework-1_decisions.md',
    userQuestionsPath: 'work/requests/run-001-rework-1_user_decisions.md',
    interfaceRequests: ['work/modules/player_health/interface_change_request.md'],
    triggers: [
      {
        type: 'review_gate',
        taskId: 'module-review',
        role: 'module_review',
        outcome: 'rework_required',
        reportPath: 'reports/reviews/run-001/module_review.md',
        itemCount: 2,
        blockingItems: evaluateReviewReport(REPORT_WITH_BLOCKER).blockingItems,
        error: null,
      },
      { type: 'diagnostics', stage: 'afterModules', reportPath: 'reports/diagnostics/run-001_latest.md', counts: { error: 3, warning: 1 } },
    ],
  });

  assert.match(prompt, /run\.id must be exactly run-001-rework-1/);
  assert.match(prompt, /tasks\/task_manifest\.run-001-rework-1\.yaml/);
  assert.match(prompt, /issue_id: MR-1/);
  assert.doesNotMatch(prompt, /MR-2/);
  assert.match(prompt, /Diagnostics failed: afterModules \(3 errors, 1 warnings\)/);
  assert.match(prompt, /interface_change_request\.md/);
  assert.match(prompt, /Do not start Claude background agents yourself/);
});
