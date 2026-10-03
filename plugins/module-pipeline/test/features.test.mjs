import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { handle, watch } from '../scripts/scope-hook.mjs';
import { validateManifest } from '../scripts/lib/manifest.mjs';
import { canonicalPath, samePath } from '../scripts/lib/paths.mjs';
import yaml from '../scripts/vendor/js-yaml.mjs';
import { DEFAULT_MANIFEST, HOOK, cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';
import { prepareArgs, runWorkflow } from './workflow-harness.mjs';

const IMPLEMENTER = 'module-pipeline:module-implementer';
const RUN_BRANCH = 'multiagent-runs/run-001';
const parse = (text) => validateManifest(yaml.load(text), path.resolve('/p/tasks/task_manifest.yaml'));
const withGenerated = (text, patterns) => text.replace('tasks:\n', `generated_files: ${JSON.stringify(patterns)}\ntasks:\n`);
const withDiagnostics = (text, lines) => text.replace('diagnostics:\n  compile_command: null\n', `diagnostics:\n${lines}\n`);
const nodeCommand = (script) => JSON.stringify(['node', '-e', script]);

/** Prepared project whose main checkout went back to main while the run branch moved ahead. */
function projectOffRunBranch(manifestText) {
  const project = makeProject(manifestText);
  cli(project.root, 'prepare', project.manifest);
  write(project.root, 'docs/contracts.md', '# contracts\n');
  git(project.root, 'add', '.');
  git(project.root, 'commit', '-q', '-m', 'planning on the run branch');
  git(project.root, 'switch', '-q', 'main');
  return project;
}

test('paths: canonical form keeps parts that do not exist yet and compares spellings of one folder as equal', () => {
  const { root } = makeProject();
  const future = canonicalPath(path.join(root, 'not', 'yet', 'file.gd'));
  assert.equal(future, path.join(fs.realpathSync.native(root), 'not', 'yet', 'file.gd'));
  assert.ok(samePath(root, path.join(root, 'src', '..')));
  if (process.platform === 'win32') {
    assert.ok(samePath(root.toUpperCase(), root.toLowerCase()));
  }
});

test('manifest: every role gets an effort from the preset unless set, and models cannot be chosen', () => {
  const withEffort = (lines) => DEFAULT_MANIFEST.replace('effort:\n  module_implementer: medium\n', `effort:\n${lines}\n`);

  const plain = parse(DEFAULT_MANIFEST.replace('effort:\n  module_implementer: medium\n', ''));
  assert.deepEqual(plain.models, {
    moduleImplementer: 'sonnet',
    moduleReviewer: 'opus',
    integrator: 'sonnet',
    systemReviewer: 'opus',
    patcher: 'opus',
  }, 'the agents that write modules and glue run on sonnet, the others on opus');
  assert.equal(plain.preset, 'balanced');
  assert.deepEqual(plain.efforts, { moduleImplementer: 'high', moduleReviewer: 'high', integrator: 'high', systemReviewer: 'high' });
  assert.deepEqual(plain.warnings, []);
  assert.equal(parse(withEffort('  preset: economy')).efforts.systemReviewer, 'medium');

  const quality = parse(withEffort('  preset: quality\n  module_reviewer: low'));
  assert.equal(quality.efforts.moduleReviewer, 'low', 'an explicit role wins over its preset');
  assert.equal(quality.efforts.systemReviewer, 'xhigh');
  assert.equal(quality.tasks[0].effort, 'xhigh');
  assert.equal(quality.integration.effort, 'xhigh');

  const perTask = parse(DEFAULT_MANIFEST.replace('    acceptance: [Player moves]', '    acceptance: [Player moves]\n    effort: max'));
  assert.deepEqual(perTask.tasks.map((task) => task.effort), ['max', 'medium', 'medium']);

  assert.throws(() => parse(withEffort('  preset: cheap')), /effort\.preset must be one of economy, balanced, quality/);
  assert.throws(() => parse(withEffort('  module_reviewer: extreme')), /effort\.module_reviewer must be one of low, medium, high, xhigh, max/);
  assert.throws(() => parse(withEffort('  reviewer: high')), /effort\.reviewer is not a role/);
  assert.deepEqual(parse(withEffort('  pipeline_ops: low')).warnings, [
    'effort.pipeline_ops is ignored: the pipeline CLI now runs without a relay agent.',
  ]);
  assert.throws(() => parse(DEFAULT_MANIFEST.replace('    acceptance: [Player moves]', '    acceptance: [Player moves]\n    model: haiku')), /player\.model is no longer supported/);
  assert.throws(() => parse(DEFAULT_MANIFEST.replace('effort:\n  module_implementer: medium', 'defaults:\n  model: sonnet')), /defaults\.model is no longer supported/);

  const generated = parse(withGenerated(DEFAULT_MANIFEST, ['*.uid', './.godot/', 'export_presets.cfg']));
  assert.deepEqual(generated.generatedFiles, ['*.uid', '.godot/', 'export_presets.cfg']);
  assert.throws(() => parse(withGenerated(DEFAULT_MANIFEST, ['src/*.gd'])), /not a glob/);
  assert.throws(() => parse(withGenerated(DEFAULT_MANIFEST, ['file?.tmp'])), /only "\*" wildcards/);
});

test('validate counts the agents a run and its integration will start, by role, model and effort', () => {
  const { root, manifest } = makeProject(DEFAULT_MANIFEST.replace('  module_implementer: medium', '  preset: economy'));
  const { json } = cli(root, 'validate', manifest);
  assert.equal(json.estimate.models.integrator, 'sonnet');
  assert.equal(json.estimate.preset, 'economy');
  assert.deepEqual(json.estimate.run, [
    { role: 'module-implementer', count: 3, model: 'sonnet', effort: 'medium' },
    { role: 'module-reviewer', count: 3, model: 'opus', effort: 'medium' },
  ]);
  assert.deepEqual(json.estimate.integrate, [
    { role: 'integrator', count: 1, model: 'sonnet', effort: 'medium' },
    { role: 'system-reviewer', count: 1, model: 'opus', effort: 'medium' },
  ]);
  assert.equal(json.estimate.totalAgents, 8);
});

test('generated files outside the scope are dropped, inside it they merge, and alone they make an empty task', () => {
  const { root, manifest } = makeProject(withGenerated(DEFAULT_MANIFEST, ['*.uid', 'build/']));
  cli(root, 'prepare', manifest);

  const player = makeAgentWorktree(root, 'gen-player');
  cli(player, 'claim', '--run', 'run-001', '--task', 'player');
  write(player, 'src/player/move.gd', 'extends Node\n');
  write(player, 'src/player/move.gd.uid', 'uid://abc\n');
  write(player, 'src/enemy/enemy.gd.uid', 'uid://def\n');
  write(player, 'build/cache.bin', 'x\n');
  const merged = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'player');
  assert.equal(merged.json.status, 'merged', JSON.stringify(merged.json));
  assert.deepEqual(merged.json.files, ['src/player/move.gd', 'src/player/move.gd.uid']);
  assert.deepEqual(merged.json.dropped, ['build/cache.bin', 'src/enemy/enemy.gd.uid']);
  assert.equal(fs.existsSync(path.join(root, 'src/enemy/enemy.gd.uid')), false);

  const enemy = makeAgentWorktree(root, 'gen-enemy');
  cli(enemy, 'claim', '--run', 'run-001', '--task', 'enemy');
  write(enemy, 'src/player/move.gd.uid', 'uid://changed\n');
  const empty = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'enemy');
  assert.equal(empty.json.status, 'empty');
  assert.match(empty.json.reason, /only generated files/);
  assert.equal(fs.existsSync(enemy), false);
});

