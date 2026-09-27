const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const yaml = require('js-yaml');
const { buildClaudeInvocation } = require('./claudeCli');
const {
  blockedStatusFor,
  classifyAgentStatus,
  launchAgentProcess,
  newSessionId,
  readAgentStatus,
} = require('./agentProcess');
const { logEvent } = require('./managerLogger');
const { DEFAULT_PROVIDER_ID, buildProviderEnvAsync, getProviderProfile } = require('./providerProfiles');
const diagnostics = require('./diagnostics');
const { createScopeMatcher, normalizeScopeEntry } = require('./fileScope');
const { validateModuleOwnership } = require('./moduleOwnership');
const {
  applyAndCommitPatch,
  commitWorkingTree,
  ensureManagerDirExcluded,
  ensureRunBranch,
  getRunBranchName,
  listUncommittedChanges,
} = require('./runGit');
const {
  getFailingReviewGates,
  isReviewGateOpenForTask,
  isReworkHoldingRun,
  refreshReviewGates,
  syncReworkArchitect,
  waiveGate,
} = require('./reworkGate');

const STATE_VERSION = 1;
const VALID_STATUSES = new Set([
  'ready',
  'queued',
  'starting',
  'running',
  'blocked_login',
  'blocked_rate_limit',
  'blocked_permission',
  'blocked_dialog',
  'done',
  'auditing',
  'patch_ready',
  'patch_applied',
  'failed',
  'policy_violation',
  'review_failed',
  'rejected',
  'session_missing',
  'worktree_missing',
]);
const BLOCKING_STATUSES = new Set([
  'blocked_login',
  'blocked_rate_limit',
  'blocked_permission',
  'blocked_dialog',
  'failed',
  'policy_violation',
  'review_failed',
  'session_missing',
  'worktree_missing',
]);
// Statuses whose Claude session can be continued instead of started over.
const RESUMABLE_STATUSES = new Set([
  'blocked_login',
  'blocked_rate_limit',
  'blocked_permission',
  'blocked_dialog',
  'session_missing',
]);
const STARTABLE_STATUSES = new Set([
  'ready',
  'queued',
  'failed',
  'rejected',
  'worktree_missing',
  ...RESUMABLE_STATUSES,
]);
const ACTIVE_AGENT_STATUSES = new Set(['starting', 'running']);
const WORKTREE_REQUIRED_STATUSES = new Set([
  'starting',
  'running',
  'done',
  'auditing',
  'patch_ready',
  'policy_violation',
]);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const invocation =
      command === 'claude' ? buildClaudeInvocation(args) : { command, args, displayCommand: null };
    const startedAt = Date.now();
    logEvent('command.start', {
      command,
      resolvedCommand: invocation.displayCommand || `${command} ${args.join(' ')}`,
      cwd: options.cwd,
      args: summarizeArgs(args),
    });
    const child = execFile(
      invocation.command,
      invocation.args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs || 120000,
        windowsHide: true,
        maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          if (invocation.displayCommand) {
            error.message = `${error.message}\nResolved Claude command: ${invocation.displayCommand}`;
          }
          logEvent(
            'command.failure',
            {
              command,
              resolvedCommand: invocation.displayCommand || `${command} ${args.join(' ')}`,
              cwd: options.cwd,
              durationMs,
              error,
            },
            { level: 'error' },
          );
          reject(error);
          return;
        }

        logEvent('command.success', {
          command,
          resolvedCommand: invocation.displayCommand || `${command} ${args.join(' ')}`,
          cwd: options.cwd,
          durationMs,
          stdout: summarizeText(stdout),
          stderr: summarizeText(stderr),
        });
        resolve({ stdout, stderr });
      },
    );

    if (options.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

function summarizeText(value, maxLength = 1200) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}

function summarizeArgs(args = []) {
  return args.map((arg, index) => {
    const text = String(arg);
    const isLikelyPrompt = text.length > 800 || (index === args.length - 1 && text.includes('\n'));
    if (!isLikelyPrompt) {
      return text;
    }
    return `${text.slice(0, 500)}\n[truncated arg ${text.length - 500} chars]`;
  });
}

function nowIso() {
  return new Date().toISOString();
}

function safeSegment(value, fieldName) {
  const text = String(value || '').trim();
  if (!text || !/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(`${fieldName} must use only letters, numbers, ".", "_", or "-".`);
  }
  return text;
}

function normalizeRelPath(value, fieldName = 'path') {
  if (!value || typeof value !== 'string') {
    throw new Error(`${fieldName} is required.`);
  }

  if (path.isAbsolute(value)) {
    throw new Error(`${fieldName} must be relative to the project root.`);
  }

  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`${fieldName} must stay inside the project root.`);
  }

  return normalized;
}

// allowed_files entries are files or folders ("src/player/"). A module's
// owned folder/script and its test/report/request paths are always included.
function normalizeAllowedFiles(task) {
  const fromTask = Array.isArray(task.allowed_files) ? task.allowed_files : [];
  const required = [
    task.owned_folder,
    task.test_folder,
    task.owned_script,
    task.test_file,
    task.module_report,
    task.interface_request,
    task.review_report,
    task.integration_report,
    task.integration_context,
    task.system_review_report,
  ];
  const unique = new Set();

  for (const entry of [...required, ...fromTask]) {
    if (!entry) {
      continue;
    }
    unique.add(normalizeScopeEntry(entry, 'allowed_files entry'));
  }

  return [...unique];
}

function isImplementationPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return /^(src|test|tests|addons|scenes|resources|scripts|assets)\//.test(normalized) ||
    /(^|\/)project\.godot$/.test(normalized) ||
    /\.(gd|cs|ts|tsx|js|jsx|py|lua|cpp|c|h|hpp|rs|go|java|kt|shader|tscn|tres|res)$/i.test(normalized);
}

function normalizeDiagnostics(rawDiagnostics = {}) {
  const diagnostics = rawDiagnostics && typeof rawDiagnostics === 'object' ? rawDiagnostics : {};
  const compileCommand = diagnostics.compile_command || diagnostics.compileCommand || null;
  const logFiles = Array.isArray(diagnostics.log_files || diagnostics.logFiles)
    ? diagnostics.log_files || diagnostics.logFiles
    : [];

  return {
    compileCommand,
    logFiles: logFiles.map(String),
    includeUnityEditorLog: Boolean(
      diagnostics.include_unity_editor_log || diagnostics.includeUnityEditorLog,
    ),
    timeoutMs: Math.max(
      1000,
      Number.parseInt(diagnostics.timeout_ms || diagnostics.timeoutMs || 300000, 10) || 300000,
    ),
  };
}

function getRawDefaultEffortForRole(rawDefaults = {}, role = 'sub') {
  if (role === 'module_review') {
    return rawDefaults.review_agent_effort || rawDefaults.effort || 'medium';
  }
  if (role === 'integration') {
    return rawDefaults.integration_agent_effort || rawDefaults.effort || 'medium';
  }
  if (role === 'system_review') {
    return rawDefaults.system_review_agent_effort || rawDefaults.effort || 'medium';
  }
  return rawDefaults.sub_agent_effort || rawDefaults.effort || 'medium';
}

function getRawDefaultModelForRole(rawDefaults = {}, role = 'sub') {
  if (role === 'module_review') {
    return rawDefaults.review_agent_model || 'opus';
  }
  if (role === 'integration') {
    return rawDefaults.integration_agent_model || 'opus';
  }
  if (role === 'system_review') {
    return rawDefaults.system_review_agent_model || 'opus';
  }
  return rawDefaults.sub_agent_model || 'sonnet';
}

