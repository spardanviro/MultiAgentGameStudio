// Task manifest: load, validate, and plan dependency waves.
//
// Schema (YAML):
//   version: 1
//   project: { name, root?, spec?, estimated_lines? }
//   run: { id, goal? }
//   effort: { preset?, module_implementer?, module_reviewer?, integrator?, system_reviewer? }
//   shared_layer: { task?, existing? }   # required with two or more modules
//   diagnostics: { compile_command?, test_command?: string | string[], timeout_ms? }
//   generated_files: ["*.uid", ".godot/"]   # tool output dropped (not rejected) when outside a task's scope
//   tasks:            # module tasks, one owned folder each
//     - id, feature, owner?, owned_folder (or legacy owned_script),
//       test_folder? | test_file?, support_folder? (shared-layer task only), prompt_file, module_report?,
//       interface_request?, allowed_files?, depends_on?, acceptance?, effort?
//   integration:      # optional glue stage
//     { id?, prompt_file, allowed_files, integration_report?, interface_request?, acceptance?, effort? }
//   patch:            # instead of tasks + integration: a small rework done by one agent
//     { prompt_file, allowed_files, acceptance?, max_changed_lines?, patch_report?, interface_request?, effort? }
//
// Every agent runs on the strongest model; roles differ only in thinking effort.
import fs from 'node:fs';
import path from 'node:path';
import yaml from '../vendor/js-yaml.mjs';
import { canonicalPath } from './paths.mjs';
import { entriesOverlap, normalizeGeneratedPattern, normalizeRelPath, normalizeScopeEntry } from './scope.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTEGRATION_ID = 'integration';
const PATCH_ID = 'patch';

// A patch run is meant for small fixes. The merge refuses a patch whose
// in-scope diff (added plus deleted lines) is larger than this.
export const DEFAULT_PATCH_LINES = 300;

// The model every pipeline agent runs on. The alias always resolves to the
// newest Opus, so the pipeline follows model upgrades without edits.
export const AGENT_MODEL = 'opus';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Role name in the manifest -> role name in the result, in the order agents appear in a run.
const ROLES = {
  module_implementer: 'moduleImplementer',
  module_reviewer: 'moduleReviewer',
  integrator: 'integrator',
  system_reviewer: 'systemReviewer',
};

// Roles that no longer exist; a manifest may still name them, with a warning.
const RETIRED_ROLES = {
  pipeline_ops: 'effort.pipeline_ops is ignored: the pipeline CLI now runs without a relay agent.',
};

export const DEFAULT_PRESET = 'balanced';

// Effort per role; a role set explicitly in the manifest wins over its preset.
// The system reviewer judges the whole result against the spec, so it thinks
// one step harder than the per-module roles. (The Main Architect is the user's
// session running plan/rework; those skills set their own effort.)
export const PRESETS = {
  economy: { moduleImplementer: 'low', moduleReviewer: 'low', integrator: 'low', systemReviewer: 'medium' },
  balanced: { moduleImplementer: 'medium', moduleReviewer: 'medium', integrator: 'medium', systemReviewer: 'high' },
  quality: { moduleImplementer: 'high', moduleReviewer: 'high', integrator: 'high', systemReviewer: 'xhigh' },
};

// How many modules (not counting the shared layer) suit a project of a given
// size. Each module is a full agent session plus a review, so too many small
// modules pay that fixed cost over and over, and too few make one agent hold
// a whole subsystem.
export const SIZE_BANDS = [
  { below: 1500, modules: [1, 3] },
  { below: 5000, modules: [2, 6] },
  { below: 15000, modules: [4, 12] },
  { below: Infinity, modules: [8, 20] },
];

function effortLevel(value, fieldName) {
  const level = String(value).trim();
  if (!EFFORT_LEVELS.includes(level)) {
    throw new Error(`${fieldName} must be one of ${EFFORT_LEVELS.join(', ')}: ${JSON.stringify(value)}`);
  }
  return level;
}

