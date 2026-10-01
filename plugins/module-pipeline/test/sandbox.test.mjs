// 0.9.0: running inside Claude Code's Bash sandbox (Linux, WSL2, macOS).
// The sandbox cannot be started from a test, so these reproduce what it does to a checkout:
// entries git cannot track appear in the working directory, and paths become read-only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { changedFiles, hasSandboxPlaceholders, isClean, isTrackable, listUncommitted } from '../scripts/lib/git.mjs';
import { cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';

const posix = process.platform !== 'win32';
// A named pipe stands in for the /dev/null device nodes the sandbox binds over protected paths:
// like them it is neither a file, a link nor a folder, and making one needs no root.
function placeholder(root, rel) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  execFileSync('mkfifo', [path.join(root, rel)]);
}

test('entries git cannot track are not project content', { skip: !posix }, () => {
  const { root, manifest } = makeProject();
  for (const rel of ['.mcp.json', '.bashrc', '.claude/commands', '.claude/settings.local.json']) {
    placeholder(root, rel);
  }
  assert.equal(isTrackable(root, '.mcp.json'), false);
  assert.equal(isTrackable(root, 'README.md'), true);
  assert.equal(isTrackable(root, 'src/not-there-yet.gd'), true, 'a deleted or missing path is still a change');
  assert.equal(hasSandboxPlaceholders(root), true);
  assert.deepEqual(listUncommitted(root), [], 'placeholders are not uncommitted work');
  assert.equal(isClean(root), true);

  const prepared = cli(root, 'prepare', manifest).json;
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));

  write(root, 'docs/notes.md', 'real work\n');
  assert.deepEqual(listUncommitted(root), ['docs/notes.md'], 'real files still count');
  assert.equal(isClean(root), false);
});

test('a module built in a sandboxed worktree is claimed, audited and merged without the placeholders', { skip: !posix }, () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  // The run branch moves on, so the claim has to move this worktree to its tip with the placeholders already there.
  const worktree = makeAgentWorktree(root, 'sandboxed');
  write(root, 'docs/later.md', 'a later commit on the run branch\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'later');
  placeholder(worktree, '.mcp.json');
  placeholder(worktree, '.claude/commands');

  const claim = cli(worktree, 'claim', '--run', 'run-001', '--task', 'player').json;
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(claim.syncedToRunBranch, true, 'placeholders do not make the worktree count as changed');
  assert.match(claim.sandboxNote, /`git add -A` fails here on placeholder entries/);

  write(worktree, 'src/player/run.gd', 'class_name Run\n');
  write(worktree, 'work/modules/player/module_report.md', 'done\n');
  assert.deepEqual(changedFiles(worktree, claim.base), ['src/player/run.gd', 'work/modules/player/module_report.md']);

  const merged = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'player').json;
  assert.equal(merged.status, 'merged', JSON.stringify(merged));
  assert.deepEqual(merged.violations ?? [], []);
  assert.ok(fs.existsSync(path.join(root, 'src/player/run.gd')));
});

test('outside the sandbox a claim carries no sandbox note', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'plain');
  assert.equal(cli(worktree, 'claim', '--run', 'run-001', '--task', 'player').json.sandboxNote, undefined);
  assert.equal(hasSandboxPlaceholders(root), false);
});

test('prepare says so when the main checkout is on the run branch but cannot be written', { skip: !posix || process.getuid?.() === 0 }, () => {
  const { root, manifest } = makeProject();
  assert.equal(cli(root, 'prepare', manifest).json.ok, true);
  cli(root, 'commit-planning', manifest);
  assert.equal(git(root, 'branch', '--show-current'), 'multiagent-runs/run-001');

  fs.chmodSync(path.join(root, 'src'), 0o555); // what sandbox.filesystem.denyWrite does to a path
  try {
    const blocked = cli(root, 'prepare', manifest).json;
    assert.equal(blocked.ok, false);
    assert.deepEqual(blocked.readOnly, ['src']);
    assert.match(blocked.errors[0], /main checkout is on the run branch, but it cannot be written here \(src\).*Switch the main checkout to another branch/);

    // On another branch the pipeline merges in its own worktree and never writes the main checkout.
    git(root, 'switch', '-q', 'main');
    const ready = cli(root, 'prepare', manifest).json;
    assert.equal(ready.ok, true, JSON.stringify(ready.errors));
    assert.equal(ready.mainCheckoutOnRunBranch, false);
  } finally {
    fs.chmodSync(path.join(root, 'src'), 0o755);
  }
});

/** Planning output committed on the run branch only, with the main checkout back on main: the strict sandbox layout. */
function planningOnRunBranchOnly() {
  const { root, manifest } = makeProject();
  git(root, 'branch', 'multiagent-runs/run-001');
  git(root, 'rm', '-q', '-r', 'tasks', 'work', 'docs');
  git(root, 'commit', '-q', '-m', 'main has no planning output');
  assert.equal(fs.existsSync(manifest), false);
  return { root, manifest };
}

test('with the main checkout on another branch, the manifest and its files are read from the run branch', () => {
  const { root, manifest } = planningOnRunBranchOnly();

  const validated = cli(root, 'validate', manifest).json;
  assert.equal(validated.ok, true, JSON.stringify(validated));
  const prepared = cli(root, 'prepare', manifest).json;
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.manifestSource, 'run-branch');
  assert.equal(prepared.mainCheckoutOnRunBranch, false);
  assert.equal(git(root, 'branch', '--show-current'), 'main', 'the main checkout is left where it is');

  const worktree = makeAgentWorktree(root, 'off-branch');
  const claim = cli(worktree, 'claim', '--run', 'run-001', '--task', 'player').json;
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(claim.syncedToRunBranch, true);
  assert.ok(fs.existsSync(path.join(worktree, 'work/prompts/player.md')), 'the agent sees the planning output in its worktree');
  write(worktree, 'src/player/run.gd', 'class_name Run\n');

  const merged = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'player').json;
  assert.equal(merged.status, 'merged', JSON.stringify(merged));
  assert.equal(merged.via, 'merge-worktree');
  assert.equal(fs.existsSync(path.join(root, 'src/player/run.gd')), false, 'nothing is written into the main checkout');
  assert.equal(cli(root, 'diagnostics', '--run', 'run-001').json.ok, true);

  write(root, '.multiagent/result.json', JSON.stringify({ stage: 'modules', runId: 'run-001', status: 'passed', modules: [] }));
  const recorded = cli(root, 'record', '--from', path.join(root, '.multiagent', 'result.json')).json;
  assert.equal(recorded.next, 'integrate', 'record finds the integration section on the run branch');
  assert.equal(recorded.strayChanges, undefined);
});

test('a manifest that is nowhere, or whose files are missing on the run branch, is reported', () => {
  const { root, manifest } = planningOnRunBranchOnly();
  const missing = cli(root, 'prepare', path.join(root, 'tasks', 'nope.yaml'));
  assert.equal(missing.code, 2);
  assert.match(missing.json.error, /Manifest not found: .*nope\.yaml\. It is not in the working tree, and no run branch holds it\./);

  git(root, 'switch', '-q', 'multiagent-runs/run-001');
  git(root, 'rm', '-q', 'work/prompts/enemy.md');
  git(root, 'commit', '-q', '-m', 'lose a prompt');
  git(root, 'switch', '-q', 'main');
  assert.deepEqual(cli(root, 'prepare', manifest).json.errors, ['enemy.prompt_file does not exist: work/prompts/enemy.md']);
});
