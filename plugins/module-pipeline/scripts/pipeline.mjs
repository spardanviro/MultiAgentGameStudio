#!/usr/bin/env node
// module-pipeline CLI. Every command prints one JSON object on stdout.
//
//   validate <manifest>                       check a manifest
//   commit-planning <manifest>                commit the architect's output on the run branch
//   prepare <manifest> [--stage integration]  check the project, return pending waves / the integration task
//   claim --run <id> --task <id>              (inside an agent worktree) bind the worktree to a task
//   integrate-task --run <id> --task <id>     audit a task's worktree and commit its changes on the run branch
//   diagnostics --run <id>                    run the manifest's compile command
//   status [--run <id>]                       summarize runs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiagnostics } from './lib/diagnostics.mjs';
import {
  applyAndCommitPatch,
  branchTip,
  changedBetween,
  changedFiles,
  commitFiles,
  createPatch,
  createPatchBetween,
  currentBranch,
  deleteBranch,
  ensureExcluded,
  ensureRunBranch,
  getRunBranchName,
  head,
  listUncommitted,
  projectTopLevel,
  removeWorktree,
} from './lib/git.mjs';
import { findMissingPromptFiles, findTask, loadManifest, planWaves } from './lib/manifest.mjs';
import { createScopeMatcher } from './lib/scope.mjs';
import {
  findGitRoot,
  listClaims,
  loadRunState,
  patchPath,
  pipelineDir,
  projectRootForWorktree,
  readClaim,
  removeClaim,
  runStatePath,
  saveRunState,
  withLock,
  writeClaim,
} from './lib/state.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const name = value.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        index += 1;
      }
    } else {
      positional.push(value);
    }
  }
  return { positional, flags };
}

function requireFlag(flags, name) {
  if (!flags[name] || flags[name] === true) {
    throw new UsageError(`--${name} <value> is required.`);
  }
  return String(flags[name]);
}

function requireManifestArg(positional) {
  if (!positional[0]) {
    throw new UsageError('A manifest path is required.');
  }
  return loadManifest(path.resolve(positional[0]));
}

