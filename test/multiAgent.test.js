const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const {
  advanceModuleReviewIfReady,
  advanceWorkflow,
  applyPatch,
  auditTask,
  buildAgentPrompt,
  getModuleReviewReadiness,
  getStatePath,
  getWorktreePath,
  importManifest,
  initializeRun,
  loadLatestRun,
  loadState,
  recoverRun,
  startAllReady,
  startTask,
  syncRun,
  validateManifest,
} = require('../src/multiAgent');
const { createFakeLauncher, runnerAlive, runnerDead, writeRunnerStatus } = require('./helpers/fakeAgents');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function makeTempGitRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-test-'));
  await run('git', ['init'], { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await fs.mkdir(path.join(root, 'src', 'player'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests', 'player'), { recursive: true });
  await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.mkdir(path.join(root, 'work', 'modules', 'player_health'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'player', 'player_health.gd'), 'class_name PlayerHealth\n');
  await fs.writeFile(path.join(root, 'tests', 'player', 'test_player_health.gd'), '# test\n');
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  await run('git', ['add', '.'], { cwd: root });
  await run('git', ['commit', '-m', 'init'], { cwd: root });
  return root;
}

function makeManifest(root, overrides = {}) {
  return {
    version: 1,
    project: {
      name: 'Game',
      root,
    },
    run: {
      id: 'run-001',
      goal: 'Build health',
      base: 'head',
    },
    main_agent: {
      name: 'main-agent',
      session_name: 'game-main',
      role: 'main',
      model: 'opus',
    },
    defaults: {
      sub_agent_model: 'sonnet',
      effort: 'medium',
      permission_mode: 'acceptEdits',
      worktree_base: 'head',
    },
    tasks: [
      {
        id: 'player-health',
        feature: 'Player Health',
        owner: 'player-health-agent',
        role: 'sub',
        model: 'sonnet',
        owned_script: 'src/player/player_health.gd',
        test_file: 'tests/player/test_player_health.gd',
        prompt_file: 'work/prompts/player_health.md',
        module_report: 'work/modules/player_health/module_report.md',
        interface_request: 'work/modules/player_health/interface_change_request.md',
        allowed_files: [
          'src/player/player_health.gd',
          'tests/player/test_player_health.gd',
          'work/modules/player_health/module_report.md',
          'work/modules/player_health/interface_change_request.md',
        ],
        depends_on: [],
        acceptance: ['Only edit assigned files'],
      },
    ],
    ...overrides,
  };
}

test('validateManifest rejects duplicate owned scripts', () => {
  const manifest = makeManifest('C:/project', {
    tasks: [
      makeManifest('C:/project').tasks[0],
      {
        ...makeManifest('C:/project').tasks[0],
        id: 'player-health-2',
        owner: 'player-health-agent-2',
      },
    ],
  });

  assert.throws(
    () => validateManifest(manifest, 'C:/project/tasks/task_manifest.yaml'),
    /Duplicate owned_script/,
  );
});

test('validateManifest rejects unknown dependencies', () => {
  const manifest = makeManifest('C:/project', {
    tasks: [
      {
        ...makeManifest('C:/project').tasks[0],
        depends_on: ['missing-task'],
      },
    ],
  });

  assert.throws(
    () => validateManifest(manifest, 'C:/project/tasks/task_manifest.yaml'),
    /references unknown task: missing-task/,
  );
});

test('validateManifest adds module review, integration, and system review agents', () => {
  const manifest = validateManifest(
    makeManifest('C:/project', {
      defaults: {
        sub_agent_model: 'sonnet',
        review_agent_model: 'opus-review',
        review_agent_effort: 'high',
        integration_agent_model: 'opus-integration',
        integration_agent_effort: 'medium',
        system_review_agent_model: 'opus-system',
        system_review_agent_effort: 'high',
        sub_agent_effort: 'low',
        effort: 'medium',
        permission_mode: 'acceptEdits',
        worktree_base: 'head',
      },
      module_review: {
        prompt_file: 'work/prompts/module_review.md',
      },
      integration: {
        prompt_file: 'work/prompts/integration.md',
        integration_context: 'work/integration/integration_context.md',
        allowed_files: [
          'src/bootstrap/game_composition.gd',
          'work/integration/integration_context.md',
          'work/integration/integration_report.md',
          'work/requests/integration_interface_request.md',
        ],
        integration_report: 'work/integration/integration_report.md',
        interface_request: 'work/requests/integration_interface_request.md',
      },
      system_review: {
        prompt_file: 'work/prompts/system_review.md',
      },
      diagnostics: {
        compile_command: ['npm', 'test'],
        log_files: ['Logs/compile.log'],
        include_unity_editor_log: true,
      },
    }),
    'C:/project/tasks/task_manifest.yaml',
  );

  const byRole = new Map(manifest.tasks.map((task) => [task.role, task]));
  assert.equal(manifest.tasks.length, 4);
  assert.equal(byRole.get('module_review').model, 'opus-review');
  assert.equal(byRole.get('integration').model, 'opus-integration');
  assert.equal(byRole.get('system_review').model, 'opus-system');
  assert.equal(byRole.get('sub').effort, 'low');
  assert.equal(byRole.get('module_review').effort, 'high');
  assert.equal(byRole.get('integration').effort, 'medium');
  assert.equal(byRole.get('system_review').effort, 'high');
  assert.equal(byRole.get('integration').ownedScript, null);
  assert.equal(byRole.get('integration').integrationContext, 'work/integration/integration_context.md');
  assert.ok(byRole.get('integration').allowedFiles.includes('src/bootstrap/game_composition.gd'));
  assert.deepEqual(manifest.diagnostics.compileCommand, ['npm', 'test']);
  assert.deepEqual(manifest.diagnostics.logFiles, ['Logs/compile.log']);
  assert.equal(manifest.diagnostics.includeUnityEditorLog, true);
});

test('validateManifest rejects integration allowed_files that include module owned scripts', () => {
  const manifest = makeManifest('C:/project', {
    integration: {
      prompt_file: 'work/prompts/integration.md',
      depends_on: ['player-health'],
      allowed_files: [
        'src/player/player_health.gd',
        'work/integration/integration_report.md',
        'work/requests/integration_interface_request.md',
      ],
      integration_report: 'work/integration/integration_report.md',
      interface_request: 'work/requests/integration_interface_request.md',
    },
  });

  assert.throws(
    () => validateManifest(manifest, 'C:/project/tasks/task_manifest.yaml'),
    /must not include module owned_script/,
  );
});

test('validateManifest rejects system review allowed_files that include implementation files', () => {
  const manifest = makeManifest('C:/project', {
    integration: {
      prompt_file: 'work/prompts/integration.md',
      depends_on: ['player-health'],
      allowed_files: [
        'src/bootstrap/game_composition.gd',
        'work/integration/integration_report.md',
        'work/requests/integration_interface_request.md',
      ],
      integration_report: 'work/integration/integration_report.md',
      interface_request: 'work/requests/integration_interface_request.md',
    },
    system_review: {
      prompt_file: 'work/prompts/system_review.md',
      allowed_files: [
        'reports/reviews/run-001/system_review.md',
        'work/requests/run-001_system_review_request.md',
        'src/player/player_health.gd',
      ],
    },
  });

  assert.throws(
    () => validateManifest(manifest, 'C:/project/tasks/task_manifest.yaml'),
    /system-review\.allowed_files must be limited to review reports and request files/,
  );
});

test('buildAgentPrompt makes review reports actionable for the main architect', () => {
  const moduleReviewPrompt = buildAgentPrompt(
    {
      role: 'module_review',
      allowedFiles: ['reports/reviews/run-001/module_review.md'],
    },
    'Review modules.',
  );
  const systemReviewPrompt = buildAgentPrompt(
    {
      role: 'system_review',
      allowedFiles: ['reports/reviews/run-001/system_review.md'],
    },
    'Review system.',
  );

  assert.match(moduleReviewPrompt, /exact task_id, agent owner, owned_script/);
  assert.match(moduleReviewPrompt, /dispatch plan for module rework/);
  assert.match(systemReviewPrompt, /related task ids, related agents, related files/);
  assert.match(systemReviewPrompt, /dispatch plan for integration or global rework/);
  assert.match(systemReviewPrompt, /Do not read implementation source files by default/);
  assert.match(systemReviewPrompt, /source_inspection_request/);
});

test('buildAgentPrompt limits module agents to their owned script folder for source reading', () => {
  const prompt = buildAgentPrompt(
    {
      role: 'sub',
      ownedScript: 'src/player/combat/player_health.gd',
      allowedFiles: [
        'src/player/combat/player_health.gd',
        'tests/player/combat/test_player_health.gd',
        'work/modules/player_health/module_report.md',
      ],
    },
    'Implement health.',
  );

  assert.match(prompt, /Your local source working area is src\/player\/combat/);
  assert.match(prompt, /do not browse unrelated source folders by default/);
  assert.match(prompt, /You may only modify the allowed files listed above/);
});

test('buildAgentPrompt constrains integration agents to contracts instead of implementation files', () => {
  const prompt = buildAgentPrompt(
    {
      role: 'integration',
      allowedFiles: [
        'src/bootstrap/game_composition.gd',
        'work/integration/run-001_integration_context.md',
        'work/integration/run-001_integration_report.md',
      ],
    },
    'Integrate modules.',
  );

  assert.match(prompt, /Do not read module implementation source files by default/);
  assert.match(prompt, /docs\/module_layout\.md/);
  assert.match(prompt, /folder-level module clusters and integration seams/);
  assert.match(prompt, /Integrate through docs\/module_contracts\.md/);
  assert.match(prompt, /public APIs, signals, events, data contracts/);
});

test('startTask launches an agent runner with the task spec', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-fake-'));
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  const manifest = validateManifest(
    makeManifest(root, {
      tasks: [
        {
          ...makeManifest(root).tasks[0],
          effort: 'high',
        },
      ],
    }),
    path.join(root, 'tasks', 'task_manifest.yaml'),
  );
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'auth') {
      return { stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\n', stderr: '' };
    }
    if (command === 'claude') {
      return { stdout: 'Started background session 7c5dcf5d\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const fake = createFakeLauncher();
  await initializeRun(manifest, { runner });
  const runState = await startTask(root, 'run-001', 'player-health', { runner, launchAgent: fake.launchAgent });
  const agent = runState.agents.find((entry) => entry.taskId === 'player-health');
  const [launch] = fake.launches;

  assert.equal(agent.status, 'running');
  assert.match(agent.claudeSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(agent.runnerPid, 4242);
  assert.equal(launch.spec.sessionId, agent.claudeSessionId);
  assert.equal(launch.spec.resume, false);
  assert.equal(launch.spec.effort, 'high');
  assert.equal(launch.spec.cwd, agent.worktreePath);
  assert.equal(launch.spec.projectConfigRoot, root);
  assert.deepEqual(launch.spec.allowedPaths, agent.allowedFiles);
  assert.match(launch.spec.prompt, /You may only modify:/);
  assert.equal(agent.logPath, path.join(launch.dir, 'agent.log'));
  assert.ok(!calls.some((call) => call.command === 'claude' && call.args.includes('--bg')));
});

test('startTask resumes the same session for a blocked agent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-resume-'));
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  const manifest = validateManifest(makeManifest(root), path.join(root, 'tasks', 'task_manifest.yaml'));
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'auth') {
      return { stdout: '{"loggedIn":true}\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const fake = createFakeLauncher();
  await initializeRun(manifest, { runner });
  const state = await loadState(root, 'run-001');
  const sessionId = '11111111-2222-4333-8444-555555555555';
  Object.assign(state.agents['player-health'], { status: 'blocked_rate_limit', claudeSessionId: sessionId });
  await fs.mkdir(state.agents['player-health'].worktreePath, { recursive: true });
  await fs.writeFile(getStatePath(root, 'run-001'), JSON.stringify(state, null, 2), 'utf8');

  const runState = await startTask(root, 'run-001', 'player-health', { runner, launchAgent: fake.launchAgent });
  const agent = runState.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(agent.status, 'running');
  assert.equal(agent.claudeSessionId, sessionId);
  assert.equal(fake.launches[0].spec.resume, true);
  assert.equal(fake.launches[0].spec.sessionId, sessionId);
  assert.match(fake.launches[0].spec.prompt, /Continue the same task/);
});

test('startTask injects provider profile environment for gateway agents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-provider-'));
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  const profilePath = path.join(root, 'profiles.json');
  await fs.writeFile(
    profilePath,
    JSON.stringify(
      {
        version: 1,
        profiles: [
          {
            id: 'gateway',
            label: 'Gateway',
            type: 'anthropic_compatible_gateway',
            baseUrl: 'https://gateway.example',
            apiKeyEnv: 'GATEWAY_KEY',
            models: ['vendor/model-a'],
          },
        ],
      },
      null,
      2,
    ),
  );
  const manifest = validateManifest(
    makeManifest(root, {
      defaults: {
        ...makeManifest(root).defaults,
        sub_agent_provider: 'gateway',
      },
      tasks: [
        {
          ...makeManifest(root).tasks[0],
          provider: 'gateway',
          model: 'vendor/model-a',
        },
      ],
    }),
    path.join(root, 'tasks', 'task_manifest.yaml'),
  );
  const fake = createFakeLauncher();
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'git') {
      return { stdout: '', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'auth') {
      return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n', stderr: '' };
    }
    throw new Error(`Unexpected command ${command}`);
  };

  await initializeRun(manifest, { runner });
  const runState = await startTask(root, 'run-001', 'player-health', {
    runner,
    env: { GATEWAY_KEY: 'secret-token', PATH: 'x' },
    providerProfileOptions: { filePath: profilePath },
    launchAgent: fake.launchAgent,
  });
  const claudeEnv = fake.launches[0].env;
  const agent = runState.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(agent.providerProfileId, 'gateway');
  assert.equal(agent.model, 'vendor/model-a');
  assert.equal(claudeEnv.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(claudeEnv.ANTHROPIC_AUTH_TOKEN, 'secret-token');
  assert.ok(!JSON.stringify(fake.launches[0].spec).includes('secret-token'));
});