test('the PostToolUse hook warns a writer about out-of-scope files right after a shell command', () => {
  const { root, manifest } = makeProject(withGenerated(DEFAULT_MANIFEST, ['*.uid']));
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'watch');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'player');
  const bash = (agentType = IMPLEMENTER) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: worktree, agent_type: agentType });

  write(worktree, 'src/player/ok.gd', 'ok\n');
  write(worktree, 'src/enemy/enemy.gd.uid', 'uid://x\n');
  assert.equal(watch(bash()), null, 'in-scope and generated files are fine');

  write(worktree, 'src/enemy/sneaky.gd', 'no\n');
  const warned = handle(bash());
  assert.equal(warned.decision, 'block');
  assert.match(warned.reason, /src\/enemy\/sneaky\.gd/);
  assert.doesNotMatch(warned.reason, /enemy\.gd\.uid/);
  assert.match(warned.reason, /work\/modules\/player\/interface_request\.md/);
  assert.equal(watch(bash('general-purpose')), null);
  assert.equal(watch({ ...bash(), tool_name: 'Edit' }), null);

  const script = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(bash()), encoding: 'utf8' });
  assert.equal(JSON.parse(script.stdout).decision, 'block');
  fs.rmSync(path.join(worktree, 'src/enemy/sneaky.gd'));
  assert.equal(watch(bash()), null, 'the warning stops once the agent undoes the change');
});

