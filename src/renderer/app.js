const state = {
  project: null,
  gitStatus: null,
  run: null,
  designDocPath: null,
  planning: null,
  selectedNodeId: 'main',
  artifacts: null,
  artifactsFor: null,
  logs: null,
  diagnostics: null,
  modelOptions: null,
  providerProfiles: [],
  providerPresets: [],
  busy: false,
  watching: false,
  watchTimer: null,
  autoAdvance: false,
  autoApplyPatches: false,
  autoDispatchRework: false,
  autoAdvanceTimer: null,
  terminalId: null,
};

const api = window.claudeManager;

const elements = {
  chooseProjectButton: document.querySelector('#chooseProjectButton'),
  initializeGitButton: document.querySelector('#initializeGitButton'),
  refreshLogsButton: document.querySelector('#refreshLogsButton'),
  openLogsButton: document.querySelector('#openLogsButton'),
  chooseDesignDocButton: document.querySelector('#chooseDesignDocButton'),
  refreshModelOptionsButton: document.querySelector('#refreshModelOptionsButton'),
  startArchitectButton: document.querySelector('#startArchitectButton'),
  attachArchitectButton: document.querySelector('#attachArchitectButton'),
  logsArchitectButton: document.querySelector('#logsArchitectButton'),
  importManifestButton: document.querySelector('#importManifestButton'),
  loadManifestButton: document.querySelector('#loadManifestButton'),
  watchManifestButton: document.querySelector('#watchManifestButton'),
  startAllButton: document.querySelector('#startAllButton'),
  startModuleReviewButton: document.querySelector('#startModuleReviewButton'),
  syncButton: document.querySelector('#syncButton'),
  diagnosticsButton: document.querySelector('#diagnosticsButton'),
  advanceWorkflowButton: document.querySelector('#advanceWorkflowButton'),
  autoAdvanceButton: document.querySelector('#autoAdvanceButton'),
  autoApplyButton: document.querySelector('#autoApplyButton'),
  autoDispatchReworkButton: document.querySelector('#autoDispatchReworkButton'),
  cleanButton: document.querySelector('#cleanButton'),
  projectName: document.querySelector('#projectName'),
  projectPath: document.querySelector('#projectPath'),
  gitStatusText: document.querySelector('#gitStatusText'),
  designDocPath: document.querySelector('#designDocPath'),
  architectRunIdInput: document.querySelector('#architectRunIdInput'),
  architectProviderInput: document.querySelector('#architectProviderInput'),
  architectModelInput: document.querySelector('#architectModelInput'),
  architectEffortInput: document.querySelector('#architectEffortInput'),
  moduleProviderInput: document.querySelector('#moduleProviderInput'),
  moduleModelInput: document.querySelector('#moduleModelInput'),
  moduleEffortInput: document.querySelector('#moduleEffortInput'),
  reviewProviderInput: document.querySelector('#reviewProviderInput'),
  reviewModelInput: document.querySelector('#reviewModelInput'),
  reviewEffortInput: document.querySelector('#reviewEffortInput'),
  integrationProviderInput: document.querySelector('#integrationProviderInput'),
  integrationModelInput: document.querySelector('#integrationModelInput'),
  integrationEffortInput: document.querySelector('#integrationEffortInput'),
  systemReviewProviderInput: document.querySelector('#systemReviewProviderInput'),
  systemReviewModelInput: document.querySelector('#systemReviewModelInput'),
  systemReviewEffortInput: document.querySelector('#systemReviewEffortInput'),
  architectNameInput: document.querySelector('#architectNameInput'),
  providerIdInput: document.querySelector('#providerIdInput'),
  providerPresetInput: document.querySelector('#providerPresetInput'),
  providerLabelInput: document.querySelector('#providerLabelInput'),
  providerBaseUrlInput: document.querySelector('#providerBaseUrlInput'),
  providerApiKeyEnvInput: document.querySelector('#providerApiKeyEnvInput'),
  providerApiKeyInput: document.querySelector('#providerApiKeyInput'),
  providerModelsInput: document.querySelector('#providerModelsInput'),
  saveProviderProfileButton: document.querySelector('#saveProviderProfileButton'),
  refreshProviderModelsButton: document.querySelector('#refreshProviderModelsButton'),
  providerMeta: document.querySelector('#providerMeta'),
  planningMeta: document.querySelector('#planningMeta'),
  runName: document.querySelector('#runName'),
  runGoal: document.querySelector('#runGoal'),
  agentCount: document.querySelector('#agentCount'),
  runningCount: document.querySelector('#runningCount'),
  statusBadge: document.querySelector('#statusBadge'),
  workspaceTitle: document.querySelector('#workspaceTitle'),
  syncMeta: document.querySelector('#syncMeta'),
  manifestPath: document.querySelector('#manifestPath'),
  graphSurface: document.querySelector('#graphSurface'),
  graphSvg: document.querySelector('#graphSvg'),
  graphContent: document.querySelector('#graphContent'),
  inspectorTitle: document.querySelector('#inspectorTitle'),
  inspectorMeta: document.querySelector('#inspectorMeta'),
  inspectorBody: document.querySelector('#inspectorBody'),
  terminalDrawer: document.querySelector('#terminalDrawer'),
  terminalTitle: document.querySelector('#terminalTitle'),
  terminalOutput: document.querySelector('#terminalOutput'),
  terminalInput: document.querySelector('#terminalInput'),
  sendTerminalButton: document.querySelector('#sendTerminalButton'),
  stopTerminalButton: document.querySelector('#stopTerminalButton'),
  closeTerminalButton: document.querySelector('#closeTerminalButton'),
};

const statusLabels = {
  ready: 'Ready',
  queued: 'Queued',
  starting: 'Starting',
  running: 'Running',
  blocked_login: 'Login Blocked',
  blocked_rate_limit: 'Rate Limited',
  blocked_permission: 'Permission Blocked',
  blocked_dialog: 'Dialog Blocked',
  done: 'Done',
  auditing: 'Auditing',
  patch_ready: 'Patch Ready',
  patch_applied: 'Applied',
  failed: 'Failed',
  policy_violation: 'Policy Violation',
  review_failed: 'Review Failed',
  rejected: 'Rejected',
  session_missing: 'Session Missing',
  worktree_missing: 'Worktree Missing',
};

// Mirror RESUMABLE_STATUSES / STARTABLE_STATUSES in src/multiAgent.js.
const RESUMABLE_AGENT_STATUSES = new Set([
  'blocked_login',
  'blocked_rate_limit',
  'blocked_permission',
  'blocked_dialog',
  'session_missing',
]);
const STARTABLE_AGENT_STATUSES = new Set([
  'ready',
  'queued',
  'failed',
  'rejected',
  'worktree_missing',
  ...RESUMABLE_AGENT_STATUSES,
]);

// Auto advance keeps polling only while the workflow is progressing on its own.
const AUTO_ADVANCE_CONTINUE_REASONS = new Set([
  'agents_started',
  'waiting_for_agents',
  'rework_dispatched',
  'rework_in_progress',
]);

// Mirrors HOLDING_REWORK_STATUSES in src/reworkGate.js.
const REWORK_HOLDING_STATUSES = new Set([
  'starting',
  'running',
  'blocked',
  'manifest_ready',
  'needs_user_decision',
  'imported',
]);

const gateOutcomeLabels = {
  passed: 'Passed',
  rework_required: 'Rework Required',
  report_missing: 'Report Missing',
  unparsed: 'No rework_items Block',
};

const reworkStatusLabels = {
  starting: 'Starting',
  running: 'Architect Working',
  blocked: 'Architect Blocked',
  failed: 'Failed',
  manifest_ready: 'Manifest Ready',
  needs_user_decision: 'Needs Your Decision',
  finished_without_manifest: 'Finished Without Manifest',
  imported: 'Imported',
};

const roleLabels = {
  sub: 'Module Agent',
  module_review: 'Module Review',
  integration: 'Integration',
  system_review: 'System Review',
};

const modelSelects = [
  elements.architectModelInput,
  elements.moduleModelInput,
  elements.reviewModelInput,
  elements.integrationModelInput,
  elements.systemReviewModelInput,
];

const providerSelects = [
  elements.architectProviderInput,
  elements.moduleProviderInput,
  elements.reviewProviderInput,
  elements.integrationProviderInput,
  elements.systemReviewProviderInput,
];

const providerModelPairs = [
  {
    provider: elements.architectProviderInput,
    model: elements.architectModelInput,
    fallback: 'opus',
  },
  {
    provider: elements.moduleProviderInput,
    model: elements.moduleModelInput,
    fallback: 'sonnet',
  },
  {
    provider: elements.reviewProviderInput,
    model: elements.reviewModelInput,
    fallback: 'opus',
  },
  {
    provider: elements.integrationProviderInput,
    model: elements.integrationModelInput,
    fallback: 'opus',
  },
  {
    provider: elements.systemReviewProviderInput,
    model: elements.systemReviewModelInput,
    fallback: 'opus',
  },
];

