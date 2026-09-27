import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { decide } from '../scripts/scope-hook.mjs';
import { HOOK, cli, makeAgentWorktree, makeProject } from './helpers.mjs';

const IMPLEMENTER = 'module-pipeline:module-implementer';

function setup() {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'hook');
  return { root, worktree };
}

const edit = (cwd, filePath, agentType = IMPLEMENTER) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: filePath },
  cwd,
  agent_type: agentType,
});

test('non-pipeline sessions and agents are never checked', () => {
  const { root } = setup();
  assert.equal(decide(edit(root, path.join(root, 'anything.txt'), null)), null);
  assert.equal(decide(edit(root, path.join(root, 'anything.txt'), 'general-purpose')), null);
  assert.equal(decide(edit(root, path.join(root, 'anything.txt'), 'module-pipeline:module-reviewer')), null);
});

test('pipeline writers are denied in the main checkout and before claiming', () => {
  const { root, worktree } = setup();
  const inMain = decide(edit(root, path.join(root, 'src/player/player.gd')));
  assert.equal(inMain.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(inMain.hookSpecificOutput.permissionDecisionReason, /isolated git worktree/);

  const unclaimed = decide(edit(worktree, path.join(worktree, 'src/player/player.gd')));
  assert.match(unclaimed.hookSpecificOutput.permissionDecisionReason, /not claimed yet/);
});

test('a claimed writer may write its folder but nothing else', () => {
  const { worktree } = setup();
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'player');

  assert.equal(decide(edit(worktree, path.join(worktree, 'src/player/states/run.gd'))), null);
  assert.equal(decide(edit(worktree, 'src/player/player.gd')), null);
  assert.equal(decide(edit(worktree, path.join(worktree, 'work/modules/player/module_report.md'))), null);

  const outside = decide(edit(worktree, path.join(worktree, 'src/enemy/enemy.gd')));
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /src\/enemy\/enemy\.gd is outside what task player may write/);
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /work\/modules\/player\/interface_request\.md/);

  const escaping = decide(edit(worktree, path.resolve(worktree, '..', 'elsewhere.txt')));
  assert.equal(escaping.hookSpecificOutput.permissionDecision, 'deny');
});

test('the hook script reads stdin and prints a deny decision', () => {
  const { worktree } = setup();
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'player');
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });

  const allowed = run(edit(worktree, path.join(worktree, 'src/player/a.gd')));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');

  const denied = run({ ...edit(worktree, ''), tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(worktree, 'notes.ipynb') } });
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const garbage = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});