test('claim moves a fresh worktree to the run branch tip when it was created from another branch', () => {
  const { root } = projectOffRunBranch();
  const worktree = makeAgentWorktree(root, 'sync');
  assert.equal(fs.existsSync(path.join(worktree, 'docs/contracts.md')), false);

  const claim = cli(worktree, 'claim', '--run', 'run-001', '--task', 'enemy');
  assert.equal(claim.code, 0, JSON.stringify(claim.json));
  assert.equal(claim.json.syncedToRunBranch, true);
  assert.equal(claim.json.base, git(root, 'rev-parse', RUN_BRANCH));
  assert.ok(fs.existsSync(path.join(worktree, 'docs/contracts.md')));

  const dirty = makeAgentWorktree(root, 'sync-dirty');
  write(dirty, 'src/enemy/early.gd', 'x\n');
  assert.match(cli(dirty, 'claim', '--run', 'run-001', '--task', 'hud').json.error, /already has changes/);
});

test('with the main checkout on another branch, modules commit through the merge worktree and diagnostics check the run branch', () => {
  const manifestText = withDiagnostics(
    DEFAULT_MANIFEST,
    `  compile_command: ${nodeCommand("require('fs').accessSync('src/enemy/enemy.gd')")}`,
  );
  const { root } = projectOffRunBranch(manifestText);
  const mainHead = git(root, 'rev-parse', 'HEAD');
  const worktree = makeAgentWorktree(root, 'offbranch');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'enemy');
  write(worktree, 'src/enemy/enemy.gd', 'class_name Enemy\n');
  write(root, 'notes/mine.txt', 'my own uncommitted work\n');

  const merged = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'enemy');
  assert.equal(merged.json.status, 'merged', JSON.stringify(merged.json));
  assert.equal(merged.json.via, 'merge-worktree');
  assert.equal(git(root, 'rev-parse', RUN_BRANCH), merged.json.commit);
  assert.equal(git(root, 'log', '-1', '--format=%s', RUN_BRANCH), 'module-pipeline(run-001): enemy');
  assert.equal(git(root, 'rev-parse', 'HEAD'), mainHead, 'the main checkout stays where the user left it');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  assert.equal(fs.existsSync(path.join(root, 'src/enemy/enemy.gd')), false);
  assert.ok(fs.existsSync(path.join(root, 'notes/mine.txt')));

  const diagnostics = cli(root, 'diagnostics', '--run', 'run-001');
  assert.equal(diagnostics.json.failed, false, JSON.stringify(diagnostics.json));
  assert.match(diagnostics.json.checkout.replace(/\\/g, '/'), /\.multiagent\/pipeline\/merge\/run-001$/);

  // A merge worktree folder git no longer knows about is rebuilt.
  const mergeDir = path.join(root, '.multiagent/pipeline/merge/run-001');
  git(root, 'worktree', 'remove', '--force', mergeDir);
  write(mergeDir, '.git', 'gitdir: /nowhere\n');
  assert.equal(cli(root, 'diagnostics', '--run', 'run-001').json.failed, false);

  const prepared = cli(root, 'prepare', path.join(root, 'tasks/task_manifest.yaml'));
  assert.equal(prepared.code, 0, 'uncommitted work on another branch does not block a run');
  assert.equal(prepared.json.mainCheckoutOnRunBranch, false);
  assert.equal(prepared.json.head, merged.json.commit);
});

test('diagnostics run the test command, skip it after a compile failure, and report failures', () => {
  const failingTests = withDiagnostics(
    DEFAULT_MANIFEST,
    `  test_command: ${nodeCommand("console.log('1 passing'); console.log('1 failing'); process.exit(3)")}`,
  );
  const { root, manifest } = makeProject(failingTests);
  cli(root, 'prepare', manifest);
  const result = cli(root, 'diagnostics', '--run', 'run-001');
  assert.equal(result.code, 1);
  assert.equal(result.json.ran, true);
  assert.equal(result.json.errorCount, 0);
  assert.equal(result.json.tests.failed, true);
  assert.equal(result.json.tests.exitCode, 3);
  assert.deepEqual(result.json.tests.tail, ['1 passing', '1 failing']);
  assert.equal(cli(root, 'status', '--run', 'run-001').json.runs[0].diagnostics.testsFailed, true);

  const compileFirst = withDiagnostics(
    DEFAULT_MANIFEST,
    `  compile_command: ${nodeCommand('process.exit(1)')}\n  test_command: ${nodeCommand('process.exit(0)')}`,
  );
  const second = makeProject(compileFirst);
  cli(second.root, 'prepare', second.manifest);
  const skipped = cli(second.root, 'diagnostics', '--run', 'run-001').json;
  assert.equal(skipped.failed, true);
  assert.equal(skipped.tests.skipped, true);

  const passing = makeProject(withDiagnostics(DEFAULT_MANIFEST, `  test_command: ${nodeCommand('process.exit(0)')}`));
  cli(passing.root, 'prepare', passing.manifest);
  const ok = cli(passing.root, 'diagnostics', '--run', 'run-001');
  assert.equal(ok.code, 0);
  assert.equal(ok.json.tests.failed, false);
});