function getRawDefaultProviderForRole(rawDefaults = {}, role = 'sub') {
  if (role === 'module_review') {
    return rawDefaults.review_agent_provider || rawDefaults.provider || DEFAULT_PROVIDER_ID;
  }
  if (role === 'integration') {
    return rawDefaults.integration_agent_provider || rawDefaults.provider || DEFAULT_PROVIDER_ID;
  }
  if (role === 'system_review') {
    return rawDefaults.system_review_agent_provider || rawDefaults.provider || DEFAULT_PROVIDER_ID;
  }
  return rawDefaults.sub_agent_provider || rawDefaults.provider || DEFAULT_PROVIDER_ID;
}

function resolveProjectRoot(projectRoot, manifestPath) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('project.root is required.');
  }

  if (path.isAbsolute(projectRoot)) {
    return path.resolve(projectRoot);
  }

  return path.resolve(path.dirname(manifestPath), projectRoot);
}

function normalizeWorkflowTasks(rawManifest) {
  const tasks = [];
  const moduleTaskIds = Array.isArray(rawManifest.tasks)
    ? rawManifest.tasks.map((task) => String(task.id || '')).filter(Boolean)
    : [];

  if (rawManifest.module_review) {
    const review = rawManifest.module_review;
    tasks.push({
      id: review.id || 'module-review',
      feature: review.feature || 'Module Review',
      owner: review.owner || 'module-review-agent',
      role: 'module_review',
      provider: review.provider || rawManifest.defaults?.review_agent_provider || rawManifest.defaults?.provider,
      model: review.model || rawManifest.defaults?.review_agent_model,
      effort: review.effort || rawManifest.defaults?.review_agent_effort,
      prompt_file: review.prompt_file,
      review_report: review.review_report || `reports/reviews/${rawManifest.run?.id || 'run'}/module_review.md`,
      interface_request:
        review.interface_request ||
        `work/requests/${rawManifest.run?.id || 'run'}_module_review_request.md`,
      allowed_files: review.allowed_files || [
        review.review_report || `reports/reviews/${rawManifest.run?.id || 'run'}/module_review.md`,
        review.interface_request ||
          `work/requests/${rawManifest.run?.id || 'run'}_module_review_request.md`,
      ],
      depends_on: review.depends_on || moduleTaskIds,
      acceptance: review.acceptance || ['Review module patches against their assigned tasks.'],
    });
  }

  if (rawManifest.integration) {
    const integration = rawManifest.integration;
    tasks.push({
      id: integration.id || 'integration',
      feature: integration.feature || 'Integration Glue',
      owner: integration.owner || 'integration-agent',
      role: 'integration',
      provider: integration.provider || rawManifest.defaults?.integration_agent_provider || rawManifest.defaults?.provider,
      model: integration.model || rawManifest.defaults?.integration_agent_model,
      effort: integration.effort || rawManifest.defaults?.integration_agent_effort,
      prompt_file: integration.prompt_file,
      integration_report:
        integration.integration_report ||
        `work/integration/${rawManifest.run?.id || 'run'}_integration_report.md`,
      integration_context:
        integration.integration_context ||
        `work/integration/${rawManifest.run?.id || 'run'}_integration_context.md`,
      interface_request:
        integration.interface_request ||
        `work/requests/${rawManifest.run?.id || 'run'}_integration_request.md`,
      allowed_files: integration.allowed_files || [
        integration.integration_report ||
          `work/integration/${rawManifest.run?.id || 'run'}_integration_report.md`,
        integration.integration_context ||
          `work/integration/${rawManifest.run?.id || 'run'}_integration_context.md`,
        integration.interface_request ||
          `work/requests/${rawManifest.run?.id || 'run'}_integration_request.md`,
      ],
      depends_on: integration.depends_on || ['module-review'],
      acceptance: integration.acceptance || ['Wire accepted modules without editing module-owned folders.'],
    });
  }

  if (rawManifest.system_review) {
    const systemReview = rawManifest.system_review;
    tasks.push({
      id: systemReview.id || 'system-review',
      feature: systemReview.feature || 'System Review',
      owner: systemReview.owner || 'system-review-agent',
      role: 'system_review',
      provider:
        systemReview.provider || rawManifest.defaults?.system_review_agent_provider || rawManifest.defaults?.provider,
      model: systemReview.model || rawManifest.defaults?.system_review_agent_model,
      effort: systemReview.effort || rawManifest.defaults?.system_review_agent_effort,
      prompt_file: systemReview.prompt_file,
      system_review_report:
        systemReview.system_review_report ||
        `reports/reviews/${rawManifest.run?.id || 'run'}/system_review.md`,
      interface_request:
        systemReview.interface_request ||
        `work/requests/${rawManifest.run?.id || 'run'}_system_review_request.md`,
      allowed_files: systemReview.allowed_files || [
        systemReview.system_review_report ||
          `reports/reviews/${rawManifest.run?.id || 'run'}/system_review.md`,
        systemReview.interface_request ||
          `work/requests/${rawManifest.run?.id || 'run'}_system_review_request.md`,
      ],
      depends_on: systemReview.depends_on || ['integration'],
      acceptance: systemReview.acceptance || ['Review the integrated game against the final spec.'],
    });
  }

  return tasks;
}

