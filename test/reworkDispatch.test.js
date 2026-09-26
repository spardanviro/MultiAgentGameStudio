const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const yaml = require('js-yaml');

const { getStatePath, initializeRun, loadState, startTask, validateManifest, waiveWorkflowGate } = require('../src/multiAgent');
const { advanceWorkflowWithRework, importReworkManifest, startArchitectRework } = require('../src/reworkDispatch');

const BLOCKING_REVIEW = `# Module Review

\`\`\`yaml
rework_items:
  - issue_id: MR-1
    severity: high
    task_id: player-health
    problem: Damage ignores armor
    recommended_action: reassign_to_same_agent
    blocks_integration: true
\`\`\`
`;

function rawManifest(root, runId = 'run-001') {
  return {
    version: 1,
    project: { name: 'Game', root },
    run: { id: runId, goal: 'Build health', base: 'head' },
    main_agent: { name: 'main-architect', model: 'opus', effort: 'high' },
    defaults: { sub_agent_model: 'sonnet', permission_mode: 'acceptEdits' },
    tasks: [
      {
        id: 'player-health',
        feature: 'Player Health',
        owner: 'player-health-agent',
        role: 'sub',
        owned_script: 'src/player/player_health.gd',
        test_file: 'tests/player/test_player_health.gd',
        prompt_file: 'work/prompts/player_health.md',
        module_report: 'work/modules/player_health/module_report.md',
        interface_request: 'work/modules/player_health/interface_change_request.md',
        allowed_files: [
          'src/player/player_health.gd',
          'tests/player/test_player_health.gd',
          'work/modules/player_health/module_report.md',
          'work/modules/player_health/interface_change_request.md',
        ],
        depends_on: [],
        acceptance: ['Health works'],
      },
    ],
    module_review: { prompt_file: 'work/prompts/module_review.md' },
    integration: { prompt_file: 'work/prompts/integration.md', allowed_files: ['src/game/wiring.gd'] },
  };
}

