// Task manifest: load, validate, and plan dependency waves.
//
// Schema (YAML):
//   version: 1
//   project: { name, root?, spec? }
//   run: { id, goal? }
//   effort: { preset?, module_implementer?, module_reviewer?, integrator?, system_reviewer?, pipeline_ops? }
//   diagnostics: { compile_command?, test_command?: string | string[], timeout_ms? }
//   generated_files: ["*.uid", ".godot/"]   # tool output dropped (not rejected) when outside a task's scope
//   tasks:            # module tasks, one owned folder each
//     - id, feature, owner?, owned_folder (or legacy owned_script),
//       test_folder? | test_file?, prompt_file, module_report?,
//       interface_request?, allowed_files?, depends_on?, acceptance?, effort?
//   integration:      # optional glue stage
//     { id?, prompt_file, allowed_files, integration_report?, interface_request?, acceptance?, effort? }
//
// Every agent runs on the strongest model; roles differ only in thinking effort.
import fs from 'node:fs';
import path from 'node:path';
import yaml from '../vendor/js-yaml.mjs';
import { canonicalPath } from './paths.mjs';
import { entriesOverlap, normalizeGeneratedPattern, normalizeRelPath, normalizeScopeEntry } from './scope.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTEGRATION_ID = 'integration';

// The model every pipeline agent runs on. The alias always resolves to the
// newest Opus, so the pipeline follows model upgrades without edits.
export const AGENT_MODEL = 'opus';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Manifest key -> result key, in the order agents appear in a run.
const ROLES = {
  module_implementer: 'moduleImplementer',
  module_reviewer: 'moduleReviewer',
  integrator: 'integrator',
  system_reviewer: 'systemReviewer',
  pipeline_ops: 'pipelineOps',
};

export const DEFAULT_PRESET = 'balanced';

// Effort per role; a role set explicitly in the manifest wins over its preset.
// The system reviewer judges the whole result against the spec, so it thinks
// one step harder than the per-module roles. (The Main Architect is the user's
// session running plan/rework; those skills set their own effort.)
export const PRESETS = {
  economy: { moduleImplementer: 'low', moduleReviewer: 'low', integrator: 'low', systemReviewer: 'medium', pipelineOps: 'low' },
  balanced: { moduleImplementer: 'medium', moduleReviewer: 'medium', integrator: 'medium', systemReviewer: 'high', pipelineOps: 'medium' },
  quality: { moduleImplementer: 'high', moduleReviewer: 'high', integrator: 'high', systemReviewer: 'xhigh', pipelineOps: 'medium' },
};

function effortLevel(value, fieldName) {
  const level = String(value).trim();
  if (!EFFORT_LEVELS.includes(level)) {
    throw new Error(`${fieldName} must be one of ${EFFORT_LEVELS.join(', ')}: ${JSON.stringify(value)}`);
  }
  return level;
}