test('startAllReady respects max_parallel_agents and queues the rest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-queue-'));
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_move.md'), 'Implement movement.\n');
  const baseTask = makeManifest(root).tasks[0];
  const manifest = validateManifest(
    makeManifest(root, {
      defaults: {
        ...makeManifest(root).defaults,
        max_parallel_agents: 1,
      },
      tasks: [
        baseTask,
        {
          ...baseTask,
          id: 'player-move',
          feature: 'Player Movement',
          owner: 'player-move-agent',
          owned_script: 'src/player/player_movement.gd',
          test_file: 'tests/player/test_player_movement.gd',
          prompt_file: 'work/prompts/player_move.md',
          module_report: 'work/modules/player_movement/module_report.md',
          interface_request: 'work/modules/player_movement/interface_change_request.md',
          allowed_files: [
            'src/player/player_movement.gd',
            'tests/player/test_player_movement.gd',
            'work/modules/player_movement/module_report.md',
            'work/modules/player_movement/interface_change_request.md',
          ],
        },
      ],
    }),
    path.join(root, 'tasks', 'task_manifest.yaml'),
  );
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'git') {
      return { stdout: '', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'auth') {
      return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n', stderr: '' };
    }
    throw new Error(`Unexpected command ${command}`);
  };

  await initializeRun(manifest, { runner });
  const runState = await startAllReady(root, 'run-001', { runner, launchAgent: createFakeLauncher().launchAgent });
  const statuses = Object.fromEntries(runState.agents.map((agent) => [agent.taskId, agent.status]));

  assert.equal(Object.values(statuses).filter((status) => status === 'running').length, 1);
  assert.equal(Object.values(statuses).filter((status) => status === 'queued').length, 1);
});

