const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  auditTask,
  buildAgentPrompt,
  getWorktreePath,
  initializeRun,
  validateManifest,
} = require('../src/multiAgent');
const { makeTempGitRepo, run } = require('./helpers/gitRepo');

const MANIFEST_PATH = 'C:/project/tasks/task_manifest.yaml';

function folderTask(id, folder, extra = {}) {
  return {
    id,
    feature: id,
    owner: `${id}-agent`,
    role: 'sub',
    owned_folder: folder,
    prompt_file: `work/prompts/${id}.md`,
    module_report: `work/modules/${id}/module_report.md`,
    interface_request: `work/modules/${id}/interface_change_request.md`,
    depends_on: [],
    ...extra,
  };
}

function manifestWith(tasks, extra = {}) {
  return {
    version: 1,
    project: { name: 'Game', root: 'C:/project' },
    run: { id: 'run-001' },
    tasks,
    ...extra,
  };
}

test('owned_folder and test_folder become folder scopes in allowed_files', () => {
  const manifest = validateManifest(
    manifestWith([folderTask('player', 'src/player', { test_folder: 'tests/player/**' })]),
    MANIFEST_PATH,
  );
  const [task] = manifest.tasks;

  assert.equal(task.ownedFolder, 'src/player/');
  assert.equal(task.testFolder, 'tests/player/');
  assert.equal(task.ownedScript, null);
  assert.deepEqual(task.allowedFiles, [
    'src/player/',
    'tests/player/',
    'work/modules/player/module_report.md',
    'work/modules/player/interface_change_request.md',
  ]);
});

test('module tasks need an owned_folder (or legacy owned_script)', () => {
  const task = folderTask('player', 'src/player');
  delete task.owned_folder;
  assert.throws(() => validateManifest(manifestWith([task]), MANIFEST_PATH), /player\.owned_folder is required/);

  const legacy = validateManifest(
    manifestWith([{ ...task, owned_script: 'src/player/player.gd' }]),
    MANIFEST_PATH,
  );
  assert.equal(legacy.tasks[0].ownedScript, 'src/player/player.gd');
  assert.ok(legacy.tasks[0].allowedFiles.includes('src/player/player.gd'));
});

test('nested or shared module folders are rejected', () => {
  assert.throws(
    () => validateManifest(manifestWith([folderTask('player', 'src/player'), folderTask('player-ai', 'src/player/ai')]), MANIFEST_PATH),
    /Module ownership overlap: player owns folder src\/player\/ and player-ai owns folder src\/player\/ai\//,
  );
  assert.throws(
    () =>
      validateManifest(
        manifestWith([
          folderTask('player', 'src/player', { test_folder: 'tests/' }),
          folderTask('enemy', 'src/enemy', { test_folder: 'tests/enemy/' }),
        ]),
        MANIFEST_PATH,
      ),
    /ownership overlap/,
  );
  // Sibling folders with a shared prefix are fine.
  validateManifest(manifestWith([folderTask('player', 'src/player'), folderTask('players', 'src/players')]), MANIFEST_PATH);
});

test('no other task may list files inside a module folder', () => {
  assert.throws(
    () =>
      validateManifest(
        manifestWith([folderTask('player', 'src/player'), folderTask('enemy', 'src/enemy', { allowed_files: ['src/player/shared.gd'] })]),
        MANIFEST_PATH,
      ),
    /enemy\.allowed_files entry src\/player\/shared\.gd reaches into player's owned folder src\/player\//,
  );
  assert.throws(
    () =>
      validateManifest(
        manifestWith([folderTask('player', 'src/player')], {
          integration: {
            prompt_file: 'work/prompts/integration.md',
            depends_on: ['player'],
            allowed_files: ['src/'],
          },
        }),
        MANIFEST_PATH,
      ),
    /integration\.allowed_files entry src\/ reaches into player's owned folder/,
  );
});

test('module prompt grants the whole owned folder', () => {
  const manifest = validateManifest(
    manifestWith([folderTask('player', 'src/player', { test_folder: 'tests/player' })]),
    MANIFEST_PATH,
  );
  const prompt = buildAgentPrompt(manifest.tasks[0], 'Build the player module.');
  assert.match(prompt, /You own the module folder src\/player\/ and the test folder tests\/player\//);
  assert.match(prompt, /create, edit, split, and delete files inside them/);
  assert.match(prompt, /- src\/player\//);
});

test('audit accepts new files anywhere in the owned folder and flags files outside it', async () => {
  const root = await makeTempGitRepo('multiagent-folder-');
  const manifest = validateManifest(
    {
      version: 1,
      project: { name: 'Game', root },
      run: { id: 'run-001' },
      tasks: [
        folderTask('player', 'src/player', {
          prompt_file: 'work/prompts/player_health.md',
          test_folder: 'tests/player',
        }),
      ],
    },
    path.join(root, 'tasks', 'task_manifest.yaml'),
  );
  await initializeRun(manifest);
  const worktreePath = getWorktreePath(root, 'run-001', 'player');
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await run('git', ['worktree', 'add', worktreePath, '-b', 'multiagent/run-001/player', 'HEAD'], { cwd: root });

  await fs.mkdir(path.join(worktreePath, 'src', 'player', 'states'), { recursive: true });
  await fs.writeFile(path.join(worktreePath, 'src', 'player', 'states', 'idle.gd'), 'class_name Idle\n');
  await fs.appendFile(path.join(worktreePath, 'src', 'player', 'player_health.gd'), 'var hp = 100\n');
  await fs.writeFile(path.join(worktreePath, 'tests', 'player', 'test_idle.gd'), '# idle test\n');

  const clean = await auditTask(root, 'run-001', 'player');
  const agent = clean.agents.find((entry) => entry.taskId === 'player');
  assert.equal(agent.status, 'patch_ready');
  assert.deepEqual(agent.violations, []);
  const patch = await fs.readFile(agent.patchPath, 'utf8');
  assert.match(patch, /src\/player\/states\/idle\.gd/);
  assert.match(patch, /tests\/player\/test_idle\.gd/);

  await fs.mkdir(path.join(worktreePath, 'src', 'enemy'), { recursive: true });
  await fs.writeFile(path.join(worktreePath, 'src', 'enemy', 'enemy.gd'), 'class_name Enemy\n');
  const dirty = await auditTask(root, 'run-001', 'player');
  const violating = dirty.agents.find((entry) => entry.taskId === 'player');
  assert.equal(violating.status, 'policy_violation');
  assert.deepEqual(violating.violations, ['src/enemy/enemy.gd']);
});