function makeRunner(claudeState) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'agents') {
      return { stdout: JSON.stringify(claudeState.agents), stderr: '' };
    }
    if (command === 'claude' && args[0] === 'auth') {
      return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n', stderr: '' };
    }
    if (command === 'claude') {
      return { stdout: `backgrounded · ${claudeState.nextLaunchId} · agent\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

async function setupReviewedRun(reviewReport) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-rework-'));
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  for (const name of ['player_health', 'module_review', 'integration']) {
    await fs.writeFile(path.join(root, 'work', 'prompts', `${name}.md`), `Prompt ${name}\n`);
  }
  if (reviewReport !== null) {
    await fs.mkdir(path.join(root, 'reports', 'reviews', 'run-001'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports', 'reviews', 'run-001', 'module_review.md'), reviewReport);
  }

  const claudeState = { agents: [], nextLaunchId: 'abcd1234' };
  const { runner, calls } = makeRunner(claudeState);
  const manifest = validateManifest(rawManifest(root), path.join(root, 'tasks', 'task_manifest.yaml'));
  await initializeRun(manifest, { runner });

  const statePath = getStatePath(root, 'run-001');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const appliedAt = new Date().toISOString();
  Object.assign(state.agents['player-health'], { status: 'patch_applied', appliedAt });
  Object.assign(state.agents['module-review'], { status: 'patch_applied', appliedAt });
  state.workflow = { diagnostics: { afterModules: 'passed', afterIntegration: 'passed' } };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

  return { root, runner, calls, claudeState };
}

test('a blocking module review closes the gate and keeps integration from starting', async () => {
  const { root, runner } = await setupReviewedRun(BLOCKING_REVIEW);

  const result = await advanceWorkflowWithRework(root, 'run-001', { runner });
  assert.equal(result.stopReason, 'rework_required');
  assert.equal(result.reviewGates[0].outcome, 'rework_required');
  assert.equal(result.reviewGates[0].blockingItems[0].issue_id, 'MR-1');

  const direct = await startTask(root, 'run-001', 'integration', { runner });
  const integration = direct.agents.find((agent) => agent.taskId === 'integration');
  assert.equal(integration.status, 'queued');
  assert.match(integration.error, /Blocked by review gate\(s\) module-review/);
});

test('a missing review report closes the gate instead of silently passing', async () => {
  const { root, runner } = await setupReviewedRun(null);
  const result = await advanceWorkflowWithRework(root, 'run-001', { runner });
  assert.equal(result.stopReason, 'rework_required');
  assert.equal(result.reviewGates[0].outcome, 'report_missing');
});

test('waiving the gate lets integration start', async () => {
  const { root, runner } = await setupReviewedRun(BLOCKING_REVIEW);
  await advanceWorkflowWithRework(root, 'run-001', { runner });
  await waiveWorkflowGate(root, 'run-001', 'module-review', 'accepted for now');

  const result = await advanceWorkflowWithRework(root, 'run-001', { runner });
  assert.equal(result.stopReason, 'agents_started');
  assert.equal(result.run.agents.find((agent) => agent.taskId === 'integration').status, 'running');
});

test('rework round: dispatch architect, wait, detect manifest, and import it as a linked run', async () => {
  const { root, runner, calls, claudeState } = await setupReviewedRun(BLOCKING_REVIEW);
  await advanceWorkflowWithRework(root, 'run-001', { runner });

  const dispatched = await startArchitectRework(root, 'run-001', { runner });
  const rework = dispatched.workflow.rework;
  assert.equal(rework.status, 'running');
  assert.equal(rework.claudeSessionId, 'abcd1234');
  assert.equal(rework.nextRunId, 'run-001-rework-1');
  assert.equal(rework.manifestPath, 'tasks/task_manifest.run-001-rework-1.yaml');

  const launch = calls.find((call) => call.command === 'claude' && call.args[0] === '--bg');
  assert.deepEqual(launch.args.slice(0, 9), [
    '--bg', '--name', 'main-architect', '--model', 'opus', '--permission-mode', 'acceptEdits', '--effort', 'high',
  ]);
  const prompt = await fs.readFile(rework.promptPath, 'utf8');
  assert.match(prompt, /issue_id: MR-1/);

  await assert.rejects(startArchitectRework(root, 'run-001', { runner }), /already running/);

  claudeState.agents = [{ id: 'abcd1234', name: 'main-architect', state: 'working' }];
  let result = await advanceWorkflowWithRework(root, 'run-001', { runner });
  assert.equal(result.stopReason, 'rework_in_progress');

  const next = rawManifest(root, 'run-001-rework-1');
  await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
  await fs.writeFile(path.join(root, rework.manifestPath), yaml.dump(next), 'utf8');
  claudeState.agents = [{ id: 'abcd1234', name: 'main-architect', state: 'done' }];
  result = await advanceWorkflowWithRework(root, 'run-001', { runner });
  assert.equal(result.stopReason, 'rework_manifest_ready');

  const nextRun = await importReworkManifest(root, 'run-001', { runner });
  assert.equal(nextRun.runId, 'run-001-rework-1');
  assert.deepEqual(nextRun.reworkOf, {
    parentRunId: 'run-001',
    rootRunId: 'run-001',
    round: 1,
    decisionsPath: 'reports/rework/run-001-rework-1_decisions.md',
  });

  const parent = await loadState(root, 'run-001');
  assert.equal(parent.workflow.rework.status, 'imported');
  result = await advanceWorkflowWithRework(root, 'run-001', { runner });
  assert.equal(result.stopReason, 'rework_imported');
});

test('a finished round without a manifest releases the hold so the user can waive', async () => {
  const { root, runner, claudeState } = await setupReviewedRun(BLOCKING_REVIEW);
  await startArchitectRework(root, 'run-001', { runner });

  claudeState.agents = [{ id: 'abcd1234', state: 'done' }];
  const result = await advanceWorkflowWithRework(root, 'run-001', { runner });
  assert.equal(result.stopReason, 'rework_required');
  assert.equal(result.run.workflow.rework.status, 'finished_without_manifest');
});

test('dispatch refuses when there is nothing to rework', async () => {
  const { root, runner } = await setupReviewedRun('```yaml\nrework_items: []\n```\n');
  await assert.rejects(startArchitectRework(root, 'run-001', { runner }), /Nothing to rework/);
});

test('auto dispatch starts the architect once and never re-dispatches the same run', async () => {
  const { root, runner, calls, claudeState } = await setupReviewedRun(BLOCKING_REVIEW);

  const first = await advanceWorkflowWithRework(root, 'run-001', { runner, autoDispatchRework: true });
  assert.equal(first.stopReason, 'rework_dispatched');
  assert.equal(first.gateStopReason, 'rework_required');

  claudeState.agents = [{ id: 'abcd1234', state: 'failed' }];
  const second = await advanceWorkflowWithRework(root, 'run-001', { runner, autoDispatchRework: true });
  assert.equal(second.stopReason, 'rework_required');
  assert.equal(second.run.workflow.rework.status, 'failed');
  assert.equal(calls.filter((call) => call.command === 'claude' && call.args[0] === '--bg').length, 1);
});

test('importing a rework manifest for another project root is refused', async () => {
  const { root, runner, claudeState } = await setupReviewedRun(BLOCKING_REVIEW);
  const dispatched = await startArchitectRework(root, 'run-001', { runner });
  const foreign = rawManifest(path.join(os.tmpdir(), 'some-other-project'), 'run-001-rework-1');
  await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
  await fs.writeFile(path.join(root, dispatched.workflow.rework.manifestPath), yaml.dump(foreign), 'utf8');
  claudeState.agents = [{ id: 'abcd1234', state: 'done' }];
  await advanceWorkflowWithRework(root, 'run-001', { runner });

  await assert.rejects(importReworkManifest(root, 'run-001', { runner }), /does not match this project/);
});