function validateManifest(rawManifest, manifestPath) {
  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new Error('Manifest must be a YAML object.');
  }

  if (rawManifest.version !== 1) {
    throw new Error('Manifest version must be 1.');
  }

  const projectRoot = resolveProjectRoot(rawManifest.project?.root, manifestPath);
  const runId = safeSegment(rawManifest.run?.id, 'run.id');
  const moduleTasks = Array.isArray(rawManifest.tasks) ? rawManifest.tasks : [];
  const workflowTasks = normalizeWorkflowTasks(rawManifest);
  const tasks = [...moduleTasks, ...workflowTasks];

  if (!tasks.length) {
    throw new Error('Manifest must contain at least one task.');
  }

  const taskIds = new Set();
  const normalizedTasks = tasks.map((task, index) => {
    if (!task || typeof task !== 'object') {
      throw new Error(`tasks[${index}] must be an object.`);
    }

    const id = safeSegment(task.id, `tasks[${index}].id`);
    if (taskIds.has(id)) {
      throw new Error(`Duplicate task id: ${id}`);
    }
    taskIds.add(id);

    const role = task.role || 'sub';
    // Module tasks own a folder (owned_folder); owned_script is the legacy
    // single-file form and is still accepted.
    const ownedFolder = task.owned_folder
      ? normalizeScopeEntry(task.owned_folder, `${id}.owned_folder`, { folder: true })
      : null;
    const ownedScript = !ownedFolder && task.owned_script
      ? normalizeRelPath(task.owned_script, `${id}.owned_script`)
      : null;
    if (role === 'sub' && !ownedFolder && !ownedScript) {
      throw new Error(`${id}.owned_folder is required for module (sub) tasks.`);
    }
    const testFolder = task.test_folder
      ? normalizeScopeEntry(task.test_folder, `${id}.test_folder`, { folder: true })
      : null;

    const testFile = task.test_file ? normalizeRelPath(task.test_file, `${id}.test_file`) : null;
    const moduleReport = task.module_report
      ? normalizeRelPath(task.module_report, `${id}.module_report`)
      : null;
    const interfaceRequest = task.interface_request
      ? normalizeRelPath(task.interface_request, `${id}.interface_request`)
      : null;
    const reviewReport = task.review_report
      ? normalizeRelPath(task.review_report, `${id}.review_report`)
      : null;
    const integrationReport = task.integration_report
      ? normalizeRelPath(task.integration_report, `${id}.integration_report`)
      : null;
    const integrationContext = task.integration_context
      ? normalizeRelPath(task.integration_context, `${id}.integration_context`)
      : null;
    const systemReviewReport = task.system_review_report
      ? normalizeRelPath(task.system_review_report, `${id}.system_review_report`)
      : null;
    const promptFile = normalizeRelPath(task.prompt_file, `${id}.prompt_file`);
    const allowedFiles = normalizeAllowedFiles({
      ...task,
      owned_folder: ownedFolder,
      test_folder: testFolder,
      owned_script: ownedScript,
      test_file: testFile,
      module_report: moduleReport,
      interface_request: interfaceRequest,
      review_report: reviewReport,
      integration_report: integrationReport,
      integration_context: integrationContext,
      system_review_report: systemReviewReport,
    });

    return {
      id,
      feature: String(task.feature || id),
      owner: String(task.owner || `${id}-agent`),
      role,
      provider: String(task.provider || getRawDefaultProviderForRole(rawManifest.defaults, role)),
      model: task.model || getRawDefaultModelForRole(rawManifest.defaults, role),
      effort: String(task.effort || getRawDefaultEffortForRole(rawManifest.defaults, role)),
      ownedFolder,
      ownedScript,
      testFolder,
      testFile,
      promptFile,
      moduleReport,
      interfaceRequest,
      reviewReport,
      integrationReport,
      integrationContext,
      systemReviewReport,
      allowedFiles,
      dependsOn: Array.isArray(task.depends_on) ? task.depends_on.map(String) : [],
      acceptance: Array.isArray(task.acceptance) ? task.acceptance.map(String) : [],
    };
  });

  for (const task of normalizedTasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        throw new Error(`${task.id}.depends_on references unknown task: ${dependency}`);
      }
    }
  }

  validateModuleOwnership(normalizedTasks);
  for (const task of normalizedTasks.filter((entry) => entry.role === 'system_review')) {
    const forbidden = task.allowedFiles.filter(isImplementationPath);
    if (forbidden.length) {
      throw new Error(
        `${task.id}.allowed_files must be limited to review reports and request files, not implementation files: ${forbidden.join(', ')}`,
      );
    }
  }

  return {
    version: 1,
    manifestPath: path.resolve(manifestPath),
    project: {
      name: String(rawManifest.project?.name || path.basename(projectRoot) || 'Project'),
      root: projectRoot,
    },
    run: {
      id: runId,
      goal: String(rawManifest.run?.goal || ''),
      base: rawManifest.run?.base || 'head',
    },
    mainAgent: {
      name: String(rawManifest.main_agent?.name || 'main-agent'),
      sessionName: String(rawManifest.main_agent?.session_name || ''),
      role: rawManifest.main_agent?.role || 'main',
      model: String(rawManifest.main_agent?.model || 'opus'),
      provider: String(rawManifest.main_agent?.provider || DEFAULT_PROVIDER_ID),
      effort: String(rawManifest.main_agent?.effort || rawManifest.defaults?.effort || 'medium'),
    },
    defaults: {
      subAgentModel: String(rawManifest.defaults?.sub_agent_model || 'sonnet'),
      subAgentProvider: String(rawManifest.defaults?.sub_agent_provider || rawManifest.defaults?.provider || DEFAULT_PROVIDER_ID),
      reviewAgentModel: String(rawManifest.defaults?.review_agent_model || 'opus'),
      reviewAgentProvider: String(rawManifest.defaults?.review_agent_provider || rawManifest.defaults?.provider || DEFAULT_PROVIDER_ID),
      integrationAgentModel: String(rawManifest.defaults?.integration_agent_model || 'opus'),
      integrationAgentProvider: String(rawManifest.defaults?.integration_agent_provider || rawManifest.defaults?.provider || DEFAULT_PROVIDER_ID),
      systemReviewAgentModel: String(rawManifest.defaults?.system_review_agent_model || 'opus'),
      systemReviewAgentProvider: String(rawManifest.defaults?.system_review_agent_provider || rawManifest.defaults?.provider || DEFAULT_PROVIDER_ID),
      effort: String(rawManifest.defaults?.effort || 'medium'),
      subAgentEffort: String(rawManifest.defaults?.sub_agent_effort || rawManifest.defaults?.effort || 'medium'),
      reviewAgentEffort: String(rawManifest.defaults?.review_agent_effort || rawManifest.defaults?.effort || 'medium'),
      integrationAgentEffort: String(rawManifest.defaults?.integration_agent_effort || rawManifest.defaults?.effort || 'medium'),
      systemReviewAgentEffort: String(rawManifest.defaults?.system_review_agent_effort || rawManifest.defaults?.effort || 'medium'),
      permissionMode: String(rawManifest.defaults?.permission_mode || 'acceptEdits'),
      worktreeBase: rawManifest.defaults?.worktree_base || 'head',
      maxParallelAgents: Math.max(1, Number.parseInt(rawManifest.defaults?.max_parallel_agents || 5, 10) || 5),
    },
    diagnostics: normalizeDiagnostics(rawManifest.diagnostics),
    tasks: normalizedTasks,
  };
}

async function loadManifestFromFile(manifestPath) {
  const resolved = path.resolve(manifestPath);
  const raw = await fs.readFile(resolved, 'utf8');
  return validateManifest(yaml.load(raw), resolved);
}

function getTaskManifestPath(projectRoot) {
  return path.join(projectRoot, 'tasks', 'task_manifest.yaml');
}

function getMultiAgentRoot(projectRoot) {
  return path.join(projectRoot, '.multiagent');
}

function getStateDir(projectRoot, runId) {
  return path.join(getMultiAgentRoot(projectRoot), 'runs', runId);
}

function getStatePath(projectRoot, runId) {
  return path.join(getStateDir(projectRoot, runId), 'state.json');
}

function getPatchPath(projectRoot, runId, taskId) {
  return path.join(getStateDir(projectRoot, runId), 'patches', `${taskId}.patch`);
}

function getAgentDir(projectRoot, runId, taskId) {
  return path.join(getStateDir(projectRoot, runId), 'agents', taskId);
}

