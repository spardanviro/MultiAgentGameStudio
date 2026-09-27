const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  buildArchitectPrompt,
  getArchitectPromptPath,
  getGitProjectStatus,
  getPlanningStatePath,
  initializeGitBaseline,
  loadLatestPlanningState,
  loadPlanningState,
  startArchitectFromDesignDoc,
} = require('../src/planning');
const { createFakeLauncher, runnerAlive, writeRunnerStatus } = require('./helpers/fakeAgents');

test('buildArchitectPrompt treats input as completed spec and includes manifest requirements', () => {
  const prompt = buildArchitectPrompt({
    projectRoot: 'C:/game',
    specDocPath: 'C:/docs/spec.md',
    specDocText: 'Make a tiny survival game.',
    runId: 'run-001',
  });

  assert.match(prompt, /tasks\/task_manifest.yaml/);
  assert.match(prompt, /module_review:/);
  assert.match(prompt, /integration:/);
  assert.match(prompt, /system_review:/);
  assert.match(prompt, /Make a tiny survival game/);
  assert.match(prompt, /Do not start Claude background agents yourself/);
  assert.match(prompt, /owned_folder: path\/to\/module_folder\//);
  assert.match(prompt, /One agent, one module folder/);
  assert.match(prompt, /never a path inside another module.s folder/);
  assert.doesNotMatch(prompt, /owned_script/);
  assert.match(prompt, /actionable dispatch inputs for the Main Architect/);
  assert.match(prompt, /exact task_id, agent owner, owned_folder/);
  assert.match(prompt, /related task ids, related agents, related files/);
  assert.match(prompt, /Do not scan or summarize the whole project source tree/);
  assert.match(prompt, /max_parallel_agents: 5/);
  assert.match(prompt, /sub_agent_effort: medium/);
  assert.match(prompt, /review_agent_effort: medium/);
  assert.match(prompt, /integration_agent_effort: medium/);
  assert.match(prompt, /system_review_agent_effort: medium/);
  assert.match(prompt, /manager starts a separate rework round/);
  assert.match(prompt, /Do not create rework manifests during this planning task/);
  assert.match(prompt, /YAML block named rework_items/);
  assert.match(prompt, /integration_context/);
  assert.match(prompt, /docs\/module_layout\.md/);
  assert.match(prompt, /Design source folder hierarchy before scaffolding scripts/);
  assert.match(prompt, /Put frequently interacting modules in the same feature folder/);
  assert.match(prompt, /diagnostics:/);
  assert.match(prompt, /Prefer a safe terminal compile command/);
  assert.match(prompt, /leave diagnostics\.compile_command as null/);
  assert.match(prompt, /dotnet build/);
  assert.match(prompt, /cargo check/);
  assert.match(prompt, /go test \.\/\.\.\./);
  assert.match(prompt, /captures stdout\/stderr directly/);
  assert.match(prompt, /fallback-only/);
  assert.match(prompt, /reports\/diagnostics\/\$\{runId\}_latest\.md|reports\/diagnostics\/run-001_latest\.md/);
  assert.match(prompt, /Do not read module implementation source files by default/);
  assert.match(prompt, /public APIs, signals, events, and data contracts only/);
  assert.match(prompt, /If source inspection is required, write a source_inspection_request/);
  assert.match(prompt, /system_review\.allowed_files must contain only/);
  assert.match(prompt, /finished AI implementation spec/);
  assert.match(prompt, /Do not spend context converting a rough design brief into a spec/);
  assert.match(prompt, /Do not rewrite the design/);
});

test('startArchitectFromDesignDoc accepts spec doc path, writes prompt file, and launches the architect runner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-test-'));
  const specDocPath = path.join(root, 'spec.md');
  await fs.writeFile(specDocPath, '# Game Spec\nBuild a small arena game.\n', 'utf8');

  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: 'abc123456789\n', stderr: '' };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const fake = createFakeLauncher();

  const state = await startArchitectFromDesignDoc({
    projectRoot: root,
    specDocPath,
    runId: 'run-001',
    architectName: 'main-architect',
    model: 'opus',
    runner,
    launchAgent: fake.launchAgent,
  });

  const promptPath = getArchitectPromptPath(root, 'run-001');
  const statePath = getPlanningStatePath(root, 'run-001');
  const prompt = await fs.readFile(promptPath, 'utf8');
  const savedState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const [launch] = fake.launches;

  assert.equal(state.status, 'running');
  assert.equal(state.claudeSessionId, launch.spec.sessionId);
  assert.equal(state.logPath, path.join(launch.dir, 'agent.log'));
  assert.equal(state.specDocPath, specDocPath);
  assert.equal(savedState.baseCommit, 'abc123456789');
  assert.match(prompt, /Build a small arena game/);
  assert.doesNotMatch(prompt, /turn the user's design document into/);
  assert.equal(launch.spec.name, 'main-architect');
  assert.equal(launch.spec.cwd, root);
  assert.equal(launch.spec.allowedPaths, null);
  assert.match(launch.spec.prompt, /\.multiagent\/planning\/run-001\/architect_prompt\.md/);
  assert.ok(!calls.some((call) => call.command === 'claude'));
});