test('loadLatestRun returns newest persisted run state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-latest-run-'));
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  await initializeRun(validateManifest(makeManifest(root), path.join(root, 'tasks', 'task_manifest.yaml')), {
    runner,
  });
  await initializeRun(
    validateManifest(
      makeManifest(root, {
        run: {
          id: 'run-002',
          goal: 'Build health again',
          base: 'head',
        },
      }),
      path.join(root, 'tasks', 'task_manifest.yaml'),
    ),
    { runner },
  );
  const oldState = await loadState(root, 'run-001');
  oldState.updatedAt = '2026-01-01T00:00:00.000Z';
  await fs.writeFile(getStatePath(root, 'run-001'), `${JSON.stringify(oldState, null, 2)}\n`, 'utf8');
  const newState = await loadState(root, 'run-002');
  newState.updatedAt = '2026-01-02T00:00:00.000Z';
  await fs.writeFile(getStatePath(root, 'run-002'), `${JSON.stringify(newState, null, 2)}\n`, 'utf8');

  const latest = await loadLatestRun(root);

  assert.equal(latest.runId, 'run-002');
});

test('recoverRun marks missing worktree for active agents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-recover-worktree-'));
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'agents') {
      return { stdout: '[]', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const manifest = validateManifest(makeManifest(root), path.join(root, 'tasks', 'task_manifest.yaml'));
  await initializeRun(manifest, { runner });
  const state = await loadState(root, 'run-001');
  state.agents['player-health'].status = 'running';
  state.agents['player-health'].claudeSessionId = 'missing123';
  await fs.writeFile(getStatePath(root, 'run-001'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const result = await recoverRun(root, 'run-001', { runner });
  const agent = result.run.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(agent.status, 'worktree_missing');
  assert.deepEqual(result.recovery.worktreeMissing, ['player-health']);
});

test('recoverRun marks a vanished agent runner as session_missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-recover-session-'));
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const manifest = validateManifest(makeManifest(root), path.join(root, 'tasks', 'task_manifest.yaml'));
  await initializeRun(manifest, { runner });
  const state = await loadState(root, 'run-001');
  const agentState = state.agents['player-health'];
  await fs.mkdir(agentState.worktreePath, { recursive: true });
  agentState.status = 'running';
  agentState.claudeSessionId = '11111111-2222-4333-8444-555555555555';
  agentState.agentDir = path.join(root, '.multiagent', 'runs', 'run-001', 'agents', 'player-health');
  await writeRunnerStatus(agentState.agentDir, { state: 'running' });
  await fs.writeFile(getStatePath(root, 'run-001'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const result = await recoverRun(root, 'run-001', { runner, agentStatusOptions: runnerDead });
  const agent = result.run.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(agent.status, 'session_missing');
  assert.deepEqual(result.recovery.sessionMissing, ['player-health']);
});

test('advanceModuleReviewIfReady starts review only after all module patches are applied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-review-'));
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.mkdir(path.join(root, '.multiagent', 'runs', 'run-001', 'patches'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  await fs.writeFile(path.join(root, 'work', 'prompts', 'module_review.md'), 'Review modules.\n');
  const patchPath = path.join(root, '.multiagent', 'runs', 'run-001', 'patches', 'player-health.patch');
  await fs.writeFile(patchPath, 'diff --git a/src/player/player_health.gd b/src/player/player_health.gd\n');
  const manifest = validateManifest(
    makeManifest(root, {
      module_review: {
        prompt_file: 'work/prompts/module_review.md',
      },
    }),
    path.join(root, 'tasks', 'task_manifest.yaml'),
  );
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'auth') {
      return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  await initializeRun(manifest, { runner });
  const statePath = getStatePath(root, 'run-001');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(getModuleReviewReadiness(state).ready, false);
  state.agents['player-health'].status = 'patch_applied';
  state.agents['player-health'].patchPath = patchPath;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

  const result = await advanceModuleReviewIfReady(root, 'run-001', { runner, launchAgent: createFakeLauncher().launchAgent });
  const reviewAgent = result.run.agents.find((agent) => agent.taskId === 'module-review');

  assert.equal(result.advanced, true);
  assert.equal(reviewAgent.status, 'running');
  assert.match(reviewAgent.claudeSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(calls.some((call) => call.command === 'git' && call.args[0] === 'apply'));
  assert.ok(calls.some((call) => call.command === 'git' && call.args.includes('multiagent: hydrate dependency patches')));
});

test('advanceWorkflow runs module diagnostics before starting module review', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-workflow-'));
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.mkdir(path.join(root, '.multiagent', 'runs', 'run-001', 'patches'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  await fs.writeFile(path.join(root, 'work', 'prompts', 'module_review.md'), 'Review modules.\n');
  const patchPath = path.join(root, '.multiagent', 'runs', 'run-001', 'patches', 'player-health.patch');
  await fs.writeFile(patchPath, '');
  const manifest = validateManifest(
    makeManifest(root, {
      module_review: {
        prompt_file: 'work/prompts/module_review.md',
      },
      diagnostics: {
        compile_command: ['compile-game'],
      },
    }),
    path.join(root, 'tasks', 'task_manifest.yaml'),
  );
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'agents') {
      return { stdout: '[]\n', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'auth') {
      return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const diagnosticsCalls = [];
  const diagnosticsRunner = async (command, args, options) => {
    diagnosticsCalls.push({ command, args, cwd: options.cwd });
    return {
      command,
      args,
      cwd: options.cwd,
      exitCode: 0,
      failed: false,
      error: null,
      stdout: '',
      stderr: '',
      durationMs: 3,
    };
  };

  await initializeRun(manifest, { runner });
  const statePath = getStatePath(root, 'run-001');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.agents['player-health'].status = 'patch_applied';
  state.agents['player-health'].patchPath = patchPath;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

  const result = await advanceWorkflow(root, 'run-001', {
    runner,
    diagnosticsOptions: { runner: diagnosticsRunner },
    launchAgent: createFakeLauncher().launchAgent,
  });
  const reviewAgent = result.run.agents.find((agent) => agent.taskId === 'module-review');

  assert.equal(result.stopReason, 'agents_started');
  assert.equal(result.events[0].type, 'diagnostics');
  assert.equal(result.events[1].type, 'start_ready_agents');
  assert.deepEqual(diagnosticsCalls[0], { command: 'compile-game', args: [], cwd: root });
  assert.equal(reviewAgent.status, 'running');
});

test('advanceWorkflow can auto-apply ready patches when explicitly enabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-autoapply-'));
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.mkdir(path.join(root, '.multiagent', 'runs', 'run-001', 'patches'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  const patchPath = path.join(root, '.multiagent', 'runs', 'run-001', 'patches', 'player-health.patch');
  await fs.writeFile(patchPath, '');
  const manifest = validateManifest(makeManifest(root), path.join(root, 'tasks', 'task_manifest.yaml'));
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (command === 'claude' && args[0] === 'agents') {
      return { stdout: '[]\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  await initializeRun(manifest, { runner });
  const statePath = getStatePath(root, 'run-001');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.agents['player-health'].status = 'patch_ready';
  state.agents['player-health'].patchPath = patchPath;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

  const blocked = await advanceWorkflow(root, 'run-001', { runner });
  const advanced = await advanceWorkflow(root, 'run-001', { runner, autoApplyPatches: true });
  const agent = advanced.run.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(blocked.stopReason, 'patch_approval_required');
  assert.ok(advanced.events.some((event) => event.type === 'auto_apply_patches'));
  assert.equal(agent.status, 'patch_applied');
});

test('auditTask generates a patch when only allowed files changed', async () => {
  const root = await makeTempGitRepo();
  const manifestPath = path.join(root, 'tasks', 'task_manifest.yaml');
  await fs.writeFile(manifestPath, '');
  const manifest = validateManifest(makeManifest(root), manifestPath);
  await initializeRun(manifest);

  const worktreePath = getWorktreePath(root, 'run-001', 'player-health');
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await run('git', ['worktree', 'add', worktreePath, '-b', 'multiagent/run-001/player-health', 'HEAD'], {
    cwd: root,
  });
  await fs.mkdir(path.join(worktreePath, 'work', 'modules', 'player_health'), { recursive: true });
  await fs.appendFile(path.join(worktreePath, 'src', 'player', 'player_health.gd'), 'var hp = 100\n');
  await fs.writeFile(
    path.join(worktreePath, 'work', 'modules', 'player_health', 'module_report.md'),
    'Implemented health.\n',
  );

  const audited = await auditTask(root, 'run-001', 'player-health');
  const agent = audited.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(agent.status, 'patch_ready');
  assert.ok(agent.patchPath.endsWith('player-health.patch'));
  assert.deepEqual(agent.violations, []);
  const patchText = await fs.readFile(agent.patchPath, 'utf8');
  assert.match(patchText, /var hp = 100/);
});

test('auditTask marks policy_violation for unassigned files', async () => {
  const root = await makeTempGitRepo();
  const manifest = validateManifest(makeManifest(root), path.join(root, 'tasks', 'task_manifest.yaml'));
  await initializeRun(manifest);

  const worktreePath = getWorktreePath(root, 'run-001', 'player-health');
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await run('git', ['worktree', 'add', worktreePath, '-b', 'multiagent/run-001/player-health', 'HEAD'], {
    cwd: root,
  });
  await fs.mkdir(path.join(worktreePath, 'src', 'player'), { recursive: true });
  await fs.writeFile(path.join(worktreePath, 'src', 'player', 'player_movement.gd'), 'class_name PlayerMovement\n');

  const audited = await auditTask(root, 'run-001', 'player-health');
  const agent = audited.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(agent.status, 'policy_violation');
  assert.deepEqual(agent.violations, ['src/player/player_movement.gd']);
});

test('applyPatch applies a ready patch to the main project', async () => {
  const root = await makeTempGitRepo();
  const manifest = validateManifest(makeManifest(root), path.join(root, 'tasks', 'task_manifest.yaml'));
  await initializeRun(manifest);

  const worktreePath = getWorktreePath(root, 'run-001', 'player-health');
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await run('git', ['worktree', 'add', worktreePath, '-b', 'multiagent/run-001/player-health', 'HEAD'], {
    cwd: root,
  });
  await fs.appendFile(path.join(worktreePath, 'src', 'player', 'player_health.gd'), 'var hp = 100\n');
  await auditTask(root, 'run-001', 'player-health');

  const applied = await applyPatch(root, 'run-001', 'player-health');
  const agent = applied.agents.find((entry) => entry.taskId === 'player-health');
  const source = await fs.readFile(path.join(root, 'src', 'player', 'player_health.gd'), 'utf8');
  const savedState = await fs.readFile(getStatePath(root, 'run-001'), 'utf8');

  assert.equal(agent.status, 'patch_applied');
  assert.match(source, /var hp = 100/);
  assert.match(savedState, /patch_applied/);
});

async function setupSyncScenario(agentPatch, runnerStatus) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-sync-'));
  const runner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc123\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const manifest = validateManifest(makeManifest(root), path.join(root, 'tasks', 'task_manifest.yaml'));
  await initializeRun(manifest, { runner });
  const state = await loadState(root, 'run-001');
  const agentDir = path.join(root, '.multiagent', 'runs', 'run-001', 'agents', 'player-health');
  Object.assign(state.agents['player-health'], { agentDir, claudeSessionId: '11111111-2222-4333-8444-555555555555' }, agentPatch);
  await fs.writeFile(getStatePath(root, 'run-001'), JSON.stringify(state, null, 2), 'utf8');
  if (runnerStatus) {
    await writeRunnerStatus(agentDir, runnerStatus);
  }
  return { root, runner };
}

test('syncRun maps a runner blocked on login to blocked_login', async () => {
  const { root, runner } = await setupSyncScenario(
    { status: 'running' },
    { state: 'blocked', blockReason: 'login', detail: 'OAuth session expired' },
  );

  const run = await syncRun(root, 'run-001', { runner, agentStatusOptions: runnerAlive });
  const agent = run.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(agent.status, 'blocked_login');
  assert.equal(agent.error, 'OAuth session expired');
});

test('syncRun audits a finished runner and keeps its result and scope denials', async () => {
  const { root, runner } = await setupSyncScenario(
    { status: 'running' },
    {
      state: 'done',
      result: { subtype: 'success', costUsd: 0.12, numTurns: 7 },
      scopeDenials: [{ tool: 'Edit', path: 'src/enemy/enemy.gd' }],
    },
  );

  const run = await syncRun(root, 'run-001', { runner, agentStatusOptions: runnerAlive });
  const agent = run.agents.find((entry) => entry.taskId === 'player-health');

  assert.equal(agent.status, 'patch_ready');
  assert.equal(agent.result.costUsd, 0.12);
  assert.equal(agent.scopeDenials[0].path, 'src/enemy/enemy.gd');
});

test('syncRun keeps a live runner running and marks a dead one session_missing', async () => {
  const live = await setupSyncScenario({ status: 'running' }, { state: 'running' });
  const liveRun = await syncRun(live.root, 'run-001', { runner: live.runner, agentStatusOptions: runnerAlive });
  assert.equal(liveRun.agents.find((entry) => entry.taskId === 'player-health').status, 'running');

  const dead = await setupSyncScenario({ status: 'running' }, { state: 'running' });
  const deadRun = await syncRun(dead.root, 'run-001', { runner: dead.runner, agentStatusOptions: runnerDead });
  const agent = deadRun.agents.find((entry) => entry.taskId === 'player-health');
  assert.equal(agent.status, 'session_missing');
  assert.match(agent.error, /exited without reporting/);
});

test('syncRun leaves agents that are not running alone', async () => {
  const { root, runner } = await setupSyncScenario({ status: 'blocked_login' }, { state: 'done' });
  const run = await syncRun(root, 'run-001', { runner, agentStatusOptions: runnerAlive });
  assert.equal(run.agents.find((entry) => entry.taskId === 'player-health').status, 'blocked_login');
});