function rejectModelFields(raw, fieldName) {
  const found = ['model', 'review_model', 'sub_agent_model', 'review_agent_model'].filter((field) => raw && raw[field] != null);
  if (found.length) {
    throw new Error(
      `${fieldName}.${found[0]} is no longer supported: every agent runs on the strongest model (${AGENT_MODEL}). ` +
        'Set thinking effort per role under `effort:` instead.',
    );
  }
}

function resolveEfforts(raw) {
  if (raw.defaults != null) {
    rejectModelFields(raw.defaults, 'defaults');
    throw new Error('defaults is no longer supported: set thinking effort per role under `effort:` (see manifest-schema.md).');
  }
  const section = raw.effort ?? {};
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new Error('effort must be a mapping of role to effort level.');
  }
  const warnings = Object.keys(section).filter((role) => RETIRED_ROLES[role]).map((role) => RETIRED_ROLES[role]);
  const unknown = Object.keys(section).filter((role) => role !== 'preset' && !ROLES[role] && !RETIRED_ROLES[role]);
  if (unknown.length) {
    throw new Error(`effort.${unknown[0]} is not a role. Roles: ${Object.keys(ROLES).join(', ')}.`);
  }
  const preset = section.preset ? String(section.preset) : DEFAULT_PRESET;
  if (!PRESETS[preset]) {
    throw new Error(`effort.preset must be one of ${Object.keys(PRESETS).join(', ')}: ${preset}`);
  }
  const efforts = { ...PRESETS[preset] };
  for (const [role, name] of Object.entries(ROLES)) {
    if (section[role] != null) {
      efforts[name] = effortLevel(section[role], `effort.${role}`);
    }
  }
  return { preset, efforts, warnings };
}

function commandOrNull(value) {
  if (Array.isArray(value)) {
    return value.length ? value.map(String) : null;
  }
  return value ? String(value) : null;
}

function safeId(value, fieldName) {
  const text = String(value ?? '').trim();
  if (!SAFE_ID.test(text)) {
    throw new Error(`${fieldName} must use only letters, numbers, ".", "_" or "-": ${JSON.stringify(value)}`);
  }
  return text;
}

function optionalPath(value, fieldName) {
  return value ? normalizeRelPath(value, fieldName) : null;
}

function asStringList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function resolveProjectRoot(rawRoot, manifestPath) {
  // Default layout: <root>/tasks/<manifest>.yaml
  return canonicalPath(path.resolve(path.dirname(manifestPath), rawRoot ? String(rawRoot) : '..'));
}

function uniqueScopes(entries, fieldName) {
  const seen = new Map();
  for (const entry of entries.filter(Boolean)) {
    const normalized = normalizeScopeEntry(entry, fieldName);
    seen.set(normalized.toLowerCase(), normalized);
  }
  return [...seen.values()];
}

function normalizeModuleTask(raw, index, efforts) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`tasks[${index}] must be an object.`);
  }
  const id = safeId(raw.id, `tasks[${index}].id`);
  rejectModelFields(raw, id);
  if (id === INTEGRATION_ID || id === PATCH_ID) {
    throw new Error(`Module task id "${id}" is reserved for the ${id} stage.`);
  }
  const ownedFolder = raw.owned_folder ? normalizeScopeEntry(raw.owned_folder, `${id}.owned_folder`, { folder: true }) : null;
  const ownedScript = !ownedFolder && raw.owned_script ? normalizeRelPath(raw.owned_script, `${id}.owned_script`) : null;
  if (!ownedFolder && !ownedScript) {
    throw new Error(`${id}.owned_folder is required.`);
  }
  const testFolder = raw.test_folder ? normalizeScopeEntry(raw.test_folder, `${id}.test_folder`, { folder: true }) : null;
  const testFile = optionalPath(raw.test_file, `${id}.test_file`);
  const supportFolder = raw.support_folder
    ? normalizeScopeEntry(raw.support_folder, `${id}.support_folder`, { folder: true })
    : null;
  const moduleReport = optionalPath(raw.module_report, `${id}.module_report`) || `work/modules/${id}/module_report.md`;
  const interfaceRequest =
    optionalPath(raw.interface_request, `${id}.interface_request`) || `work/modules/${id}/interface_request.md`;

  return {
    id,
    kind: 'module',
    feature: String(raw.feature || id),
    owner: String(raw.owner || `${id}-agent`),
    ownedFolder,
    ownedScript,
    testFolder,
    testFile,
    supportFolder,
    promptFile: normalizeRelPath(raw.prompt_file, `${id}.prompt_file`),
    moduleReport,
    interfaceRequest,
    allowedFiles: uniqueScopes(
      [ownedFolder, ownedScript, testFolder, testFile, supportFolder, moduleReport, interfaceRequest, ...asStringList(raw.allowed_files)],
      `${id}.allowed_files entry`,
    ),
    dependsOn: asStringList(raw.depends_on),
    acceptance: asStringList(raw.acceptance),
    effort: raw.effort != null ? effortLevel(raw.effort, `${id}.effort`) : efforts.moduleImplementer,
  };
}