function getWorktreePath(projectRoot, runId, taskId) {
  return path.join(getMultiAgentRoot(projectRoot), 'worktrees', runId, taskId);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  if (!(await fileExists(filePath))) {
    return null;
  }

  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function ensureGitProject(projectRoot, options = {}) {
  const runner = options.runner || runCommand;
  const result = await runner('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot });
  if (result.stdout.trim() !== 'true') {
    throw new Error('Selected project is not a git working tree.');
  }
}

async function getHeadCommit(projectRoot, options = {}) {
  const runner = options.runner || runCommand;
  const result = await runner('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
  return result.stdout.trim();
}

async function getGitPorcelain(projectRoot, files = [], options = {}) {
  const runner = options.runner || runCommand;
  const args = ['status', '--porcelain'];
  if (files.length) {
    args.push('--', ...files);
  }
  const result = await runner('git', args, { cwd: projectRoot });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getClaudeAuthStatus(projectRoot, options = {}) {
  const runner = options.runner || runCommand;
  try {
    const result = await runner('claude', ['auth', 'status'], {
      cwd: projectRoot,
      timeoutMs: 30000,
    });
    return JSON.parse(result.stdout || '{}');
  } catch (error) {
    const text = String(error.stdout || error.message || '').trim();
    try {
      return JSON.parse(text || '{}');
    } catch {
      return {
        loggedIn: false,
        error: `${error.message}${error.stderr ? `\n${error.stderr}` : ''}`,
      };
    }
  }
}

async function preflightRun(projectRoot, runId, options = {}) {
  const state = await loadState(projectRoot, runId);
  const errors = [];
  const warnings = [];

  try {
    await ensureGitProject(projectRoot, options);
    await getHeadCommit(projectRoot, options);
    const uncommitted = await listUncommittedChanges(projectRoot, options.runner || runCommand);
    if (uncommitted.length) {
      const shown = uncommitted.slice(0, 8).join(', ');
      const more = uncommitted.length > 8 ? ` and ${uncommitted.length - 8} more` : '';
      errors.push(
        `The project has uncommitted changes (${shown}${more}). Agents start from the last commit and would not see them. Use Commit Working Tree, or commit/stash them yourself.`,
      );
    }
  } catch (error) {
    errors.push(`Git baseline is not ready: ${error.message}`);
  }

  const auth = await getClaudeAuthStatus(projectRoot, options);
  if (!auth.loggedIn) {
    errors.push('Claude Code CLI is not logged in. Run `claude auth login --claudeai`.');
  }
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    errors.push('Claude Agent SDK is not installed. Run `npm install` in the manager folder.');
  }

  const taskIds = new Set(state.manifest.tasks.map((task) => task.id));
  for (const task of state.manifest.tasks) {
    const promptPath = path.join(projectRoot, task.promptFile);
    if (!(await fileExists(promptPath))) {
      errors.push(`${task.id}.prompt_file does not exist: ${task.promptFile}`);
    }
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        errors.push(`${task.id}.depends_on references unknown task: ${dependency}`);
      }
    }
    if (task.role === 'integration') {
      const broad = task.allowedFiles.filter((file) => /[*?]|\.\.\//.test(file));
      if (broad.length) {
        warnings.push(`${task.id}.allowed_files contains broad entries: ${broad.join(', ')}`);
      }
    }
  }

  state.preflight = {
    ok: errors.length === 0,
    errors,
    warnings,
    checkedAt: nowIso(),
    claudeAuth: {
      loggedIn: Boolean(auth.loggedIn),
      authMethod: auth.authMethod || null,
      apiProvider: auth.apiProvider || null,
      email: auth.email || null,
    },
  };
  await saveState(state);
  return state.preflight;
}

async function recoverRun(projectRoot, runId, options = {}) {
  const state = await loadState(projectRoot, runId);
  const recovery = {
    checkedAt: nowIso(),
    worktreeMissing: [],
    sessionMissing: [],
    errors: [],
  };

  for (const agent of Object.values(state.agents)) {
    agent.recoveryIssues = [];

    if (
      WORKTREE_REQUIRED_STATUSES.has(agent.status) &&
      agent.worktreePath &&
      !(await fileExists(agent.worktreePath))
    ) {
      agent.recoveryIssues.push('worktree_missing');
      recovery.worktreeMissing.push(agent.taskId);
      agent.status = 'worktree_missing';
      agent.error = `Worktree is missing: ${agent.worktreePath}`;
      continue;
    }

    if (ACTIVE_AGENT_STATUSES.has(agent.status)) {
      try {
        await syncAgentFromRunner(state, agent, options);
      } catch (error) {
        recovery.errors.push(`${agent.taskId}: ${error.message}`);
      }
      if (agent.status === 'session_missing') {
        agent.recoveryIssues.push('session_missing');
        recovery.sessionMissing.push(agent.taskId);
      }
    }
  }

  state.recovery = recovery;
  await saveState(state);
  return {
    run: toClientRun(state),
    recovery,
  };
}

function createAgentState(task, manifest, existingAgent) {
  return {
    taskId: task.id,
    role: task.role,
    displayName: task.feature,
    owner: task.owner,
    providerProfileId: task.provider || getDefaultProviderForRole(manifest, task.role),
    model: task.model || getDefaultModelForRole(manifest, task.role),
    effort: task.effort || getDefaultEffortForRole(manifest, task.role),
    claudeSessionId: existingAgent?.claudeSessionId || null,
    status: existingAgent?.status && VALID_STATUSES.has(existingAgent.status)
      ? existingAgent.status
      : 'ready',
    worktreePath:
      existingAgent?.worktreePath || getWorktreePath(manifest.project.root, manifest.run.id, task.id),
    branch: existingAgent?.branch || `multiagent/${manifest.run.id}/${task.id}`,
    ownedFolder: task.ownedFolder || null,
    ownedScript: task.ownedScript,
    testFolder: task.testFolder || null,
    testFile: task.testFile,
    moduleReport: task.moduleReport,
    interfaceRequest: task.interfaceRequest,
    reviewReport: task.reviewReport,
    integrationReport: task.integrationReport,
    integrationContext: task.integrationContext,
    systemReviewReport: task.systemReviewReport,
    allowedFiles: task.allowedFiles,
    promptFile: task.promptFile,
    dependsOn: task.dependsOn,
    startedAt: existingAgent?.startedAt || null,
    finishedAt: existingAgent?.finishedAt || null,
    appliedAt: existingAgent?.appliedAt || null,
    patchPath: existingAgent?.patchPath || null,
    changedFiles: existingAgent?.changedFiles || [],
    violations: existingAgent?.violations || [],
    error: existingAgent?.error || null,
    lastSyncAt: existingAgent?.lastSyncAt || null,
    recoveryIssues: existingAgent?.recoveryIssues || [],
    appliedCommit: existingAgent?.appliedCommit || null,
    auditBaseCommit: existingAgent?.auditBaseCommit || null,
  };
}

function getDefaultModelForRole(manifest, role) {
  if (role === 'module_review') {
    return manifest.defaults.reviewAgentModel;
  }
  if (role === 'integration') {
    return manifest.defaults.integrationAgentModel;
  }
  if (role === 'system_review') {
    return manifest.defaults.systemReviewAgentModel;
  }
  return manifest.defaults.subAgentModel;
}

function getDefaultProviderForRole(manifest, role) {
  if (role === 'module_review') {
    return manifest.defaults.reviewAgentProvider;
  }
  if (role === 'integration') {
    return manifest.defaults.integrationAgentProvider;
  }
  if (role === 'system_review') {
    return manifest.defaults.systemReviewAgentProvider;
  }
  return manifest.defaults.subAgentProvider;
}

function getDefaultEffortForRole(manifest, role) {
  if (role === 'module_review') {
    return manifest.defaults.reviewAgentEffort;
  }
  if (role === 'integration') {
    return manifest.defaults.integrationAgentEffort;
  }
  if (role === 'system_review') {
    return manifest.defaults.systemReviewAgentEffort;
  }
  return manifest.defaults.subAgentEffort || manifest.defaults.effort;
}

async function initializeRun(manifest, options = {}) {
  await ensureGitProject(manifest.project.root, options);
  await ensureManagerDirExcluded(manifest.project.root, options.runner || runCommand);
  const statePath = getStatePath(manifest.project.root, manifest.run.id);
  const existing = await readJsonIfExists(statePath);
  const baseCommit = existing?.baseCommit || (await getHeadCommit(manifest.project.root, options));
  const agents = {};

  for (const task of manifest.tasks) {
    agents[task.id] = createAgentState(task, manifest, existing?.agents?.[task.id]);
  }

  const state = {
    version: STATE_VERSION,
    runId: manifest.run.id,
    projectRoot: manifest.project.root,
    manifestPath: manifest.manifestPath,
    baseCommit,
    runBranch: existing?.runBranch || getRunBranchName(manifest.run.id),
    manifest,
    agents,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastSyncError: null,
  };

  await writeJson(statePath, state);
  return toClientRun(state);
}

async function loadDefaultManifest(projectRoot, options = {}) {
  const manifest = await loadManifestFromFile(getTaskManifestPath(projectRoot));
  return initializeRun(manifest, options);
}

async function importManifest(manifestPath, options = {}) {
  const manifest = await loadManifestFromFile(manifestPath);
  return initializeRun(manifest, options);
}

async function loadState(projectRoot, runId) {
  const state = await readJsonIfExists(getStatePath(projectRoot, runId));
  if (!state) {
    throw new Error(`Run state not found: ${runId}`);
  }
  return state;
}

async function loadRun(projectRoot, runId) {
  return toClientRun(await loadState(projectRoot, runId));
}

async function loadLatestRun(projectRoot) {
  const runsRoot = path.join(getMultiAgentRoot(projectRoot), 'runs');
  let entries = [];
  try {
    entries = await fs.readdir(runsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const statePath = getStatePath(projectRoot, entry.name);
    const state = await readJsonIfExists(statePath);
    if (!state) {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(statePath)).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    candidates.push({
      state,
      time: Date.parse(state.updatedAt || state.createdAt || '') || mtimeMs,
    });
  }

  candidates.sort((a, b) => b.time - a.time);
  return candidates[0] ? toClientRun(candidates[0].state) : null;
}

async function saveState(state) {
  state.updatedAt = nowIso();
  await writeJson(getStatePath(state.projectRoot, state.runId), state);
}

function getTask(state, taskId) {
  const task = state.manifest.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

function buildResumePrompt(task) {
  return `Your previous session for task ${task.id} stopped before it finished (for example a login, rate limit, or app restart). Continue the same task from where you left off. The execution constraints from your original instructions still apply, and you must still write your assigned report before finishing.`;
}

function buildAgentPrompt(task, promptText) {
  const allowedList = task.allowedFiles.map((file) => `- ${file}`).join('\n');
  const ownedSourceFolder = task.ownedScript ? path.posix.dirname(task.ownedScript) : null;
  const moduleGuidance = task.ownedFolder
    ? `You are a module implementation agent. You own the module folder ${task.ownedFolder}${task.testFolder ? ` and the test folder ${task.testFolder}` : ''}: you may create, edit, split, and delete files inside them as the module needs, keeping its public API consistent with docs/module_contracts.md. Do not browse or edit other modules' folders by default. You may only modify the allowed files listed above.`
    : null;
  const roleGuidance = {
    sub: moduleGuidance || `You are a module implementation agent. Implement exactly one assigned script and its matching test/report files. Your local source working area is ${ownedSourceFolder || 'the owned script folder'}. You may read source files in that folder when needed, but do not browse unrelated source folders by default. You may only modify the allowed files listed above.`,
    module_review: `You are a module review agent. Review whether module agents completed their assigned work. Do not modify source scripts. Every finding must name the exact task_id, agent owner, owned_folder, evidence files, violated contract or acceptance criterion, and a recommended action for the Main Architect such as reassign_to_same_agent, create_new_task, contract_change, or main_agent_decision. Your report must be directly usable as a dispatch plan for module rework. Include a YAML block named rework_items with fields: issue_id, severity, task_id, agent_owner, owned_folder, problem, expected_behavior, actual_behavior, evidence, recommended_action, blocks_integration.`,
    integration: `You are an integration agent. Write only explicit glue/composition/integration files listed below. Do not modify files inside module-owned folders. Do not read module implementation source files by default. Use docs/module_layout.md and the integration_context file to understand folder-level module clusters and integration seams. Integrate through docs/module_contracts.md, public APIs, signals, events, data contracts, module reports, and interface requests. If a required API or signal is missing or unclear, write an interface request instead of inspecting or editing module internals.`,
    system_review: `You are a system review agent. Review the integrated project against the final spec. Do not modify source scripts. Default to reviewing contracts, reports, patch summaries, integration context, integration reports, prior review reports, supplied test output, and supplied runtime logs. Do not read implementation source files by default. If source inspection is required, write a source_inspection_request in the allowed request file with the exact file path, reason, expected risk, and question to answer; do not inspect the source in this task. Every finding must name related task ids, related agents, related files, the likely responsible owner, whether it blocks release, and a recommended action for the Main Architect. Your report must be directly usable as a dispatch plan for integration or global rework. Include a YAML block named rework_items with fields: issue_id, severity, scope, related_task_ids, related_agents, related_files, problem, expected_behavior, actual_behavior, recommended_owner, recommended_action, blocks_release.`,
  };

  return `${promptText.trim()}

---

MultiAgent execution constraints:

You may only modify:
${allowedList}

${roleGuidance[task.role] || roleGuidance.sub}
Do not create or edit any other file outside the allowed list.
If another file is needed, write an interface change request instead.
Always write the assigned report file before finishing.`;
}

async function startTask(projectRoot, runId, taskId, options = {}) {
  const runner = options.runner || runCommand;
  const state = await loadState(projectRoot, runId);
  const task = getTask(state, taskId);
  const agent = state.agents[taskId];

  if (!STARTABLE_STATUSES.has(agent.status)) {
    return toClientRun(state);
  }

  await refreshReviewGates(state);
  if (!dependenciesSatisfied(state, taskId)) {
    const closedGates = task.dependsOn.filter(
      (dependencyId) =>
        state.agents[dependencyId]?.status === 'patch_applied' && !isReviewGateOpenForTask(state, dependencyId),
    );
    agent.status = 'queued';
    agent.error = closedGates.length
      ? `Blocked by review gate(s) ${closedGates.join(', ')}: dispatch rework to the Main Architect or waive the gate.`
      : `Waiting for dependencies to reach patch_applied: ${task.dependsOn.join(', ')}`;
    await saveState(state);
    return toClientRun(state);
  }

  const preflight = await preflightRun(projectRoot, runId, options);
  state.preflight = preflight;
  if (!preflight.ok) {
    agent.status = preflight.errors.some((error) => /not logged in|auth login/i.test(error))
      ? 'blocked_login'
      : 'failed';
    agent.blockedSource = 'preflight';
    agent.error = preflight.errors.join('\n');
    await saveState(state);
    return toClientRun(state);
  }

  const resume = Boolean(
    RESUMABLE_STATUSES.has(agent.status) &&
      agent.claudeSessionId &&
      options.fresh !== true &&
      (await fileExists(agent.worktreePath)),
  );
  agent.status = 'starting';
  agent.error = null;
  agent.violations = [];
  agent.changedFiles = [];
  agent.patchPath = null;
  await saveState(state);

  try {
    await ensureStateOnRunBranch(state, runner);
    await fs.mkdir(path.dirname(agent.worktreePath), { recursive: true });
    if (!(await fileExists(agent.worktreePath))) {
      // The run branch tip already holds every applied dependency patch.
      await runner('git', ['worktree', 'add', agent.worktreePath, '-b', agent.branch, 'HEAD'], {
        cwd: projectRoot,
        timeoutMs: 120000,
      });
      const head = await runner('git', ['rev-parse', 'HEAD'], { cwd: agent.worktreePath });
      agent.auditBaseCommit = head.stdout.trim() || state.baseCommit;
    }

    const promptText = await fs.readFile(path.join(projectRoot, task.promptFile), 'utf8');
    const providerProfile = await getProviderProfile(agent.providerProfileId, options.providerProfileOptions || {});
    const providerEnv = await buildProviderEnvAsync(
      providerProfile,
      options.env || process.env,
      options.providerProfileOptions || {},
    );
    const sessionId = resume ? agent.claudeSessionId : newSessionId();
    const agentDir = getAgentDir(projectRoot, runId, taskId);
    const launch = await (options.launchAgent || launchAgentProcess)({
      dir: agentDir,
      env: providerEnv,
      spec: {
        name: task.owner,
        sessionId,
        resume,
        cwd: agent.worktreePath,
        projectConfigRoot: projectRoot,
        prompt: resume ? buildResumePrompt(task) : buildAgentPrompt(task, promptText),
        model: task.model || getDefaultModelForRole(state.manifest, task.role),
        effort: task.effort || getDefaultEffortForRole(state.manifest, task.role),
        permissionMode: state.manifest.defaults.permissionMode,
        allowedPaths: task.allowedFiles,
        interfaceRequest: task.interfaceRequest,
      },
    });

    agent.claudeSessionId = sessionId;
    agent.agentDir = agentDir;
    agent.logPath = launch.logPath;
    agent.runnerPid = launch.pid;
    agent.blockedSource = null;
    agent.scopeDenials = resume ? agent.scopeDenials || [] : [];
    agent.status = 'running';
    agent.startedAt = nowIso();
    agent.lastSyncAt = nowIso();
    agent.error = null;
  } catch (error) {
    agent.status = 'failed';
    agent.error = `${error.message}${error.stderr ? `\n${error.stderr}` : ''}`;
  }

  await saveState(state);
  return toClientRun(state);
}

async function startAllReady(projectRoot, runId, options = {}) {
  let state = await loadState(projectRoot, runId);
  const preflight = await preflightRun(projectRoot, runId, options);
  if (!preflight.ok) {
    return toClientRun(await loadState(projectRoot, runId));
  }
  if (await refreshReviewGates(state)) {
    await saveState(state);
  }

  const maxParallel = Math.max(1, Number(options.maxParallelAgents || state.manifest.defaults.maxParallelAgents || 5));
  const runningCount = Object.values(state.agents).filter((agent) =>
    ['starting', 'running'].includes(agent.status),
  ).length;
  let slots = Math.max(0, maxParallel - runningCount);
  const readyIds = Object.values(state.agents)
    .filter((agent) =>
      ['ready', 'queued', 'failed', 'rejected', 'session_missing', 'worktree_missing'].includes(agent.status),
    )
    .filter((agent) => dependenciesSatisfied(state, agent.taskId))
    .map((agent) => agent.taskId);

  for (const taskId of readyIds) {
    if (slots <= 0) {
      state = await loadState(projectRoot, runId);
      if (state.agents[taskId]?.status === 'ready') {
        state.agents[taskId].status = 'queued';
        await saveState(state);
      }
      continue;
    }
    await startTask(projectRoot, runId, taskId, options);
    slots -= 1;
  }

  state = await loadState(projectRoot, runId);
  return toClientRun(state);
}

function getModuleReviewReadiness(state) {
  const moduleAgents = Object.values(state.agents).filter((agent) => agent.role === 'sub');
  const reviewAgents = Object.values(state.agents).filter((agent) => agent.role === 'module_review');

  if (!reviewAgents.length) {
    return {
      ready: false,
      reason: 'No module_review agent is defined in the manifest.',
      reviewTaskId: null,
      blockers: [],
    };
  }

  const blockers = moduleAgents
    .filter((agent) => agent.status !== 'patch_applied')
    .map((agent) => ({
      taskId: agent.taskId,
      status: agent.status,
    }));

  if (blockers.length) {
    return {
      ready: false,
      reason: 'Module review waits until every module patch is applied.',
      reviewTaskId: reviewAgents[0].taskId,
      blockers,
    };
  }

  const pendingReview = reviewAgents.find((agent) => ['ready', 'queued'].includes(agent.status));
  if (!pendingReview) {
    return {
      ready: false,
      reason: 'Module review is already started or has reached a terminal state.',
      reviewTaskId: reviewAgents[0].taskId,
      blockers: [],
    };
  }

  return {
    ready: true,
    reason: 'All module patches are applied; module review can start.',
    reviewTaskId: pendingReview.taskId,
    blockers: [],
  };
}

async function advanceModuleReviewIfReady(projectRoot, runId, options = {}) {
  const state = await loadState(projectRoot, runId);
  const readiness = getModuleReviewReadiness(state);

  if (!readiness.ready) {
    return {
      advanced: false,
      reason: readiness.reason,
      reviewTaskId: readiness.reviewTaskId,
      blockers: readiness.blockers,
      run: toClientRun(state),
    };
  }

  const run = await startTask(projectRoot, runId, readiness.reviewTaskId, options);
  const reviewAgent = run.agents.find((agent) => agent.taskId === readiness.reviewTaskId);
  return {
    advanced: ['starting', 'running', 'blocked_login', 'failed'].includes(reviewAgent?.status),
    reason: `Module review ${reviewAgent?.status || 'started'}.`,
    reviewTaskId: readiness.reviewTaskId,
    blockers: [],
    run,
  };
}

function getAgentsByRole(state, role) {
  return Object.values(state.agents).filter((agent) => agent.role === role);
}

function isDiagnosticsStageCleared(stageStatus) {
  return stageStatus === 'passed' || stageStatus === 'waived';
}

function shouldRunDiagnosticsBeforeRole(state, role) {
  const diagnosticsState = state.workflow?.diagnostics || {};
  if (role === 'module_review') {
    const moduleAgents = getAgentsByRole(state, 'sub');
    return (
      moduleAgents.length > 0 &&
      moduleAgents.every((agent) => agent.status === 'patch_applied') &&
      !isDiagnosticsStageCleared(diagnosticsState.afterModules)
    );
  }
  if (role === 'system_review') {
    const integrationAgents = getAgentsByRole(state, 'integration');
    return (
      integrationAgents.length > 0 &&
      integrationAgents.every((agent) => agent.status === 'patch_applied') &&
      !isDiagnosticsStageCleared(diagnosticsState.afterIntegration)
    );
  }
  return false;
}

async function runWorkflowDiagnostics(state, stage, options = {}) {
  const result = await diagnostics.runDiagnostics(
    state.projectRoot,
    state.runId,
    state.manifest?.diagnostics || {},
    options.diagnosticsOptions || {},
  );
  state.workflow = state.workflow || {};
  state.workflow.diagnostics = state.workflow.diagnostics || {};
  state.workflow.diagnostics[stage] = result.counts.error > 0 ? 'failed' : 'passed';
  state.workflow.diagnostics[`${stage}ReportPath`] = result.reportPath;
  state.workflow.diagnostics[`${stage}JsonPath`] = result.jsonPath;
  state.workflow.diagnostics[`${stage}CheckedAt`] = result.generatedAt;
  state.workflow.diagnostics[`${stage}Counts`] = result.counts;
  await saveState(state);
  return result;
}

async function advanceWorkflow(projectRoot, runId, options = {}) {
  const events = [];
  let run = await syncRun(projectRoot, runId, options);
  let state = await loadState(projectRoot, runId);

  const blockingAgent = Object.values(state.agents).find((agent) => BLOCKING_STATUSES.has(agent.status));
  if (blockingAgent) {
    return {
      advanced: false,
      reason: `${blockingAgent.taskId} is blocked: ${blockingAgent.status}`,
      stopReason: 'blocked_agent',
      events,
      run,
    };
  }

  if (isReworkHoldingRun(state)) {
    return {
      advanced: false,
      reason: `Rework round ${state.workflow.rework.round} is ${state.workflow.rework.status}.`,
      stopReason: 'rework_open',
      events,
      run,
    };
  }

  const patchReady = Object.values(state.agents).filter((agent) => agent.status === 'patch_ready');
  if (patchReady.length) {
    if (options.autoApplyPatches) {
      const applied = [];
      for (const agent of patchReady) {
        try {
          await applyPatch(projectRoot, runId, agent.taskId, {
            ...options,
            autoStartModuleReview: false,
          });
          applied.push(agent.taskId);
        } catch (error) {
          return {
            advanced: false,
            reason: `Auto-apply failed for ${agent.taskId}: ${error.message}`,
            stopReason: 'patch_apply_failed',
            events: [...events, { type: 'auto_apply_failed', taskId: agent.taskId, error: error.message }],
            pendingPatches: patchReady.map((entry) => entry.taskId),
            run: toClientRun(await loadState(projectRoot, runId)),
          };
        }
      }
      events.push({ type: 'auto_apply_patches', taskIds: applied });
      state = await loadState(projectRoot, runId);
      run = toClientRun(state);
    } else {
      return {
        advanced: false,
        reason: `${patchReady.length} patch(es) need user approval before continuing.`,
        stopReason: 'patch_approval_required',
        events,
        pendingPatches: patchReady.map((agent) => agent.taskId),
        run,
      };
    }
  }

  if (shouldRunDiagnosticsBeforeRole(state, 'module_review')) {
    const result = await runWorkflowDiagnostics(state, 'afterModules', options);
    events.push({
      type: 'diagnostics',
      stage: 'afterModules',
      counts: result.counts,
      reportPath: result.reportPath,
    });
    if (result.counts.error > 0) {
      return {
        advanced: true,
        reason: 'Module diagnostics found errors. Main Architect should read the diagnostics report and dispatch rework.',
        stopReason: 'diagnostics_failed',
        events,
        diagnostics: result,
        run: toClientRun(await loadState(projectRoot, runId)),
      };
    }
    state = await loadState(projectRoot, runId);
    run = toClientRun(state);
  }

  state = await loadState(projectRoot, runId);
  if (shouldRunDiagnosticsBeforeRole(state, 'system_review')) {
    const result = await runWorkflowDiagnostics(state, 'afterIntegration', options);
    events.push({
      type: 'diagnostics',
      stage: 'afterIntegration',
      counts: result.counts,
      reportPath: result.reportPath,
    });
    if (result.counts.error > 0) {
      return {
        advanced: true,
        reason: 'Integration diagnostics found errors. Main Architect should read the diagnostics report and dispatch rework.',
        stopReason: 'diagnostics_failed',
        events,
        diagnostics: result,
        run: toClientRun(await loadState(projectRoot, runId)),
      };
    }
    state = await loadState(projectRoot, runId);
    run = toClientRun(state);
  }

  if (await refreshReviewGates(state)) {
    await saveState(state);
  }
  const failingGates = getFailingReviewGates(state);
  if (failingGates.length) {
    return {
      advanced: false,
      reason: `Review gate closed (${failingGates.map((gate) => `${gate.taskId}: ${gate.outcome}`).join(', ')}). Dispatch rework to the Main Architect or waive the gate.`,
      stopReason: 'rework_required',
      events,
      reviewGates: failingGates,
      run: toClientRun(state),
    };
  }

  const readyIds = Object.values(state.agents)
    .filter((agent) => ['ready', 'queued'].includes(agent.status))
    .filter((agent) => dependenciesSatisfied(state, agent.taskId))
    .map((agent) => agent.taskId);

  if (readyIds.length) {
    run = await startAllReady(projectRoot, runId, options);
    events.push({ type: 'start_ready_agents', taskIds: readyIds });
    return {
      advanced: true,
      reason: `Started ${readyIds.length} ready agent(s).`,
      stopReason: 'agents_started',
      events,
      run,
    };
  }

  return describeIdleWorkflow(state, events);
}

function describeIdleWorkflow(state, events) {
  const agents = Object.values(state.agents);
  const activeCount = agents.filter((agent) => ['starting', 'running', 'auditing'].includes(agent.status)).length;
  if (activeCount) {
    return {
      advanced: false,
      reason: `Waiting for ${activeCount} running agent(s).`,
      stopReason: 'waiting_for_agents',
      events,
      run: toClientRun(state),
    };
  }
  if (agents.length && agents.every((agent) => agent.status === 'patch_applied')) {
    return {
      advanced: false,
      reason: 'Every agent patch is applied and all review gates are open. This run is complete.',
      stopReason: 'workflow_complete',
      events,
      run: toClientRun(state),
    };
  }
  return {
    advanced: false,
    reason: 'No safe automatic workflow step is available.',
    stopReason: 'idle_or_waiting',
    events,
    run: toClientRun(state),
  };
}

async function waiveWorkflowGate(projectRoot, runId, gateId, note = '') {
  const state = await loadState(projectRoot, runId);
  waiveGate(state, String(gateId || ''), String(note || ''));
  await saveState(state);
  return toClientRun(state);
}

// A dependency counts once its patch is applied and, for review agents, once
// its review gate is open (passed or waived). Call refreshReviewGates first.
function dependenciesSatisfied(state, taskId) {
  const task = getTask(state, taskId);
  return task.dependsOn.every(
    (dependencyId) =>
      state.agents[dependencyId]?.status === 'patch_applied' && isReviewGateOpenForTask(state, dependencyId),
  );
}

async function getChangedFiles(worktreePath, baseCommit, options = {}) {
  const runner = options.runner || runCommand;
  const diff = await runner('git', ['diff', '--name-only', baseCommit], { cwd: worktreePath });
  const untracked = await runner('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: worktreePath,
  });
  const files = new Set();

  for (const value of `${diff.stdout}\n${untracked.stdout}`.split(/\r?\n/)) {
    const normalized = value.trim().replace(/\\/g, '/');
    if (normalized) {
      files.add(normalized);
    }
  }

  return [...files].sort();
}

async function createPatchForAgent(state, agent, options = {}) {
  const runner = options.runner || runCommand;
  const patchPath = getPatchPath(state.projectRoot, state.runId, agent.taskId);
  const untrackedAllowed = agent.changedFiles.filter(createScopeMatcher(agent.allowedFiles));
  const auditBaseCommit = agent.auditBaseCommit || state.baseCommit;

  if (untrackedAllowed.length) {
    await runner('git', ['add', '-N', '--', ...untrackedAllowed], { cwd: agent.worktreePath });
  }

  const diff = await runner(
    'git',
    ['diff', '--binary', auditBaseCommit, '--', ...agent.allowedFiles],
    { cwd: agent.worktreePath, maxBuffer: 30 * 1024 * 1024 },
  );

  await fs.mkdir(path.dirname(patchPath), { recursive: true });
  await fs.writeFile(patchPath, diff.stdout, 'utf8');
  return patchPath;
}

async function auditAgentInState(state, taskId, options = {}) {
  const agent = state.agents[taskId];
  if (!agent) {
    throw new Error(`Agent not found: ${taskId}`);
  }

  agent.status = 'auditing';
  agent.changedFiles = await getChangedFiles(
    agent.worktreePath,
    agent.auditBaseCommit || state.baseCommit,
    options,
  );
  const isAllowed = createScopeMatcher(agent.allowedFiles);
  agent.violations = agent.changedFiles.filter((file) => !isAllowed(file));

  if (agent.violations.length) {
    agent.status = 'policy_violation';
    agent.error = `Agent changed files outside its allowed set: ${agent.violations.join(', ')}`;
    return agent;
  }

  agent.patchPath = await createPatchForAgent(state, agent, options);
  agent.status = 'patch_ready';
  agent.error = null;
  return agent;
}

async function auditTask(projectRoot, runId, taskId, options = {}) {
  const state = await loadState(projectRoot, runId);
  await auditAgentInState(state, taskId, options);
  await saveState(state);
  return toClientRun(state);
}

async function syncAgentFromRunner(state, agent, options = {}) {
  const status = await readAgentStatus(agent.agentDir);
  const lifecycle = classifyAgentStatus(status, {
    ...(options.agentStatusOptions || {}),
    launchedPid: agent.runnerPid,
  });
  agent.lastSyncAt = nowIso();
  if (status?.scopeDenials) {
    agent.scopeDenials = status.scopeDenials;
  }
  if (status?.result) {
    agent.result = status.result;
  }

  if (lifecycle.phase === 'blocked') {
    agent.status = blockedStatusFor(lifecycle.blockReason);
    agent.blockedSource = 'session';
    agent.error = lifecycle.detail;
  } else if (lifecycle.phase === 'failed') {
    agent.status = 'failed';
    agent.error = lifecycle.detail;
  } else if (lifecycle.phase === 'lost') {
    agent.status = 'session_missing';
    agent.error = lifecycle.detail;
  } else if (lifecycle.phase === 'done') {
    agent.status = 'done';
    agent.finishedAt = agent.finishedAt || nowIso();
    await auditAgentInState(state, agent.taskId, options);
  }
}

async function syncRun(projectRoot, runId, options = {}) {
  const state = await loadState(projectRoot, runId);

  try {
    for (const agent of Object.values(state.agents)) {
      if (ACTIVE_AGENT_STATUSES.has(agent.status) && agent.agentDir) {
        await syncAgentFromRunner(state, agent, options);
      }
    }
    await syncReworkArchitect(state, options.agentStatusOptions || {});
    state.lastSyncError = null;
  } catch (error) {
    state.lastSyncError = error.message;
  }

  await saveState(state);
  return toClientRun(state);
}

async function applyPatch(projectRoot, runId, taskId, options = {}) {
  const runner = options.runner || runCommand;
  const state = await loadState(projectRoot, runId);
  const task = getTask(state, taskId);
  const agent = state.agents[taskId];
  if (!agent) {
    throw new Error(`Agent not found: ${taskId}`);
  }

  if (agent.status !== 'patch_ready') {
    throw new Error('Patch can only be applied from patch_ready status.');
  }

  const patchText = agent.patchPath ? await fs.readFile(agent.patchPath, 'utf8') : '';
  if (patchText.trim()) {
    await ensureStateOnRunBranch(state, runner);
    try {
      await runner('git', ['merge-base', '--is-ancestor', state.baseCommit, 'HEAD'], { cwd: projectRoot });
    } catch {
      throw new Error('Patch safety check failed: run baseCommit is no longer an ancestor of HEAD.');
    }

    const dirtyAllowedFiles = await getGitPorcelain(projectRoot, agent.allowedFiles, { runner });
    if (dirtyAllowedFiles.length) {
      throw new Error(
        `Patch safety check failed: target files have uncommitted changes: ${dirtyAllowedFiles.join(', ')}`,
      );
    }

    agent.appliedCommit = await applyAndCommitPatch(
      projectRoot,
      agent.patchPath,
      `multiagent(${runId}): apply ${taskId}\n\n${task.feature} by ${task.owner}.`,
      runner,
    );
  }

  agent.status = 'patch_applied';
  agent.appliedAt = nowIso();
  await saveState(state);

  if (task.role === 'sub' && options.autoStartModuleReview === true) {
    const advancement = await advanceModuleReviewIfReady(projectRoot, runId, options);
    return advancement.run;
  }

  return toClientRun(await loadState(projectRoot, runId));
}

async function ensureStateOnRunBranch(state, runner) {
  state.runBranch = state.runBranch || getRunBranchName(state.runId);
  const result = await ensureRunBranch(state.projectRoot, state.runBranch, runner);
  if (result.created) {
    state.runBranchCreatedFrom = result.previousBranch;
  }
}

/**
 * Commit uncommitted project changes (typically the Main Architect's scaffold,
 * docs and prompts) on the run branch so agent worktrees include them.
 */
async function commitRunWorkingTree(projectRoot, runId, options = {}) {
  const runner = options.runner || runCommand;
  const state = await loadState(projectRoot, runId);
  await ensureStateOnRunBranch(state, runner);
  const result = await commitWorkingTree(
    projectRoot,
    options.message || `multiagent(${runId}): commit planning output`,
    runner,
  );
  state.preflight = null;
  await saveState(state);
  return { run: toClientRun(state), ...result };
}

async function rejectPatch(projectRoot, runId, taskId) {
  const state = await loadState(projectRoot, runId);
  const agent = state.agents[taskId];
  if (!agent) {
    throw new Error(`Agent not found: ${taskId}`);
  }
  agent.status = 'rejected';
  await saveState(state);
  return toClientRun(state);
}

async function cleanAcceptedWorktrees(projectRoot, runId, options = {}) {
  const runner = options.runner || runCommand;
  const state = await loadState(projectRoot, runId);
  const cleaned = [];

  for (const agent of Object.values(state.agents)) {
    if (agent.status !== 'patch_applied' || !agent.worktreePath) {
      continue;
    }

    try {
      await runner('git', ['worktree', 'remove', '--force', agent.worktreePath], {
        cwd: projectRoot,
        timeoutMs: 120000,
      });
      // Its work is already committed on the run branch.
      await runner('git', ['branch', '-D', agent.branch], { cwd: projectRoot });
      cleaned.push(agent.taskId);
    } catch (error) {
      agent.error = `Clean failed: ${error.message}`;
    }
  }

  await saveState(state);
  return { run: toClientRun(state), cleaned };
}

async function readTextMaybe(filePath, maxBytes = 250000) {
  if (!filePath || !(await fileExists(filePath))) {
    return '';
  }
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, 0);
      return `${buffer.toString('utf8')}\n\n[truncated at ${maxBytes} bytes]`;
    } finally {
      await handle.close();
    }
  }
  return fs.readFile(filePath, 'utf8');
}

