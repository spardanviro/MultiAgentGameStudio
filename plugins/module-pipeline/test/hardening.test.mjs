// Regressions for problems found in the first real run (spec: CHANGELOG 0.4.0).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from '../scripts/vendor/js-yaml.mjs';
import { CLI, PLUGIN_ROOT, cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';

/** Runs the CLI without any global or system git config, so only the repo's own identity counts. */
function cliWithoutGlobalGit(cwd, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'module-pipeline-no-such-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  });
  return { code: result.status, json: JSON.parse(result.stdout) };
}

test('prepare refuses to run when the session is not in the project', () => {
  const { root, manifest } = makeProject();
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'module-pipeline-elsewhere-')));
  const outside = cli(elsewhere, 'prepare', manifest);
  assert.equal(outside.code, 1);
  assert.match(outside.json.errors[0], /Claude Code session is in .* not in the project/);

  const other = makeProject();
  const wrongRepo = cli(other.root, 'prepare', manifest);
  assert.match(wrongRepo.json.errors[0], /Agent worktrees are created from the session's repository/);

  const subfolder = path.join(root, 'src');
  assert.equal(cli(subfolder, 'prepare', manifest).code, 0, 'a subfolder of the project is the same repository');
});

test('missing git identity is reported before anything is committed', () => {
  const { root, manifest } = makeProject();
  git(root, 'config', '--unset', 'user.name');
  git(root, 'config', '--unset', 'user.email');
  write(root, 'docs/architecture.md', '# arch\n');

  const planning = cliWithoutGlobalGit(root, 'commit-planning', manifest);
  assert.equal(planning.code, 1);
  assert.match(planning.json.errors[0], /git has no user\.name \/ user\.email/);
  assert.equal(git(root, 'branch', '--show-current'), 'main', 'nothing switched or committed');

  const prepare = cliWithoutGlobalGit(root, 'prepare', manifest);
  assert.ok(prepare.json.errors.some((error) => /git has no user\.name/.test(error)));
});

test('CLI output is one line of JSON unless --pretty is given', () => {
  const { root, manifest } = makeProject();
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' }).stdout;
  const compact = run('validate', manifest);
  assert.equal(compact.trimEnd().split('\n').length, 1);
  assert.equal(JSON.parse(compact).ok, true);
  const pretty = run('validate', manifest, '--pretty');
  assert.ok(pretty.split('\n').length > 10);
  assert.deepEqual(JSON.parse(pretty), JSON.parse(compact));
});

test('merging removes a worktree even when Claude Code locked it', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'locked');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'enemy');
  write(worktree, 'src/enemy/enemy.gd', 'class_name Enemy\n');
  git(root, 'worktree', 'lock', '--reason', 'claude agent', worktree);

  assert.equal(cli(root, 'integrate-task', '--run', 'run-001', '--task', 'enemy').json.status, 'merged');
  assert.equal(fs.existsSync(worktree), false);
});

test('workflow scripts contain no carriage returns or other control characters', () => {
  for (const name of ['implement-modules.js', 'integrate-system.js', 'patch-run.js']) {
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'workflows', name), 'utf8');
    assert.doesNotMatch(source, /[\u0000-\u0008\u000b-\u001f\u007f]/, `${name} must be plain LF text`);
  }
});

test('the architect skills think at high effort and the others at medium, all on opus', () => {
  const expected = { plan: 'high', rework: 'high', run: 'medium', integrate: 'medium', status: 'medium', finish: 'medium', clean: 'medium' };
  for (const [skill, effort] of Object.entries(expected)) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    const frontmatter = yaml.load(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
    assert.equal(frontmatter.effort, effort, `${skill} effort`);
    assert.equal(frontmatter.model, 'opus', `${skill} model`);
  }
});

test('prepare copies the stage workflow script into the git-ignored project folder', () => {
  const { root, manifest } = makeProject();
  const modules = cli(root, 'prepare', manifest).json;
  assert.match(modules.workflowScript, /\.multiagent\/pipeline\/workflows\/implement-modules\.js$/);
  assert.equal(
    fs.readFileSync(modules.workflowScript, 'utf8'),
    fs.readFileSync(path.join(PLUGIN_ROOT, 'workflows', 'implement-modules.js'), 'utf8'),
  );
  assert.equal(git(root, 'status', '--porcelain'), '', 'the copy never shows up as a project change');
});