function normalizeIntegration(raw, runId, efforts) {
  if (!raw) {
    return null;
  }
  rejectModelFields(raw, 'integration');
  const report = optionalPath(raw.integration_report, 'integration.integration_report') ||
    `work/integration/${runId}_integration_report.md`;
  const interfaceRequest = optionalPath(raw.interface_request, 'integration.interface_request') ||
    `work/integration/${runId}_interface_request.md`;
  const extra = asStringList(raw.allowed_files);
  if (!extra.length) {
    throw new Error('integration.allowed_files must list the glue/composition files or folder it may write.');
  }
  return {
    id: INTEGRATION_ID,
    kind: 'integration',
    feature: String(raw.feature || 'Integration glue'),
    owner: String(raw.owner || 'integration-agent'),
    promptFile: normalizeRelPath(raw.prompt_file, 'integration.prompt_file'),
    integrationReport: report,
    interfaceRequest,
    allowedFiles: uniqueScopes([report, interfaceRequest, ...extra], 'integration.allowed_files entry'),
    acceptance: asStringList(raw.acceptance),
    effort: raw.effort != null ? effortLevel(raw.effort, 'integration.effort') : efforts.integrator,
  };
}

/**
 * A patch run: one agent applies a list of small rework items across the
 * folders they touch, instead of one agent per module plus integration.
 */
function normalizePatch(raw, runId, efforts) {
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('patch must be a mapping.');
  }
  rejectModelFields(raw, PATCH_ID);
  const report = optionalPath(raw.patch_report, 'patch.patch_report') || `work/patches/${runId}_patch_report.md`;
  const interfaceRequest = optionalPath(raw.interface_request, 'patch.interface_request') ||
    `work/patches/${runId}_interface_request.md`;
  const extra = asStringList(raw.allowed_files);
  if (!extra.length) {
    throw new Error('patch.allowed_files must list the folders or files the patch may change.');
  }
  const maxChangedLines = raw.max_changed_lines != null ? Number(raw.max_changed_lines) : DEFAULT_PATCH_LINES;
  if (!Number.isInteger(maxChangedLines) || maxChangedLines <= 0) {
    throw new Error(`patch.max_changed_lines must be a positive whole number: ${JSON.stringify(raw.max_changed_lines)}`);
  }
  return {
    id: PATCH_ID,
    kind: 'patch',
    feature: String(raw.feature || 'Rework patch'),
    owner: String(raw.owner || 'patch-agent'),
    promptFile: normalizeRelPath(raw.prompt_file, 'patch.prompt_file'),
    patchReport: report,
    interfaceRequest,
    allowedFiles: uniqueScopes([report, interfaceRequest, ...extra], 'patch.allowed_files entry'),
    acceptance: asStringList(raw.acceptance),
    maxChangedLines,
    effort: raw.effort != null ? effortLevel(raw.effort, 'patch.effort') : efforts.moduleImplementer,
  };
}

function describeOwned(entry) {
  return entry.endsWith('/') ? `folder ${entry}` : `script ${entry}`;
}

/**
 * One module folder has one owner, and no other task may write inside it.
 */