const effortSelects = [
  elements.architectEffortInput,
  elements.moduleEffortInput,
  elements.reviewEffortInput,
  elements.integrationEffortInput,
  elements.systemReviewEffortInput,
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function shortHash(value) {
  return value ? String(value).slice(0, 10) : '-';
}

function projectNameFromPath(projectPath) {
  return String(projectPath || '').split(/[\\/]/).filter(Boolean).pop() || projectPath || 'Project';
}

function formatGitStatus(gitStatus) {
  if (!state.project) {
    return 'Choose a project to check git status.';
  }
  if (!gitStatus) {
    return 'Checking git status...';
  }
  if (gitStatus.canStart) {
    return `Git ready - HEAD ${shortHash(gitStatus.headCommit)}`;
  }
  return gitStatus.reason || 'Git baseline is required before starting agents.';
}

function setBusy(isBusy) {
  state.busy = isBusy;
  renderChrome();
}

function setStatus(text) {
  elements.statusBadge.textContent = text;
}

function logClientFailure(label, payload) {
  console.error(`[MultiAgent] ${label}`, payload);
}

function formatModelOptionLabel(option) {
  return option.label || option.id;
}

function formatEffortOptionLabel(option) {
  return option.label || option.id;
}

function replaceSelectOptions(select, options, formatter, fallbackValue) {
  const currentValue = select.value || fallbackValue;
  select.innerHTML = '';

  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.id;
    element.textContent = formatter(option);
    select.appendChild(element);
  }

  if (currentValue && !options.some((option) => option.id === currentValue)) {
    const customOption = document.createElement('option');
    customOption.value = currentValue;
    customOption.textContent = `${currentValue} current`;
    select.appendChild(customOption);
  }

  select.value = currentValue || fallbackValue;
}

function getProfile(profileId) {
  return state.providerProfiles.find((profile) => profile.id === profileId) || state.providerProfiles[0] || null;
}

function getProviderPreset(presetId) {
  return state.providerPresets.find((preset) => preset.id === presetId) || null;
}

function modelOptionsForProvider(profileId) {
  const profile = getProfile(profileId);
  if (profile?.type === 'anthropic_compatible_gateway' && profile.models?.length) {
    return profile.models.map((id) => ({ id, label: id, source: profile.id }));
  }
  return state.modelOptions?.models || [];
}

function populateProviderPresetSelect() {
  const select = elements.providerPresetInput;
  if (!select || !state.providerPresets.length) {
    return;
  }
  const currentValue = select.value || 'custom-compatible';
  select.innerHTML = '';
  for (const preset of state.providerPresets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label || preset.id;
    select.appendChild(option);
  }
  select.value = state.providerPresets.some((preset) => preset.id === currentValue)
    ? currentValue
    : 'custom-compatible';
}

function applyProviderPresetToForm() {
  const preset = getProviderPreset(elements.providerPresetInput?.value);
  if (!preset) {
    return;
  }
  if (preset.type === 'claude_code_default') {
    elements.providerIdInput.value = preset.id;
    elements.providerLabelInput.value = preset.label || preset.id;
    elements.providerBaseUrlInput.value = '';
    elements.providerApiKeyEnvInput.value = '';
    elements.providerModelsInput.value = (preset.models || []).join(', ');
    elements.providerApiKeyInput.value = '';
    elements.providerMeta.textContent = 'Claude subscription profile uses the existing Claude Code login; no API key is needed.';
    return;
  }
  elements.providerIdInput.value = preset.id;
  elements.providerLabelInput.value = preset.label || preset.id;
  elements.providerBaseUrlInput.value = preset.baseUrl || '';
  elements.providerApiKeyEnvInput.value = preset.apiKeyEnv || '';
  elements.providerModelsInput.value = (preset.models || []).join(', ');
  elements.providerApiKeyInput.value = '';
  elements.providerMeta.textContent =
    `${preset.label || preset.id}: endpoint/model defaults filled. Paste API key and save.`;
}

function populateProviderSelects() {
  if (!state.providerProfiles.length) {
    return;
  }

  for (const select of providerSelects) {
    const currentValue = select.value || 'claude-subscription';
    select.innerHTML = '';
    for (const profile of state.providerProfiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.label || profile.id;
      select.appendChild(option);
    }
    select.value = state.providerProfiles.some((profile) => profile.id === currentValue)
      ? currentValue
      : 'claude-subscription';
  }
}

function populateModelForPair(pair) {
  const options = modelOptionsForProvider(pair.provider.value);
  if (!options.length) {
    return;
  }
  replaceSelectOptions(pair.model, options, formatModelOptionLabel, pair.fallback);
}

function populateAllProviderModels() {
  for (const pair of providerModelPairs) {
    populateModelForPair(pair);
  }
}

function populateModelOptionSelects(options) {
  if (!options?.models?.length || !options?.efforts?.length) {
    return;
  }

  const modelFallbacks = ['opus', 'sonnet', 'opus', 'opus', 'opus'];
  const effortFallbacks = ['medium', 'medium', 'medium', 'medium', 'medium'];

  modelSelects.forEach((select, index) => {
    const pair = providerModelPairs[index];
    if (pair && getProfile(pair.provider.value)?.type === 'anthropic_compatible_gateway') {
      populateModelForPair(pair);
      return;
    }
    replaceSelectOptions(select, options.models, formatModelOptionLabel, modelFallbacks[index]);
  });
  effortSelects.forEach((select, index) => {
    replaceSelectOptions(select, options.efforts, formatEffortOptionLabel, effortFallbacks[index]);
  });
}

async function loadProviderProfiles() {
  try {
    if (!state.providerPresets.length) {
      state.providerPresets = await api.providerProfiles.getPresets();
      populateProviderPresetSelect();
      applyProviderPresetToForm();
    }
    const result = await api.providerProfiles.get();
    state.providerProfiles = result.profiles || [];
    populateProviderSelects();
    populateAllProviderModels();
    elements.providerMeta.textContent = `${state.providerProfiles.length} provider profile(s) loaded`;
  } catch (error) {
    elements.providerMeta.textContent = error.message;
  }
}