function taskInfo(task) {
  return {
    id: task.id,
    kind: task.kind,
    feature: task.feature,
    owner: task.owner,
    ownedFolder: task.ownedFolder || null,
    ownedScript: task.ownedScript || null,
    testFolder: task.testFolder || null,
    testFile: task.testFile || null,
    promptFile: task.promptFile,
    report: task.moduleReport || task.integrationReport,
    interfaceRequest: task.interfaceRequest,
    allowedFiles: task.allowedFiles,
    acceptance: task.acceptance,
    dependsOn: task.dependsOn || [],
    model: task.model || null,
    effort: task.effort || null,
  };
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function ensureProjectRepo(manifest) {
  const topLevel = projectTopLevel(manifest.projectRoot);
  if (!samePath(topLevel, manifest.projectRoot)) {
    throw new Error(`project root ${manifest.projectRoot} is not the top of a git repository (found ${topLevel}).`);
  }
}

function loadOrInitState(manifest) {
  const existing = loadRunState(manifest.projectRoot, manifest.runId);
  return {
    runId: manifest.runId,
    runBranch: existing?.runBranch || getRunBranchName(manifest.runId),
    baseCommit: existing?.baseCommit || head(manifest.projectRoot),
    createdAt: existing?.createdAt || new Date().toISOString(),
    tasks: existing?.tasks || {},
    diagnostics: existing?.diagnostics || null,
    manifestPath: manifest.manifestPath,
  };
}

// ---- commands -----------------------------------------------------------------

function cmdValidate({ positional }) {
  const manifest = requireManifestArg(positional);
  const errors = findMissingPromptFiles(manifest);
  return {
    ok: errors.length === 0,
    errors,
    runId: manifest.runId,
    projectRoot: manifest.projectRoot,
    modules: manifest.tasks.map((task) => ({ id: task.id, owns: task.ownedFolder || task.ownedScript })),
    waves: planWaves(manifest.tasks).map((wave) => wave.map((task) => task.id)),
    integration: Boolean(manifest.integration),
  };
}

function cmdCommitPlanning({ positional }) {
  const manifest = requireManifestArg(positional);
  ensureProjectRepo(manifest);
  const root = manifest.projectRoot;
  ensureExcluded(root);
  const branch = ensureRunBranch(root, getRunBranchName(manifest.runId));
  const files = listUncommitted(root);
  if (!files.length) {
    return { ok: true, committed: false, branch: getRunBranchName(manifest.runId), createdBranch: branch.created };
  }
  const commit = commitFiles(root, files, `module-pipeline(${manifest.runId}): planning output`);
  return { ok: true, committed: true, commit, files, branch: getRunBranchName(manifest.runId), createdBranch: branch.created };
}

function cmdPrepare({ positional, flags }) {
  const manifest = requireManifestArg(positional);
  ensureProjectRepo(manifest);
  const root = manifest.projectRoot;
  ensureExcluded(root);

  const errors = findMissingPromptFiles(manifest);
  const uncommitted = listUncommitted(root);
  if (uncommitted.length) {
    errors.push(
      `The project has uncommitted changes (${uncommitted.slice(0, 10).join(', ')}${uncommitted.length > 10 ? ', …' : ''}). Agents start from the last commit and would not see them. Commit them (commit-planning) or stash them first.`,
    );
  }
  if (errors.length) {
    return { ok: false, errors };
  }

  const branch = ensureRunBranch(root, getRunBranchName(manifest.runId));
  const state = loadOrInitState(manifest);
  saveRunState(root, state);

  const merged = Object.entries(state.tasks)
    .filter(([, entry]) => entry.status === 'merged')
    .map(([id]) => id);
  const base = {
    ok: true,
    runId: manifest.runId,
    runBranch: state.runBranch,
    createdBranch: branch.created,
    projectRoot: root,
    head: head(root),
    goal: manifest.goal,
    spec: manifest.project.spec,
    reviewModel: manifest.defaults.reviewModel,
    reviewEffort: manifest.defaults.reviewEffort,
  };

  if (flags.stage === 'integration') {
    if (!manifest.integration) {
      return { ok: false, errors: ['The manifest has no integration section.'] };
    }
    const unmerged = manifest.tasks.filter((task) => !merged.includes(task.id)).map((task) => task.id);
    if (unmerged.length) {
      return { ok: false, errors: [`Modules not merged yet: ${unmerged.join(', ')}. Finish /module-pipeline:run first.`] };
    }
    return {
      ...base,
      integration: state.tasks.integration?.status === 'merged' ? null : taskInfo(manifest.integration),
      modules: manifest.tasks.map(taskInfo),
    };
  }

  return {
    ...base,
    skipped: merged,
    waves: planWaves(manifest.tasks, new Set(merged)).map((wave) => wave.map(taskInfo)),
  };
}

function cmdClaim({ flags }) {
  const runId = requireFlag(flags, 'run');
  const taskId = requireFlag(flags, 'task');
  const gitInfo = findGitRoot(process.cwd());
  if (!gitInfo?.isLinkedWorktree) {
    throw new Error('claim must run inside the isolated git worktree the agent was started in.');
  }
  const root = projectRootForWorktree(gitInfo);
  const state = loadRunState(root, runId);
  if (!state) {
    throw new Error(`No pipeline run ${runId} in ${root}. Run prepare first.`);
  }
  const task = findTask(loadManifest(state.manifestPath), taskId);
  const existing = readClaim(root, gitInfo.root);
  if (existing && (existing.runId !== runId || existing.taskId !== taskId)) {
    throw new Error(`This worktree is already claimed for ${existing.runId}/${existing.taskId}.`);
  }
  const claim = existing || {
    runId,
    taskId,
    worktree: gitInfo.root,
    projectRoot: root,
    base: head(gitInfo.root),
    branch: currentBranch(gitInfo.root) || null,
    allowedFiles: task.allowedFiles,
    interfaceRequest: task.interfaceRequest,
    claimedAt: new Date().toISOString(),
  };
  writeClaim(root, claim);
  return { ok: true, worktree: claim.worktree, base: claim.base, allowedFiles: claim.allowedFiles };
}

function recordTask(root, runId, taskId, entry) {
  const state = loadRunState(root, runId);
  state.tasks[taskId] = { ...(state.tasks[taskId] || {}), ...entry, updatedAt: new Date().toISOString() };
  saveRunState(root, state);
}

function dropClaims(root, claims) {
  for (const claim of claims) {
    removeClaim(root, claim.worktree);
  }
}

// The harness may remove a worktree whose working tree is clean even though
// the agent committed its work there; the claim's branch still holds it.
function integrateFromBranch(root, state, task, claim, claims) {
  const tip = claim.branch ? branchTip(root, claim.branch) : null;
  if (!tip || tip === claim.base) {
    dropClaims(root, claims);
    return { status: 'empty', reason: 'The agent made no changes.' };
  }
  const changed = changedBetween(root, claim.base, tip);
  const allowed = createScopeMatcher(task.allowedFiles);
  const violations = changed.filter((file) => !allowed(file));
  if (violations.length) {
    return { status: 'violation', violations, changed, branch: claim.branch };
  }
  ensureRunBranch(root, state.runBranch);
  const patch = createPatchBetween(root, claim.base, tip, changed, patchPath(root, state.runId, task.id));
  const commit = applyAndCommitPatch(root, patch, `module-pipeline(${state.runId}): ${task.id}\n\n${task.feature} by ${task.owner}.`);
  deleteBranch(root, claim.branch);
  dropClaims(root, claims);
  return { status: 'merged', commit, files: changed, recoveredFromBranch: claim.branch };
}

function integrateClaim(root, state, task, claim, claims) {
  if (!fs.existsSync(claim.worktree)) {
    return integrateFromBranch(root, state, task, claim, claims);
  }
  const changed = changedFiles(claim.worktree, claim.base);
  const allowed = createScopeMatcher(task.allowedFiles);
  const violations = changed.filter((file) => !allowed(file));
  if (violations.length) {
    return { status: 'violation', violations, changed, worktree: claim.worktree };
  }
  if (!changed.length) {
    removeWorktree(root, claim.worktree);
    dropClaims(root, claims);
    return { status: 'empty', reason: 'The agent made no changes.' };
  }
  ensureRunBranch(root, state.runBranch);
  const patch = createPatch(claim.worktree, claim.base, changed, patchPath(root, state.runId, task.id));
  if (!patch) {
    removeWorktree(root, claim.worktree);
    dropClaims(root, claims);
    return { status: 'empty', reason: 'The changes produced an empty diff.' };
  }
  const commit = applyAndCommitPatch(root, patch, `module-pipeline(${state.runId}): ${task.id}\n\n${task.feature} by ${task.owner}.`);
  removeWorktree(root, claim.worktree);
  dropClaims(root, claims);
  return { status: 'merged', commit, files: changed };
}

function cmdIntegrateTask({ flags }) {
  const runId = requireFlag(flags, 'run');
  const taskId = requireFlag(flags, 'task');
  const root = projectTopLevel(process.cwd());
  return withLock(root, () => {
    const state = loadRunState(root, runId);
    if (!state) {
      throw new Error(`No pipeline run ${runId} in ${root}.`);
    }
    const task = findTask(loadManifest(state.manifestPath), taskId);
    const claims = listClaims(root)
      .filter((claim) => claim.runId === runId && claim.taskId === taskId)
      .sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt)));

    let outcome;
    if (!claims.length) {
      outcome = { status: 'unclaimed', reason: 'The agent never claimed a worktree, so nothing can be merged.' };
    } else {
      try {
        outcome = integrateClaim(root, state, task, claims[0], claims);
      } catch (error) {
        outcome = { status: 'merge_failed', error: error.message, worktree: claims[0].worktree };
      }
    }
    recordTask(root, runId, taskId, outcome);
    return { ok: outcome.status === 'merged', taskId, ...outcome };
  });
}

