// 0.8.0: a module whose implementer finished before the run was interrupted is merged and reviewed, not rebuilt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';
import { prepareArgs, runWorkflow } from './workflow-harness.mjs';

const PASS = { verdict: 'pass', summary: 'Looks right.', rework_items: [] };

/** An implementer of an interrupted invocation: a claimed worktree with work in it, with or without the report. */
function interruptedImplementer(root, taskId, { finished }) {
  const worktree = makeAgentWorktree(root, `interrupted-${taskId}`);
  assert.equal(cli(worktree, 'claim', '--run', 'run-001', '--task', taskId).json.ok, true);
  write(worktree, `src/${taskId}/${taskId}_first.gd`, `class_name ${taskId}First\n`);
  if (finished) {
    write(worktree, `work/modules/${taskId}/module_report.md`, `${taskId} done before the interruption.\n`);
  }
  return worktree;
}

test('a rerun sends finished but unmerged modules straight to review and rebuilds only the rest', async () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  interruptedImplementer(root, 'player', { finished: true });
  interruptedImplementer(root, 'enemy', { finished: false });

  const prepared = cli(root, 'prepare', manifest).json;
  assert.deepEqual(prepared.resumable, ['player']);
  assert.deepEqual(prepared.workflowArgs.waves[0], [
    { id: 'player', dependsOn: [], effort: 'medium', resume: true },
    { id: 'enemy', dependsOn: [], effort: 'medium' },
  ]);

  const implemented = [];
  let playerReviewPrompt = '';
  const { result, calls, logs } = await runWorkflow('implement-modules', {
    root,
    args: prepared.workflowArgs,
    scenario: {
      implement: ({ taskId, write: writeFile }) => {
        implemented.push(taskId);
        writeFile(`src/${taskId}/${taskId}_second.gd`, `class_name ${taskId}Second\n`);
        writeFile(`work/modules/${taskId}/module_report.md`, `${taskId} done.\n`);
        return { summary: `${taskId} built`, testsRun: 'none', blockers: [] };
      },
      review: (taskId, prompt) => {
        if (taskId === 'player') {
          playerReviewPrompt = prompt;
        }
        return PASS;
      },
    },
  });

  assert.deepEqual(implemented.sort(), ['enemy', 'hud'], 'the finished module is not implemented again');
  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  const byTask = Object.fromEntries(result.modules.map((module) => [module.task, module]));
  assert.equal(byTask.player.resumed, true);
  assert.equal(byTask.enemy.resumed, false);
  assert.match(playerReviewPrompt, /Resumed: the implementer finished in an earlier invocation/);
  assert.match(logs[0], /player \(resumed, review only\), enemy/);
  assert.equal(calls.filter((call) => call.agentType === 'module-pipeline:module-implementer').length, 2);

  assert.ok(fs.existsSync(path.join(root, 'src/player/player_first.gd')), 'the interrupted implementer\'s work is merged');
  assert.ok(fs.existsSync(path.join(root, 'src/enemy/enemy_second.gd')));
  assert.equal(fs.existsSync(path.join(root, 'src/enemy/enemy_first.gd')), false, 'the unfinished attempt is not merged; the newest claim wins');
});

test('a module whose merge was already refused is not resumed', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = interruptedImplementer(root, 'player', { finished: true });
  write(worktree, 'src/enemy/sneaky.gd', 'not mine\n');
  assert.equal(cli(root, 'integrate-task', '--run', 'run-001', '--task', 'player').json.status, 'violation');
  assert.deepEqual(cli(root, 'prepare', manifest).json.resumable, [], 'merging the same worktree again would only repeat the violation');
});

test('a finished module is found on its branch when the harness already removed the clean worktree', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = interruptedImplementer(root, 'player', { finished: true });
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'agent commit');
  git(root, 'worktree', 'remove', '--force', worktree);
  assert.deepEqual(cli(root, 'prepare', manifest).json.resumable, ['player']);
});