export function validateOwnership(tasks, integration) {
  const owners = tasks.map((task) => ({
    id: task.id,
    entries: [task.ownedFolder || task.ownedScript, task.testFolder, task.supportFolder].filter(Boolean),
  }));
  for (let i = 0; i < owners.length; i += 1) {
    for (let j = i + 1; j < owners.length; j += 1) {
      for (const a of owners[i].entries) {
        const clash = owners[j].entries.find((b) => entriesOverlap(a, b));
        if (clash) {
          throw new Error(
            `Module ownership overlap: ${owners[i].id} owns ${describeOwned(a)} and ${owners[j].id} owns ${describeOwned(clash)}. One module folder can have only one owner.`,
          );
        }
      }
    }
  }
  for (const task of [...tasks, integration].filter(Boolean)) {
    for (const owner of owners) {
      if (owner.id === task.id) {
        continue;
      }
      for (const entry of task.allowedFiles) {
        const owned = owner.entries.find((ownedEntry) => entriesOverlap(entry, ownedEntry));
        if (owned) {
          throw new Error(
            `${task.id}.allowed_files entry ${entry} reaches into ${owner.id}'s owned ${describeOwned(owned)}. Only ${owner.id} may write there; other tasks must use interface requests.`,
          );
        }
      }
    }
  }
}

/**
 * The shared layer holds what several modules need: cross-cutting helpers,
 * constants, theme values and test fixtures. Without one, every module agent
 * writes its own copy. A run with two or more modules must name it: the module
 * that builds it in this run (`task`: it runs first and every other module
 * depends on it), or the folders that already hold it (`existing`, for rework
 * runs and existing code bases).
 * @returns {{sharedLayer: object|null, tasks: object[]}} tasks with the shared dependency added
 */
function resolveSharedLayer(raw, tasks) {
  const section = raw.shared_layer;
  if (section == null) {
    if (tasks.length >= 2) {
      throw new Error(
        'shared_layer is required when a run has two or more modules: name the module that builds the shared helpers and ' +
          'test fixtures (shared_layer.task) or the folders that already hold them (shared_layer.existing). See manifest-schema.md.',
      );
    }
    tasks.filter((task) => task.supportFolder).forEach(rejectSupportFolder);
    return { sharedLayer: null, tasks };
  }
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new Error('shared_layer must be a mapping with task and/or existing.');
  }
  const taskId = section.task != null ? safeId(section.task, 'shared_layer.task') : null;
  const existing = uniqueScopes(asStringList(section.existing), 'shared_layer.existing entry');
  if (!taskId && !existing.length) {
    throw new Error('shared_layer needs task (the module that builds it) or existing (folders that already hold it).');
  }
  const owner = taskId ? tasks.find((task) => task.id === taskId) : null;
  if (taskId && !owner) {
    throw new Error(`shared_layer.task references unknown task: ${taskId}`);
  }
  if (owner && owner.dependsOn.length) {
    throw new Error(`${taskId} builds the shared layer, so it runs first and cannot depend on other modules.`);
  }
  tasks.filter((task) => task.supportFolder && task.id !== taskId).forEach(rejectSupportFolder);
  const paths = owner
    ? [owner.ownedFolder || owner.ownedScript, owner.supportFolder, ...existing].filter(Boolean)
    : existing;
  const withShared = tasks.map((task) =>
    !owner || task.id === taskId || task.dependsOn.includes(taskId)
      ? task
      : { ...task, dependsOn: [taskId, ...task.dependsOn] },
  );
  return { sharedLayer: { taskId, paths }, tasks: withShared };
}

function rejectSupportFolder(task) {
  throw new Error(`${task.id}.support_folder is only for the module named in shared_layer.task.`);
}

/**
 * Checks the module count against the project's estimated size.
 * @param {number|null} estimatedLines source lines the finished project should have, tests excluded
 * @param {number} moduleCount modules, not counting the one that builds the shared layer
 */
