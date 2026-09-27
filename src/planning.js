const fs = require('node:fs/promises');
const path = require('node:path');

const { classifyAgentStatus, launchAgentProcess, newSessionId, readAgentStatus } = require('./agentProcess');
const { runCommand } = require('./multiAgent');
const { DEFAULT_PROVIDER_ID, buildProviderEnvAsync, getProviderProfile } = require('./providerProfiles');

const PLANNING_STATE_VERSION = 1;
const DEFAULT_MAX_SPEC_DOC_BYTES = 240000;

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

function defaultRunId() {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')}`;
}

function normalizeProjectRoot(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('projectRoot is required.');
  }
  return path.resolve(projectRoot);
}

function getPlanningDir(projectRoot, runId) {
  return path.join(normalizeProjectRoot(projectRoot), '.multiagent', 'planning', safeSegment(runId, 'runId'));
}

function getPlanningStatePath(projectRoot, runId) {
  return path.join(getPlanningDir(projectRoot, runId), 'state.json');
}

function getArchitectPromptPath(projectRoot, runId) {
  return path.join(getPlanningDir(projectRoot, runId), 'architect_prompt.md');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextWithLimit(filePath, maxBytes = DEFAULT_MAX_SPEC_DOC_BYTES) {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error('Spec document path must point to a file.');
  }

  if (stat.size <= maxBytes) {
    return {
      path: resolved,
      text: await fs.readFile(resolved, 'utf8'),
      truncated: false,
      size: stat.size,
    };
  }

  const handle = await fs.open(resolved, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    await handle.read(buffer, 0, maxBytes, 0);
    return {
      path: resolved,
      text: `${buffer.toString('utf8')}\n\n[Spec document truncated at ${maxBytes} bytes. Ask the user to split the document or continue from the original path if more detail is required.]`,
      truncated: true,
      size: stat.size,
    };
  } finally {
    await handle.close();
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function ensureGitProject(projectRoot, options = {}) {
  const status = await getGitProjectStatus(projectRoot, options);
  if (!status.isGit) {
    throw new Error(
      'Selected project is not a git repository. Click Initialize Git Baseline or run git init, git add -A, and git commit before starting agents.',
    );
  }
  if (!status.hasHead) {
    throw new Error(
      'Selected project has no git commit yet. Click Initialize Git Baseline or create an initial commit before starting agents.',
    );
  }
}

async function getHeadCommit(projectRoot, options = {}) {
  const runner = options.runner || runCommand;
  const result = await runner('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
  return result.stdout.trim();
}

async function getGitProjectStatus(projectRoot, options = {}) {
  const root = normalizeProjectRoot(projectRoot);
  const runner = options.runner || runCommand;

  try {
    const inside = await runner('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
    if (inside.stdout.trim() !== 'true') {
      return {
        projectRoot: root,
        isGit: false,
        hasHead: false,
        canStart: false,
        headCommit: null,
        reason: 'Selected project is not a git repository.',
      };
    }
  } catch {
    return {
      projectRoot: root,
      isGit: false,
      hasHead: false,
      canStart: false,
      headCommit: null,
      reason: 'Selected project is not a git repository.',
    };
  }

  try {
    const head = await runner('git', ['rev-parse', 'HEAD'], { cwd: root });
    return {
      projectRoot: root,
      isGit: true,
      hasHead: true,
      canStart: true,
      headCommit: head.stdout.trim(),
      reason: null,
    };
  } catch {
    return {
      projectRoot: root,
      isGit: true,
      hasHead: false,
      canStart: false,
      headCommit: null,
      reason: 'Git repository has no commits yet.',
    };
  }
}

async function initializeGitBaseline(projectRoot, options = {}) {
  const root = normalizeProjectRoot(projectRoot);
  const runner = options.runner || runCommand;
  let status = await getGitProjectStatus(root, { runner });

  if (!status.isGit) {
    await runner('git', ['init'], { cwd: root, timeoutMs: 120000 });
  }

  status = await getGitProjectStatus(root, { runner });
  if (status.hasHead) {
    return status;
  }

  await runner('git', ['add', '-A'], { cwd: root, timeoutMs: 120000 });
  await runner('git', ['commit', '--allow-empty', '-m', 'Initial project baseline'], {
    cwd: root,
    timeoutMs: 120000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'MultiAgent Manager',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'multiagent@example.local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'MultiAgent Manager',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'multiagent@example.local',
    },
  });

  return getGitProjectStatus(root, { runner });
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function buildArchitectPrompt({
  projectRoot,
  specDocPath,
  specDocText,
  designDocPath,
  designDocText,
  runId,
  architectName = 'main-architect',
  architectModel = 'opus',
  architectProvider = DEFAULT_PROVIDER_ID,
  architectEffort = 'medium',
  moduleModel = 'sonnet',
  moduleProvider = DEFAULT_PROVIDER_ID,
  moduleEffort = 'medium',
  reviewModel = 'opus',
  reviewProvider = DEFAULT_PROVIDER_ID,
  reviewEffort = 'medium',
  integrationModel = 'opus',
  integrationProvider = DEFAULT_PROVIDER_ID,
  integrationEffort = 'medium',
  systemReviewModel = 'opus',
  systemReviewProvider = DEFAULT_PROVIDER_ID,
  systemReviewEffort = 'medium',
}) {
  const sourceDocPath = specDocPath || designDocPath;
  const sourceDocText = specDocText || designDocText || '';
  return `# MultiAgent Planning Prompt

You are the persistent Main Architect Agent for this project.

Project root:
${projectRoot}

AI implementation spec path:
${sourceDocPath}

Run id:
${runId}

Your job is to turn the user's finished AI implementation spec into a complete, executable MultiAgent dispatch package for the local manager app.

The user has already discussed the game design in ChatGPT, Claude Chat, or another design session. Do not spend context converting a rough design brief into a spec. Treat the input below as the source-of-truth implementation spec.

## Hard Boundaries

- Do not start Claude background agents yourself.
- Do not run module implementation work yourself.
- Do not perform module review, integration, or system review yourself.
- Do not scan or summarize the whole project source tree as your normal workflow. You are a dispatcher and contract author, not a global code-reading implementation agent.
- Only read project source files when creating a specific scaffold, resolving a specific interface request, or inspecting a narrowly identified file mentioned by a report.
- In later rework rounds, base your decisions on manifest files, reports, interface requests, patch summaries, and explicit contracts instead of loading the full project context.
- You may create or update planning documents, prompt files, task manifest files, scaffold source files, scaffold test files, reports/request directories, and minimal public API stubs needed for later agents.
- You must not implement real module logic beyond scaffold stubs and TODO markers.
- Do not rewrite the design, expand vague product ideas, or invent missing game rules as if you were still in a design chat.
- If the spec is too ambiguous to create a safe manifest, write questions to work/requests/planning_questions.md and stop before creating a misleading manifest.
- Keep every module task to one owned source script.
- Never assign the same owned_script to more than one module task.
- If a future feature needs a new script, represent it as a new module task with its own owned_script.
- Before creating scaffold source scripts, design and create a clear source folder hierarchy.
- Place modules that interact frequently in the same feature folder or neighboring subfolders, while keeping each script single-responsibility.
- Do not scatter tightly coupled gameplay modules across unrelated folders.
- Glue/integration work must be handled by an integration agent after module patches are accepted.
- Review must be handled by separate module_review and system_review agents.
- Review agents must not fix code directly. Their reports must be actionable dispatch inputs for the Main Architect, who decides whether to reassign work, create new tasks, change contracts, defer issues, or ask the user.

## Files You Should Produce

Create or update these files when the spec is sufficiently clear:

- docs/game_design.md as a normalized copy/implementation index of the supplied spec, not a new design pass
- docs/architecture_principles.md, if missing
- docs/model_routing.md, if missing
- docs/architecture.md
- docs/module_layout.md describing source folders, module clusters, high-frequency interactions, owned scripts, and integration seams
- docs/module_contracts.md
- tasks/task_manifest.yaml
- work/prompts/<task_id>.md for every module/review/integration agent
- work/modules/<task_id>/module_report.md scaffold placeholders, if useful
- work/integration/${runId}_integration_context.md containing only module responsibilities, public APIs, signals/events, data contracts, execution order, and integration notes.
- work/requests/.gitkeep or request placeholders, if useful
- scaffolded owned source scripts for module tasks
- matching test file scaffolds for module tasks
- source folders for every planned module before writing scaffold files
- diagnostics configuration in tasks/task_manifest.yaml for terminal-based compile checks

## Manifest Requirements

Write tasks/task_manifest.yaml with this shape:

Replace every placeholder with a concrete project-relative value. In particular, allowed_files must repeat the actual owned_script, test_file, module_report, and interface_request paths. Do not write the literal words "owned_script", "test_file", "module_report", or "interface_request" as allowed file entries.

\`\`\`yaml
version: 1
project:
  name: string
  root: ${toPosixPath(projectRoot)}
run:
  id: ${runId}
  goal: string
  base: head
main_agent:
  name: ${architectName}
  session_name: ${architectName}
  role: main
  provider: ${architectProvider}
  model: ${architectModel}
  effort: ${architectEffort}
defaults:
  sub_agent_provider: ${moduleProvider}
  sub_agent_model: ${moduleModel}
  sub_agent_effort: ${moduleEffort}
  review_agent_provider: ${reviewProvider}
  review_agent_model: ${reviewModel}
  review_agent_effort: ${reviewEffort}
  integration_agent_provider: ${integrationProvider}
  integration_agent_model: ${integrationModel}
  integration_agent_effort: ${integrationEffort}
  system_review_agent_provider: ${systemReviewProvider}
  system_review_agent_model: ${systemReviewModel}
  system_review_agent_effort: ${systemReviewEffort}
  max_parallel_agents: 5
  effort: ${moduleEffort}
  permission_mode: acceptEdits
  worktree_base: head
diagnostics:
  compile_command: null
  log_files: []
  include_unity_editor_log: false
  timeout_ms: 300000
tasks:
  - id: string
    feature: string
    owner: string
    role: sub
    provider: ${moduleProvider}
    model: ${moduleModel}
    effort: ${moduleEffort}
    owned_script: path/relative/to/project
    test_file: path/relative/to/project
    prompt_file: work/prompts/<task_id>.md
    module_report: work/modules/<task_id>/module_report.md
    interface_request: work/modules/<task_id>/interface_change_request.md
    allowed_files:
      - owned_script
      - test_file
      - module_report
      - interface_request
    depends_on: []
    acceptance:
      - clear acceptance criterion
module_review:
  id: module-review
  feature: Module Review
  owner: module-review-agent
  role: module_review
  provider: ${reviewProvider}
  model: ${reviewModel}
  effort: ${reviewEffort}
  prompt_file: work/prompts/module_review.md
  review_report: reports/reviews/${runId}/module_review.md
  interface_request: work/requests/${runId}_module_review_request.md
  allowed_files:
    - reports/reviews/${runId}/module_review.md
    - work/requests/${runId}_module_review_request.md
  depends_on:
    - every module task id
integration:
  id: integration
  feature: Integration Glue
  owner: integration-agent
  role: integration
  provider: ${integrationProvider}
  model: ${integrationModel}
  effort: ${integrationEffort}
  prompt_file: work/prompts/integration.md
  integration_context: work/integration/${runId}_integration_context.md
  integration_report: work/integration/${runId}_integration_report.md
  interface_request: work/requests/${runId}_integration_request.md
  allowed_files:
    - explicit glue/composition files only
    - work/integration/${runId}_integration_context.md
    - work/integration/${runId}_integration_report.md
    - work/requests/${runId}_integration_request.md
  depends_on:
    - module-review
system_review:
  id: system-review
  feature: System Review
  owner: system-review-agent
  role: system_review
  provider: ${systemReviewProvider}
  model: ${systemReviewModel}
  effort: ${systemReviewEffort}
  prompt_file: work/prompts/system_review.md
  system_review_report: reports/reviews/${runId}/system_review.md
  interface_request: work/requests/${runId}_system_review_request.md
  allowed_files:
    - reports/reviews/${runId}/system_review.md
    - work/requests/${runId}_system_review_request.md
  depends_on:
    - integration
\`\`\`

## Prompt File Requirements

For diagnostics:

- Prefer a safe terminal compile command in diagnostics.compile_command using an argv-style YAML list.
- If the compile command is obvious, set it explicitly; otherwise leave diagnostics.compile_command as null and the manager will auto-detect from project files.
- The manager runs diagnostics.compile_command in the project root and captures stdout/stderr directly.
- Auto-detection should match the project's primary language/tooling: package.json build/typecheck/test for JavaScript or TypeScript, dotnet build for .sln/.csproj C#, cargo check for Rust, go test ./... for Go, python -m compileall . for Python, or npx tsc --noEmit for tsconfig-only TypeScript projects.
- Do not depend on the game editor or engine UI for compile diagnostics when a terminal command is available.
- Use diagnostics.log_files or include_unity_editor_log only as an explicit fallback when no terminal compile command exists.
- For Unity projects, prefer a terminal/batchmode compile or test command when the project supports it; include_unity_editor_log is fallback-only.
- The manager writes reports/diagnostics/${runId}_latest.md and .multiagent/runs/${runId}/diagnostics/latest.json. Main Architect must read these reports before assigning compile-fix rework.
- Compile diagnostics should be captured after applying module/integration patches and before module_review, integration, system_review, or rework decisions.

For every module prompt:

- Include the exact owned script path.
- Include the source folder that contains the owned script and state that this is the agent's local source working area.
- Include the exact test file path.
- Include the relevant module contract.
- Include acceptance criteria.
- State that the implementation agent may read source files in its owned script folder when needed, but must not browse unrelated source folders by default.
- State that the implementation agent may only modify files listed in allowed_files.
- State that the implementation agent must not edit any other source script.
- State that if it needs another file, it must write the interface_request instead.

For module_review:

- Review whether each module agent completed its assigned feature.
- Check if each patch stayed inside allowed files.
- Check whether each module report is credible.
- For every defect, identify the exact task_id, agent owner, owned_script, violated contract or acceptance criterion, evidence file(s), and whether the issue should be sent back to the same agent, split into a new task, escalated to a contract change, or left for Main Architect decision.
- The module review report must be grouped by module task and must be directly usable by the Main Architect as a refactor/redo dispatch plan.
- Include a YAML block named rework_items with fields: issue_id, severity, task_id, agent_owner, owned_script, problem, expected_behavior, actual_behavior, evidence, recommended_action, blocks_integration.
- Do not edit source scripts.

For integration:

- Work only after module patches are accepted.
- Write only explicit glue/composition files in allowed_files.
- Do not edit module-owned scripts.
- Do not read module implementation source files by default.
- Use only docs/game_design.md, docs/architecture.md, docs/module_contracts.md, tasks/task_manifest.yaml, module reports, interface requests, integration_context, and assigned glue/composition files.
- Use docs/module_layout.md and integration_context to understand which module folders are adjacent and where glue/composition should live.
- Integrate modules through public APIs, signals, events, and data contracts only.
- If a required API/signal/event is missing or unclear, write the integration interface_request instead of inspecting or editing module internals.
- integration_context must summarize each module with: module_id, owned_script, responsibility, public_api, signals, data_inputs, data_outputs, events_consumed, events_emitted, execution_order, integration_notes, forbidden_dependencies.
- integration.allowed_files must not include module owned_script implementation files.

For system_review:

- Review the integrated project against docs/game_design.md.
- Read by default only docs/game_design.md, docs/architecture.md, docs/module_contracts.md, tasks/task_manifest.yaml, module reports, interface requests, integration_context, integration report, prior review reports, patch summaries/diffs, supplied test output, and supplied runtime logs.
- Do not read implementation source files by default.
- If source inspection is required, write a source_inspection_request inside work/requests/${runId}_system_review_request.md with: exact file path, reason, expected risk, and exact question to answer. Do not inspect that source file in the same task.
- Check execution order, data/code separation, simulation/presentation separation, hidden coupling, testing, save/data risk, and glue-code bloat.
- For every defect, identify related task ids, related agents, related files, the likely responsible owner (module agent, integration agent, new agent, main agent, or user decision), and whether it blocks release.
- The system review report must be directly usable by the Main Architect as an integration/global refactor dispatch plan.
- Include a YAML block named rework_items with fields: issue_id, severity, scope, related_task_ids, related_agents, related_files, problem, expected_behavior, actual_behavior, recommended_owner, recommended_action, blocks_release.
- system_review.allowed_files must contain only reports/reviews/${runId}/system_review.md and work/requests/${runId}_system_review_request.md unless the user explicitly approves a narrower follow-up inspection task.
- Do not edit source scripts.

For Main Architect re-dispatch:

- The manager parses every review report's rework_items block. Blocking items stop the pipeline and the manager starts a separate rework round with its own prompt naming the exact manifest path and run id to write. Do not create rework manifests during this planning task.
- Rework manifests must keep the same ownership rule: one agent owns one source script, one source script has one owner.
- If review identifies a missing script, create a new task and scaffold for that script rather than allowing an existing agent to edit outside its owned_script.

## Architecture Rules

- Reusable independent modules.
- Small explicit glue code.
- Design source folder hierarchy before scaffolding scripts.
- Put frequently interacting modules in the same feature folder or neighboring folders.
- Folder boundaries should make integration seams obvious.
- No giant universal GameManager.
- Separate gameplay data from code.
- Design data structures before systems.
- Critical gameplay logic needs an explicit execution order.
- Separate simulation from presentation.
- One script, one responsibility.
- One agent, one source script.
- One source script, one owner.

## AI Implementation Spec

\`\`\`text
${sourceDocText}
\`\`\`
`;
}

function toClientState(state) {
  return {
    version: state.version,
    runId: state.runId,
    projectRoot: state.projectRoot,
    specDocPath: state.specDocPath || state.designDocPath,
    designDocPath: state.specDocPath || state.designDocPath,
    architectName: state.architectName,
    model: state.model,
    permissionMode: state.permissionMode,
    effort: state.effort,
    claudeSessionId: state.claudeSessionId,
    logPath: state.logPath || null,
    promptPath: state.promptPath,
    baseCommit: state.baseCommit,
    status: state.status,
    error: state.error,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
}

// Runner phases map onto planning statuses; a vanished runner counts as failed.
const PLANNING_STATUS_FOR_PHASE = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  blocked: 'blocked',
  lost: 'failed',
};

async function syncArchitectStatus(state, statusOptions = {}) {
  if (!state?.agentDir || !['starting', 'running'].includes(state.status)) {
    return state;
  }

  const { phase, detail } = classifyAgentStatus(await readAgentStatus(state.agentDir), {
    ...statusOptions,
    launchedPid: state.runnerPid,
  });
  const nextStatus = PLANNING_STATUS_FOR_PHASE[phase];
  if (nextStatus && (nextStatus !== state.status || detail !== state.error)) {
    state.status = nextStatus;
    state.error = detail;
    state.updatedAt = nowIso();
  }
  return state;
}

async function startArchitectFromDesignDoc(options = {}) {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const specDoc = await readTextWithLimit(
    options.specDocPath || options.designDocPath,
    options.maxSpecDocBytes || options.maxDesignDocBytes,
  );
  const runId = safeSegment(options.runId || defaultRunId(), 'runId');
  const architectName = String(options.architectName || 'main-architect');
  const model = String(options.model || 'opus');
  const permissionMode = String(options.permissionMode || 'acceptEdits');
  const effort = String(options.effort || 'medium');
  const runner = options.runner || runCommand;

  let baseCommit = null;
  try {
    await ensureGitProject(projectRoot, { runner });
    baseCommit = await getHeadCommit(projectRoot, { runner });
  } catch (error) {
    return toClientState({
      version: PLANNING_STATE_VERSION,
      runId,
      projectRoot,
      specDocPath: specDoc.path,
      designDocPath: specDoc.path,
      architectName,
      model,
      permissionMode,
      effort,
      claudeSessionId: null,
      promptPath: null,
      baseCommit: null,
      status: 'failed',
      error: error.message,
      startedAt: null,
      updatedAt: nowIso(),
    });
  }

  const promptPath = getArchitectPromptPath(projectRoot, runId);
  const prompt = buildArchitectPrompt({
    projectRoot,
    specDocPath: specDoc.path,
    specDocText: specDoc.text,
    runId,
    architectName,
    architectModel: model,
    architectProvider: options.providerProfileId || options.provider || DEFAULT_PROVIDER_ID,
    architectEffort: effort,
    moduleProvider: options.moduleProvider || DEFAULT_PROVIDER_ID,
    moduleModel: options.moduleModel || 'sonnet',
    moduleEffort: options.moduleEffort || 'medium',
    reviewProvider: options.reviewProvider || DEFAULT_PROVIDER_ID,
    reviewModel: options.reviewModel || 'opus',
    reviewEffort: options.reviewEffort || 'medium',
    integrationProvider: options.integrationProvider || DEFAULT_PROVIDER_ID,
    integrationModel: options.integrationModel || 'opus',
    integrationEffort: options.integrationEffort || 'medium',
    systemReviewProvider: options.systemReviewProvider || DEFAULT_PROVIDER_ID,
    systemReviewModel: options.systemReviewModel || 'opus',
    systemReviewEffort: options.systemReviewEffort || 'medium',
  });

  await fs.mkdir(path.dirname(promptPath), { recursive: true });
  await fs.writeFile(promptPath, prompt, 'utf8');

  const state = {
    version: PLANNING_STATE_VERSION,
    type: 'architect_planning',
    runId,
    projectRoot,
    specDocPath: specDoc.path,
    designDocPath: specDoc.path,
    specDocTruncated: specDoc.truncated,
    designDocTruncated: specDoc.truncated,
    specDocSize: specDoc.size,
    designDocSize: specDoc.size,
    architectName,
    providerProfileId: options.providerProfileId || options.provider || DEFAULT_PROVIDER_ID,
    model,
    permissionMode,
    effort,
    baseCommit,
    promptPath,
    claudeSessionId: null,
    status: 'starting',
    error: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  await writeJson(getPlanningStatePath(projectRoot, runId), state);

  try {
    const relativePromptPath = toPosixPath(path.relative(projectRoot, promptPath));
    const providerProfile = await getProviderProfile(
      options.providerProfileId || options.provider || DEFAULT_PROVIDER_ID,
      options.providerProfileOptions || {},
    );
    const sessionId = newSessionId();
    const agentDir = path.join(getPlanningDir(projectRoot, runId), 'agent');
    const launch = await (options.launchAgent || launchAgentProcess)({
      dir: agentDir,
      env: await buildProviderEnvAsync(
        providerProfile,
        options.env || process.env,
        options.providerProfileOptions || {},
      ),
      spec: {
        name: architectName,
        sessionId,
        resume: false,
        cwd: projectRoot,
        prompt: `Read and execute the MultiAgent planning prompt at ${relativePromptPath}.`,
        model,
        effort,
        permissionMode,
        allowedPaths: null,
      },
    });
    state.claudeSessionId = sessionId;
    state.agentDir = agentDir;
    state.logPath = launch.logPath;
    state.runnerPid = launch.pid;
    state.status = 'running';
    state.error = null;
  } catch (error) {
    state.status = 'failed';
    state.error = `${error.message}${error.stderr ? `\n${error.stderr}` : ''}`;
  }

  state.updatedAt = nowIso();
  await writeJson(getPlanningStatePath(projectRoot, runId), state);
  return toClientState(state);
}

async function startArchitectFromSpecDoc(options = {}) {
  return startArchitectFromDesignDoc(options);
}

async function loadPlanningState(projectRoot, runId, statusOptions = {}) {
  const statePath = getPlanningStatePath(projectRoot, runId);
  if (!(await fileExists(statePath))) {
    throw new Error(`Planning state not found: ${runId}`);
  }
  const state = await syncArchitectStatus(JSON.parse(await fs.readFile(statePath, 'utf8')), statusOptions);
  await writeJson(statePath, state);
  return toClientState(state);
}

async function loadLatestPlanningState(projectRoot) {
  const planningRoot = path.join(normalizeProjectRoot(projectRoot), '.multiagent', 'planning');
  if (!(await fileExists(planningRoot))) {
    return null;
  }

  const entries = await fs.readdir(planningRoot, { withFileTypes: true });
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const statePath = path.join(planningRoot, entry.name, 'state.json');
    if (!(await fileExists(statePath))) {
      continue;
    }
    const stat = await fs.stat(statePath);
    states.push({ statePath, mtimeMs: stat.mtimeMs });
  }
  states.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!states.length) {
    return null;
  }
  const state = await syncArchitectStatus(JSON.parse(await fs.readFile(states[0].statePath, 'utf8')));
  await writeJson(states[0].statePath, state);
  return toClientState(state);
}

module.exports = {
  PLANNING_STATE_VERSION,
  buildArchitectPrompt,
  getArchitectPromptPath,
  getGitProjectStatus,
  getPlanningStatePath,
  initializeGitBaseline,
  loadLatestPlanningState,
  loadPlanningState,
  readTextWithLimit,
  startArchitectFromDesignDoc,
  startArchitectFromSpecDoc,
};
