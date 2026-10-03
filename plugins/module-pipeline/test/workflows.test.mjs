import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cli, git, makeProject } from './helpers.mjs';
import { prepareArgs, runWorkflow } from './workflow-harness.mjs';

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

/** Runs the module stage the way the run skill does: prepare, then the workflow with its args. */
function runModules(root, manifest, scenario) {
  return runWorkflow('implement-modules', { root, args: prepareArgs(root, manifest), scenario });
}

function runIntegration(root, manifest, scenario) {
  return runWorkflow('integrate-system', { root, args: prepareArgs(root, manifest, '--stage', 'integration'), scenario });
}

test('implement workflow: waves run in order, each reviewer merges its module and reviews it', async () => {
  const { root, manifest } = makeProject();
  let hudSawPlayer = null;
  let playerClaim = null;
  const { result, calls } = await runModules(root, manifest, {
    implement: implementer({
      hud: ({ write, worktree }) => {
        hudSawPlayer = fs.existsSync(path.join(worktree, 'src/player/player_impl.gd'));
        write('src/hud/hud.gd', 'class_name Hud\n');
        return { summary: 'hud built', testsRun: 'none', blockers: [] };
      },
    }),
    review: (taskId, prompt, merged) => {
      if (taskId === 'player') {
        playerClaim = merged;
      }
      return PASS;
    },
  });

  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  assert.equal(result.next, 'diagnostics');
  assert.deepEqual(result.modules.map((module) => [module.task, module.status]), [
    ['player', 'merged'],
    ['enemy', 'merged'],
    ['hud', 'merged'],
  ]);
  assert.equal(hudSawPlayer, true, 'the second wave starts from the run branch that already holds wave one');
  assert.equal(playerClaim.task.promptFile, 'work/prompts/player.md', 'the merge output carries the task for the reviewer');
  assert.deepEqual(playerClaim.sharedLayer, ['src/common/']);
  assert.equal(git(root, 'branch', '--show-current'), 'multiagent-runs/run-001');
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'module-pipeline(run-001): hud');

  assert.deepEqual([...new Set(calls.map((call) => call.agentType))].sort(), [
    'module-pipeline:module-implementer',
    'module-pipeline:module-reviewer',
  ], 'no agent is spent on relaying pipeline commands');
  const implementCalls = calls.filter((call) => call.agentType === 'module-pipeline:module-implementer');
  assert.equal(implementCalls.length, 3);
  assert.ok(implementCalls.every((call) => call.isolation === 'worktree'));
  const reviewCalls = calls.filter((call) => call.agentType === 'module-pipeline:module-reviewer');
  assert.ok(implementCalls.every((call) => call.model === 'sonnet'), 'implementers run on sonnet');
  assert.ok(reviewCalls.every((call) => call.model === 'opus'), 'reviewers run on opus');
  assert.ok(implementCalls.every((call) => call.effort === 'medium'), 'effort.module_implementer reaches the implementers');
  assert.ok(reviewCalls.every((call) => call.effort === 'high'), 'a role the manifest leaves alone thinks at high');
});

test('implement workflow: an out-of-scope module is not merged and its dependents are skipped', async () => {
  const { root, manifest } = makeProject();
  let reviewedPlayer = false;
  const { result } = await runModules(root, manifest, {
    implement: implementer({
      player: ({ write }) => {
        write('src/player/player_impl.gd', 'ok\n');
        write('src/enemy/sneaky.gd', 'not mine\n');
        return { summary: 'player built', testsRun: 'none', blockers: [] };
      },
    }),
    review: (taskId) => {
      reviewedPlayer ||= taskId === 'player';
      return PASS;
    },
  });

  assert.equal(result.status, 'modules_failed');
  assert.equal(result.next, 'rework');
  const byTask = Object.fromEntries(result.modules.map((module) => [module.task, module]));
  assert.equal(byTask.player.status, 'violation');
  assert.deepEqual(byTask.player.violations, ['src/enemy/sneaky.gd']);
  assert.equal(byTask.player.review, null);
  assert.equal(reviewedPlayer, false, 'a module that did not merge is not reviewed');
  assert.equal(byTask.enemy.status, 'merged');
  assert.equal(byTask.hud.status, 'skipped');
  assert.match(byTask.hud.reason, /depends on player/);
  assert.equal(fs.existsSync(path.join(root, 'src/enemy/sneaky.gd')), false);
});