export function sizeModules(estimatedLines, moduleCount) {
  if (!estimatedLines) {
    return { sizing: null, warnings: [] };
  }
  const [min, max] = SIZE_BANDS.find((band) => estimatedLines < band.below).modules;
  const sizing = {
    estimatedLines,
    modules: moduleCount,
    recommended: { min, max },
    linesPerModule: Math.round(estimatedLines / Math.max(moduleCount, 1)),
  };
  const warnings = [];
  if (moduleCount > max) {
    warnings.push(
      `${moduleCount} modules for about ${estimatedLines} lines is too fine: each module is a full agent session plus a review. ` +
        `Merge them into ${min}-${max} modules.`,
    );
  } else if (moduleCount < min) {
    warnings.push(
      `${moduleCount} modules for about ${estimatedLines} lines is too coarse: one agent would hold a whole subsystem. ` +
        `Split them into ${min}-${max} modules.`,
    );
  }
  if (estimatedLines < SIZE_BANDS[0].below) {
    warnings.push('A project this small is usually cheaper to build in one session than through the pipeline.');
  }
  return { sizing, warnings };
}

/**
 * Group module tasks into waves: a task runs once all its dependencies are in
 * earlier waves or already done. Throws on unknown dependencies and cycles.
 * @param {Array<{id: string, dependsOn: string[]}>} tasks
 * @param {Set<string>} [done] ids already merged in an earlier invocation
 */
export function planWaves(tasks, done = new Set()) {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`${task.id}.depends_on references unknown task: ${dependency}`);
      }
    }
  }
  const finished = new Set(done);
  let pending = tasks.filter((task) => !finished.has(task.id));
  const waves = [];
  while (pending.length) {
    const ready = pending.filter((task) => task.dependsOn.every((dependency) => finished.has(dependency)));
    if (!ready.length) {
      throw new Error(`Dependency cycle between: ${pending.map((task) => task.id).join(', ')}`);
    }
    waves.push(ready);
    for (const task of ready) {
      finished.add(task.id);
    }
    pending = pending.filter((task) => !finished.has(task.id));
  }
  return waves;
}

/**
 * @param {object} raw parsed YAML
 * @param {string} manifestPath absolute path of the manifest file
 */
export function validateManifest(raw, manifestPath) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Manifest must be a YAML object.');
  }
  if (raw.version !== 1) {
    throw new Error('Manifest version must be 1.');
  }
  const runId = safeId(raw.run?.id, 'run.id');
  const { preset, efforts, warnings: effortWarnings } = resolveEfforts(raw);
  const common = {
    manifestPath: canonicalPath(manifestPath),
    projectRoot: resolveProjectRoot(raw.project?.root, manifestPath),
    runId,
    goal: String(raw.run?.goal || ''),
    model: AGENT_MODEL,
    preset,
    efforts,
    diagnostics: {
      compileCommand: commandOrNull(raw.diagnostics?.compile_command),
      testCommand: commandOrNull(raw.diagnostics?.test_command),
      timeoutMs: Number(raw.diagnostics?.timeout_ms) || 300000,
    },
  };
  if (raw.patch != null) {
    if ((Array.isArray(raw.tasks) && raw.tasks.length) || raw.integration) {
      throw new Error('A patch run has only the patch section: no tasks and no integration.');
    }
    const existing = raw.shared_layer?.existing ? uniqueScopes(asStringList(raw.shared_layer.existing), 'shared_layer.existing entry') : [];
    return {
      ...common,
      project: {
        name: String(raw.project?.name || 'Project'),
        spec: raw.project?.spec ? String(raw.project.spec) : null,
        estimatedLines: null,
      },
      generatedFiles: normalizeGenerated(raw),
      sharedLayer: existing.length ? { taskId: null, paths: existing } : null,
      sizing: null,
      warnings: effortWarnings,
      tasks: [],
      integration: null,
      patch: normalizePatch(raw.patch, runId, efforts),
    };
  }
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) {
    throw new Error('Manifest must contain at least one module task under tasks.');
  }
  const declared = raw.tasks.map((task, index) => normalizeModuleTask(task, index, efforts));
  const seen = new Set();
  for (const task of declared) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
  }
  const integration = normalizeIntegration(raw.integration, runId, efforts);
  validateOwnership(declared, integration);
  planWaves(declared);
  const { sharedLayer, tasks } = resolveSharedLayer(raw, declared);

  const estimatedLines = raw.project?.estimated_lines != null ? Number(raw.project.estimated_lines) : null;
  if (estimatedLines !== null && !(Number.isInteger(estimatedLines) && estimatedLines > 0)) {
    throw new Error(`project.estimated_lines must be a positive whole number: ${JSON.stringify(raw.project.estimated_lines)}`);
  }
  const moduleCount = tasks.filter((task) => task.id !== sharedLayer?.taskId).length;
  const { sizing, warnings: sizeWarnings } = sizeModules(estimatedLines, moduleCount);

  return {
    ...common,
    project: {
      name: String(raw.project?.name || 'Project'),
      spec: raw.project?.spec ? String(raw.project.spec) : null,
      estimatedLines,
    },
    generatedFiles: normalizeGenerated(raw),
    sharedLayer,
    sizing,
    warnings: [...effortWarnings, ...sizeWarnings],
    tasks,
    integration,
    patch: null,
  };
}

