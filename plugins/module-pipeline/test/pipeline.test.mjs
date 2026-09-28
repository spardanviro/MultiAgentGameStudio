import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_MANIFEST, cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';
import { planWaves, validateManifest } from '../scripts/lib/manifest.mjs';
import yaml from '../scripts/vendor/js-yaml.mjs';

const parse = (text) => validateManifest(yaml.load(text), path.resolve('/p/tasks/task_manifest.yaml'));

test('validate reports modules, waves and missing prompts', () => {
  const { root, manifest } = makeProject();
  const ok = cli(root, 'validate', manifest);
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.json.waves, [['player', 'enemy'], ['hud']]);
  assert.equal(ok.json.modules[0].owns, 'src/player/');

  fs.rmSync(path.join(root, 'work/prompts/enemy.md'));
  const missing = cli(root, 'validate', manifest);
  assert.equal(missing.code, 1);
  assert.match(missing.json.errors[0], /enemy\.prompt_file does not exist/);
});

test('manifest rules: folder overlap, intrusion, cycles, unknown deps', () => {
  assert.throws(() => parse(DEFAULT_MANIFEST.replace('owned_folder: src/enemy/', 'owned_folder: src/player/ai/')), /Module ownership overlap: player owns folder src\/player\//);
  assert.throws(
    () => parse(DEFAULT_MANIFEST.replace('    - src/game/', '    - src/hud/overlay.gd')),
    /integration\.allowed_files entry src\/hud\/overlay\.gd reaches into hud's owned folder/,
  );
  assert.throws(() => parse(DEFAULT_MANIFEST.replace('depends_on: [player]', 'depends_on: [ghost]')), /unknown task: ghost/);
  const cyclic = DEFAULT_MANIFEST.replace("    prompt_file: work/prompts/player.md\n", "    prompt_file: work/prompts/player.md\n    depends_on: [hud]\n");
  assert.throws(() => parse(cyclic), /Dependency cycle between: player, hud/);
  assert.throws(() => parse(DEFAULT_MANIFEST.replace('id: enemy', 'id: integration')), /reserved/);
});

test('module defaults: report and request paths join allowed_files', () => {
  const manifest = parse(DEFAULT_MANIFEST);
  const player = manifest.tasks[0];
  assert.deepEqual(player.allowedFiles, [
    'src/player/',
    'tests/player/',
    'work/modules/player/module_report.md',
    'work/modules/player/interface_request.md',
  ]);
  assert.equal(player.model, 'sonnet');
  assert.deepEqual(planWaves(manifest.tasks, new Set(['player'])).map((wave) => wave.map((task) => task.id)), [['enemy', 'hud']]);
});

test('prepare refuses uncommitted work until commit-planning commits it on the run branch', () => {
  const { root, manifest } = makeProject();
  write(root, 'docs/architecture.md', '# arch\n');

  const blocked = cli(root, 'prepare', manifest);
  assert.equal(blocked.code, 1);
  assert.match(blocked.json.errors.join('\n'), /uncommitted changes \(docs\/architecture\.md\)/);

  const committed = cli(root, 'commit-planning', manifest);
  assert.equal(committed.json.committed, true);
  assert.deepEqual(committed.json.files, ['docs/architecture.md']);
  assert.equal(git(root, 'branch', '--show-current'), 'multiagent-runs/run-001');

  const prepared = cli(root, 'prepare', manifest);
  assert.equal(prepared.code, 0);
  assert.deepEqual(prepared.json.waves.map((wave) => wave.map((task) => task.id)), [['player', 'enemy'], ['hud']]);
  assert.equal(prepared.json.waves[0][0].ownedFolder, 'src/player/');
  assert.equal(prepared.json.spec, 'docs/spec.md');
  assert.match(fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8'), /\/\.multiagent\//);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('claim + integrate-task commits an in-scope module and cleans up its worktree', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'player');

  const claim = cli(worktree, 'claim', '--run', 'run-001', '--task', 'player');
  assert.equal(claim.code, 0, JSON.stringify(claim.json));
  assert.equal(claim.json.base, git(root, 'rev-parse', 'HEAD'));

  write(worktree, 'src/player/states/idle.gd', 'class_name Idle\n');
  write(worktree, 'src/player/player.gd', 'class_name Player\nvar hp = 100\n');
  write(worktree, 'tests/player/test_idle.gd', '# test\n');
  write(worktree, 'work/modules/player/module_report.md', 'Done.\n');
  git(worktree, 'add', 'src/player/player.gd');
  git(worktree, 'commit', '-q', '-m', 'agent commit inside its worktree');

  const merged = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'player');
  assert.equal(merged.code, 0, JSON.stringify(merged.json));
  assert.equal(merged.json.status, 'merged');
  assert.equal(merged.json.via, 'main-checkout');
  assert.equal(merged.json.commit, git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'module-pipeline(run-001): player');
  assert.match(fs.readFileSync(path.join(root, 'src/player/player.gd'), 'utf8'), /var hp = 100/);
  assert.ok(fs.existsSync(path.join(root, 'src/player/states/idle.gd')));
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(git(root, 'status', '--porcelain'), '');

  const status = cli(root, 'status', '--run', 'run-001');
  assert.equal(status.json.runs[0].tasks.player, 'merged');
  assert.deepEqual(status.json.activeClaims, []);

  const next = cli(root, 'prepare', manifest);
  assert.deepEqual(next.json.skipped, ['player']);
  assert.deepEqual(next.json.waves.map((wave) => wave.map((task) => task.id)), [['enemy', 'hud']]);
});

test('integrate-task refuses out-of-scope changes and keeps the worktree for inspection', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'enemy');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'enemy');
  write(worktree, 'src/enemy/enemy.gd', 'class_name Enemy\n');
  write(worktree, 'src/player/player.gd', 'hacked\n');

  const result = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'enemy');
  assert.equal(result.code, 1);
  assert.equal(result.json.status, 'violation');
  assert.deepEqual(result.json.violations, ['src/player/player.gd']);
  assert.ok(fs.existsSync(worktree));
  assert.equal(fs.readFileSync(path.join(root, 'src/player/player.gd'), 'utf8'), 'class_name Player\n');
});