test('implement workflow: a blocking review item requires rework; a rerun skips merged modules', async () => {
  const { root, manifest } = makeProject();
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
  const first = await runModules(root, manifest, {
    implement: implementer(),
    review: (taskId) => (taskId === 'hud' ? blocking : PASS),
  });
  assert.equal(first.result.status, 'rework_required');
  assert.deepEqual(first.result.blockingItems.map((item) => [item.task, item.issue_id]), [['hud', 'hud-1']]);

  const second = await runModules(root, manifest, {
    implement: () => assert.fail('nothing should be re-implemented'),
    review: () => PASS,
  });
  assert.deepEqual(second.result.alreadyMerged.sort(), ['enemy', 'hud', 'player']);
  assert.deepEqual(second.result.modules, []);
});

test('prepare errors stop the run before the workflow starts; the workflow needs its args', async () => {
  const { root, manifest } = makeProject();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'uncommitted\n');
  const prepared = cli(root, 'prepare', manifest).json;
  assert.equal(prepared.ok, false);
  assert.match(prepared.errors[0], /uncommitted changes \(notes\.txt\)/);
  await assert.rejects(
    runWorkflow('implement-modules', { root, args: { manifest }, scenario: {} }),
    /requires the workflowArgs printed by `pipeline\.mjs prepare`/,
  );
});

test('integrate workflow: the system reviewer commits the glue, runs diagnostics and gates release', async () => {
  const { root, manifest } = makeProject();
  await runModules(root, manifest, { implement: implementer(), review: () => PASS });

  let reviewPrompt = '';
  const { result, calls } = await runIntegration(root, manifest, {
    integrate: ({ write }) => {
      write('src/game/main.gd', 'extends Node\n');
      write('work/integration/run-001_integration_report.md', 'wired\n');
      return { summary: 'wired player, enemy, hud', executionOrder: 'player, enemy, hud', testsRun: 'none', blockers: [] };
    },
    systemReview: (prompt) => {
      reviewPrompt = prompt;
      return { verdict: 'pass', summary: 'Meets the spec.', spec_coverage: [{ feature: 'Player', status: 'done' }], rework_items: [] };
    },
  });

  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  assert.equal(result.integration.status, 'merged');
  assert.equal(result.diagnostics.failed, false);
  assert.deepEqual(calls.map((call) => [call.agentType, call.model, call.effort]), [
    ['module-pipeline:integrator', 'sonnet', 'high'],
    ['module-pipeline:system-reviewer', 'opus', 'high'],
  ]);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'module-pipeline(run-001): integration');
  assert.match(reviewPrompt, /against the spec \(docs\/spec\.md\)/);
  assert.match(reviewPrompt, /<<<AGENT_OUTPUT\nwired player, enemy, hud/);
  assert.equal(cli(root, 'status', '--run', 'run-001').json.runs[0].tasks.integration, 'merged');
});

test('integrate workflow: an integrator with nothing to change still gets diagnostics and the system review', async () => {
  const { root, manifest } = makeProject();
  await runModules(root, manifest, { implement: implementer(), review: () => PASS });

  let reviewed = false;
  const { result } = await runIntegration(root, manifest, {
    integrate: () => ({ summary: 'the existing glue already fits', testsRun: 'none', blockers: [] }),
    systemReview: () => {
      reviewed = true;
      return { verdict: 'pass', summary: 'ok', spec_coverage: [], rework_items: [] };
    },
  });

  assert.equal(result.integration.status, 'empty');
  assert.equal(reviewed, true);
  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
});

test('integrate workflow: glue written outside its scope fails the integration without a review', async () => {
  const { root, manifest } = makeProject();
  await runModules(root, manifest, { implement: implementer(), review: () => PASS });

  const { result } = await runIntegration(root, manifest, {
    integrate: ({ write }) => {
      write('src/player/patched.gd', 'not the glue\n');
      return { summary: 'patched the player', testsRun: 'none', blockers: [] };
    },
    systemReview: () => assert.fail('no review without the glue'),
  });
  assert.equal(result.status, 'integration_failed');
  assert.equal(result.integration.status, 'violation');
});

test('integration cannot be prepared before every module is merged', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const prepared = cli(root, 'prepare', manifest, '--stage', 'integration').json;
  assert.equal(prepared.ok, false);
  assert.match(prepared.errors[0], /Modules not merged yet/);
});
