// 0.8.0: the CLI finishes a stage (diagnostics, result, report), so the session spends one call on it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_MANIFEST, cli, git, makeProject, write } from './helpers.mjs';
import { prepareArgs, runWorkflow } from './workflow-harness.mjs';

const PASS = { verdict: 'pass', summary: 'Looks right.', rework_items: [] };
const FAILING_TESTS = DEFAULT_MANIFEST.replace(
  'compile_command: null',
  `compile_command: null\n  test_command: ["node", "-e", "console.log('1 test failed'); process.exit(1)"]`,
);

function implementer({ taskId, write: writeFile }) {
  writeFile(`src/${taskId}/${taskId}_impl.gd`, `class_name ${taskId}\nvar a = 1\nvar b = 2\n`);
  writeFile(`work/modules/${taskId}/module_report.md`, `${taskId} done.\n`);
  return { summary: `${taskId} built`, testsRun: 'none', interfaceRequests: taskId === 'hud' ? ['player: expose max_hp'] : [], blockers: [] };
}

/** Runs the module stage and stores its result the way the Workflow tool does: wrapped in an output file. */
async function moduleStage(manifestText, review = () => PASS) {
  const { root, manifest } = makeProject(manifestText);
  const { result } = await runWorkflow('implement-modules', { root, args: prepareArgs(root, manifest), scenario: { implement: implementer, review } });
  const output = path.join(root, '.multiagent', 'workflow-output.json');
  write(root, '.multiagent/workflow-output.json', JSON.stringify({ summary: 'modules', agentCount: 6, logs: [], result }, null, 2));
  return { root, manifest, result, output };
}

test('record finishes the module stage: diagnostics, result file, report, and the next step', async () => {
  const { root, output } = await moduleStage(DEFAULT_MANIFEST.replace('  spec: docs/spec.md\n', '  spec: docs/spec.md\n  estimated_lines: 3000\n'));
  const { code, json } = cli(root, 'record', '--from', output);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, 'passed');
  assert.equal(json.next, 'integrate');
  assert.equal(json.nextCommand, '/module-pipeline:integrate tasks/task_manifest.yaml');
  assert.deepEqual(json.modules.map((module) => [module.task, module.status]), [['player', 'merged'], ['enemy', 'merged'], ['hud', 'merged']]);
  assert.match(json.diagnostics, /nothing to run/);
  assert.equal(json.size.estimatedLines, 3000);
  assert.deepEqual(json.size.perModule, [{ id: 'player', lines: 3 }, { id: 'enemy', lines: 3 }, { id: 'hud', lines: 3 }]);
  assert.equal(json.size.builtLines, 9);

  const stored = JSON.parse(fs.readFileSync(json.resultPath, 'utf8'));
  assert.equal(stored.status, 'passed');
  assert.equal(stored.diagnostics.ran, false);
  const report = fs.readFileSync(json.reportPath, 'utf8');
  assert.match(report, /^# run-001: modules stage\n\nStatus: \*\*passed\*\*\. Next: integrate\./);
  assert.match(report, /\| hud \| merged \| [0-9a-f]{10} \| pass \| 0 \|/);
  assert.match(report, /Interface requests:\n- player: expose max_hp/);
  assert.match(report, /9 source line\(s\) changed in the module folders on this run; the plan estimated 3000/);
  assert.equal(cli(root, 'status').json.runs.length, 1, 'result and report files are not runs');
});

test('record turns a passed module stage into diagnostics_failed when the test suite fails', async () => {
  const { root, output } = await moduleStage(FAILING_TESTS);
  const { json } = cli(root, 'record', '--from', output);
  assert.equal(json.status, 'diagnostics_failed');
  assert.equal(json.next, 'rework');
  assert.equal(json.nextCommand, '/module-pipeline:rework run-001');
  assert.match(json.diagnostics, /Diagnostics failed \(tests: failed\)/);
  assert.match(fs.readFileSync(json.reportPath, 'utf8'), /Tail of the test output:\n\n```\n1 test failed/);
  assert.equal(cli(root, 'finish', '--run', 'run-001').json.latest.modules.status, 'diagnostics_failed');
});

test('record lists review items with the blocking ones first, and the report keeps them in full', async () => {
  const item = (issue_id, severity, blocks) => ({
    issue_id,
    severity,
    problem: `${issue_id} is wrong`,
    expected_behavior: 'right',
    actual_behavior: 'wrong',
    evidence: 'src/enemy/enemy_impl.gd:1',
    recommended_action: 'reassign_to_same_agent',
    blocks_integration: blocks,
  });
  const { root, output } = await moduleStage(DEFAULT_MANIFEST, (taskId) =>
    taskId === 'enemy' ? { verdict: 'rework', summary: 'Two problems.', rework_items: [item('enemy-1', 'low', false), item('enemy-2', 'high', true)] } : PASS,
  );
  const { json } = cli(root, 'record', '--from', output);
  assert.equal(json.status, 'rework_required');
  assert.deepEqual(json.items.map((entry) => [entry.issue_id, entry.task, entry.blocking]), [['enemy-2', 'enemy', true], ['enemy-1', 'enemy', false]]);
  assert.equal(json.blockingCount, 1);
  assert.match(fs.readFileSync(json.reportPath, 'utf8'), /Review \(rework\): Two problems\.\n\n```yaml\n- issue_id: enemy-1\n[\s\S]*expected_behavior: right/);
});

