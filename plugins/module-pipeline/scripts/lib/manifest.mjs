// Task manifest: load, validate, and plan dependency waves.
//
// Schema (YAML):
//   version: 1
//   project: { name, root?, spec? }
//   run: { id, goal? }
//   defaults: { model?, effort?, review_model?, review_effort? }
//   diagnostics: { compile_command?: string | string[], timeout_ms? }
//   tasks:            # module tasks, one owned folder each
//     - id, feature, owner?, owned_folder (or legacy owned_script),
//       test_folder? | test_file?, prompt_file, module_report?,
//       interface_request?, allowed_files?, depends_on?, acceptance?, model?, effort?
//   integration:      # optional glue stage
//     { id?, prompt_file, allowed_files, integration_report?, interface_request?, acceptance?, model?, effort? }
import fs from 'node:fs';
import path from 'node:path';
import yaml from '../vendor/js-yaml.mjs';
import { entriesOverlap, normalizeRelPath, normalizeScopeEntry } from './scope.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTEGRATION_ID = 'integration';

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
  if (rawRoot) {
    return path.resolve(path.dirname(manifestPath), String(rawRoot));
  }
  // Default layout: <root>/tasks/<manifest>.yaml
  return path.resolve(path.dirname(manifestPath), '..');
}

function uniqueScopes(entries, fieldName) {
  const seen = new Map();
  for (const entry of entries.filter(Boolean)) {
    const normalized = normalizeScopeEntry(entry, fieldName);
    seen.set(normalized.toLowerCase(), normalized);
  }
  return [...seen.values()];
}

function normalizeModuleTask(raw, index, defaults) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`tasks[${index}] must be an object.`);
  }
  const id = safeId(raw.id, `tasks[${index}].id`);
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
    model: raw.model ? String(raw.model) : defaults.model,
    effort: raw.effort ? String(raw.effort) : defaults.effort,
  };
}

function normalizeIntegration(raw, runId, defaults) {
  if (!raw) {
    return null;
  }
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
    model: raw.model ? String(raw.model) : defaults.model,
    effort: raw.effort ? String(raw.effort) : defaults.effort,
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
  const rawDefaults = raw.defaults || {};
  const defaults = {
    model: rawDefaults.model || rawDefaults.sub_agent_model || null,
    effort: rawDefaults.effort || rawDefaults.sub_agent_effort || null,
    reviewModel: rawDefaults.review_model || rawDefaults.review_agent_model || null,
    reviewEffort: rawDefaults.review_effort || rawDefaults.review_agent_effort || null,
  };
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) {
    throw new Error('Manifest must contain at least one module task under tasks.');
  }
  const tasks = raw.tasks.map((task, index) => normalizeModuleTask(task, index, defaults));
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
  }
  const integration = normalizeIntegration(raw.integration, runId, defaults);
  validateOwnership(tasks, integration);
  planWaves(tasks);

  const compileCommand = raw.diagnostics?.compile_command ?? null;
  return {
    manifestPath: path.resolve(manifestPath),
    projectRoot: resolveProjectRoot(raw.project?.root, manifestPath),
    project: { name: String(raw.project?.name || 'Project'), spec: raw.project?.spec ? String(raw.project.spec) : null },
    runId,
    goal: String(raw.run?.goal || ''),
    defaults,
    diagnostics: {
      compileCommand: Array.isArray(compileCommand) ? compileCommand.map(String) : compileCommand ? String(compileCommand) : null,
      timeoutMs: Number(raw.diagnostics?.timeout_ms) || 300000,
    },
    tasks,
    integration,
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