async function readAgentArtifacts(projectRoot, runId, taskId, options = {}) {
  const runner = options.runner || runCommand;
  const state = await loadState(projectRoot, runId);
  const task = getTask(state, taskId);
  const agent = state.agents[taskId];

  let diff = '';
  if (agent?.worktreePath && (await fileExists(agent.worktreePath))) {
    try {
      const result = await runner(
        'git',
        ['diff', '--binary', agent.auditBaseCommit || state.baseCommit, '--', ...agent.allowedFiles],
        { cwd: agent.worktreePath, maxBuffer: 30 * 1024 * 1024 },
      );
      diff = result.stdout;
    } catch (error) {
      diff = error.message;
    }
  }

  return {
    prompt: await readTextMaybe(path.join(projectRoot, task.promptFile)),
    moduleReport: await readTextMaybe(
      task.moduleReport ? path.join(agent.worktreePath, task.moduleReport) : '',
    ),
    reviewReport: await readTextMaybe(
      task.reviewReport ? path.join(agent.worktreePath, task.reviewReport) : '',
    ),
    integrationReport: await readTextMaybe(
      task.integrationReport ? path.join(agent.worktreePath, task.integrationReport) : '',
    ),
    integrationContext: await readTextMaybe(
      task.integrationContext ? path.join(agent.worktreePath, task.integrationContext) : '',
    ),
    systemReviewReport: await readTextMaybe(
      task.systemReviewReport ? path.join(agent.worktreePath, task.systemReviewReport) : '',
    ),
    interfaceRequest: await readTextMaybe(
      task.interfaceRequest ? path.join(agent.worktreePath, task.interfaceRequest) : '',
    ),
    patch: await readTextMaybe(agent.patchPath),
    diff,
  };
}