test('record takes the bare result of the integration and patch stages, and refuses anything else', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const integration = {
    stage: 'integration',
    runId: 'run-001',
    status: 'rework_required',
    integration: { status: 'merged', commit: 'abcdef0123456789' },
    diagnostics: { failed: false, summary: '0 errors; 12 tests pass' },
    review: {
      verdict: 'rework',
      summary: 'Time is summed twice.',
      spec_coverage: [{ feature: 'Player | movement', status: 'done', owner: 'player' }],
      rule_checks: [{ topic: 'Time', status: 'violated', evidence: 'src/enemy/a.gd:3' }],
      rework_items: [{ issue_id: 'SYS-1', severity: 'high', scope: 'architecture', problem: 'two clocks', blocks_release: true }],
    },
    ruleViolations: [{ topic: 'Time', status: 'violated', evidence: 'src/enemy/a.gd:3' }],
    next: 'rework',
  };
  write(root, '.multiagent/integration.json', JSON.stringify(integration));
  const recorded = cli(root, 'record', '--from', path.join(root, '.multiagent', 'integration.json')).json;
  assert.equal(recorded.status, 'rework_required');
  assert.equal(recorded.diagnostics, 'Diagnostics passed: 0 errors; 12 tests pass');
  assert.deepEqual(recorded.ruleViolations.map((check) => check.topic), ['Time']);
  assert.deepEqual(recorded.items, [{ issue_id: 'SYS-1', task: 'architecture', severity: 'high', blocking: true, problem: 'two clocks' }]);
  const report = fs.readFileSync(recorded.reportPath, 'utf8');
  assert.match(report, /### Seam audit\n\n\| Rule topic \| Status \| Evidence \|\n\| --- \| --- \| --- \|\n\| Time \| violated \| src\/enemy\/a\.gd:3 \|/);
  assert.match(report, /\| Player \\\| movement \| done \| player \|/, 'a pipe in a cell is escaped');

  write(root, '.multiagent/passed.json', JSON.stringify({ ...integration, status: 'passed', next: 'merge_run_branch' }));
  const passed = cli(root, 'record', '--from', path.join(root, '.multiagent', 'passed.json')).json;
  assert.equal(passed.next, 'finish');
  assert.equal(passed.nextCommand, '/module-pipeline:finish run-001');

  write(root, '.multiagent/patch.json', JSON.stringify({ stage: 'patch', runId: 'run-001', status: 'patch_too_large', merge: { status: 'too_large', changedLines: 412 } }));
  const patch = cli(root, 'record', '--from', path.join(root, '.multiagent', 'patch.json')).json;
  assert.equal(patch.nextCommand, '/module-pipeline:rework run-001');
  assert.match(fs.readFileSync(patch.reportPath, 'utf8'), /Patch: too_large, 412 changed line\(s\)/);

  write(root, '.multiagent/other.json', JSON.stringify({ hello: 'world' }));
  const refused = cli(root, 'record', '--from', path.join(root, '.multiagent', 'other.json'));
  assert.equal(refused.code, 1);
  assert.match(refused.json.error, /does not hold a stage result/);
  write(root, '.multiagent/unknown.json', JSON.stringify({ stage: 'modules', runId: 'run-404', status: 'passed' }));
  assert.match(cli(root, 'record', '--from', path.join(root, '.multiagent', 'unknown.json')).json.error, /No pipeline run run-404/);
});