function cmdDiagnostics({ flags }) {
  const runId = requireFlag(flags, 'run');
  const root = projectTopLevel(process.cwd());
  const state = loadRunState(root, runId);
  if (!state) {
    throw new Error(`No pipeline run ${runId} in ${root}.`);
  }
  const manifest = loadManifest(state.manifestPath);
  const { output, ...result } = runDiagnostics(root, manifest.diagnostics);
  let logPath = null;
  if (result.ran) {
    logPath = path.join(pipelineDir(root), 'runs', `${runId}-diagnostics.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, output, 'utf8');
  }
  const fresh = loadRunState(root, runId);
  fresh.diagnostics = { ...result, logPath, checkedAt: new Date().toISOString() };
  saveRunState(root, fresh);
  return { ok: !result.failed, ...result, logPath };
}

function cmdStatus({ flags }) {
  const root = projectTopLevel(process.cwd());
  const runsDir = path.join(pipelineDir(root), 'runs');
  const runIds = flags.run
    ? [String(flags.run)]
    : fs.existsSync(runsDir)
      ? fs.readdirSync(runsDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
      : [];
  const runs = runIds
    .map((runId) => loadRunState(root, runId))
    .filter(Boolean)
    .map((state) => ({
      runId: state.runId,
      runBranch: state.runBranch,
      manifestPath: state.manifestPath,
      updatedAt: state.updatedAt,
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, entry]) => [id, entry.status])),
      diagnostics: state.diagnostics ? { failed: state.diagnostics.failed, errorCount: state.diagnostics.errorCount } : null,
      statePath: runStatePath(root, state.runId),
    }));
  return { ok: true, projectRoot: root, runs, activeClaims: listClaims(root).map(({ runId, taskId, worktree }) => ({ runId, taskId, worktree })) };
}

const COMMANDS = {
  validate: cmdValidate,
  'commit-planning': cmdCommitPlanning,
  prepare: cmdPrepare,
  claim: cmdClaim,
  'integrate-task': cmdIntegrateTask,
  diagnostics: cmdDiagnostics,
  status: cmdStatus,
};

export function main(argv) {
  const [command, ...rest] = argv;
  const handler = COMMANDS[command];
  if (!handler) {
    return { code: 2, result: { ok: false, error: `Unknown command "${command || ''}". Commands: ${Object.keys(COMMANDS).join(', ')}` } };
  }
  try {
    const result = handler(parseArgs(rest));
    return { code: result.ok === false ? 1 : 0, result };
  } catch (error) {
    return { code: error instanceof UsageError ? 2 : 1, result: { ok: false, error: error.message } };
  }
}

const invokedDirectly = process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { code, result } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = code;
}