function rejectModelFields(raw, fieldName) {
  const found = ['model', 'review_model', 'sub_agent_model', 'review_agent_model'].filter((key) => raw && raw[key] != null);
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
  const unknown = Object.keys(section).filter((key) => key !== 'preset' && !ROLES[key]);
  if (unknown.length) {
    throw new Error(`effort.${unknown[0]} is not a role. Roles: ${Object.keys(ROLES).join(', ')}.`);
  }
  const preset = section.preset ? String(section.preset) : DEFAULT_PRESET;
  if (!PRESETS[preset]) {
    throw new Error(`effort.preset must be one of ${Object.keys(PRESETS).join(', ')}: ${preset}`);
  }
  const efforts = { ...PRESETS[preset] };
  for (const [key, name] of Object.entries(ROLES)) {
    if (section[key] != null) {
      efforts[name] = effortLevel(section[key], `effort.${key}`);
    }
  }
  return { preset, efforts };
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
  if (id === INTEGRATION_ID) {
    throw new Error(`Module task id "${INTEGRATION_ID}" is reserved for the integration stage.`);
  }
  const ownedFolder = raw.owned_folder ? normalizeScopeEntry(raw.owned_folder, `${id}.owned_folder`, { folder: true }) : null;
  const ownedScript = !ownedFolder && raw.owned_script ? normalizeRelPath(raw.owned_script, `${id}.owned_script`) : null;
  if (!ownedFolder && !ownedScript) {
    throw new Error(`${id}.owned_folder is required.`);
  }
  const testFolder = raw.test_folder ? normalizeScopeEntry(raw.test_folder, `${id}.test_folder`, { folder: true }) : null;
  const testFile = optionalPath(raw.test_file, `${id}.test_file`);
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
    promptFile: normalizeRelPath(raw.prompt_file, `${id}.prompt_file`),
    moduleReport,
    interfaceRequest,
    allowedFiles: uniqueScopes(
      [ownedFolder, ownedScript, testFolder, testFile, moduleReport, interfaceRequest, ...asStringList(raw.allowed_files)],
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

function describeOwned(entry) {
  return entry.endsWith('/') ? `folder ${entry}` : `script ${entry}`;
}

/**
 * One module folder has one owner, and no other task may write inside it.
 */
export function validateOwnership(tasks, integration) {
  const owners = tasks.map((task) => ({
    id: task.id,
    entries: [task.ownedFolder || task.ownedScript, task.testFolder].filter(Boolean),
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
  const { preset, efforts } = resolveEfforts(raw);
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) {
    throw new Error('Manifest must contain at least one module task under tasks.');
  }
  const tasks = raw.tasks.map((task, index) => normalizeModuleTask(task, index, efforts));
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
  }
  const integration = normalizeIntegration(raw.integration, runId, efforts);
  validateOwnership(tasks, integration);
  planWaves(tasks);

  if (raw.generated_files != null && !Array.isArray(raw.generated_files)) {
    throw new Error('generated_files must be a list.');
  }
  const generatedFiles = [...new Set(asStringList(raw.generated_files).map((entry) => normalizeGeneratedPattern(entry)))];
  return {
    manifestPath: canonicalPath(manifestPath),
    projectRoot: resolveProjectRoot(raw.project?.root, manifestPath),
    project: { name: String(raw.project?.name || 'Project'), spec: raw.project?.spec ? String(raw.project.spec) : null },
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
    generatedFiles,
    tasks,
    integration,
  };
}

/**
 * How many agents a run starts, by role and thinking effort. Token use is not
 * estimated: it depends far more on the modules than on the counts.
 */
export function estimateRun(manifest, done = new Set()) {
  const { efforts } = manifest;
  const pending = manifest.tasks.filter((task) => !done.has(task.id));
  const byEffort = new Map();
  for (const task of pending) {
    byEffort.set(task.effort, (byEffort.get(task.effort) || 0) + 1);
  }
  const run = [
    ...[...byEffort].map(([effort, count]) => ({ role: 'module-implementer', count, effort })),
    { role: 'module-reviewer', count: pending.length, effort: efforts.moduleReviewer },
    { role: 'pipeline-ops', count: pending.length + 2, effort: efforts.pipelineOps },
  ].filter((row) => row.count > 0);
  const integrate = manifest.integration
    ? [
        { role: 'integrator', count: 1, effort: manifest.integration.effort },
        { role: 'system-reviewer', count: 1, effort: efforts.systemReviewer },
        { role: 'pipeline-ops', count: 3, effort: efforts.pipelineOps },
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

/** Prompt files that don't exist yet (reported by validate/prepare). */
export function findMissingPromptFiles(manifest) {
  return [...manifest.tasks, manifest.integration]
    .filter(Boolean)
    .filter((task) => !fs.existsSync(path.join(manifest.projectRoot, task.promptFile)))
    .map((task) => `${task.id}.prompt_file does not exist: ${task.promptFile}`);
}

export function findTask(manifest, taskId) {
  if (taskId === INTEGRATION_ID && manifest.integration) {
    return manifest.integration;
  }
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`Task not found in manifest: ${taskId}`);
  }
  return task;
}
