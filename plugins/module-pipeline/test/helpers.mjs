// Shared fixtures: temp git projects with a manifest, and CLI runners.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(PLUGIN_ROOT, 'scripts', 'pipeline.mjs');
export const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'scope-hook.mjs');

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** Run the CLI; returns { code, json }. */
export function cli(cwd, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new Error(`CLI did not print JSON (exit ${result.status}): ${result.stdout}\n${result.stderr}`);
  }
  return { code: result.status, json };
}

export const DEFAULT_MANIFEST = `version: 1
project:
  name: Game
  spec: docs/spec.md
run:
  id: run-001
  goal: Build the game
defaults:
  model: sonnet
diagnostics:
  compile_command: null
tasks:
  - id: player
    feature: Player
    owned_folder: src/player/
    test_folder: tests/player/
    prompt_file: work/prompts/player.md
    acceptance: [Player moves]
  - id: enemy
    feature: Enemy
    owned_folder: src/enemy/
    prompt_file: work/prompts/enemy.md
  - id: hud
    feature: HUD
    owned_folder: src/hud/
    prompt_file: work/prompts/hud.md
    depends_on: [player]
integration:
  prompt_file: work/prompts/integration.md
  allowed_files:
    - src/game/
`;

/**
 * A committed project with prompts and the manifest at tasks/task_manifest.yaml.
 */
export function makeProject(manifestText = DEFAULT_MANIFEST) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'module-pipeline-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  write(root, 'README.md', '# game\n');
  for (const name of ['player', 'enemy', 'hud', 'integration']) {
    write(root, `work/prompts/${name}.md`, `Build ${name}.\n`);
  }
  write(root, 'src/player/player.gd', 'class_name Player\n');
  write(root, 'tasks/task_manifest.yaml', manifestText);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, manifest: path.join(root, 'tasks', 'task_manifest.yaml') };
}

/**
 * Stand-in for the harness's `isolation: 'worktree'`: a linked worktree of
 * the project at its current HEAD.
 */
export function makeAgentWorktree(root, name) {
  const worktree = path.join(fs.realpathSync(os.tmpdir()), `mp-wt-${name}-${process.pid}-${Math.floor(performance.now())}`);
  git(root, 'worktree', 'add', '-q', '-b', `agent/${path.basename(worktree)}`, worktree, 'HEAD');
  return worktree;
}