test('startArchitectFromDesignDoc returns failed state for non-git project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-nongit-'));
  const specDocPath = path.join(root, 'spec.md');
  await fs.writeFile(specDocPath, 'Spec\n', 'utf8');
  const runner = async (command) => {
    if (command === 'git') {
      const error = new Error('not a git repository');
      error.stderr = 'fatal: not a git repository\n';
      throw error;
    }
    throw new Error(`Unexpected command ${command}`);
  };

  const state = await startArchitectFromDesignDoc({
    projectRoot: root,
    specDocPath,
    runId: 'run-001',
    runner,
  });

  assert.equal(state.status, 'failed');
  assert.equal(state.claudeSessionId, null);
  assert.match(state.error, /not a git repository/);
});

test('initializeGitBaseline runs init, add, and initial commit when needed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-init-'));
  const calls = [];
  let initialized = false;
  let committed = false;
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command !== 'git') {
      throw new Error(`Unexpected command ${command}`);
    }
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      if (!initialized) {
        throw new Error('not a git repository');
      }
      return { stdout: 'true\n', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      if (!committed) {
        throw new Error('no commits');
      }
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (args[0] === 'init') {
      initialized = true;
      return { stdout: 'Initialized\n', stderr: '' };
    }
    if (args[0] === 'add') {
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'commit') {
      committed = true;
      return { stdout: '[main abc123] Initial project baseline\n', stderr: '' };
    }
    throw new Error(`Unexpected git args ${args.join(' ')}`);
  };

  const status = await initializeGitBaseline(root, { runner });

  assert.equal(status.canStart, true);
  assert.equal(status.headCommit, 'abc123');
  assert.ok(calls.some((call) => call.args[0] === 'init'));
  assert.ok(calls.some((call) => call.args[0] === 'add'));
  assert.ok(calls.some((call) => call.args[0] === 'commit'));
});

test('getGitProjectStatus reports git repo without HEAD', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-nohead-'));
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      throw new Error('no commits');
    }
    throw new Error(`Unexpected command ${command}`);
  };

  const status = await getGitProjectStatus(root, { runner });
  assert.equal(status.isGit, true);
  assert.equal(status.hasHead, false);
  assert.equal(status.canStart, false);
  assert.match(status.reason, /no commits/);
});

test('loadLatestPlanningState returns newest planning state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-latest-'));
  const specDocPath = path.join(root, 'spec.md');
  await fs.writeFile(specDocPath, 'Spec\n', 'utf8');

  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: `${args.at(-1)}-commit\n`, stderr: '' };
    }
    if (command === 'claude') {
      return { stdout: `Started background session ${args[2]}-session\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  await startArchitectFromDesignDoc({ projectRoot: root, specDocPath, runId: 'run-old', runner });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await startArchitectFromDesignDoc({ projectRoot: root, specDocPath, runId: 'run-new', runner });

  const latest = await loadLatestPlanningState(root);
  assert.equal(latest.runId, 'run-new');
});

test('loadPlanningState surfaces a runner blocked on login', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-blocked-'));
  const agentDir = path.join(root, '.multiagent', 'planning', 'run-blocked', 'agent');
  {
    const statePath = getPlanningStatePath(root, 'run-blocked');
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          runId: 'run-blocked',
          projectRoot: root,
          specDocPath: path.join(root, 'spec.md'),
          architectName: 'main-architect',
          model: 'opus',
          permissionMode: 'acceptEdits',
          effort: 'medium',
          claudeSessionId: '11111111-2222-4333-8444-555555555555',
          agentDir,
          promptPath: path.join(root, '.multiagent', 'planning', 'run-blocked', 'architect_prompt.md'),
          baseCommit: 'abc123',
          status: 'running',
          error: null,
          startedAt: '2026-06-15T17:00:00.000Z',
          updatedAt: '2026-06-15T17:00:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await writeRunnerStatus(agentDir, { state: 'blocked', blockReason: 'login', detail: 'login required - run /login' });

    const state = await loadPlanningState(root, 'run-blocked', runnerAlive);
    assert.equal(state.status, 'blocked');
    assert.equal(state.error, 'login required - run /login');
  }
});

test('loadPlanningState marks the architect done when its runner finishes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-done-'));
  const agentDir = path.join(root, '.multiagent', 'planning', 'run-done', 'agent');
  const statePath = getPlanningStatePath(root, 'run-done');
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify({ version: 1, runId: 'run-done', projectRoot: root, agentDir, status: 'running', error: null }),
    'utf8',
  );
  await writeRunnerStatus(agentDir, { state: 'done' });

  const state = await loadPlanningState(root, 'run-done', runnerAlive);
  assert.equal(state.status, 'done');
  assert.equal(state.error, null);
});