test('clean lists leftovers on a dry run, then removes them and run branches merged into the base', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const kept = makeAgentWorktree(root, 'clean-violation');
  cli(kept, 'claim', '--run', 'run-001', '--task', 'player');
  write(kept, 'src/enemy/nope.gd', 'x\n');
  assert.equal(cli(root, 'integrate-task', '--run', 'run-001', '--task', 'player').json.status, 'violation');
  git(root, 'switch', '-q', 'main');
  cli(root, 'diagnostics', '--run', 'run-001');

  const dry = cli(root, 'clean', '--dry-run', '--branches', '--into', 'main').json;
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.claims.map((claim) => [claim.taskId, claim.worktreeExists]), [['player', true]]);
  assert.deepEqual(dry.branches.deleted, [RUN_BRANCH], 'the run branch has no new commits, so it counts as merged');
  assert.ok(fs.existsSync(kept));

  const wet = cli(root, 'clean', '--branches', '--into', 'main').json;
  assert.equal(wet.claims.length, 1);
  assert.equal(fs.existsSync(kept), false);
  assert.equal(git(root, 'branch', '--list', RUN_BRANCH), '');
  assert.deepEqual(cli(root, 'status').json.activeClaims, []);
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
});

test('clean keeps run branches that are not merged into the base yet', () => {
  const { root } = projectOffRunBranch();
  const result = cli(root, 'clean', '--branches', '--into', 'main').json;
  assert.deepEqual(result.branches.deleted, []);
  assert.deepEqual(result.branches.kept, [{ branch: RUN_BRANCH, reason: 'not merged into main' }]);
});

test('finish summarizes the run branch against its base and drafts a PR description', async () => {
  const { root, manifest } = makeProject();
  const implementer = ({ taskId, write: put }) => {
    put(`src/${taskId}/${taskId}_impl.gd`, `class_name ${taskId}\n`);
    return { summary: `${taskId} built`, testsRun: 'none', blockers: [] };
  };
  await runWorkflow('implement-modules', {
    root,
    args: prepareArgs(root, manifest),
    scenario: { implement: implementer, review: () => ({ verdict: 'pass', summary: 'ok', rework_items: [] }) },
  });

  const { json } = cli(root, 'finish', '--run', 'run-001');
  assert.equal(json.base, 'main');
  assert.equal(json.behind, 0);
  assert.equal(json.commits.length, 3);
  assert.ok(json.commits.every((commit) => commit.subject.startsWith('module-pipeline(run-001): ')));
  assert.ok(json.filesChanged.includes('src/hud/hud_impl.gd'));
  assert.deepEqual(json.runs.map((run) => run.runId), ['run-001']);
  const draft = fs.readFileSync(json.prDraftPath, 'utf8');
  assert.match(draft, /\| player \| merged \|/);
  assert.match(draft, /## Commits/);
  assert.match(cli(root, 'finish', '--run', 'run-001', '--base', 'nope').json.error, /Branch nope does not exist/);
});

test('status lists runs but not the result files stored beside them', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  write(root, '.multiagent/pipeline/runs/run-001-modules-result.json', '{"status":"passed"}');
  assert.deepEqual(cli(root, 'status').json.runs.map((run) => run.runId), ['run-001']);
});

test('implement workflow runs while the main checkout is on another branch', async () => {
  const { root, manifest } = projectOffRunBranch();
  let hudSawPlayer = null;
  const { result } = await runWorkflow('implement-modules', {
    root,
    args: prepareArgs(root, manifest),
    scenario: {
      implement: ({ taskId, write: put, worktree }) => {
        if (taskId === 'hud') {
          hudSawPlayer = fs.existsSync(path.join(worktree, 'src/player/player_impl.gd'));
        }
        put(`src/${taskId}/${taskId}_impl.gd`, `class_name ${taskId}\n`);
        return { summary: `${taskId} built`, testsRun: 'none', blockers: [] };
      },
      review: () => ({ verdict: 'pass', summary: 'ok', rework_items: [] }),
    },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result, null, 2));
  assert.equal(hudSawPlayer, true);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  assert.equal(fs.existsSync(path.join(root, 'src/hud/hud_impl.gd')), false);
  assert.equal(git(root, 'log', '-1', '--format=%s', RUN_BRANCH), 'module-pipeline(run-001): hud');
});
