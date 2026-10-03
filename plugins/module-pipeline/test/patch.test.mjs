// 0.6.0: small rework runs as one patch instead of the full module path.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { handle } from '../scripts/scope-hook.mjs';
import { validateManifest } from '../scripts/lib/manifest.mjs';
import yaml from '../scripts/vendor/js-yaml.mjs';
import { cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';
import { prepareArgs, runWorkflow } from './workflow-harness.mjs';

const PATCH_MANIFEST = (maxLines = 40) => `version: 1
project:
  name: Game
  spec: docs/spec.md
run:
  id: run-001-r1
  goal: Fix the balance values
diagnostics:
  compile_command: null
shared_layer:
  existing: [src/common/]
patch:
  prompt_file: work/prompts/patch.md
  allowed_files: [src/player/, src/hud/]
  acceptance:
    - Player speed is 85
    - The HUD shows the new speed
  max_changed_lines: ${maxLines}
`;

const parse = (text) => validateManifest(yaml.load(text), path.resolve('/p/tasks/task_manifest.yaml'));
const PASS = { verdict: 'pass', summary: 'Both items resolved.', rework_items: [] };

function patchProject(maxLines) {
  const project = makeProject(PATCH_MANIFEST(maxLines));
  write(project.root, 'work/prompts/patch.md', 'Fix the speed.\n');
  git(project.root, 'add', '.');
  git(project.root, 'commit', '-q', '-m', 'patch prompt');
  return project;
}

function runPatch(root, manifest, scenario) {
  return runWorkflow('patch-run', { root, args: prepareArgs(root, manifest), scenario });
}

test('a patch manifest has one patch task instead of modules and integration', () => {
  const manifest = parse(PATCH_MANIFEST());
  assert.deepEqual(manifest.tasks, []);
  assert.equal(manifest.integration, null);
  assert.equal(manifest.patch.maxChangedLines, 40);
  assert.equal(manifest.patch.effort, 'high');
  assert.deepEqual(manifest.patch.allowedFiles, [
    'work/patches/run-001-r1_patch_report.md',
    'work/patches/run-001-r1_interface_request.md',
    'src/player/',
    'src/hud/',
  ]);
  assert.deepEqual(manifest.sharedLayer, { taskId: null, paths: ['src/common/'], rules: null });
  assert.equal(parse(PATCH_MANIFEST().replace('  max_changed_lines: 40\n', '')).patch.maxChangedLines, 300);

  const withTasks = `${PATCH_MANIFEST()}tasks:\n  - id: player\n    owned_folder: src/player/\n    prompt_file: work/prompts/player.md\n`;
  assert.throws(() => parse(withTasks), /A patch run has only the patch section/);
  assert.throws(() => parse(PATCH_MANIFEST().replace('  allowed_files: [src/player/, src/hud/]\n', '')), /patch\.allowed_files must list/);
  assert.throws(() => parse(PATCH_MANIFEST('lots')), /patch\.max_changed_lines must be a positive whole number/);
});

test('validate and prepare describe a patch run: two agents, no waves, no integration stage', () => {
  const { root, manifest } = patchProject();
  const validated = cli(root, 'validate', manifest).json;
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.equal(validated.mode, 'patch');
  assert.deepEqual(validated.waves, []);
  assert.deepEqual(validated.estimate.run, [
    { role: 'patcher', count: 1, model: 'opus', effort: 'high' },
    { role: 'module-reviewer', count: 1, model: 'opus', effort: 'high' },
  ]);
  assert.equal(validated.estimate.totalAgents, 2);

  const prepared = cli(root, 'prepare', manifest).json;
  assert.equal(prepared.workflowArgs.mode, 'patch');
  assert.deepEqual(prepared.workflowArgs.patch, { effort: 'high', maxChangedLines: 40 });
  assert.match(cli(root, 'prepare', manifest, '--stage', 'integration').json.errors[0], /A patch run has no integration stage/);
});

test('patch workflow: one patcher fixes several folders, one reviewer merges, runs diagnostics and checks the items', async () => {
  const { root, manifest } = patchProject();
  let claimedTask = null;
  const { result, calls } = await runPatch(root, manifest, {
    patch: ({ write: put, claimed }) => {
      claimedTask = claimed.task;
      put('src/player/player.gd', 'class_name Player\nconst SPEED = 85\n');
      put('src/hud/hud.gd', 'class_name Hud\n');
      put('work/patches/run-001-r1_patch_report.md', 'speed fixed\n');
      return { summary: 'speed 85, HUD updated', testsRun: 'none', blockers: [] };
    },
    review: () => PASS,
  });

  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  assert.equal(result.next, 'finish');
  assert.equal(result.merge.status, 'merged');
  assert.equal(result.diagnostics.failed, false);
  assert.deepEqual(claimedTask.acceptance, ['Player speed is 85', 'The HUD shows the new speed']);
  assert.deepEqual(calls.map((call) => [call.agentType, call.model, call.effort]), [
    ['module-pipeline:patcher', 'opus', 'high'],
    ['module-pipeline:module-reviewer', 'opus', 'high'],
  ]);
  assert.equal(git(root, 'log', '-1', '--format=%s', 'multiagent-runs/run-001-r1'), 'module-pipeline(run-001-r1): patch');
  assert.equal(cli(root, 'status', '--run', 'run-001-r1').json.runs[0].tasks.patch, 'merged');

  const again = await runPatch(root, manifest, { patch: () => assert.fail('already merged'), review: () => assert.fail('already merged') });
  assert.equal(again.result.alreadyMerged, true);
});

test('finish and status read a patch run whose result file sits beside the run state', async () => {
  const { root, manifest } = patchProject();
  const { result } = await runPatch(root, manifest, {
    patch: ({ write: put }) => {
      put('src/player/player.gd', 'class_name Player\nconst SPEED = 85\n');
      return { summary: 'speed 85', testsRun: 'none', blockers: [] };
    },
    review: () => PASS,
  });
  // The run skill records the workflow result next to the run state.
  write(root, '.multiagent/pipeline/runs/run-001-r1-patch-result.json', JSON.stringify(result));

  assert.deepEqual(cli(root, 'status').json.runs.map((run) => run.runId), ['run-001-r1']);
  const finished = cli(root, 'finish', '--run', 'run-001-r1').json;
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.deepEqual(finished.runs.map((run) => run.runId), ['run-001-r1']);
  assert.equal(finished.latest.patch.status, 'passed');
});

test('a patch larger than its line limit is not merged; its worktree is kept for the module path', async () => {
  const { root, manifest } = patchProject(5);
  const big = Array.from({ length: 12 }, (_, index) => `var v${index} = ${index}`).join('\n');
  const { result } = await runPatch(root, manifest, {
    patch: ({ write: put }) => {
      put('src/player/player.gd', `${big}\n`);
      return { summary: 'rewrote the player', testsRun: 'none', blockers: [] };
    },
    review: () => assert.fail('nothing to review'),
  });

  assert.equal(result.status, 'patch_too_large', JSON.stringify(result, null, 2));
  assert.equal(result.next, 'rework');
  assert.ok(result.merge.changedLines > 5);
  assert.equal(git(root, 'log', '-1', '--format=%s', 'multiagent-runs/run-001-r1'), 'patch prompt');
  assert.equal(cli(root, 'status', '--run', 'run-001-r1').json.runs[0].tasks.patch, 'too_large');
  assert.equal(cli(root, 'status').json.activeClaims.length, 1, 'the claim and worktree stay for inspection');
});

test('the patch report the patcher writes does not count toward the line limit', async () => {
  const { root, manifest } = patchProject(5);
  const report = Array.from({ length: 30 }, (_, index) => `- note ${index}`).join('\n');
  const { result } = await runPatch(root, manifest, {
    patch: ({ write: put }) => {
      put('src/player/player.gd', 'class_name Player\nconst SPEED = 85\n');
      put('work/patches/run-001-r1_patch_report.md', `${report}\n`);
      put('work/patches/run-001-r1_interface_request.md', `${report}\n`);
      return { summary: 'speed 85', testsRun: 'none', blockers: [] };
    },
    review: () => PASS,
  });

  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  assert.equal(result.merge.status, 'merged');
  assert.ok(result.merge.files.includes('work/patches/run-001-r1_patch_report.md'), 'the report is still merged');
  assert.equal(result.merge.changedLines, 1, 'the merge says how large the fix was');
});

test('an unresolved item makes the patch run require rework', async () => {
  const { root, manifest } = patchProject();
  const { result } = await runPatch(root, manifest, {
    patch: ({ write: put }) => {
      put('src/player/player.gd', 'class_name Player\nconst SPEED = 85\n');
      return { summary: 'speed 85', testsRun: 'none', blockers: [] };
    },
    review: () => ({
      verdict: 'rework',
      summary: 'HUD not updated.',
      rework_items: [{
        issue_id: 'PATCH-1',
        severity: 'high',
        problem: 'HUD still shows the old speed',
        expected_behavior: 'HUD shows 85',
        actual_behavior: 'HUD shows 110',
        evidence: 'src/hud/hud.gd:1',
        recommended_action: 'reassign_to_same_agent',
        blocks_integration: true,
      }],
    }),
  });
  assert.equal(result.status, 'rework_required');
  assert.deepEqual(result.blockingItems.map((item) => [item.task, item.issue_id]), [['patch', 'PATCH-1']]);
});

test('the scope hook guards the patcher like the other writers', () => {
  const { root, manifest } = patchProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'patcher');
  cli(worktree, 'claim', '--run', 'run-001-r1', '--task', 'patch');
  const input = (file) => ({
    hook_event_name: 'PreToolUse',
    agent_type: 'module-pipeline:patcher',
    cwd: worktree,
    tool_name: 'Write',
    tool_input: { file_path: path.join(worktree, file) },
  });
  assert.equal(handle(input('src/hud/hud.gd')), null);
  assert.equal(handle(input('src/enemy/enemy.gd')).hookSpecificOutput.permissionDecision, 'deny');
});
