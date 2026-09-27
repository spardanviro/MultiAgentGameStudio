// Review gates and the Main Architect rework round.
//
// After a module_review / system_review patch is applied, its report is parsed
// for the `rework_items` YAML block. Blocking items close the gate, which stops
// dependent agents until the Main Architect dispatches a rework manifest (or
// the user waives the gate). This module has no dependency on multiAgent.js so
// it can be used from inside the run state machine.
const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');
const { classifyAgentStatus, readAgentStatus } = require('./agentProcess');

const REVIEW_ROLES = new Set(['module_review', 'system_review']);
const BLOCKING_SEVERITIES = new Set(['critical', 'blocker']);
const TRUE_VALUES = new Set(['true', 'yes', 'y', '1']);
const FENCED_BLOCK_PATTERN = /```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;
const REWORK_LABEL_LOOKBEHIND_CHARS = 300;
const ACTIVE_REWORK_STATUSES = new Set(['starting', 'running', 'blocked']);
// While a rework round is in one of these states the current run is on hold:
// the architect is working, or its output is waiting for the user.
const HOLDING_REWORK_STATUSES = new Set([
  ...ACTIVE_REWORK_STATUSES,
  'manifest_ready',
  'needs_user_decision',
  'imported',
]);
const DIAGNOSTICS_GATE_PREFIX = 'diagnostics:';
const DIAGNOSTICS_STAGES = ['afterModules', 'afterIntegration'];

function nowIso() {
  return new Date().toISOString();
}

function isTruthy(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

function reportPathForTask(task) {
  if (task.role === 'module_review') {
    return task.reviewReport || null;
  }
  if (task.role === 'system_review') {
    return task.systemReviewReport || null;
  }
  return null;
}

/**
 * Find the `rework_items` list in a review report. Accepts a fenced YAML block
 * whose top-level key is `rework_items`, or a bare YAML list block that is
 * labelled `rework_items` just before the fence.
 * @param {string} markdown
 * @returns {{found: boolean, items: object[], error: string|null}}
 */
function extractReworkItems(markdown) {
  const text = String(markdown || '');
  let parseError = null;

  for (const match of text.matchAll(FENCED_BLOCK_PATTERN)) {
    const [, language, body] = match;
    if (language && !/^ya?ml$/i.test(language)) {
      continue;
    }
    const label = text.slice(Math.max(0, match.index - REWORK_LABEL_LOOKBEHIND_CHARS), match.index);
    const mentionsKey = /rework_items/i.test(body);
    if (!mentionsKey && !/rework_items/i.test(label)) {
      continue;
    }

    let parsed;
    try {
      parsed = yaml.load(body);
    } catch (error) {
      parseError = `rework_items YAML is invalid: ${error.message}`;
      continue;
    }

    const items = Array.isArray(parsed) ? parsed : parsed?.rework_items;
    if (items === null || items === undefined) {
      return { found: true, items: [], error: null };
    }
    if (!Array.isArray(items)) {
      parseError = 'rework_items must be a YAML list.';
      continue;
    }
    return { found: true, items: items.filter((item) => item && typeof item === 'object'), error: null };
  }

  return { found: false, items: [], error: parseError };
}

/**
 * An item blocks the pipeline when the reviewer flagged it as blocking the
 * next stage, or rated it critical/blocker.
 */
function isBlockingReworkItem(item) {
  if (isTruthy(item?.blocks_integration) || isTruthy(item?.blocks_release)) {
    return true;
  }
  return BLOCKING_SEVERITIES.has(String(item?.severity || '').trim().toLowerCase());
}

/**
 * @param {string|null} reportText null when the report file does not exist
 * @returns {{outcome: 'passed'|'rework_required'|'report_missing'|'unparsed', items: object[],
 *   blockingItems: object[], error: string|null}}
 */
function evaluateReviewReport(reportText) {
  if (reportText === null || !String(reportText).trim()) {
    return { outcome: 'report_missing', items: [], blockingItems: [], error: 'Review report is missing or empty.' };
  }
  const extracted = extractReworkItems(reportText);
  if (!extracted.found) {
    return {
      outcome: 'unparsed',
      items: [],
      blockingItems: [],
      error: extracted.error || 'Review report has no rework_items YAML block.',
    };
  }
  const blockingItems = extracted.items.filter(isBlockingReworkItem);
  return {
    outcome: blockingItems.length ? 'rework_required' : 'passed',
    items: extracted.items,
    blockingItems,
    error: null,
  };
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isGateOpen(gate) {
  return Boolean(gate && (gate.outcome === 'passed' || gate.waived));
}

/**
 * (Re)evaluate the gate of every applied review agent whose gate is missing or
 * older than its patch. Mutates state.workflow.reviewGates; caller saves.
 * @returns {Promise<boolean>} whether any gate changed
 */
async function refreshReviewGates(state) {
  state.workflow = state.workflow || {};
  const gates = state.workflow.reviewGates || {};
  let changed = false;

  for (const task of state.manifest.tasks.filter((entry) => REVIEW_ROLES.has(entry.role))) {
    const agent = state.agents[task.id];
    if (agent?.status !== 'patch_applied') {
      continue;
    }
    const existing = gates[task.id];
    const appliedAtMs = agent.appliedAt ? Date.parse(agent.appliedAt) : 0;
    if (existing && Date.parse(existing.evaluatedAt) >= appliedAtMs) {
      continue;
    }

    const reportPath = reportPathForTask(task);
    const reportText = reportPath ? await readTextIfExists(path.join(state.projectRoot, reportPath)) : null;
    gates[task.id] = {
      taskId: task.id,
      role: task.role,
      reportPath,
      ...evaluateReviewReport(reportText),
      evaluatedAt: nowIso(),
      waived: false,
      waivedAt: null,
      waiveNote: null,
    };
    changed = true;
  }

  state.workflow.reviewGates = gates;
  return changed;
}

function getFailingReviewGates(state) {
  return Object.values(state.workflow?.reviewGates || {}).filter((gate) => !isGateOpen(gate));
}

function isReviewGateOpenForTask(state, taskId) {
  const task = state.manifest.tasks.find((entry) => entry.id === taskId);
  if (!task || !REVIEW_ROLES.has(task.role)) {
    return true;
  }
  return isGateOpen(state.workflow?.reviewGates?.[taskId]);
}

/**
 * Waive a review gate (by review task id) or a diagnostics stage
 * (`diagnostics:afterModules` / `diagnostics:afterIntegration`). Mutates state.
 */
function waiveGate(state, gateId, note = '') {
  state.workflow = state.workflow || {};
  if (gateId.startsWith(DIAGNOSTICS_GATE_PREFIX)) {
    const stage = gateId.slice(DIAGNOSTICS_GATE_PREFIX.length);
    if (!DIAGNOSTICS_STAGES.includes(stage)) {
      throw new Error(`Unknown diagnostics stage: ${stage}`);
    }
    const diagnosticsState = state.workflow.diagnostics || {};
    if (diagnosticsState[stage] !== 'failed') {
      throw new Error(`Diagnostics stage ${stage} has not failed; nothing to waive.`);
    }
    diagnosticsState[stage] = 'waived';
    diagnosticsState[`${stage}WaiveNote`] = note || null;
    state.workflow.diagnostics = diagnosticsState;
    return;
  }

  const gates = state.workflow.reviewGates || {};
  const gate = Object.hasOwn(gates, gateId) ? gates[gateId] : null;
  if (!gate) {
    throw new Error(`Review gate not found: ${gateId}`);
  }
  gate.waived = true;
  gate.waivedAt = nowIso();
  gate.waiveNote = note || null;
}

function getFailedDiagnosticsStages(state) {
  const diagnosticsState = state.workflow?.diagnostics || {};
  return DIAGNOSTICS_STAGES
    .filter((stage) => diagnosticsState[stage] === 'failed')
    .map((stage) => ({
      stage,
      reportPath: diagnosticsState[`${stage}ReportPath`] || null,
      counts: diagnosticsState[`${stage}Counts`] || null,
    }));
}

function isReworkActive(state) {
  return ACTIVE_REWORK_STATUSES.has(state.workflow?.rework?.status);
}

function isReworkHoldingRun(state) {
  return HOLDING_REWORK_STATUSES.has(state.workflow?.rework?.status);
}

/**
 * Update the rework architect's status from its runner status file.
 * When the session finishes, the outcome depends on which files it produced.
 * Mutates state; caller saves.
 */
async function syncReworkArchitect(state, statusOptions = {}) {
  const rework = state.workflow?.rework;
  if (!rework?.agentDir || !isReworkActive(state)) {
    return;
  }
  const lifecycle = classifyAgentStatus(await readAgentStatus(rework.agentDir), {
    ...statusOptions,
    launchedPid: rework.runnerPid,
  });
  rework.lastSyncAt = nowIso();

  if (lifecycle.phase === 'blocked' || lifecycle.phase === 'failed' || lifecycle.phase === 'lost') {
    rework.status = lifecycle.phase === 'blocked' ? 'blocked' : 'failed';
    rework.error = lifecycle.detail;
  } else if (lifecycle.phase === 'running') {
    rework.status = 'running';
    rework.error = null;
  } else if (lifecycle.phase === 'done') {
    rework.finishedAt = nowIso();
    rework.error = null;
    if (await fileExists(path.join(state.projectRoot, rework.manifestPath))) {
      rework.status = 'manifest_ready';
    } else if (await fileExists(path.join(state.projectRoot, rework.userQuestionsPath))) {
      rework.status = 'needs_user_decision';
    } else {
      rework.status = 'finished_without_manifest';
    }
  }
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function formatTrigger(trigger) {
  if (trigger.type === 'diagnostics') {
    const counts = trigger.counts ? ` (${trigger.counts.error} errors, ${trigger.counts.warning} warnings)` : '';
    return `### Diagnostics failed: ${trigger.stage}${counts}

