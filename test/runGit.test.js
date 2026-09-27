const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  applyPatch,
  auditTask,
  commitRunWorkingTree,
  initializeRun,
  loadState,
  preflightRun,
  runCommand,
  startTask,
  validateManifest,
} = require('../src/multiAgent');
const { createFakeLauncher } = require('./helpers/fakeAgents');
const { git, makeTempGitRepo } = require('./helpers/gitRepo');

// Real git, fake Claude auth (never call the real CLI from tests).
const hybridRunner = async (command, args, options) => {
  if (command === 'claude') {
    return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n', stderr: '' };
  }
  return runCommand(command, args, options);
};

function moduleTask(id, script, extra = {}) {
  const folder = id.replace(/-/g, '_');
  return {
    id,
    feature: id,
    owner: `${id}-agent`,
    role: 'sub',
    owned_script: script,
    prompt_file: `work/prompts/${folder}.md`,
    module_report: `work/modules/${folder}/module_report.md`,
    interface_request: `work/modules/${folder}/interface_change_request.md`,
    depends_on: [],
    ...extra,
  };
}

async function setupRun() {
  const root = await makeTempGitRepo('multiagent-rungit-');
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_hud.md'), 'Build the HUD.\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'hud prompt');
  const manifest = validateManifest(
    {
      version: 1,
      project: { name: 'Game', root },
      run: { id: 'run-001', goal: 'Build', base: 'head' },
      main_agent: { name: 'main-architect' },
      defaults: { permission_mode: 'acceptEdits' },
      tasks: [
        moduleTask('player-health', 'src/player/player_health.gd'),
        moduleTask('player-hud', 'src/ui/hud.gd', { depends_on: ['player-health'] }),
      ],
    },
    path.join(root, 'tasks', 'task_manifest.yaml'),
  );
  await initializeRun(manifest, { runner: hybridRunner });
  const fake = createFakeLauncher();
  const options = { runner: hybridRunner, launchAgent: fake.launchAgent };
  return { root, options, fake, originalBranch: await git(root, 'branch', '--show-current') };
}

async function finishHealthAgent(root, options) {
  const started = await startTask(root, 'run-001', 'player-health', options);
  const agent = started.agents.find((entry) => entry.taskId === 'player-health');
  await fs.appendFile(path.join(agent.worktreePath, 'src', 'player', 'player_health.gd'), 'var hp = 100\n');
  const audited = await auditTask(root, 'run-001', 'player-health', options);
  return audited.agents.find((entry) => entry.taskId === 'player-health');
}

test('initializeRun keeps .multiagent/ out of git status via info/exclude', async () => {
  const { root } = await setupRun();
  const exclude = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/\.multiagent\/$/m);
  assert.equal(await git(root, 'status', '--porcelain'), '');
});

test('preflight rejects uncommitted changes until Commit Working Tree commits them on the run branch', async () => {
  const { root, options } = await setupRun();
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'architecture.md'), '# Architecture\n');

  const before = await preflightRun(root, 'run-001', options);
  assert.equal(before.ok, false);
  assert.match(before.errors.join('\n'), /uncommitted changes \(docs\/architecture\.md\)/);

  const committed = await commitRunWorkingTree(root, 'run-001', options);
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.files, ['docs/architecture.md']);
  assert.equal(await git(root, 'branch', '--show-current'), 'multiagent-runs/run-001');
  assert.equal(await git(root, 'log', '-1', '--format=%s'), 'multiagent(run-001): commit planning output');
  assert.equal((await preflightRun(root, 'run-001', options)).ok, true);
});

test('applied patches become commits on the run branch and dependent agents start from them', async () => {
  const { root, options, originalBranch } = await setupRun();
  const ready = await finishHealthAgent(root, options);
  assert.equal(ready.status, 'patch_ready');
  assert.equal(await git(root, 'branch', '--show-current'), 'multiagent-runs/run-001');

  const applied = await applyPatch(root, 'run-001', 'player-health', options);
  const health = applied.agents.find((entry) => entry.taskId === 'player-health');
  assert.equal(health.status, 'patch_applied');
  assert.equal(health.appliedCommit, await git(root, 'rev-parse', 'HEAD'));
  assert.equal(await git(root, 'log', '-1', '--format=%s'), 'multiagent(run-001): apply player-health');
  assert.equal(await git(root, 'status', '--porcelain'), '');
  assert.notEqual(await git(root, 'rev-parse', originalBranch), health.appliedCommit);

  const started = await startTask(root, 'run-001', 'player-hud', options);
  const hud = started.agents.find((entry) => entry.taskId === 'player-hud');
  assert.equal(hud.status, 'running');
  assert.equal(hud.auditBaseCommit, health.appliedCommit);
  const inherited = await fs.readFile(path.join(hud.worktreePath, 'src', 'player', 'player_health.gd'), 'utf8');
  assert.match(inherited, /var hp = 100/);

  // The dependency's change is part of the base, so it is not audited as the HUD agent's own change.
  const audited = await auditTask(root, 'run-001', 'player-hud', options);
  const hudAudit = audited.agents.find((entry) => entry.taskId === 'player-hud');
  assert.deepEqual(hudAudit.violations, []);
  assert.deepEqual(hudAudit.changedFiles, []);
});

test('a rejected commit (pre-commit hook) reverts the applied patch', async () => {
  const { root, options } = await setupRun();
  await finishHealthAgent(root, options);
  await fs.writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');

  await assert.rejects(applyPatch(root, 'run-001', 'player-health', options), /could not be committed, so it was reverted/);

  const source = await fs.readFile(path.join(root, 'src', 'player', 'player_health.gd'), 'utf8');
  assert.doesNotMatch(source, /var hp = 100/);
  assert.equal(await git(root, 'diff', '--cached', '--name-only'), '');
  const state = await loadState(root, 'run-001');
  assert.equal(state.agents['player-health'].status, 'patch_ready');
});

test('applyPatch refuses when the project left the run branch', async () => {
  const { root, options, originalBranch } = await setupRun();
  await finishHealthAgent(root, options);
  await git(root, 'switch', originalBranch);

  await assert.rejects(applyPatch(root, 'run-001', 'player-health', options), /multiagent-runs\/run-001 already exists/);
});
