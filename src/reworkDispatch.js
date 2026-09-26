// Closes the loop from review/diagnostics failures back to the Main Architect:
// dispatch a rework round, then import the rework manifest it writes as a new
// run linked to the current one.
const fs = require('node:fs/promises');
const path = require('node:path');
const { launchBackgroundAgent } = require('./claudeAgents');
const { buildProviderEnvAsync, getProviderProfile } = require('./providerProfiles');
const multiAgent = require('./multiAgent');
const {
  buildReworkPrompt,
  getFailedDiagnosticsStages,
  getFailingReviewGates,
  isReworkActive,
  refreshReviewGates,
} = require('./reworkGate');

const NON_RESTARTABLE_REWORK_STATUSES = new Set(['manifest_ready', 'needs_user_decision', 'imported']);

const AUTO_DISPATCH_STOP_REASONS = new Set(['rework_required', 'diagnostics_failed']);

function nowIso() {
  return new Date().toISOString();
}

function toPosixRelative(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function isSameProjectRoot(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function isNonEmptyFile(filePath) {
  try {
    return (await fs.stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

function getReworkLineage(state) {
  const rootRunId = state.reworkOf?.rootRunId || state.runId;
  const round = (state.reworkOf?.round || 0) + 1;
  const nextRunId = `${rootRunId}-rework-${round}`;
  return {
    rootRunId,
    round,
    nextRunId,
    manifestPath: `tasks/task_manifest.${nextRunId}.yaml`,
    decisionsPath: `reports/rework/${nextRunId}_decisions.md`,
    userQuestionsPath: `work/requests/${nextRunId}_user_decisions.md`,
  };
}

async function collectReworkTriggers(state) {
  const triggers = [
    ...getFailingReviewGates(state).map((gate) => ({
      type: 'review_gate',
      taskId: gate.taskId,
      role: gate.role,
      outcome: gate.outcome,
      reportPath: gate.reportPath,
      itemCount: gate.items.length,
      blockingItems: gate.blockingItems,
      error: gate.error,
    })),
    ...getFailedDiagnosticsStages(state).map((stage) => ({
      type: 'diagnostics',
      ...stage,
      reportPath: stage.reportPath ? toPosixRelative(state.projectRoot, stage.reportPath) : null,
    })),
  ];

  const interfaceRequests = [];
  for (const task of state.manifest.tasks) {
    if (task.interfaceRequest && (await isNonEmptyFile(path.join(state.projectRoot, task.interfaceRequest)))) {
      interfaceRequests.push(task.interfaceRequest);
    }
  }
  return { triggers, interfaceRequests };
}

/**
 * Start a Main Architect background session that turns the current failures
 * into a rework manifest for the next run.
 */
async function startArchitectRework(projectRoot, runId, options = {}) {
  const runner = options.runner || multiAgent.runCommand;
  const state = await multiAgent.loadState(projectRoot, runId);
  const previous = state.workflow?.rework;
  if (previous && (isReworkActive(state) || NON_RESTARTABLE_REWORK_STATUSES.has(previous.status))) {
    throw new Error(`Rework round ${previous.round} is already ${previous.status}.`);
  }

  await refreshReviewGates(state);
  const { triggers, interfaceRequests } = await collectReworkTriggers(state);
  if (!triggers.length) {
    throw new Error('Nothing to rework: no closed review gate and no failed diagnostics in this run.');
  }

  const lineage = getReworkLineage(state);
  const mainAgent = state.manifest.mainAgent;
  const promptPath = path.join(projectRoot, '.multiagent', 'runs', runId, 'rework', `${lineage.nextRunId}_prompt.md`);
  const prompt = buildReworkPrompt({
    projectRoot,
    runId,
    round: lineage.round,
    nextRunId: lineage.nextRunId,
    previousManifestPath: toPosixRelative(projectRoot, state.manifestPath),
    manifestPath: lineage.manifestPath,
    decisionsPath: lineage.decisionsPath,
    userQuestionsPath: lineage.userQuestionsPath,
    triggers,
    interfaceRequests,
  });
  await fs.mkdir(path.dirname(promptPath), { recursive: true });
  await fs.writeFile(promptPath, prompt, 'utf8');

  state.workflow = state.workflow || {};
  state.workflow.rework = {
    ...lineage,
    status: 'starting',
    promptPath,
    claudeSessionId: null,
    triggers: triggers.map(({ type, taskId, stage, outcome, reportPath }) => ({ type, taskId, stage, outcome, reportPath })),
    startedAt: nowIso(),
    finishedAt: null,
    error: null,
  };
  await multiAgent.saveState(state);

  const rework = state.workflow.rework;
  try {
    const providerProfile = await getProviderProfile(mainAgent.provider, options.providerProfileOptions || {});
    const launch = await launchBackgroundAgent({
      runner,
      name: mainAgent.name,
      cwd: projectRoot,
      args: [
        '--bg',
        '--name',
        mainAgent.name,
        '--model',
        mainAgent.model,
        '--permission-mode',
        state.manifest.defaults.permissionMode,
        '--effort',
        mainAgent.effort,
        `Read and execute the MultiAgent rework prompt at ${toPosixRelative(projectRoot, promptPath)}.`,
      ],
      env: await buildProviderEnvAsync(providerProfile, options.env || process.env, options.providerProfileOptions || {}),
    });
    rework.claudeSessionId = launch.sessionId;
    rework.status = launch.sessionId ? 'running' : 'failed';
    rework.error = launch.sessionId ? null : `Rework architect started, but its session id could not be resolved (${launch.lookupError}).`;
  } catch (error) {
    rework.status = 'failed';
    rework.error = `${error.message}${error.stderr ? `\n${error.stderr}` : ''}`;
  }

  await multiAgent.saveState(state);
  return multiAgent.loadRun(projectRoot, runId);
}

/**
 * Import the rework manifest written by the architect as a new run and link
 * both runs. Returns the new run.
 */
async function importReworkManifest(projectRoot, runId, options = {}) {
  const state = await multiAgent.loadState(projectRoot, runId);
  const rework = state.workflow?.rework;
  if (!rework) {
    throw new Error('This run has no rework round to import.');
  }
  const manifestPath = path.join(projectRoot, rework.manifestPath);
  const manifest = await multiAgent.loadManifestFromFile(manifestPath);
  if (manifest.run.id === runId) {
    throw new Error(`Rework manifest reuses the current run id ${runId}; it must use ${rework.nextRunId}.`);
  }
  if (!isSameProjectRoot(manifest.project.root, projectRoot)) {
    throw new Error(`Rework manifest project.root ${manifest.project.root} does not match this project ${projectRoot}.`);
  }

  const nextRun = await multiAgent.importManifest(manifestPath, options);
  const nextState = await multiAgent.loadState(projectRoot, nextRun.runId);
  nextState.reworkOf = {
    parentRunId: runId,
    rootRunId: rework.rootRunId,
    round: rework.round,
    decisionsPath: rework.decisionsPath,
  };
  await multiAgent.saveState(nextState);

  rework.status = 'imported';
  rework.importedRunId = nextRun.runId;
  rework.importedAt = nowIso();
  await multiAgent.saveState(state);

  return multiAgent.loadRun(projectRoot, nextRun.runId);
}

function describeReworkProgress(rework) {
  if (rework.status === 'manifest_ready') {
    return {
      stopReason: 'rework_manifest_ready',
      reason: `Rework manifest is ready: ${rework.manifestPath}. Review it, then import it as run ${rework.nextRunId}.`,
    };
  }
  if (rework.status === 'needs_user_decision') {
    return {
      stopReason: 'rework_needs_user',
      reason: `The Main Architect needs your decision: ${rework.userQuestionsPath}`,
    };
  }
  if (rework.status === 'finished_without_manifest') {
    return {
      stopReason: 'rework_no_manifest',
      reason: `The Main Architect finished without a rework manifest; see ${rework.decisionsPath} and waive the gate if appropriate.`,
    };
  }
  if (rework.status === 'imported') {
    return {
      stopReason: 'rework_imported',
      reason: `This run is superseded by rework run ${rework.importedRunId}.`,
    };
  }
  if (rework.status === 'blocked' || rework.status === 'failed') {
    return { stopReason: 'rework_blocked', reason: `Rework architect ${rework.status}: ${rework.error || '-'}` };
  }
  return { stopReason: 'rework_in_progress', reason: `Rework round ${rework.round} is ${rework.status}.` };
}

/**
 * advanceWorkflow plus the rework loop: report rework progress while a round
 * is open, and optionally dispatch the Main Architect automatically.
 */
async function advanceWorkflowWithRework(projectRoot, runId, options = {}) {
  const result = await multiAgent.advanceWorkflow(projectRoot, runId, options);
  const rework = result.run.workflow?.rework;
  if (result.stopReason === 'rework_open') {
    return { ...result, ...describeReworkProgress(rework) };
  }
  // Auto-dispatch at most once per run; a failed or empty round needs the user.
  if (!AUTO_DISPATCH_STOP_REASONS.has(result.stopReason) || !options.autoDispatchRework || rework) {
    return result;
  }

  const run = await startArchitectRework(projectRoot, runId, options);
  const dispatched = run.workflow.rework;
  return {
    ...result,
    advanced: dispatched.status === 'running',
    reason: dispatched.status === 'running'
      ? `Dispatched rework round ${dispatched.round} to the Main Architect.`
      : `Rework dispatch failed: ${dispatched.error}`,
    stopReason: dispatched.status === 'running' ? 'rework_dispatched' : 'rework_blocked',
    gateStopReason: result.stopReason,
    events: [...result.events, { type: 'rework_dispatched', round: dispatched.round, nextRunId: dispatched.nextRunId }],
    run,
  };
}

module.exports = {
  advanceWorkflowWithRework,
  collectReworkTriggers,
  getReworkLineage,
  importReworkManifest,
  startArchitectRework,
};