function normalizeGenerated(raw) {
  if (raw.generated_files != null && !Array.isArray(raw.generated_files)) {
    throw new Error('generated_files must be a list.');
  }
  return [...new Set(asStringList(raw.generated_files).map((entry) => normalizeGeneratedPattern(entry)))];
}

/**
 * How many agents a run starts, by role and thinking effort. Cost is not
 * estimated: it depends far more on the modules than on the counts.
 */
export function estimateRun(manifest, done = new Set()) {
  const { efforts } = manifest;
  if (manifest.patch) {
    const run = done.has(PATCH_ID)
      ? []
      : [
          { role: 'patcher', count: 1, effort: manifest.patch.effort },
          { role: 'module-reviewer', count: 1, effort: efforts.moduleReviewer },
        ];
    return { model: manifest.model, preset: manifest.preset, efforts, run, integrate: [], totalAgents: run.length };
  }
  const pending = manifest.tasks.filter((task) => !done.has(task.id));
  const byEffort = new Map();
  for (const task of pending) {
    byEffort.set(task.effort, (byEffort.get(task.effort) || 0) + 1);
  }
  const run = [
    ...[...byEffort].map(([effort, count]) => ({ role: 'module-implementer', count, effort })),
    { role: 'module-reviewer', count: pending.length, effort: efforts.moduleReviewer },
  ].filter((row) => row.count > 0);
  const integrate = manifest.integration
    ? [
        { role: 'integrator', count: 1, effort: manifest.integration.effort },
        { role: 'system-reviewer', count: 1, effort: efforts.systemReviewer },
      ]
    : [];
  const sum = (rows) => rows.reduce((total, row) => total + row.count, 0);
  return {
    model: manifest.model,
    preset: manifest.preset,
    efforts,
    run,
    integrate,
    totalAgents: sum(run) + sum(integrate),
  };
}

export function loadManifest(manifestPath) {
  const absolute = path.resolve(manifestPath);
  const raw = yaml.load(fs.readFileSync(absolute, 'utf8'));
  return validateManifest(raw, absolute);
}

/** Prompt files and existing shared-layer folders that are missing (reported by validate/prepare). */
export function findMissingPromptFiles(manifest) {
  const prompts = [...manifest.tasks, manifest.integration, manifest.patch]
    .filter(Boolean)
    .filter((task) => !fs.existsSync(path.join(manifest.projectRoot, task.promptFile)))
    .map((task) => `${task.id}.prompt_file does not exist: ${task.promptFile}`);
  const existing = manifest.sharedLayer && !manifest.sharedLayer.taskId ? manifest.sharedLayer.paths : [];
  const shared = existing
    .filter((entry) => !fs.existsSync(path.join(manifest.projectRoot, entry)))
    .map((entry) => `shared_layer.existing does not exist: ${entry}`);
  return [...prompts, ...shared];
}

export function findTask(manifest, taskId) {
  if (taskId === INTEGRATION_ID && manifest.integration) {
    return manifest.integration;
  }
  if (taskId === PATCH_ID && manifest.patch) {
    return manifest.patch;
  }
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`Task not found in manifest: ${taskId}`);
  }
  return task;
}