function parseProviderModelsInput() {
  return elements.providerModelsInput.value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function saveProviderProfile() {
  const presetId = elements.providerPresetInput?.value || 'custom-compatible';
  const preset = getProviderPreset(presetId);
  if (preset?.type === 'claude_code_default') {
    elements.providerMeta.textContent = 'Claude subscription is already available; no provider profile needs to be saved.';
    return;
  }
  const profile = {
    id: elements.providerIdInput.value.trim(),
    label: elements.providerLabelInput.value.trim(),
    type: 'anthropic_compatible_gateway',
    baseUrl: elements.providerBaseUrlInput.value.trim(),
    apiKeyEnv: elements.providerApiKeyEnvInput.value.trim(),
    apiKey: elements.providerApiKeyInput.value.trim(),
    models: parseProviderModelsInput(),
  };
  setBusy(true);
  try {
    const result =
      preset && preset.id !== 'custom-compatible' && preset.type !== 'claude_code_default'
        ? await api.providerProfiles.upsertPreset({
          presetId: preset.id,
          id: profile.id,
          label: profile.label,
          baseUrl: profile.baseUrl,
          apiKeyEnv: profile.apiKeyEnv,
          apiKey: profile.apiKey,
          models: profile.models,
        })
        : await api.providerProfiles.upsert(profile);
    state.providerProfiles = result.profiles || [];
    populateProviderSelects();
    populateAllProviderModels();
    elements.providerApiKeyInput.value = '';
    elements.providerMeta.textContent = `Saved provider profile: ${profile.id}`;
  } catch (error) {
    elements.providerMeta.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function refreshProviderModels() {
  const profileId = elements.providerIdInput.value.trim();
  if (!profileId) {
    elements.providerMeta.textContent = 'Enter a profile id first.';
    return;
  }
  setBusy(true);
  try {
    const result = await api.providerProfiles.refreshModels(profileId);
    state.providerProfiles = result.profiles || [];
    populateProviderSelects();
    populateAllProviderModels();
    const profile = getProfile(profileId);
    elements.providerModelsInput.value = (profile?.models || []).join(', ');
    elements.providerMeta.textContent = `Refreshed ${profile?.models?.length || 0} model(s) for ${profileId}`;
  } catch (error) {
    elements.providerMeta.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function loadModelOptions({ refresh = false } = {}) {
  elements.refreshModelOptionsButton.disabled = true;
  try {
    const options = refresh ? await api.modelOptions.refresh() : await api.modelOptions.get();
    state.modelOptions = options;
    populateModelOptionSelects(options);
    if (refresh) {
      setStatus(
        options.error
          ? `Model refresh failed, using cached list: ${options.error}`
          : `Model list refreshed: ${options.models.length} models, ${options.efforts.length} efforts`,
      );
    }
  } catch (error) {
    if (refresh) {
      setStatus(error.message);
    }
  } finally {
    elements.refreshModelOptionsButton.disabled = state.busy;
  }
}

function getAgents() {
  return state.run?.agents || [];
}

function getSelectedAgent() {
  if (!state.run || state.selectedNodeId === 'main') {
    return null;
  }
  return getAgents().find((agent) => agent.taskId === state.selectedNodeId) || null;
}

function canStartModuleReview() {
  const agents = getAgents();
  const moduleAgents = agents.filter((agent) => agent.role === 'sub');
  const reviewAgent = agents.find((agent) => agent.role === 'module_review');
  return Boolean(
    moduleAgents.length &&
      reviewAgent &&
      ['ready', 'queued'].includes(reviewAgent.status) &&
      moduleAgents.every((agent) => agent.status === 'patch_applied'),
  );
}

function setRun(run) {
  state.run = run;
  if (run?.manifest?.project) {
    state.project = {
      path: run.manifest.project.root,
      name: run.manifest.project.name,
    };
  }
  if (run && state.selectedNodeId !== 'main' && !getSelectedAgent()) {
    state.selectedNodeId = 'main';
  }
  render();
}

async function recoverRunForProject(projectRoot, preferredRunId = null) {
  let run = null;
  let recovery = null;

  if (preferredRunId) {
    try {
      const result = await api.multiAgent.recoverRun(projectRoot, preferredRunId);
      run = result.run;
      recovery = result.recovery;
    } catch {
      run = null;
    }
  }

  if (!run) {
    const latest = await api.multiAgent.loadLatestRun(projectRoot);
    if (latest?.runId) {
      const result = await api.multiAgent.recoverRun(projectRoot, latest.runId);
      run = result.run;
      recovery = result.recovery;
    }
  }

  if (run) {
    setRun(run);
  }
  return { run, recovery };
}

function recoveryStatusText(recovery) {
  if (!recovery) {
    return 'Run restored';
  }
  const issueCount = recovery.worktreeMissing.length + recovery.sessionMissing.length + recovery.errors.length;
  if (!issueCount) {
    return 'Run restored';
  }
  return `Run restored with ${issueCount} recovery issue(s)`;
}

function renderChrome() {
  const agents = getAgents();
  const runningCount = agents.filter((agent) => agent.status === 'running').length;
  const readyCount = agents.filter((agent) =>
    ['ready', 'failed', 'rejected', 'session_missing', 'worktree_missing'].includes(agent.status),
  ).length;
  const appliedCount = agents.filter((agent) => agent.status === 'patch_applied').length;
  const gitReady = Boolean(state.gitStatus?.canStart);

  elements.projectName.textContent = state.project?.name || 'No project';
  elements.projectPath.textContent = state.project?.path || '-';
  elements.gitStatusText.textContent = formatGitStatus(state.gitStatus);
  elements.designDocPath.textContent =
    state.designDocPath || state.planning?.specDocPath || state.planning?.designDocPath || 'No AI implementation spec selected';
  elements.runName.textContent = state.run?.runId || 'No manifest loaded';
  elements.runGoal.textContent = state.run?.manifest?.run?.goal || 'Import or watch tasks/task_manifest.yaml';
  elements.agentCount.textContent = String(agents.length);
  elements.runningCount.textContent = String(runningCount);
  elements.workspaceTitle.textContent = state.run
    ? `${state.run.manifest.project.name} / ${state.run.runId}`
    : 'Choose a project and import a manifest';
  elements.syncMeta.textContent = state.run
    ? `Base ${shortHash(state.run.baseCommit)} - Preflight ${
        state.run.preflight ? (state.run.preflight.ok ? 'OK' : 'Failed') : 'Not checked'
      } - Updated ${formatDateTime(state.run.updatedAt)}`
    : '-';
  elements.manifestPath.textContent = state.run?.manifestPath || 'No manifest';
  elements.planningMeta.textContent = state.planning
    ? `${state.planning.status} - session ${state.planning.claudeSessionId || '-'} - prompt ${state.planning.promptPath || '-'}`
    : 'Architect prompt will be saved under .multiagent/planning.';

  elements.loadManifestButton.disabled = state.busy || !state.project;
  elements.watchManifestButton.disabled = state.busy || !state.project;
  elements.chooseDesignDocButton.disabled = state.busy || !state.project;
  elements.refreshModelOptionsButton.disabled = state.busy;
  elements.initializeGitButton.disabled = state.busy || !state.project || gitReady;
  elements.refreshLogsButton.disabled = state.busy;
  elements.openLogsButton.disabled = state.busy;
  elements.saveProviderProfileButton.disabled = state.busy;
  elements.refreshProviderModelsButton.disabled = state.busy;
  elements.startArchitectButton.disabled = state.busy || !state.project || !state.designDocPath || !gitReady;
  elements.attachArchitectButton.disabled = state.busy || !state.planning?.claudeSessionId;
  elements.logsArchitectButton.disabled = state.busy || !state.planning?.claudeSessionId;
  elements.importManifestButton.disabled = state.busy;
  elements.chooseProjectButton.disabled = state.busy;
  elements.startAllButton.disabled = state.busy || !state.run || readyCount === 0;
  elements.startModuleReviewButton.disabled = state.busy || !state.run || !canStartModuleReview();
  elements.syncButton.disabled = state.busy || !state.run;
  elements.diagnosticsButton.disabled = state.busy || !state.run;
  elements.advanceWorkflowButton.disabled = state.busy || !state.run;
  elements.autoAdvanceButton.disabled = state.busy || !state.run;
  elements.autoApplyButton.disabled = state.busy || !state.run;
  elements.autoDispatchReworkButton.disabled = state.busy || !state.run;
  elements.autoDispatchReworkButton.textContent = state.autoDispatchRework
    ? 'Auto Dispatch Rework On'
    : 'Auto Dispatch Rework Off';
  elements.autoAdvanceButton.textContent = state.autoAdvance ? 'Auto Advance On' : 'Auto Advance Off';
  elements.autoApplyButton.textContent = state.autoApplyPatches
    ? 'Auto Apply Patches On'
    : 'Auto Apply Patches Off';
  elements.cleanButton.disabled = state.busy || !state.run || appliedCount === 0;
  elements.watchManifestButton.textContent = state.watching ? 'Stop Manifest Watch' : 'Start Manifest Watch';
}

function renderGraph() {
  if (!state.run) {
    if (state.planning) {
      elements.graphContent.innerHTML = `
        <div class="graph-column">
          <div class="graph-column-title">Main Architect</div>
          ${renderMainNode({
            name: state.planning.architectName,
            sessionName: state.planning.claudeSessionId,
            model: state.planning.model,
            status: state.planning.status,
            statusLabel: statusLabels[state.planning.status] || state.planning.status,
          })}
        </div>
        <div class="graph-column">
          <div class="graph-column-title">Generated Dispatch</div>
          <div class="empty-state">Waiting for tasks/task_manifest.yaml</div>
        </div>
      `;
      const mainNode = elements.graphContent.querySelector('[data-node-id]');
      if (mainNode) {
        mainNode.addEventListener('click', () => selectNode(mainNode.dataset.nodeId));
      }
      requestAnimationFrame(drawGraphConnections);
      return;
    }
    elements.graphContent.innerHTML = '<div class="empty-state">Import task_manifest.yaml to show the agent pipeline.</div>';
    elements.graphSvg.innerHTML = '';
    return;
  }

  const manifest = state.run.manifest;
  const moduleAgents = getAgents().filter((agent) => agent.role === 'sub');
  const moduleReviewAgents = getAgents().filter((agent) => agent.role === 'module_review');
  const integrationAgents = getAgents().filter((agent) => agent.role === 'integration');
  const systemReviewAgents = getAgents().filter((agent) => agent.role === 'system_review');
  const outcomeAgents = getAgents().filter((agent) =>
    ['patch_ready', 'patch_applied', 'policy_violation', 'rejected'].includes(agent.status),
  );

  elements.graphContent.innerHTML = `
    <div class="graph-column">
      <div class="graph-column-title">Main Agent</div>
      ${renderMainNode(manifest.mainAgent)}
    </div>
    <div class="graph-column">
      <div class="graph-column-title">Module Agents</div>
      <div class="sub-grid">${moduleAgents.map(renderAgentNode).join('')}</div>
    </div>
    <div class="graph-column">
      <div class="graph-column-title">Module Review</div>
      ${moduleReviewAgents.length ? moduleReviewAgents.map(renderAgentNode).join('') : '<div class="empty-state">No module reviewer</div>'}
    </div>
    <div class="graph-column">
      <div class="graph-column-title">Integration</div>
      ${integrationAgents.length ? integrationAgents.map(renderAgentNode).join('') : '<div class="empty-state">No integration agent</div>'}
    </div>
    <div class="graph-column">
      <div class="graph-column-title">System Review / Outcome</div>
      ${
        systemReviewAgents.length || outcomeAgents.length
          ? `${systemReviewAgents.map(renderAgentNode).join('')}${outcomeAgents.map(renderReviewNode).join('')}`
          : '<div class="empty-state">No system review or patch outcome</div>'
      }
    </div>
  `;

  for (const node of elements.graphContent.querySelectorAll('[data-node-id]')) {
    node.addEventListener('click', () => selectNode(node.dataset.nodeId));
  }
  requestAnimationFrame(drawGraphConnections);
}

function renderMainNode(mainAgent) {
  const selected = state.selectedNodeId === 'main' ? ' selected' : '';
  const sessionName = state.planning?.claudeSessionId || mainAgent.sessionName || 'not linked';
  const status = mainAgent.status || 'running';
  const statusLabel = mainAgent.statusLabel || 'Main';
  return `
    <button class="agent-node ${escapeHtml(status)}${selected}" type="button" data-node-id="main" id="mainNode">
      <div class="node-topline">
        <div class="node-title">${escapeHtml(mainAgent.name)}</div>
        <div class="node-status">${escapeHtml(statusLabel)}</div>
      </div>
      <div class="node-meta">session: ${escapeHtml(sessionName)}</div>
      <div class="node-meta">model: ${escapeHtml(mainAgent.model)}</div>
    </button>
  `;
}

function renderAgentNode(agent) {
  const selected = state.selectedNodeId === agent.taskId ? ' selected' : '';
  return `
    <button class="agent-node ${agent.status}${selected}" type="button" data-node-id="${escapeHtml(
      agent.taskId,
    )}" data-agent-id="${escapeHtml(agent.taskId)}" data-role="${escapeHtml(agent.role)}">
      <div class="node-topline">
        <div class="node-title">${escapeHtml(agent.displayName)}</div>
        <div class="node-status">${escapeHtml(statusLabels[agent.status] || agent.status)}</div>
      </div>
      <div class="node-meta">${escapeHtml(roleLabels[agent.role] || agent.role)}</div>
      <div class="node-meta">provider: ${escapeHtml(agent.providerProfileId || 'claude-subscription')}</div>
      <div class="node-meta">model: ${escapeHtml(agent.model)} / effort: ${escapeHtml(agent.effort || '-')}</div>
      <div class="node-meta">${escapeHtml(agent.ownedScript || agent.reviewReport || agent.integrationReport || agent.systemReviewReport || '-')}</div>
      <div class="node-meta">session: ${escapeHtml(agent.claudeSessionId || '-')}</div>
    </button>
  `;
}

function renderReviewNode(agent) {
  return `
    <button class="agent-node ${agent.status}" type="button" data-node-id="${escapeHtml(
      agent.taskId,
    )}" data-review-id="${escapeHtml(agent.taskId)}">
      <div class="node-topline">
        <div class="node-title">${escapeHtml(agent.displayName)}</div>
        <div class="node-status">${escapeHtml(statusLabels[agent.status] || agent.status)}</div>
      </div>
      <div class="node-meta">${escapeHtml(agent.patchPath || agent.error || 'waiting')}</div>
    </button>
  `;
}

function drawGraphConnections() {
  const surface = elements.graphSurface;
  const svg = elements.graphSvg;
  const mainNode = document.querySelector('#mainNode');
  const moduleNodes = [...document.querySelectorAll('[data-role="sub"]')];
  const moduleReviewNodes = [...document.querySelectorAll('[data-role="module_review"]')];
  const integrationNodes = [...document.querySelectorAll('[data-role="integration"]')];
  const systemReviewNodes = [...document.querySelectorAll('[data-role="system_review"]')];
  const reviewNodes = [...document.querySelectorAll('[data-review-id]')];

  svg.innerHTML = `
    <defs>
      <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L6,3 z" fill="#9b9387"></path>
      </marker>
    </defs>
  `;
  svg.setAttribute('width', surface.scrollWidth);
  svg.setAttribute('height', surface.scrollHeight);
  if (!mainNode) {
    return;
  }

  const surfaceRect = surface.getBoundingClientRect();
  const pointFor = (element, side) => {
    const rect = element.getBoundingClientRect();
    const x = side === 'right' ? rect.right : side === 'left' ? rect.left : rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return {
      x: x - surfaceRect.left + surface.scrollLeft,
      y: y - surfaceRect.top + surface.scrollTop,
    };
  };
  const addLine = (from, to) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const mid = Math.max(from.x + 28, (from.x + to.x) / 2);
    path.setAttribute('d', `M ${from.x} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x} ${to.y}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#9b9387');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('marker-end', 'url(#arrow)');
    svg.appendChild(path);
  };
  const connectMany = (fromNodes, toNodes) => {
    if (!fromNodes.length || !toNodes.length) return;
    for (const fromNode of fromNodes) {
      for (const toNode of toNodes) {
        addLine(pointFor(fromNode, 'right'), pointFor(toNode, 'left'));
      }
    }
  };

  connectMany([mainNode], moduleNodes);
  connectMany(moduleNodes.length ? moduleNodes : [mainNode], moduleReviewNodes);
  connectMany(moduleReviewNodes.length ? moduleReviewNodes : moduleNodes, integrationNodes);
  connectMany(integrationNodes.length ? integrationNodes : moduleReviewNodes, systemReviewNodes);

  for (const reviewNode of reviewNodes) {
    const agentNode = document.querySelector(`[data-agent-id="${reviewNode.dataset.reviewId}"]`);
    if (agentNode) {
      addLine(pointFor(agentNode, 'right'), pointFor(reviewNode, 'left'));
    }
  }
}

function renderInspector() {
  if (state.selectedNodeId === 'logs' && state.logs) {
    renderLogsInspector();
    return;
  }
  if (state.selectedNodeId === 'diagnostics' && state.diagnostics) {
    renderDiagnosticsInspector();
    return;
  }
  if (!state.run) {
    if (state.planning) {
      renderPlanningInspector();
      return;
    }
    if (state.logs) {
      renderLogsInspector();
      return;
    }
    elements.inspectorTitle.textContent = 'No run loaded';
    elements.inspectorMeta.textContent = 'Import a manifest to inspect nodes';
    elements.inspectorBody.innerHTML = '<div class="empty-state">No run to show</div>';
    return;
  }
  if (state.selectedNodeId === 'main') {
    renderMainInspector();
    return;
  }
  const agent = getSelectedAgent();
  if (!agent) {
    elements.inspectorTitle.textContent = 'No node selected';
    elements.inspectorMeta.textContent = 'Click an agent node';
    elements.inspectorBody.innerHTML = '<div class="empty-state">No node selected</div>';
    return;
  }

  elements.inspectorTitle.textContent = agent.displayName;
  elements.inspectorMeta.textContent = `${roleLabels[agent.role] || agent.role} - ${statusLabels[agent.status] || agent.status}`;
  elements.inspectorBody.innerHTML = `
    <section class="detail-section">
      <h4>Status</h4>
      <dl class="kv-list">
        <dt>Task</dt><dd>${escapeHtml(agent.taskId)}</dd>
        <dt>Owner</dt><dd>${escapeHtml(agent.owner)}</dd>
        <dt>Role</dt><dd>${escapeHtml(roleLabels[agent.role] || agent.role)}</dd>
        <dt>Model</dt><dd>${escapeHtml(agent.model)}</dd>
        <dt>Effort</dt><dd>${escapeHtml(agent.effort || '-')}</dd>
        <dt>Session</dt><dd>${escapeHtml(agent.claudeSessionId || '-')}</dd>
        <dt>Started</dt><dd>${formatDateTime(agent.startedAt)}</dd>
        <dt>Finished</dt><dd>${formatDateTime(agent.finishedAt)}</dd>
      </dl>
      <div class="button-row">${renderAgentButtons(agent)}</div>
    </section>
    <section class="detail-section">
      <h4>Allowed Files</h4>
      <ul class="file-list">${agent.allowedFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join('')}</ul>
    </section>
    <section class="detail-section">
      <h4>Changed Files</h4>
      ${
        agent.changedFiles?.length
          ? `<ul class="file-list">${agent.changedFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join('')}</ul>`
          : '<p class="muted-text">No changed files recorded.</p>'
      }
    </section>
    ${renderViolationSection(agent)}
    ${renderArtifactsSection(agent)}
  `;
  bindInspectorButtons(agent);
}

function renderLogsInspector() {
  elements.inspectorTitle.textContent = 'Manager Logs';
  elements.inspectorMeta.textContent = state.project
    ? 'App log and selected project log'
    : 'App log';
  elements.inspectorBody.innerHTML = `
    <section class="detail-section">
      <h4>Paths</h4>
      <dl class="kv-list">
        <dt>App Log</dt><dd>${escapeHtml(state.logs.appLogPath || '-')}</dd>
        <dt>Project Log</dt><dd>${escapeHtml(state.logs.projectLogPath || '-')}</dd>
      </dl>
      <div class="button-row">
        <button class="ghost-button compact" data-log-action="refresh">Refresh</button>
        <button class="ghost-button compact" data-log-action="open">Open Folder</button>
      </div>
    </section>
    <section class="detail-section">
      <h4>Project Log Tail</h4>
      <pre class="code-preview">${escapeHtml(state.logs.projectLog || 'No project log yet.')}</pre>
    </section>
    <section class="detail-section">
      <h4>App Log Tail</h4>
      <pre class="code-preview">${escapeHtml(state.logs.appLog || 'No app log yet.')}</pre>
    </section>
  `;
  for (const button of elements.inspectorBody.querySelectorAll('[data-log-action]')) {
    button.addEventListener('click', async () => {
      if (button.dataset.logAction === 'refresh') {
        await refreshLogs();
      } else {
        await openLogsFolder();
      }
    });
  }
}

function renderDiagnosticsInspector() {
  const diagnostics = state.diagnostics;
  elements.inspectorTitle.textContent = 'Compile Diagnostics';
  elements.inspectorMeta.textContent = `${diagnostics.counts?.error || 0} errors - ${
    diagnostics.counts?.warning || 0
  } warnings`;
  elements.inspectorBody.innerHTML = `
    <section class="detail-section">
      <h4>Report</h4>
      <dl class="kv-list">
        <dt>Markdown</dt><dd>${escapeHtml(diagnostics.reportPath || '-')}</dd>
        <dt>JSON</dt><dd>${escapeHtml(diagnostics.jsonPath || '-')}</dd>
        <dt>Command</dt><dd>${escapeHtml(
          diagnostics.compile
            ? `${diagnostics.compile.command} ${(diagnostics.compile.args || []).join(' ')}`
            : 'not configured',
        )}</dd>
        <dt>Language</dt><dd>${escapeHtml(diagnostics.compile?.detectedLanguage || 'explicit/unknown')}</dd>
        <dt>Reason</dt><dd>${escapeHtml(diagnostics.compile?.detectedReason || 'explicit configuration or not detected')}</dd>
        <dt>Exit</dt><dd>${escapeHtml(diagnostics.compile?.exitCode ?? 'n/a')}</dd>
      </dl>
    </section>
    <section class="detail-section">
      <h4>Errors / Warnings</h4>
      ${
        diagnostics.items?.length
          ? `<ul class="file-list">${diagnostics.items
              .map(
                (item) =>
                  `<li>[${escapeHtml(item.severity)}] ${escapeHtml(item.source)}:${escapeHtml(
                    item.line,
                  )} ${escapeHtml(item.message)}</li>`,
              )
              .join('')}</ul>`
          : '<p class="muted-text">No diagnostics captured.</p>'
      }
    </section>
    <section class="detail-section">
      <h4>Sources</h4>
      <ul class="file-list">${(diagnostics.sources || [])
        .map((source) => `<li>${escapeHtml(source.name)} - ${escapeHtml(source.path || 'command output')}</li>`)
        .join('')}</ul>
    </section>
  `;
}

function renderPlanningInspector() {
  const planning = state.planning;
  elements.inspectorTitle.textContent = planning.architectName;
  elements.inspectorMeta.textContent = `Main Architect - ${planning.status}`;
  elements.inspectorBody.innerHTML = `
    <section class="detail-section">
      <h4>Planning Session</h4>
      <dl class="kv-list">
        <dt>Run ID</dt><dd>${escapeHtml(planning.runId)}</dd>
        <dt>Status</dt><dd>${escapeHtml(planning.status)}</dd>
        <dt>Session</dt><dd>${escapeHtml(planning.claudeSessionId || '-')}</dd>
        <dt>Model</dt><dd>${escapeHtml(planning.model)}</dd>
        <dt>Base</dt><dd>${escapeHtml(shortHash(planning.baseCommit))}</dd>
        <dt>Started</dt><dd>${formatDateTime(planning.startedAt)}</dd>
      </dl>
      ${
        planning.claudeSessionId
          ? '<div class="button-row"><button class="ghost-button compact" data-main-action="attach">Continue</button><button class="ghost-button compact" data-main-action="logs">Logs</button></div>'
          : ''
      }
    </section>
    <section class="detail-section">
      <h4>Inputs</h4>
      <dl class="kv-list">
        <dt>Spec</dt><dd>${escapeHtml(planning.specDocPath || planning.designDocPath || '-')}</dd>
        <dt>Prompt</dt><dd>${escapeHtml(planning.promptPath || '-')}</dd>
      </dl>
    </section>
    ${
      planning.error
        ? `<section class="detail-section"><h4>Error</h4><pre class="code-preview">${escapeHtml(planning.error)}</pre></section>`
        : ''
    }
    <section class="detail-section">
      <h4>Next Step</h4>
      <p class="muted-text">The app is waiting for the architect to write tasks/task_manifest.yaml. Keep manifest watch on, then review the generated run before starting module agents.</p>
    </section>
  `;
  for (const button of elements.inspectorBody.querySelectorAll('[data-main-action]')) {
    button.addEventListener('click', () => startPlanningTerminal(button.dataset.mainAction));
  }
}

function renderMainInspector() {
  const main = state.run.manifest.mainAgent;
  elements.inspectorTitle.textContent = main.name;
  elements.inspectorMeta.textContent = 'Persistent root agent';
  elements.inspectorBody.innerHTML = `
    <section class="detail-section">
      <h4>Run</h4>
      <dl class="kv-list">
        <dt>Run ID</dt><dd>${escapeHtml(state.run.runId)}</dd>
        <dt>Goal</dt><dd>${escapeHtml(state.run.manifest.run.goal || '-')}</dd>
        <dt>Base</dt><dd>${escapeHtml(shortHash(state.run.baseCommit))}</dd>
        <dt>Manifest</dt><dd>${escapeHtml(state.run.manifestPath)}</dd>
      </dl>
    </section>
    <section class="detail-section">
      <h4>Main Agent</h4>
      <dl class="kv-list">
        <dt>Name</dt><dd>${escapeHtml(main.name)}</dd>
        <dt>Session</dt><dd>${escapeHtml(state.planning?.claudeSessionId || main.sessionName || '-')}</dd>
        <dt>Model</dt><dd>${escapeHtml(main.model)}</dd>
        <dt>Prompt</dt><dd>${escapeHtml(state.planning?.promptPath || '-')}</dd>
      </dl>
      ${
        state.planning?.claudeSessionId
          ? '<div class="button-row"><button class="ghost-button compact" data-main-action="attach">Continue</button><button class="ghost-button compact" data-main-action="logs">Logs</button></div>'
          : ''
      }
    </section>
    ${renderReworkSection()}
  `;
  for (const button of elements.inspectorBody.querySelectorAll('[data-main-action]')) {
    button.addEventListener('click', () => startPlanningTerminal(button.dataset.mainAction));
  }
  bindReworkActions();
}

function getReworkView() {
  const workflow = state.run?.workflow || {};
  const gates = Object.values(workflow.reviewGates || {});
  const diagnostics = workflow.diagnostics || {};
  const failedDiagnostics = ['afterModules', 'afterIntegration'].filter((stage) => diagnostics[stage] === 'failed');
  const rework = workflow.rework || null;
  const hasTrigger = gates.some((gate) => gate.outcome !== 'passed' && !gate.waived) || failedDiagnostics.length > 0;
  return {
    gates,
    failedDiagnostics,
    rework,
    canDispatch: hasTrigger && !(rework && REWORK_HOLDING_STATUSES.has(rework.status)),
  };
}

function renderGateCard(gate) {
  const open = gate.outcome === 'passed' || gate.waived;
  const tone = gate.waived ? 'waived' : open ? 'open' : 'closed';
  const label = gate.waived ? 'Waived' : gateOutcomeLabels[gate.outcome] || gate.outcome;
  const items = (gate.blockingItems || [])
    .map((item) => `<li>${escapeHtml(item.issue_id || '-')}: ${escapeHtml(item.problem || '-')}</li>`)
    .join('');
  return `
    <div class="gate-card ${tone}">
      <div class="gate-card-head">
        <strong>${escapeHtml(gate.taskId)}</strong>
        <span>${escapeHtml(label)}</span>
      </div>
      <p class="muted-text">${escapeHtml(gate.reportPath || '-')} · ${gate.items?.length || 0} item(s), ${gate.blockingItems?.length || 0} blocking</p>
      ${gate.error && !open ? `<p class="muted-text">${escapeHtml(gate.error)}</p>` : ''}
      ${items ? `<ul class="file-list">${items}</ul>` : ''}
      ${open ? '' : `<div class="button-row"><button class="ghost-button compact" data-waive-gate="${escapeHtml(gate.taskId)}">Waive Gate</button></div>`}
    </div>
  `;
}

function renderReworkRound(rework) {
  if (!rework) {
    return '';
  }
  const buttons = [];
  if (rework.status === 'manifest_ready') {
    buttons.push('<button class="primary-button compact" data-rework-action="import">Import Rework Manifest</button>');
  }
  if (rework.claudeSessionId) {
    buttons.push('<button class="ghost-button compact" data-rework-action="attach">Continue</button>');
    buttons.push('<button class="ghost-button compact" data-rework-action="logs">Logs</button>');
  }
  return `
    <dl class="kv-list">
      <dt>Round</dt><dd>${escapeHtml(rework.round)} → ${escapeHtml(rework.nextRunId)}</dd>
      <dt>Status</dt><dd>${escapeHtml(reworkStatusLabels[rework.status] || rework.status)}</dd>
      <dt>Session</dt><dd>${escapeHtml(rework.claudeSessionId || '-')}</dd>
      <dt>Manifest</dt><dd>${escapeHtml(rework.manifestPath)}</dd>
      <dt>Decisions</dt><dd>${escapeHtml(rework.decisionsPath)}</dd>
      <dt>Questions</dt><dd>${escapeHtml(rework.userQuestionsPath)}</dd>
      ${rework.importedRunId ? `<dt>Imported</dt><dd>${escapeHtml(rework.importedRunId)}</dd>` : ''}
    </dl>
    ${rework.error ? `<pre class="code-preview">${escapeHtml(rework.error)}</pre>` : ''}
    ${buttons.length ? `<div class="button-row">${buttons.join('')}</div>` : ''}
  `;
}

function renderReworkSection() {
  const view = getReworkView();
  const reworkOf = state.run.reworkOf;
  const lineage = reworkOf
    ? `<p class="muted-text">Rework round ${escapeHtml(reworkOf.round)} of ${escapeHtml(reworkOf.parentRunId)} · decisions in ${escapeHtml(reworkOf.decisionsPath)}</p>`
    : '';
  const diagnostics = view.failedDiagnostics
    .map(
      (stage) => `
        <div class="gate-card closed">
          <div class="gate-card-head"><strong>diagnostics ${escapeHtml(stage)}</strong><span>Failed</span></div>
          <div class="button-row"><button class="ghost-button compact" data-waive-gate="diagnostics:${escapeHtml(stage)}">Waive Diagnostics</button></div>
        </div>`,
    )
    .join('');
  const empty = !view.gates.length && !view.failedDiagnostics.length && !view.rework;
  return `
    <section class="detail-section">
      <h4>Rework Loop</h4>
      ${lineage}
      ${empty ? '<p class="muted-text">Review gates appear here once a review patch is applied. Blocking rework_items stop the pipeline until the Main Architect dispatches rework or you waive the gate.</p>' : ''}
      ${view.gates.map(renderGateCard).join('')}
      ${diagnostics}
      ${renderReworkRound(view.rework)}
      ${view.canDispatch ? '<div class="button-row"><button class="primary-button compact" data-rework-action="dispatch">Dispatch Rework to Main Architect</button></div>' : ''}
    </section>
  `;
}

function bindReworkActions() {
  for (const button of elements.inspectorBody.querySelectorAll('[data-waive-gate]')) {
    button.addEventListener('click', () => waiveGate(button.dataset.waiveGate));
  }
  for (const button of elements.inspectorBody.querySelectorAll('[data-rework-action]')) {
    const action = button.dataset.reworkAction;
    if (action === 'dispatch') {
      button.addEventListener('click', dispatchRework);
    } else if (action === 'import') {
      button.addEventListener('click', importReworkManifest);
    } else {
      button.addEventListener('click', () => startReworkTerminal(action));
    }
  }
}

async function dispatchRework() {
  if (!state.run) return;
  await runAction(
    () => api.multiAgent.dispatchRework(state.run.projectRoot, state.run.runId),
    'Rework dispatched to the Main Architect',
  );
}

async function importReworkManifest() {
  if (!state.run) return;
  await runAction(
    () => api.multiAgent.importReworkManifest(state.run.projectRoot, state.run.runId),
    'Rework manifest imported as a new run',
  );
}

async function waiveGate(gateId) {
  if (!state.run) return;
  const confirmed = window.confirm(`Waive ${gateId}? The pipeline will continue even though the check did not pass.`);
  if (!confirmed) return;
  await runAction(
    () => api.multiAgent.waiveGate(state.run.projectRoot, state.run.runId, gateId, 'waived from UI'),
    `${gateId} waived`,
  );
}

function renderAgentButtons(agent) {
  const buttons = [];
  if (STARTABLE_AGENT_STATUSES.has(agent.status) && agent.status !== 'queued') {
    const label = RESUMABLE_AGENT_STATUSES.has(agent.status) && agent.claudeSessionId
      ? 'Resume'
      : agent.status === 'worktree_missing' ? 'Restart' : 'Start';
    buttons.push(`<button class="primary-button compact" data-action="start">${label}</button>`);
  }
  if (agent.status === 'done') {
    buttons.push('<button class="ghost-button compact" data-action="audit">Audit</button>');
  }
  if (agent.status === 'patch_ready') {
    buttons.push('<button class="primary-button compact" data-action="apply">Apply Patch</button>');
    buttons.push('<button class="ghost-button compact" data-action="reject">Reject</button>');
  }
  if (agent.claudeSessionId) {
    buttons.push('<button class="ghost-button compact" data-action="attach">Continue</button>');
    buttons.push('<button class="ghost-button compact" data-action="logs">Logs</button>');
  }
  return buttons.join('');
}

function renderViolationSection(agent) {
  if (!agent.violations?.length && !agent.error) {
    return '';
  }
  return `
    <section class="detail-section">
      <h4>Risk</h4>
      ${agent.error ? `<p class="error-state">${escapeHtml(agent.error)}</p>` : ''}
      ${agent.violations?.length ? `<ul class="file-list">${agent.violations.map((file) => `<li>${escapeHtml(file)}</li>`).join('')}</ul>` : ''}
    </section>
  `;
}

function renderArtifactsSection(agent) {
  if (state.artifactsFor !== agent.taskId || !state.artifacts) {
    return `
      <section class="detail-section">
        <h4>Artifacts</h4>
        <p class="muted-text">Reading prompt, reports, and diff...</p>
      </section>
    `;
  }
  const artifacts = state.artifacts;
  const report =
    artifacts.moduleReport ||
    artifacts.reviewReport ||
    artifacts.integrationReport ||
    artifacts.systemReviewReport ||
    'No report yet.';
  return `
    ${
      artifacts.integrationContext
        ? `<section class="detail-section">
            <h4>Integration Context</h4>
            <pre class="code-preview">${escapeHtml(artifacts.integrationContext)}</pre>
          </section>`
        : ''
    }
    <section class="detail-section">
      <h4>Report</h4>
      <pre class="code-preview">${escapeHtml(report)}</pre>
    </section>
    <section class="detail-section">
      <h4>Diff Preview</h4>
      <pre class="code-preview">${escapeHtml(artifacts.diff || artifacts.patch || 'No diff yet.')}</pre>
    </section>
    <section class="detail-section">
      <h4>Interface Request</h4>
      <pre class="code-preview">${escapeHtml(artifacts.interfaceRequest || 'No interface request.')}</pre>
    </section>
  `;
}

function bindInspectorButtons(agent) {
  for (const button of elements.inspectorBody.querySelectorAll('[data-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      if (action === 'start') {
        await runAction(() => api.multiAgent.startTask(state.run.projectRoot, state.run.runId, agent.taskId));
      } else if (action === 'audit') {
        await runAction(() => api.multiAgent.auditTask(state.run.projectRoot, state.run.runId, agent.taskId));
      } else if (action === 'apply') {
        await runAction(() => api.multiAgent.applyPatch(state.run.projectRoot, state.run.runId, agent.taskId));
      } else if (action === 'reject') {
        await runAction(() => api.multiAgent.rejectPatch(state.run.projectRoot, state.run.runId, agent.taskId));
      } else if (action === 'attach') {
        await startTerminal('attach');
      } else if (action === 'logs') {
        await startTerminal('logs');
      }
    });
  }
}

async function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  state.artifacts = null;
  state.artifactsFor = null;
  render();
  const agent = getSelectedAgent();
  if (!agent) return;
  try {
    state.artifacts = await api.multiAgent.readArtifacts(state.run.projectRoot, state.run.runId, agent.taskId);
    state.artifactsFor = agent.taskId;
  } catch (error) {
    state.artifacts = { diff: error.message };
    state.artifactsFor = agent.taskId;
  }
  renderInspector();
}

async function runAction(action, successText = 'Updated') {
  setBusy(true);
  try {
    const run = await action();
    setRun(run.run || run);
    if (successText) {
      setStatus(successText);
    }
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

async function chooseProject() {
  setBusy(true);
  try {
    const project = await api.chooseProject();
    if (!project) {
      return;
    }
    setAutoAdvance(false, 'Auto advance stopped');
    state.project = project;
    state.gitStatus = null;
    state.run = null;
    state.planning = null;
    state.logs = null;
    state.diagnostics = null;
    state.designDocPath = null;
    state.selectedNodeId = 'main';
    state.gitStatus = await api.planning.checkGit(project.path);
    try {
      state.planning = await api.planning.loadLatest(project.path);
      state.designDocPath = state.planning?.specDocPath || state.planning?.designDocPath || null;
    } catch {
      state.planning = null;
    }
    const recovered = await recoverRunForProject(project.path);
    setStatus(recovered.run ? recoveryStatusText(recovered.recovery) : 'Project selected');
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
  render();
}

async function restoreLastWorkspace() {
  setBusy(true);
  try {
    const saved = await api.appState.get();
    if (!saved?.lastProjectRoot) {
      return;
    }

    const project = {
      path: saved.lastProjectRoot,
      name: projectNameFromPath(saved.lastProjectRoot),
    };
    state.project = project;
    state.gitStatus = null;
    state.run = null;
    state.planning = null;
    state.logs = null;
    state.diagnostics = null;
    state.designDocPath = null;
    state.selectedNodeId = 'main';
    state.gitStatus = await api.planning.checkGit(project.path);
    try {
      state.planning = await api.planning.loadLatest(project.path);
      state.designDocPath = state.planning?.specDocPath || state.planning?.designDocPath || null;
    } catch {
      state.planning = null;
    }
    const recovered = await recoverRunForProject(project.path, saved.lastRunId || null);
    setStatus(recovered.run ? recoveryStatusText(recovered.recovery) : 'Last project restored');
  } catch (error) {
    setStatus(`Restore failed: ${error.message}`);
  } finally {
    setBusy(false);
    render();
  }
}

async function refreshLogs() {
  setBusy(true);
  try {
    state.logs = await api.logs.read(state.project?.path || null);
    state.selectedNodeId = 'logs';
    setStatus('Logs refreshed');
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
  render();
}

async function openLogsFolder() {
  try {
    const logPath = await api.logs.showInFolder(state.project?.path || null);
    setStatus(`Opened logs: ${logPath}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function initializeGitBaseline() {
  if (!state.project) return;
  setBusy(true);
  try {
    state.gitStatus = await api.planning.initializeGit(state.project.path);
    setStatus(state.gitStatus.canStart ? 'Git baseline ready' : state.gitStatus.reason);
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
  render();
}

async function chooseDesignDoc() {
  if (!state.project) return;
  const designDocPath = await api.planning.chooseDesignDoc();
  if (!designDocPath) return;
  state.designDocPath = designDocPath;
  setStatus('Spec document selected');
  renderChrome();
}

async function startArchitect() {
  if (!state.project || !state.designDocPath) return;
  setBusy(true);
  try {
    state.gitStatus = await api.planning.checkGit(state.project.path);
    if (!state.gitStatus.canStart) {
      setStatus(state.gitStatus.reason || 'Git baseline is required');
      render();
      return;
    }
    const runId = elements.architectRunIdInput.value.trim();
    const model = elements.architectModelInput.value.trim() || 'opus';
    const effort = elements.architectEffortInput.value.trim() || 'medium';
    const architectName = elements.architectNameInput.value.trim() || 'main-architect';
    const planning = await api.planning.startArchitect({
      projectRoot: state.project.path,
      specDocPath: state.designDocPath,
      runId: runId || undefined,
      model,
      providerProfileId: elements.architectProviderInput.value || 'claude-subscription',
      effort,
      architectName,
      moduleProvider: elements.moduleProviderInput.value || 'claude-subscription',
      moduleModel: elements.moduleModelInput.value.trim() || 'sonnet',
      moduleEffort: elements.moduleEffortInput.value.trim() || 'medium',
      reviewProvider: elements.reviewProviderInput.value || 'claude-subscription',
      reviewModel: elements.reviewModelInput.value.trim() || 'opus',
      reviewEffort: elements.reviewEffortInput.value.trim() || 'medium',
      integrationProvider: elements.integrationProviderInput.value || 'claude-subscription',
      integrationModel: elements.integrationModelInput.value.trim() || 'opus',
      integrationEffort: elements.integrationEffortInput.value.trim() || 'medium',
      systemReviewProvider: elements.systemReviewProviderInput.value || 'claude-subscription',
      systemReviewModel: elements.systemReviewModelInput.value.trim() || 'opus',
      systemReviewEffort: elements.systemReviewEffortInput.value.trim() || 'medium',
    });
    state.planning = planning;
    if (planning.runId && !elements.architectRunIdInput.value.trim()) {
      elements.architectRunIdInput.value = planning.runId;
    }
    if (planning.status === 'failed') {
      logClientFailure('Architect failed to start', planning);
      setStatus(planning.error || 'Architect failed to start');
    } else {
      setStatus('Main architect started');
    }
    if (planning.status !== 'failed' && !state.watching) {
      setManifestWatch(true, 'Watching for generated manifest');
    }
    render();
  } catch (error) {
    logClientFailure('Architect start threw', {
      message: error.message,
      stack: error.stack,
    });
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

async function importManifest() {
  setBusy(true);
  try {
    const run = await api.multiAgent.importManifest();
    if (run) {
      setRun(run);
      setStatus('Manifest imported');
    }
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

async function loadDefaultManifest({ silent = false } = {}) {
  if (!state.project) return;
  if (!silent) setBusy(true);
  try {
    const run = await api.multiAgent.loadDefaultManifest(state.project.path);
    if (!run) {
      if (!silent) {
        setStatus('tasks/task_manifest.yaml not generated yet');
      }
      return;
    }
    setRun(run);
    setStatus('Manifest loaded');
  } catch (error) {
    if (!silent) setStatus(error.message);
  } finally {
    if (!silent) setBusy(false);
  }
}

function setManifestWatch(enabled, statusText) {
  state.watching = enabled;
  if (state.watchTimer) {
    clearInterval(state.watchTimer);
    state.watchTimer = null;
  }
  if (state.watching) {
    state.watchTimer = setInterval(async () => {
      if (!state.run) {
        await loadDefaultManifest({ silent: true });
      }
      if (state.run) {
        await runAction(() => api.multiAgent.sync(state.run.projectRoot, state.run.runId));
      }
    }, 5000);
    setStatus(statusText || 'Watching manifest');
  } else {
    setStatus(statusText || 'Manifest watch stopped');
  }
  renderChrome();
}

function toggleWatchManifest() {
  setManifestWatch(!state.watching);
}

async function syncRun() {
  if (!state.run) return;
  await runAction(() => api.multiAgent.sync(state.run.projectRoot, state.run.runId));
}

async function captureDiagnostics() {
  if (!state.run) return;
  setBusy(true);
  try {
    state.diagnostics = await api.diagnostics.run(state.run.projectRoot, state.run.runId);
    state.selectedNodeId = 'diagnostics';
    setStatus(
      `Diagnostics: ${state.diagnostics.counts.error} errors, ${state.diagnostics.counts.warning} warnings`,
    );
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
  render();
}

async function advanceWorkflow({ fromAuto = false } = {}) {
  if (!state.run) return null;
  setBusy(true);
  try {
    const result = await api.multiAgent.advanceWorkflow(state.run.projectRoot, state.run.runId, {
      autoApplyPatches: state.autoApplyPatches,
      autoDispatchRework: state.autoDispatchRework,
    });
    setRun(result.run);
    if (result.diagnostics) {
      state.diagnostics = result.diagnostics;
      state.selectedNodeId = 'diagnostics';
    }
    setStatus(result.reason || 'Workflow checked');
    if (fromAuto && !AUTO_ADVANCE_CONTINUE_REASONS.has(result.stopReason)) {
      setAutoAdvance(false, result.reason);
    }
    return result;
  } catch (error) {
    setStatus(error.message);
    if (fromAuto) {
      setAutoAdvance(false, error.message);
    }
    return null;
  } finally {
    setBusy(false);
    render();
  }
}

function setAutoAdvance(enabled, statusText) {
  state.autoAdvance = enabled;
  if (state.autoAdvanceTimer) {
    clearInterval(state.autoAdvanceTimer);
    state.autoAdvanceTimer = null;
  }
  if (enabled) {
    state.autoAdvanceTimer = setInterval(async () => {
      if (!state.busy && state.run) {
        await advanceWorkflow({ fromAuto: true });
      }
    }, 7000);
    setStatus(statusText || 'Auto advance enabled');
  } else {
    setStatus(statusText || 'Auto advance disabled');
  }
  renderChrome();
}

function toggleAutoAdvance() {
  setAutoAdvance(!state.autoAdvance);
}

function toggleAutoDispatchRework() {
  state.autoDispatchRework = !state.autoDispatchRework;
  setStatus(state.autoDispatchRework ? 'Auto rework dispatch enabled' : 'Auto rework dispatch disabled');
  renderChrome();
}

function toggleAutoApplyPatches() {
  state.autoApplyPatches = !state.autoApplyPatches;
  setStatus(state.autoApplyPatches ? 'Auto patch apply enabled' : 'Auto patch apply disabled');
  renderChrome();
}

async function startAllReady() {
  if (!state.run) return;
  const preflight = await api.multiAgent.preflight(state.run.projectRoot, state.run.runId);
  if (!preflight.ok) {
    state.run.preflight = preflight;
    setStatus(preflight.errors[0] || 'Preflight failed');
    render();
    return;
  }
  await runAction(() => api.multiAgent.startAllReady(state.run.projectRoot, state.run.runId));
}

async function startModuleReview() {
  if (!state.run) return;
  await runAction(async () => {
    const result = await api.multiAgent.advanceModuleReview(state.run.projectRoot, state.run.runId);
    setStatus(result.reason || (result.advanced ? 'Module review started' : 'Module review not ready'));
    return result.run;
  }, null);
}

async function cleanAcceptedWorktrees() {
  if (!state.run) return;
  await runAction(async () => {
    const result = await api.multiAgent.cleanAcceptedWorktrees(state.run.projectRoot, state.run.runId);
    setStatus(`Cleaned ${result.cleaned.length} worktrees`);
    return result.run;
  });
}

const ACTIVE_SESSION_STATUSES = new Set(['starting', 'running']);

// Logs streams the runner's agent.log into the drawer. Continue opens
// `claude --resume` in a system terminal, only once the runner has stopped.
async function openAgentTerminal({ mode, title, sessionId, cwd, logPath, status }) {
  if (mode === 'attach' && ACTIVE_SESSION_STATUSES.has(status)) {
    setStatus('The session is still running. Use Logs now, or Continue after it stops.');
    return;
  }
  try {
    const result = await api.terminal.start({ mode, sessionId, cwd, logPath });
    if (!result.terminalId) {
      setStatus(`Opened session ${sessionId} in a terminal window`);
      return;
    }
    elements.terminalDrawer.classList.remove('collapsed');
    elements.terminalOutput.textContent = '';
    elements.terminalTitle.textContent = `${title} / ${mode}`;
    state.terminalId = result.terminalId;
    elements.sendTerminalButton.disabled = true;
    elements.stopTerminalButton.disabled = false;
  } catch (error) {
    setStatus(error.message);
  }
}

async function startTerminal(mode) {
  const agent = getSelectedAgent();
  if (!agent?.claudeSessionId) return;
  await openAgentTerminal({
    mode,
    title: agent.displayName,
    sessionId: agent.claudeSessionId,
    cwd: agent.worktreePath || state.run.projectRoot,
    logPath: agent.logPath,
    status: agent.status,
  });
}

async function startPlanningTerminal(mode) {
  if (!state.planning?.claudeSessionId) return;
  await openAgentTerminal({
    mode,
    title: state.planning.architectName,
    sessionId: state.planning.claudeSessionId,
    cwd: state.planning.projectRoot || state.project?.path,
    logPath: state.planning.logPath,
    status: state.planning.status,
  });
}

async function startReworkTerminal(mode) {
  const rework = state.run?.workflow?.rework;
  if (!rework?.claudeSessionId) return;
  await openAgentTerminal({
    mode,
    title: `${state.run.manifest.mainAgent.name} rework ${rework.round}`,
    sessionId: rework.claudeSessionId,
    cwd: state.run.projectRoot,
    logPath: rework.logPath,
    status: rework.status,
  });
}

async function sendTerminalInput() {
  if (!state.terminalId || !elements.terminalInput.value) return;
  await api.terminal.input(state.terminalId, `${elements.terminalInput.value}\n`);
  elements.terminalInput.value = '';
}

async function stopTerminal() {
  if (!state.terminalId) return;
  await api.terminal.stop(state.terminalId);
  state.terminalId = null;
  elements.sendTerminalButton.disabled = true;
  elements.stopTerminalButton.disabled = true;
}

function closeTerminal() {
  elements.terminalDrawer.classList.add('collapsed');
}

function appendTerminal(text) {
  elements.terminalOutput.textContent += text;
  elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
}

function render() {
  renderChrome();
  renderGraph();
  renderInspector();
}

elements.chooseProjectButton.addEventListener('click', chooseProject);
elements.initializeGitButton.addEventListener('click', initializeGitBaseline);
elements.refreshLogsButton.addEventListener('click', refreshLogs);
elements.openLogsButton.addEventListener('click', openLogsFolder);
elements.chooseDesignDocButton.addEventListener('click', chooseDesignDoc);
elements.refreshModelOptionsButton.addEventListener('click', () => loadModelOptions({ refresh: true }));
elements.providerPresetInput.addEventListener('change', applyProviderPresetToForm);
elements.saveProviderProfileButton.addEventListener('click', saveProviderProfile);
elements.refreshProviderModelsButton.addEventListener('click', refreshProviderModels);
for (const pair of providerModelPairs) {
  pair.provider.addEventListener('change', () => populateModelForPair(pair));
}
elements.startArchitectButton.addEventListener('click', startArchitect);
elements.attachArchitectButton.addEventListener('click', () => startPlanningTerminal('attach'));
elements.logsArchitectButton.addEventListener('click', () => startPlanningTerminal('logs'));
elements.importManifestButton.addEventListener('click', importManifest);
elements.loadManifestButton.addEventListener('click', () => loadDefaultManifest());
elements.watchManifestButton.addEventListener('click', toggleWatchManifest);
elements.syncButton.addEventListener('click', syncRun);
elements.diagnosticsButton.addEventListener('click', captureDiagnostics);
elements.advanceWorkflowButton.addEventListener('click', () => advanceWorkflow());
elements.autoAdvanceButton.addEventListener('click', toggleAutoAdvance);
elements.autoApplyButton.addEventListener('click', toggleAutoApplyPatches);
elements.autoDispatchReworkButton.addEventListener('click', toggleAutoDispatchRework);
elements.startAllButton.addEventListener('click', startAllReady);
elements.startModuleReviewButton.addEventListener('click', startModuleReview);
elements.cleanButton.addEventListener('click', cleanAcceptedWorktrees);
elements.sendTerminalButton.addEventListener('click', sendTerminalInput);
elements.stopTerminalButton.addEventListener('click', stopTerminal);
elements.closeTerminalButton.addEventListener('click', closeTerminal);
elements.terminalInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendTerminalInput();
});
elements.graphSurface.addEventListener('scroll', () => requestAnimationFrame(drawGraphConnections));
window.addEventListener('resize', () => requestAnimationFrame(drawGraphConnections));

api.terminal.onEvent((event) => {
  if (event.terminalId !== state.terminalId) return;
  if (event.type === 'start') {
    appendTerminal(`$ ${event.command}\n${event.cwd}\n\n`);
  } else if (event.type === 'data') {
    appendTerminal(event.text);
  } else if (event.type === 'error') {
    appendTerminal(`\n[error] ${event.text}\n`);
  } else if (event.type === 'exit') {
    appendTerminal(`\n[process exited with code ${event.code}]\n`);
    state.terminalId = null;
    elements.sendTerminalButton.disabled = true;
    elements.stopTerminalButton.disabled = true;
  }
});

loadProviderProfiles();
loadModelOptions();
restoreLastWorkspace();
render();
