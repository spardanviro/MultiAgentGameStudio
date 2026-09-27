import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PLUGIN_ROOT, cli, git, makeProject } from './helpers.mjs';
import { runWorkflow } from './workflow-harness.mjs';

const PASS = { verdict: 'pass', summary: 'Looks right.', rework_items: [] };

function implementer(overrides = {}) {
  return ({ taskId, write, worktree }) => {
    const custom = overrides[taskId];
    if (custom) {
      return custom({ taskId, write, worktree });
    }
    write(`src/${taskId}/${taskId}_impl.gd`, `class_name ${taskId}\n`);
    write(`work/modules/${taskId}/module_report.md`, `${taskId} done.\n`);
    return { summary: `${taskId} built`, testsRun: 'none', blockers: [] };
  };
}

function setup() {
  const { root, manifest } = makeProject();
  return { root, args: { pluginRoot: PLUGIN_ROOT.replace(/\\/g, '/'), manifest } };
}

test('implement workflow: waves run in order, each module is committed, reviewed and passes', async () => {
  const { root, args } = setup();
  let hudSawPlayer = null;
  const { result, calls } = await runWorkflow('implement-modules', {
    root,
    args,
    scenario: {
      implement: implementer({
        hud: ({ write, worktree }) => {
          hudSawPlayer = fs.existsSync(path.join(worktree, 'src/player/player_impl.gd'));
          write('src/hud/hud.gd', 'class_name Hud\n');
          return { summary: 'hud built', testsRun: 'none', blockers: [] };
        },
      }),
      review: () => PASS,
    },
  });

  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  assert.equal(result.next, 'integrate');
  assert.deepEqual(result.modules.map((module) => [module.task, module.status]), [
    ['player', 'merged'],
    ['enemy', 'merged'],
    ['hud', 'merged'],
  ]);
  assert.equal(hudSawPlayer, true, 'the second wave starts from the run branch that already holds wave one');
  assert.equal(git(root, 'branch', '--show-current'), 'multiagent-runs/run-001');
  assert.deepEqual(git(root, 'log', '--format=%s', '-3').split('\n').sort(), [
    'module-pipeline(run-001): enemy',
    'module-pipeline(run-001): hud',
    'module-pipeline(run-001): player',
  ]);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'module-pipeline(run-001): hud');

  const implementCalls = calls.filter((call) => call.agentType === 'module-pipeline:module-implementer');
  assert.equal(implementCalls.length, 3);
  assert.ok(implementCalls.every((call) => call.isolation === 'worktree'));
  assert.ok(implementCalls.every((call) => call.model === 'sonnet'), 'manifest defaults.model reaches the agents');
  assert.equal(calls.filter((call) => call.agentType === 'module-pipeline:module-reviewer').length, 3);
  assert.ok(calls.filter((call) => call.agentType === 'module-pipeline:pipeline-ops').every((call) => call.model === 'haiku'));
});

test('implement workflow: an out-of-scope module is not merged and its dependents are skipped', async () => {
  const { root, args } = setup();
  const { result } = await runWorkflow('implement-modules', {
    root,
    args,
    scenario: {
      implement: implementer({
        player: ({ write }) => {
          write('src/player/player_impl.gd', 'ok\n');
          write('src/enemy/sneaky.gd', 'not mine\n');
          return { summary: 'player built', testsRun: 'none', blockers: [] };
        },
      }),
      review: () => PASS,
    },
  });

  assert.equal(result.status, 'modules_failed');
  assert.equal(result.next, 'rework');
  const byTask = Object.fromEntries(result.modules.map((module) => [module.task, module]));
  assert.equal(byTask.player.status, 'violation');
  assert.deepEqual(byTask.player.violations, ['src/enemy/sneaky.gd']);
  assert.equal(byTask.enemy.status, 'merged');
  assert.equal(byTask.hud.status, 'skipped');
  assert.match(byTask.hud.reason, /depends on player/);
  assert.equal(fs.existsSync(path.join(root, 'src/enemy/sneaky.gd')), false);
});

test('implement workflow: a blocking review item requires rework; a rerun skips merged modules', async () => {
  const { root, args } = setup();
  const blocking = {
    verdict: 'rework',
    summary: 'HUD ignores health changes.',
    rework_items: [
      {
        issue_id: 'hud-1',
        severity: 'high',
        problem: 'HUD never subscribes to health_changed',
        expected_behavior: 'Bar updates on damage',
        actual_behavior: 'Bar stays full',
        evidence: 'src/hud/hud_impl.gd:1',
        recommended_action: 'reassign_to_same_agent',
        blocks_integration: true,
      },
      {
        issue_id: 'hud-2',
        severity: 'low',
        problem: 'naming',
        expected_behavior: '-',
        actual_behavior: '-',
        evidence: '-',
        recommended_action: 'main_agent_decision',
        blocks_integration: false,
      },
    ],
  };
  const first = await runWorkflow('implement-modules', {
    root,
    args,
    scenario: { implement: implementer(), review: (taskId) => (taskId === 'hud' ? blocking : PASS) },
  });
  assert.equal(first.result.status, 'rework_required');
  assert.deepEqual(first.result.blockingItems.map((item) => [item.task, item.issue_id]), [['hud', 'hud-1']]);

  const second = await runWorkflow('implement-modules', {
    root,
    args,
    scenario: { implement: () => assert.fail('nothing should be re-implemented'), review: () => PASS },
  });
  assert.deepEqual(second.result.alreadyMerged.sort(), ['enemy', 'hud', 'player']);
  assert.deepEqual(second.result.modules, []);
});

test('implement workflow: prepare errors stop the run before any agent starts', async () => {
  const { root, args } = setup();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'uncommitted\n');
  const { result, calls } = await runWorkflow('implement-modules', {
    root,
    args,
    scenario: { implement: () => assert.fail('no agents'), review: () => assert.fail('no agents') },
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.errors[0], /uncommitted changes \(notes\.txt\)/);
  assert.equal(calls.length, 1);
});

test('integrate workflow: glue is committed, diagnostics run, and the system review gates release', async () => {
  const { root, args } = setup();
  await runWorkflow('implement-modules', { root, args, scenario: { implement: implementer(), review: () => PASS } });

  let reviewPrompt = '';
  const { result } = await runWorkflow('integrate-system', {
    root,
    args,
    scenario: {
      integrate: ({ write }) => {
        write('src/game/main.gd', 'extends Node\n');
        write('work/integration/run-001_integration_report.md', 'wired\n');
        return { summary: 'wired player, enemy, hud', executionOrder: 'player, enemy, hud', testsRun: 'none', blockers: [] };
      },
      systemReview: (prompt) => {
        reviewPrompt = prompt;
        return { verdict: 'pass', summary: 'Meets the spec.', spec_coverage: [{ feature: 'Player', status: 'done' }], rework_items: [] };
      },
    },
  });

  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  assert.equal(result.integration.status, 'merged');
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'module-pipeline(run-001): integration');
  assert.match(reviewPrompt, /Spec: docs\/spec\.md/);
  assert.match(reviewPrompt, /<<<AGENT_OUTPUT\nwired player, enemy, hud/);
  assert.equal(cli(root, 'status', '--run', 'run-001').json.runs[0].tasks.integration, 'merged');
});

test('integrate workflow refuses to start before every module is merged', async () => {
  const { root, args } = setup();
  cli(root, 'prepare', args.manifest);
  const { result } = await runWorkflow('integrate-system', {
    root,
    args,
    scenario: { integrate: () => assert.fail('no agent'), systemReview: () => assert.fail('no agent') },
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.errors[0], /Modules not merged yet/);
});