Report: ${toPosix(trigger.reportPath) || '(missing)'}
Read this report and turn every compile error into a fix task for the owning module or the integration layer.`;
  }

  const items = trigger.blockingItems.length
    ? `Blocking rework_items reported by the reviewer:

\`\`\`yaml
${yaml.dump({ rework_items: trigger.blockingItems }, { lineWidth: 120 }).trim()}
\`\`\``
    : `The review gate is closed because: ${trigger.error}`;
  return `### ${trigger.role} gate: ${trigger.outcome} (task ${trigger.taskId})

Report: ${trigger.reportPath || '(no report path)'}
All rework_items in report: ${trigger.itemCount}; blocking: ${trigger.blockingItems.length}.

${items}`;
}

/**
 * Prompt for the Main Architect's rework round. Paths are project-relative.
 */
function buildReworkPrompt({
  projectRoot,
  runId,
  round,
  nextRunId,
  previousManifestPath,
  manifestPath,
  decisionsPath,
  userQuestionsPath,
  triggers,
  interfaceRequests,
}) {
  const requestList = interfaceRequests.length
    ? interfaceRequests.map((file) => `- ${file}`).join('\n')
    : '- (none written)';

  return `# MultiAgent Rework Prompt

You are the persistent Main Architect Agent for this project, running rework round ${round}.

Project root:
${toPosix(projectRoot)}

Current run id: ${runId}
Current manifest: ${previousManifestPath}
Next run id: ${nextRunId}

## Why This Round Exists

The manager stopped the pipeline because the checks below failed. Their blocking items are already extracted for you.

${triggers.map(formatTrigger).join('\n\n')}

## Inputs

Read these by default, and nothing else unless an item names a specific file:

- ${previousManifestPath}
- the review and diagnostics reports listed above
- interface/change requests written by agents in this run:
${requestList}
- docs/architecture.md, docs/module_layout.md, docs/module_contracts.md, and the integration context of the current run

## Decide Every Blocking Item

For every blocking item choose exactly one action and record it in ${decisionsPath}:

- reassign_to_same_agent: rework task for the same owner and owned_folder
- create_new_task: a new module task for a new module folder (scaffold it first)
- contract_change: update docs/module_contracts.md, then rework every affected module
- defer: not fixed in this round; state why it is safe to proceed
- ask_user: the spec does not settle it

The decisions file must list: issue_id, source report, decision, target task id (if any), and a one-line rationale.

## Output

If any item needs ask_user, write the questions to ${userQuestionsPath} and stop without writing a manifest.

If every item is deferred, write only the decisions file explaining why, and stop without writing a manifest.

Otherwise write ${manifestPath} with the same schema as ${previousManifestPath}:

- run.id must be exactly ${nextRunId}.
- Copy project, main_agent, defaults, and diagnostics from the current manifest unless a decision requires a change.
- Include only the module tasks needed for this round. reassign_to_same_agent tasks keep the original owner and owned_folder.
- Write a rework prompt for every task at work/prompts/${nextRunId}/<task_id>.md that quotes the exact rework items (problem, expected_behavior, actual_behavior, evidence) the task must resolve.
- Always include module_review, depending on every rework module task. Include integration if glue code or contracts are affected, and system_review whenever integration runs or a system_review item triggered this round.
- Review and integration report paths must live under reports/reviews/${nextRunId}/ and work/integration/${nextRunId}_*.

## Hard Boundaries

- Do not start Claude background agents yourself.
- Do not implement module logic, fix code, review, or integrate yourself.
- Do not modify tasks/task_manifest.yaml, the current manifest, or the reports of the current run.
- Do not scan or summarize the whole project source tree.
- One agent owns one module folder; one module folder has one owner.
`;
}

module.exports = {
  DIAGNOSTICS_GATE_PREFIX,
  REVIEW_ROLES,
  buildReworkPrompt,
  evaluateReviewReport,
  extractReworkItems,
  getFailedDiagnosticsStages,
  getFailingReviewGates,
  isBlockingReworkItem,
  isReviewGateOpenForTask,
  isReworkActive,
  isReworkHoldingRun,
  refreshReviewGates,
  reportPathForTask,
  syncReworkArchitect,
  waiveGate,
};