test('record hands a passed module stage straight to the integration, so one command runs both', async () => {
  const { root, manifest, output } = await moduleStage(DEFAULT_MANIFEST);
  const recorded = cli(root, 'record', '--from', output).json;
  assert.equal(recorded.next, 'integrate');
  const { continueWith } = recorded;
  assert.equal(continueWith.stage, 'integration');
  assert.match(continueWith.workflowScript, /\.multiagent\/pipeline\/workflows\/integrate-system\.js$/);
  assert.deepEqual(continueWith.agents.map((row) => [row.role, row.count, row.model]), [['integrator', 1, 'sonnet'], ['system-reviewer', 1, 'opus']]);
  const prepared = cli(root, 'prepare', manifest, '--stage', 'integration').json;
  assert.deepEqual(continueWith.workflowArgs, prepared.workflowArgs, 'the same args the integrate command would get from prepare');

  // The session starts the integration with those args and records it: the run is ready to finish.
  const { result } = await runWorkflow('integrate-system', {
    root,
    args: continueWith.workflowArgs,
    scenario: {
      integrate: ({ write: writeFile }) => {
        writeFile('src/game/main.gd', 'extends Node\n');
        writeFile('work/integration/run-001_integration_report.md', 'wired\n');
        return { summary: 'wired', executionOrder: 'player, enemy, hud', testsRun: 'none', blockers: [] };
      },
      systemReview: () => ({ verdict: 'pass', summary: 'Meets the spec.', spec_coverage: [{ feature: 'Player', status: 'done' }], rework_items: [] }),
    },
  });
  write(root, '.multiagent/integration-output.json', JSON.stringify({ result }));
  const finished = cli(root, 'record', '--from', path.join(root, '.multiagent', 'integration-output.json')).json;
  assert.equal(finished.status, 'passed', JSON.stringify(finished));
  assert.equal(finished.nextCommand, '/module-pipeline:finish run-001');
  assert.equal(finished.continueWith, undefined, 'nothing follows the integration');
});

test('record hands over nothing when the module stage did not pass, has no integration, or left stray files', async () => {
  const failed = await moduleStage(FAILING_TESTS);
  const failedRecord = cli(failed.root, 'record', '--from', failed.output).json;
  assert.equal(failedRecord.status, 'diagnostics_failed');
  assert.equal(failedRecord.continueWith, undefined);

  const noGlue = await moduleStage(DEFAULT_MANIFEST.replace(/integration:\n[\s\S]*$/, ''));
  const noGlueRecord = cli(noGlue.root, 'record', '--from', noGlue.output).json;
  assert.equal(noGlueRecord.next, 'finish');
  assert.equal(noGlueRecord.continueWith, undefined);

  // A file written around the pipeline blocks the integration's own checks, so the user is asked first.
  const stray = await moduleStage(DEFAULT_MANIFEST);
  write(stray.root, 'build/output.log', 'left by a build\n');
  const strayRecord = cli(stray.root, 'record', '--from', stray.output).json;
  assert.equal(strayRecord.status, 'passed');
  assert.ok(strayRecord.strayChanges.some((file) => file.startsWith('build/')), JSON.stringify(strayRecord.strayChanges));
  assert.equal(strayRecord.continueWith, undefined);
  assert.equal(strayRecord.nextCommand, '/module-pipeline:integrate tasks/task_manifest.yaml');
});

test('the run skill starts the integration from the fields record prints, and can be told to stop before it', async () => {
  const skill = fs.readFileSync(new URL('../skills/run/SKILL.md', import.meta.url), 'utf8');
  const { root, output } = await moduleStage(DEFAULT_MANIFEST);
  const { continueWith } = cli(root, 'record', '--from', output).json;
  // Every field of the hand-over the skill names is one record really prints.
  const named = [...skill.matchAll(/continueWith\.([A-Za-z]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(named)].sort(), ['workflowArgs', 'workflowScript']);
  for (const field of named) {
    assert.ok(continueWith[field], `record prints continueWith.${field}`);
  }
  assert.match(skill, /argument-hint: "\[manifest-path\] \[--modules-only\]"/);
  assert.match(skill, /`--modules-only` stops after\s+the module stage/);
  assert.match(skill, /do not run prepare again/);
});

test('prepare alone tells the session what to ask and what to announce', () => {
  const { root, manifest } = makeProject();
  write(root, 'docs/notes.md', 'planning output\n');
  const blocked = cli(root, 'prepare', manifest).json;
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.uncommitted, ['docs/notes.md']);

  cli(root, 'commit-planning', manifest);
  const ready = cli(root, 'prepare', manifest).json;
  assert.equal(ready.ok, true);
  assert.equal(ready.estimate.totalAgents, 8);
  assert.deepEqual(ready.estimate.run.map((row) => [row.role, row.count]), [['module-implementer', 3], ['module-reviewer', 3]]);
  assert.equal(git(root, 'branch', '--show-current'), 'multiagent-runs/run-001');
});

test('prepare for integration reports how the module stage ended', async () => {
  const { root, manifest, output } = await moduleStage(FAILING_TESTS);
  assert.equal(cli(root, 'prepare', manifest, '--stage', 'integration').json.modulesStatus, null, 'nothing recorded yet');
  cli(root, 'record', '--from', output);
  const prepared = cli(root, 'prepare', manifest, '--stage', 'integration').json;
  assert.equal(prepared.modulesStatus, 'diagnostics_failed');
  assert.deepEqual(prepared.modules, ['player', 'enemy', 'hud']);
});
