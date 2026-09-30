// 0.5.0: a mandatory shared layer, module sizing, and lean agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateManifest } from '../scripts/lib/manifest.mjs';
import yaml from '../scripts/vendor/js-yaml.mjs';
import { DEFAULT_MANIFEST, PLUGIN_ROOT, cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';

const parse = (text) => validateManifest(yaml.load(text), path.resolve('/p/tasks/task_manifest.yaml'));
const withShared = (section) => DEFAULT_MANIFEST.replace('shared_layer:\n  existing: [src/common/]\n', section);

const SHARED_TASK_MANIFEST = withShared('shared_layer:\n  task: shared\n').replace(
  'tasks:\n',
  `tasks:
  - id: shared
    feature: Shared helpers and fixtures
    owned_folder: src/shared/
    support_folder: tests/support/
    prompt_file: work/prompts/shared.md
`,
);

test('a run with two or more modules must name its shared layer', () => {
  assert.throws(() => parse(withShared('')), /shared_layer is required when a run has two or more modules/);
  assert.throws(() => parse(withShared('shared_layer: {}\n')), /shared_layer needs task/);
  assert.throws(() => parse(withShared('shared_layer:\n  task: nope\n')), /shared_layer\.task references unknown task: nope/);

  const single = DEFAULT_MANIFEST.replace('shared_layer:\n  existing: [src/common/]\n', '').split('  - id: enemy')[0] +
    'integration:\n  prompt_file: work/prompts/integration.md\n  allowed_files:\n    - src/game/\n';
  assert.equal(parse(single).sharedLayer, null, 'one module needs no shared layer');

  const existing = parse(DEFAULT_MANIFEST);
  assert.deepEqual(existing.sharedLayer, { taskId: null, paths: ['src/common/'] });
  assert.deepEqual(existing.tasks.map((task) => task.dependsOn), [[], [], ['player']], 'existing folders add no dependency');
});

test('the shared-layer task runs first, alone, and every other module depends on it', () => {
  const manifest = parse(SHARED_TASK_MANIFEST);
  assert.deepEqual(manifest.sharedLayer, { taskId: 'shared', paths: ['src/shared/', 'tests/support/'] });
  assert.deepEqual(Object.fromEntries(manifest.tasks.map((task) => [task.id, task.dependsOn])), {
    shared: [],
    player: ['shared'],
    enemy: ['shared'],
    hud: ['shared', 'player'],
  });
  assert.ok(manifest.tasks[0].allowedFiles.includes('tests/support/'));

  assert.throws(
    () => parse(SHARED_TASK_MANIFEST.replace('    support_folder: tests/support/\n', '    support_folder: tests/support/\n    depends_on: [player]\n')),
    /shared builds the shared layer, so it runs first and cannot depend on other modules/,
  );
  assert.throws(
    () => parse(SHARED_TASK_MANIFEST.replace('    prompt_file: work/prompts/enemy.md', '    prompt_file: work/prompts/enemy.md\n    support_folder: tests/enemy_support/')),
    /enemy\.support_folder is only for the module named in shared_layer\.task/,
  );
  assert.throws(
    () => parse(SHARED_TASK_MANIFEST.replace('    prompt_file: work/prompts/enemy.md', '    prompt_file: work/prompts/enemy.md\n    allowed_files: [tests/support/]')),
    /reaches into shared's owned folder tests\/support\//,
    'the fixtures folder belongs to the shared layer alone',
  );
});

test('prepare puts the shared layer in the first wave and hands the workflow only ids, dependencies and efforts', () => {
  const { root, manifest } = makeProject(SHARED_TASK_MANIFEST);
  write(root, 'work/prompts/shared.md', 'Build the shared layer.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'shared prompt');
  const { json } = cli(root, 'validate', manifest);
  assert.deepEqual(json.waves, [['shared'], ['player', 'enemy'], ['hud']]);

  const prepared = cli(root, 'prepare', manifest).json;
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const args = prepared.workflowArgs;
  assert.equal(args.pluginRoot, PLUGIN_ROOT.replace(/\\/g, '/'));
  assert.equal(args.runId, 'run-001');
  assert.deepEqual(args.waves, [
    [{ id: 'shared', dependsOn: [], effort: 'medium' }],
    [{ id: 'player', dependsOn: ['shared'], effort: 'medium' }, { id: 'enemy', dependsOn: ['shared'], effort: 'medium' }],
    [{ id: 'hud', dependsOn: ['shared', 'player'], effort: 'medium' }],
  ]);
  assert.equal(args.efforts.systemReviewer, 'high');
});

test('claim prints the task and the shared-layer folders, so the prompt only has to name the task', () => {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = makeAgentWorktree(root, 'lean-claim');
  const claim = cli(worktree, 'claim', '--run', 'run-001', '--task', 'player').json;
  assert.equal(claim.ok, true);
  assert.equal(claim.task.promptFile, 'work/prompts/player.md');
  assert.deepEqual(claim.task.acceptance, ['Player moves']);
  assert.ok(claim.task.allowedFiles.includes('src/player/'));
  assert.deepEqual(claim.sharedLayer, ['src/common/']);
});

test('validate compares the module count with the estimated project size', () => {
  const sized = (lines) => parse(DEFAULT_MANIFEST.replace('  spec: docs/spec.md\n', `  spec: docs/spec.md\n  estimated_lines: ${lines}\n`));

  const fits = sized(3000);
  assert.deepEqual(fits.sizing, { estimatedLines: 3000, modules: 3, recommended: { min: 2, max: 6 }, linesPerModule: 1000 });
  assert.deepEqual(fits.warnings, []);

  assert.match(sized(40000).warnings[0], /3 modules for about 40000 lines is too coarse.*Split them into 8-20 modules/);
  const tiny = sized(800).warnings;
  assert.equal(tiny.length, 1, 'three modules fit the smallest band');
  assert.match(tiny[0], /usually cheaper to build in one session/);

  const shared = parse(SHARED_TASK_MANIFEST.replace('  spec: docs/spec.md\n', '  spec: docs/spec.md\n  estimated_lines: 3000\n'));
  assert.equal(shared.sizing.modules, 3, 'the shared layer does not count as a module');
  assert.equal(sized(3000).project.estimatedLines, 3000);
  assert.throws(() => sized('lots'), /project\.estimated_lines must be a positive whole number/);
  assert.equal(parse(DEFAULT_MANIFEST).sizing, null, 'no estimate, no check');
});

test('too many modules for the size is a warning, not an error', () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    .map((id) => `  - id: ${id}\n    owned_folder: src/${id}/\n    prompt_file: work/prompts/${id}.md\n`)
    .join('');
  const manifest = parse(
    `version: 1\nproject:\n  name: Tiny\n  estimated_lines: 2000\nrun:\n  id: run-001\nshared_layer:\n  existing: [src/common/]\ntasks:\n${many}`,
  );
  assert.match(manifest.warnings[0], /7 modules for about 2000 lines is too fine.*Merge them into 2-6 modules/);
});

test('an existing shared-layer folder must exist', () => {
  const { root, manifest } = makeProject(withShared('shared_layer:\n  existing: [src/common/, src/missing/]\n'));
  const { json } = cli(root, 'validate', manifest);
  assert.equal(json.ok, false);
  assert.deepEqual(json.errors, ['shared_layer.existing does not exist: src/missing/']);
});

test('pipeline agents start without CLAUDE.md files, and no relay agent exists', () => {
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  const names = fs.readdirSync(agentsDir).sort();
  assert.deepEqual(names, ['integrator.md', 'module-implementer.md', 'module-reviewer.md', 'patcher.md', 'system-reviewer.md']);
  for (const name of names) {
    const text = fs.readFileSync(path.join(agentsDir, name), 'utf8');
    const frontmatter = yaml.load(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
    assert.equal(frontmatter.omitClaudeMd, true, `${name} omits CLAUDE.md`);
    assert.ok(text.length < 3000, `${name} stays short (${text.length} chars)`);
  }
  for (const name of ['implement-modules.js', 'integrate-system.js', 'patch-run.js']) {
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'workflows', name), 'utf8');
    assert.doesNotMatch(source, /pipeline-ops/, `${name} starts no relay agent`);
  }
});
