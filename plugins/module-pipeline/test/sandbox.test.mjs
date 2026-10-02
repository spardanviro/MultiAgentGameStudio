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

test('planning is committed without the placeholders, and the session is told to leave them alone', { skip: !posix }, () => {
  const { root, manifest } = makeProject();
  assert.equal(cli(root, 'validate', manifest).json.sandboxNote, undefined, 'no note outside the sandbox');
  for (const rel of ['.mcp.json', '.bashrc', '.claude/skills']) {
    placeholder(root, rel);
  }
  write(root, 'docs/plan-notes.md', 'planning output\n');

  assert.match(cli(root, 'validate', manifest).json.sandboxNote, /commit-planning skips them: leave them alone/);
  const committed = cli(root, 'commit-planning', manifest).json;
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.deepEqual(committed.files, ['docs/plan-notes.md']);
  assert.match(committed.sandboxNote, /add no \.gitignore or \.git\/info\/exclude lines/);
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD'), 'docs/plan-notes.md');
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

const canDeny = posix && process.getuid?.() !== 0;
/** What the sandbox does to a path it denies: the path, and everything below it, cannot be written. */
function readOnly(root, rel, body) {
  fs.chmodSync(path.join(root, rel), 0o555);
  try {
    return body();
  } finally {
    fs.chmodSync(path.join(root, rel), 0o755);
  }
}

test('a tracked path the sandbox protects on its own does not make the checkout read-only', { skip: !canDeny }, () => {
  const { root, manifest } = makeProject();
  write(root, '.vscode/settings.json', '{}\n');
  write(root, '.mcp.json', '{}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'editor and MCP configuration');
  cli(root, 'commit-planning', manifest);
  // The sandbox keeps .vscode, .idea, .mcp.json and more read-only in every project; no module writes there.
  readOnly(root, '.vscode', () => {
    fs.chmodSync(path.join(root, '.mcp.json'), 0o444);
    const prepared = cli(root, 'prepare', manifest).json;
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
    assert.deepEqual(prepared.readOnly ?? [], []);
    assert.equal(cli(root, 'finish', '--run', 'run-001').json.readOnly, undefined);
  });
});

test('rework and finish are told not to switch or merge in a checkout they cannot write', { skip: !canDeny }, () => {
  const { root, manifest } = makeProject();
  assert.equal(cli(root, 'prepare', manifest).json.ok, true);
  git(root, 'switch', '-q', 'multiagent-runs/run-001');
  write(root, 'src/player/run.gd', 'class_name Run\n');
  write(root, 'reports/rework/notes.md', 'only on the run branch\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'module-pipeline(run-001): player');

  // On the run branch nothing has to change to start a rework there.
  readOnly(root, 'src', () => {
    assert.equal(cli(root, 'status', '--run', 'run-001').json.readOnly, undefined);
    const summary = cli(root, 'finish', '--run', 'run-001').json;
    assert.deepEqual(summary.readOnly, ['src'], 'reports/ is writable: git can remove it on the way to main');
    assert.match(summary.readOnlyNote, /Do not run `git switch`, `git checkout` or `git merge` here: git would move the branch and report success/);
    assert.match(summary.readOnlyNote, /commands to run in their own terminal/);
  });

  git(root, 'switch', '-q', 'main');
  // A path the sandbox denies before it exists is a placeholder there: nothing can be created below it.
  placeholder(root, 'reports');
  readOnly(root, 'src', () => {
    const status = cli(root, 'status', '--run', 'run-001').json;
    assert.deepEqual(status.readOnly, ['reports', 'src']);
    assert.match(status.readOnlyNote, /cannot change these paths of the main checkout \(reports, src\)/);
    assert.equal(cli(root, 'status').json.readOnly, undefined, 'a plain status does not switch anything');

    const summary = cli(root, 'finish', '--run', 'run-001').json;
    assert.deepEqual(summary.readOnly, ['reports', 'src']);
    assert.deepEqual(summary.uncommitted, [], 'the placeholder is not uncommitted work');
  });
  fs.rmSync(path.join(root, 'reports'));

  const writable = cli(root, 'finish', '--run', 'run-001').json;
  assert.equal(writable.readOnly, undefined);
  assert.equal(writable.readOnlyNote, undefined);
});

test('commit-planning says what the user has to do before the run when the checkout cannot be written', { skip: !canDeny }, () => {
  const { root, manifest } = makeProject();
  write(root, 'docs/plan-notes.md', 'planning output\n');
  const committed = readOnly(root, 'src', () => cli(root, 'commit-planning', manifest).json);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.match(committed.readOnlyNote, /main checkout is now on multiagent-runs\/run-001, and this shell cannot write it \(src\)/);
  assert.match(committed.readOnlyNote, /from their own terminal/);

  write(root, 'docs/more-notes.md', 'more\n');
  assert.equal(cli(root, 'commit-planning', manifest).json.readOnlyNote, undefined);
});

test('finish names the run family and lists real uncommitted work', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  write(root, 'docs/unsaved.md', 'mine\n');
  const summary = cli(root, 'finish', '--run', 'run-001').json;
  assert.equal(summary.family, 'run-001');
  assert.deepEqual(summary.uncommitted, ['docs/unsaved.md']);
  // An ordinary checkout, on every platform, is never taken for a read-only one.
  assert.equal(summary.readOnly, undefined);
  assert.equal(cli(root, 'status', '--run', 'run-001').json.readOnly, undefined);
});

test('clean lists worktree records whose folder is gone, and prunes them where it may', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'gone');
  fs.rmSync(worktree, { recursive: true, force: true });

  const dry = cli(root, 'clean', '--dry-run').json;
  assert.equal(dry.prunable.length, 1);
  assert.equal(path.basename(dry.prunable[0]), path.basename(worktree));
  // Outside the sandbox git removes the record; inside it the list stays and the session passes it on.
  assert.equal(cli(root, 'clean').json.prunable, undefined);
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