test('integrate-task reports unclaimed and empty tasks', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  assert.equal(cli(root, 'integrate-task', '--run', 'run-001', '--task', 'hud').json.status, 'unclaimed');

  const worktree = makeAgentWorktree(root, 'empty');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'enemy');
  const empty = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'enemy');
  assert.equal(empty.json.status, 'empty');
  assert.equal(fs.existsSync(worktree), false);
});

test('claim rejects the main checkout and a second task on the same worktree', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  assert.match(cli(root, 'claim', '--run', 'run-001', '--task', 'player').json.error, /inside the isolated git worktree/);

  const worktree = makeAgentWorktree(root, 'twice');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'player');
  assert.match(cli(worktree, 'claim', '--run', 'run-001', '--task', 'enemy').json.error, /already claimed for run-001\/player/);
});

test('prepare --stage integration waits for every module, then returns the integration task', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  assert.match(cli(root, 'prepare', manifest, '--stage', 'integration').json.errors[0], /Modules not merged yet: player, enemy, hud/);

  const statePath = path.join(root, '.multiagent/pipeline/runs/run-001.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const id of ['player', 'enemy', 'hud']) {
    state.tasks[id] = { status: 'merged' };
  }
  fs.writeFileSync(statePath, JSON.stringify(state));

  const ready = cli(root, 'prepare', manifest, '--stage', 'integration');
  assert.equal(ready.code, 0, JSON.stringify(ready.json));
  assert.equal(ready.json.integration.id, 'integration');
  assert.deepEqual(ready.json.integration.allowedFiles, [
    'work/integration/run-001_integration_report.md',
    'work/integration/run-001_interface_request.md',
    'src/game/',
  ]);
  assert.equal(ready.json.modules.length, 3);
});

test('diagnostics runs the configured command and counts errors', () => {
  const failing = DEFAULT_MANIFEST.replace(
    'compile_command: null',
    `compile_command: ["node", "-e", "console.error('src/player/player.gd:3 error: unknown identifier'); console.log('warning: unused var'); process.exit(1)"]`,
  );
  const { root, manifest } = makeProject(failing);
  cli(root, 'prepare', manifest);
  const result = cli(root, 'diagnostics', '--run', 'run-001');
  assert.equal(result.code, 1);
  assert.equal(result.json.failed, true);
  assert.equal(result.json.errorCount, 1);
  assert.equal(result.json.warningCount, 1);
  assert.match(fs.readFileSync(result.json.logPath, 'utf8'), /unknown identifier/);

  const { root: quietRoot, manifest: quietManifest } = makeProject();
  cli(quietRoot, 'prepare', quietManifest);
  assert.equal(cli(quietRoot, 'diagnostics', '--run', 'run-001').json.ran, false);
});

test('integrate-task recovers committed work when the harness already removed a clean worktree', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'committed');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'enemy');
  write(worktree, 'src/enemy/enemy.gd', 'class_name Enemy\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'enemy');
  const branch = git(worktree, 'branch', '--show-current');
  git(root, 'worktree', 'remove', worktree);

  const merged = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'enemy');
  assert.equal(merged.json.status, 'merged', JSON.stringify(merged.json));
  assert.equal(merged.json.recoveredFromBranch, branch);
  assert.match(fs.readFileSync(path.join(root, 'src/enemy/enemy.gd'), 'utf8'), /^class_name Enemy\r?\n$/);
  assert.equal(git(root, 'branch', '--list', branch), '');
});

test('integrate-task audits recovered branch work too', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'committed-bad');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'enemy');
  write(worktree, 'src/player/player.gd', 'hacked\n');
  git(worktree, 'commit', '-q', '-am', 'bad');
  git(root, 'worktree', 'remove', worktree);

  const result = cli(root, 'integrate-task', '--run', 'run-001', '--task', 'enemy');
  assert.equal(result.json.status, 'violation');
  assert.deepEqual(result.json.violations, ['src/player/player.gd']);
});