function toClientRun(state) {
  const agents = Object.values(state.agents || {});
  return {
    runId: state.runId,
    projectRoot: state.projectRoot,
    manifestPath: state.manifestPath,
    baseCommit: state.baseCommit,
    runBranch: state.runBranch || null,
    manifest: state.manifest,
    agents,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastSyncError: state.lastSyncError,
    preflight: state.preflight || null,
    recovery: state.recovery || null,
    workflow: state.workflow || null,
    reworkOf: state.reworkOf || null,
    counts: agents.reduce(
      (acc, agent) => {
        acc.total += 1;
        acc[agent.status] = (acc[agent.status] || 0) + 1;
        return acc;
      },
      { total: 0 },
    ),
  };
}

module.exports = {
  STATE_VERSION,
  VALID_STATUSES,
  applyPatch,
  auditTask,
  advanceModuleReviewIfReady,
  advanceWorkflow,
  buildAgentPrompt,
  cleanAcceptedWorktrees,
  commitRunWorkingTree,
  getModuleReviewReadiness,
  getAgentDir,
  getPatchPath,
  getStatePath,
  getTaskManifestPath,
  getWorktreePath,
  importManifest,
  initializeRun,
  loadDefaultManifest,
  loadLatestRun,
  loadManifestFromFile,
  loadRun,
  loadState,
  normalizeRelPath,
  preflightRun,
  RESUMABLE_STATUSES,
  readAgentArtifacts,
  recoverRun,
  rejectPatch,
  runCommand,
  saveState,
  startAllReady,
  startTask,
  syncRun,
  validateManifest,
  waiveWorkflowGate,
};
