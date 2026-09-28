#!/usr/bin/env node
// module-pipeline CLI. Every command prints one JSON object on stdout.
//
//   validate <manifest>                       check a manifest, plan waves, count agents
//   commit-planning <manifest>                commit the architect's output on the run branch
//   prepare <manifest> [--stage integration]  check the project, return pending waves / the integration task
//   claim --run <id> --task <id>              (inside an agent worktree) bind the worktree to a task
//   integrate-task --run <id> --task <id>     audit a task's worktree and commit its changes on the run branch
//   diagnostics --run <id>                    run the manifest's compile and test commands on the run branch
//   status [--run <id>]                       summarize runs
//   clean [--run <id>] [--branches] [--into <branch>] [--dry-run]
//                                             remove leftover worktrees, claims and merged run branches
//   finish --run <id> [--base <branch>]       summarize a run branch for merging and draft a PR description
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiagnostics } from './lib/diagnostics.mjs';
import {
  branchTip,
  changedBetween,
  changedFiles,
  commitFiles,
  commitPatchOnRunBranch,
  createPatch,
  createPatchBetween,
  currentBranch,
  deleteBranch,
  ensureExcluded,
  ensureRunBranch,
  ensureRunBranchExists,
  getRunBranchName,
  git,
  head,
  isMainCheckoutOn,
  listBranches,
  listUncommitted,
  mergedBranches,
  projectTopLevel,
  removeWorktree,
  runBranchCheckout,
  syncWorktreeTo,
  worktreeForBranch,
} from './lib/git.mjs';
import { estimateRun, findMissingPromptFiles, findTask, loadManifest, planWaves } from './lib/manifest.mjs';
import { samePath } from './lib/paths.mjs';
import { auditChanges } from './lib/scope.mjs';
import {
  findGitRoot,
  listClaims,
  listRunIds,
  loadRunState,
  mergeWorktreePath,
  patchPath,
  pipelineDir,
  projectRootForWorktree,
  readClaim,
  readJson,
  removeClaim,
  runStatePath,
  saveRunState,
  withLock,
  writeClaim,
} from './lib/state.mjs';

class UsageError extends Error {}

const RUN_BRANCH_PATTERN = 'multiagent-runs/*';
const REWORK_SUFFIX = /(-r\d+)+$/;

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

function optionalFlag(flags, name) {
  return flags[name] && flags[name] !== true ? String(flags[name]) : null;
}

function requireFlag(flags, name) {
  const value = optionalFlag(flags, name);
  if (!value) {
    throw new UsageError(`--${name} <value> is required.`);
  }
  return value;
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

function ensureProjectRepo(manifest) {
  const topLevel = projectTopLevel(manifest.projectRoot);
  if (!samePath(topLevel, manifest.projectRoot)) {
    throw new Error(`project root ${manifest.projectRoot} is not the top of a git repository (found ${topLevel}).`);
  }
}

function loadOrInitState(manifest) {
  const existing = loadRunState(manifest.projectRoot, manifest.runId);
  const runBranch = existing?.runBranch || getRunBranchName(manifest.runId);
  return {
    runId: manifest.runId,
    runBranch,
    baseCommit: existing?.baseCommit || branchTip(manifest.projectRoot, runBranch),
    createdAt: existing?.createdAt || new Date().toISOString(),
    tasks: existing?.tasks || {},
    diagnostics: existing?.diagnostics || null,
    manifestPath: manifest.manifestPath,
  };
}

function detectBaseBranch(root, requested) {
  if (requested) {
    if (!branchTip(root, requested)) {
      throw new Error(`Branch ${requested} does not exist.`);
    }
    return requested;
  }
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    if (branchTip(root, candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not find a main branch (main, master, trunk, develop); pass --base <branch>.');
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
    generatedFiles: manifest.generatedFiles,
    diagnostics: { compile: manifest.diagnostics.compileCommand, tests: manifest.diagnostics.testCommand },
    estimate: estimateRun(manifest),
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

  const runBranch = getRunBranchName(manifest.runId);
  const errors = findMissingPromptFiles(manifest);
  // Agents start from the run branch tip. Uncommitted work matters only while
  // the main checkout is on that branch (it is then likely planning output);
  // on any other branch it is the user's own work and is left alone.
  const onRunBranch = !branchTip(root, runBranch) || isMainCheckoutOn(root, runBranch);
  const uncommitted = onRunBranch ? listUncommitted(root) : [];
  if (uncommitted.length) {
    errors.push(
      `The project has uncommitted changes (${uncommitted.slice(0, 10).join(', ')}${uncommitted.length > 10 ? ', …' : ''}). Agents start from the last commit and would not see them. Commit them (commit-planning) or stash them first.`,
    );
  }
  if (errors.length) {
    return { ok: false, errors };
  }

  const branch = ensureRunBranchExists(root, runBranch);
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
    head: branchTip(root, state.runBranch),
    mainCheckoutOnRunBranch: isMainCheckoutOn(root, state.runBranch),
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
  const manifest = loadManifest(state.manifestPath);
  const task = findTask(manifest, taskId);
  const existing = readClaim(root, gitInfo.root);
  if (existing && (existing.runId !== runId || existing.taskId !== taskId)) {
    throw new Error(`This worktree is already claimed for ${existing.runId}/${existing.taskId}.`);
  }
  let synced = false;
  if (!existing) {
    // The harness may create the worktree from whatever the main checkout has
    // checked out; every agent must start from the run branch tip.
    const tip = branchTip(root, state.runBranch);
    if (!tip) {
      throw new Error(`Run branch ${state.runBranch} does not exist. Run prepare first.`);
    }
    synced = syncWorktreeTo(gitInfo.root, tip);
  }
  const claim = existing || {
    runId,
    taskId,
    worktree: gitInfo.root,
    projectRoot: root,
    base: head(gitInfo.root),
    branch: currentBranch(gitInfo.root) || null,
    allowedFiles: task.allowedFiles,
    generatedFiles: manifest.generatedFiles,
    interfaceRequest: task.interfaceRequest,
    claimedAt: new Date().toISOString(),
  };
  writeClaim(root, claim);
  return { ok: true, worktree: claim.worktree, base: claim.base, syncedToRunBranch: synced, allowedFiles: claim.allowedFiles };
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

function commitTask(root, state, task, patch) {
  return commitPatchOnRunBranch(
    root,
    state.runBranch,
    mergeWorktreePath(root, state.runId),
    patch,
    `module-pipeline(${state.runId}): ${task.id}\n\n${task.feature} by ${task.owner}.`,
  );
}

// The harness may remove a worktree whose working tree is clean even though
// the agent committed its work there; the claim's branch still holds it.
function integrateFromBranch(root, state, task, claim, claims, generatedFiles) {
  const tip = claim.branch ? branchTip(root, claim.branch) : null;
  if (!tip || tip === claim.base) {
    dropClaims(root, claims);
    return { status: 'empty', reason: 'The agent made no changes.' };
  }
  const changed = changedBetween(root, claim.base, tip);
  const { inScope, violations, dropped } = auditChanges(changed, task.allowedFiles, generatedFiles);
  if (violations.length) {
    return { status: 'violation', violations, changed, branch: claim.branch };
  }
  if (!inScope.length) {
    deleteBranch(root, claim.branch);
    dropClaims(root, claims);
    return { status: 'empty', reason: 'The agent changed only generated files outside its scope.', dropped };
  }
  const patch = createPatchBetween(root, claim.base, tip, inScope, patchPath(root, state.runId, task.id));
  const { commit, via } = commitTask(root, state, task, patch);
  deleteBranch(root, claim.branch);
  dropClaims(root, claims);
  return { status: 'merged', commit, via, files: inScope, dropped, recoveredFromBranch: claim.branch };
}

function integrateClaim(root, state, task, claim, claims, generatedFiles) {
  if (!fs.existsSync(claim.worktree)) {
    return integrateFromBranch(root, state, task, claim, claims, generatedFiles);
  }
  const changed = changedFiles(claim.worktree, claim.base);
  const { inScope, violations, dropped } = auditChanges(changed, task.allowedFiles, generatedFiles);
  if (violations.length) {
    return { status: 'violation', violations, changed, worktree: claim.worktree };
  }
  const patch = inScope.length ? createPatch(claim.worktree, claim.base, inScope, patchPath(root, state.runId, task.id)) : null;
  if (!patch) {
    removeWorktree(root, claim.worktree);
    dropClaims(root, claims);
    return {
      status: 'empty',
      reason: changed.length ? 'The agent changed only generated files outside its scope.' : 'The agent made no changes.',
      dropped,
    };
  }
  const { commit, via } = commitTask(root, state, task, patch);
  removeWorktree(root, claim.worktree);
  dropClaims(root, claims);
  return { status: 'merged', commit, via, files: inScope, dropped };
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
    const manifest = loadManifest(state.manifestPath);
    const task = findTask(manifest, taskId);
    const claims = listClaims(root)
      .filter((claim) => claim.runId === runId && claim.taskId === taskId)
      .sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt)));

    let outcome;
    if (!claims.length) {
      outcome = { status: 'unclaimed', reason: 'The agent never claimed a worktree, so nothing can be merged.' };
    } else {
      try {
        outcome = integrateClaim(root, state, task, claims[0], claims, manifest.generatedFiles);
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
  const { compileCommand, testCommand } = manifest.diagnostics;
  const checkout = compileCommand || testCommand
    ? withLock(root, () => runBranchCheckout(root, state.runBranch, mergeWorktreePath(root, runId)))
    : root;
  const { output, ...result } = runDiagnostics(checkout, manifest.diagnostics);
  let logPath = null;
  if (result.ran) {
    logPath = path.join(pipelineDir(root), 'runs', `${runId}-diagnostics.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, output, 'utf8');
  }
  const fresh = loadRunState(root, runId);
  fresh.diagnostics = { ...result, checkout, logPath, checkedAt: new Date().toISOString() };
  saveRunState(root, fresh);
  return { ok: !result.failed, ...result, checkout, logPath };
}

function cmdStatus({ flags }) {
  const root = projectTopLevel(process.cwd());
  const runIds = flags.run ? [String(flags.run)] : listRunIds(root);
  const runs = runIds
    .map((runId) => loadRunState(root, runId))
    .filter(Boolean)
    .map((state) => ({
      runId: state.runId,
      runBranch: state.runBranch,
      manifestPath: state.manifestPath,
      updatedAt: state.updatedAt,
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, entry]) => [id, entry.status])),
      diagnostics: state.diagnostics
        ? { failed: state.diagnostics.failed, errorCount: state.diagnostics.errorCount, testsFailed: Boolean(state.diagnostics.tests?.failed) }
        : null,
      statePath: runStatePath(root, state.runId),
    }));
  return {
    ok: true,
    projectRoot: root,
    currentBranch: currentBranch(root) || null,
    runs,
    activeClaims: listClaims(root).map(({ runId, taskId, worktree }) => ({ runId, taskId, worktree })),
  };
}

// ---- clean --------------------------------------------------------------------

const belongsToRun = (runFilter) => (runId) =>
  !runFilter || runId === runFilter || runId.startsWith(`${runFilter}-r`);

function cleanClaims(root, matches, dryRun) {
  return listClaims(root)
    .filter((claim) => matches(claim.runId))
    .map((claim) => {
      const exists = fs.existsSync(claim.worktree);
      if (!dryRun) {
        if (exists) {
          removeWorktree(root, claim.worktree);
        } else if (claim.branch) {
          deleteBranch(root, claim.branch);
        }
        removeClaim(root, claim.worktree);
      }
      return { runId: claim.runId, taskId: claim.taskId, worktree: claim.worktree, worktreeExists: exists, branch: claim.branch || null };
    });
}

function cleanMergeWorktrees(root, matches, dryRun) {
  const dir = path.join(pipelineDir(root), 'merge');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter(matches)
    .map((runId) => {
      const worktree = path.join(dir, runId);
      if (!dryRun) {
        git(root, ['worktree', 'remove', '--force', worktree], { allowFail: true });
        fs.rmSync(worktree, { recursive: true, force: true });
      }
      return { runId, worktree };
    });
}

function cleanBranches(root, matches, into, dryRun) {
  const prefix = 'multiagent-runs/';
  const candidates = listBranches(root, RUN_BRANCH_PATTERN).filter((branch) => matches(branch.slice(prefix.length)));
  const merged = new Set(mergedBranches(root, RUN_BRANCH_PATTERN, into));
  const deleted = [];
  const kept = [];
  for (const branch of candidates) {
    const holder = worktreeForBranch(root, branch);
    if (holder) {
      kept.push({ branch, reason: `checked out in ${holder}` });
    } else if (!merged.has(branch)) {
      kept.push({ branch, reason: `not merged into ${into}` });
    } else {
      if (!dryRun) {
        git(root, ['branch', '-d', branch]);
        fs.rmSync(path.join(pipelineDir(root), 'patches', branch.slice(prefix.length)), { recursive: true, force: true });
      }
      deleted.push(branch);
    }
  }
  return { deleted, kept };
}

function cmdClean({ flags }) {
  const root = projectTopLevel(process.cwd());
  const dryRun = Boolean(flags['dry-run']);
  const runFilter = optionalFlag(flags, 'run');
  const matches = belongsToRun(runFilter);
  return withLock(root, () => {
    const claims = cleanClaims(root, matches, dryRun);
    const mergeWorktrees = cleanMergeWorktrees(root, matches, dryRun);
    if (!dryRun) {
      git(root, ['worktree', 'prune'], { allowFail: true });
    }
    let branches = null;
    if (flags.branches) {
      const into = detectBaseBranch(root, optionalFlag(flags, 'into'));
      branches = { into, ...cleanBranches(root, matches, into, dryRun) };
    }
    return { ok: true, dryRun, run: runFilter, claims, mergeWorktrees, branches };
  });
}

// ---- finish -------------------------------------------------------------------

function relatedRuns(root, runId) {
  const family = runId.replace(REWORK_SUFFIX, '');
  return listRunIds(root)
    .filter((id) => id === family || id.startsWith(`${family}-r`))
    .map((id) => loadRunState(root, id))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function readResult(root, runId, stage) {
  const result = readJson(path.join(pipelineDir(root), 'runs', `${runId}-${stage}-result.json`));
  return result ? { status: result.status || null, blockingItems: result.blockingItems || [] } : null;
}

function prDraft({ runBranch, base, commits, shortstat, runs, latest }) {
  const lines = [`# ${runBranch}`, '', `Built by module-pipeline across ${runs.length} run(s); merges into \`${base}\`.`, ''];
  for (const run of runs) {
    lines.push(`## ${run.runId}`, '', '| Task | Status |', '| --- | --- |');
    for (const [task, status] of Object.entries(run.tasks)) {
      lines.push(`| ${task} | ${status} |`);
    }
    if (run.diagnostics) {
      lines.push('', `Diagnostics: ${run.diagnostics.failed ? 'failed' : 'passed'}${run.diagnostics.tests ? `, tests ${run.diagnostics.tests.failed ? 'failed' : run.diagnostics.tests.skipped ? 'skipped' : 'passed'}` : ''}.`);
    }
    lines.push('');
  }
  const open = [...(latest.modules?.blockingItems || []), ...(latest.integration?.blockingItems || [])];
  if (open.length) {
    lines.push('## Open blocking items', '', ...open.map((item) => `- ${item.issue_id}: ${item.problem}`), '');
  }
  lines.push('## Commits', '', ...commits.map((commit) => `- ${commit.sha.slice(0, 10)} ${commit.subject}`), '', shortstat || '', '');
  return lines.join('\n');
}

function cmdFinish({ flags }) {
  const runId = requireFlag(flags, 'run');
  const root = projectTopLevel(process.cwd());
  const state = loadRunState(root, runId);
  if (!state) {
    throw new Error(`No pipeline run ${runId} in ${root}.`);
  }
  const runBranch = state.runBranch;
  if (!branchTip(root, runBranch)) {
    throw new Error(`Run branch ${runBranch} does not exist.`);
  }
  const base = detectBaseBranch(root, optionalFlag(flags, 'base'));
  const mergeBase = git(root, ['merge-base', base, runBranch]).trim();
  const commits = git(root, ['log', '--reverse', '--format=%H%x09%s', `${base}..${runBranch}`])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split('\t');
      return { sha, subject: subject.join('\t') };
    });
  const behind = Number(git(root, ['rev-list', '--count', `${runBranch}..${base}`]).trim());
  const filesChanged = git(root, ['diff', '--name-only', mergeBase, runBranch]).split(/\r?\n/).filter(Boolean);
  const shortstat = git(root, ['diff', '--shortstat', mergeBase, runBranch]).trim();
  const runs = relatedRuns(root, runId).map((run) => ({
    runId: run.runId,
    runBranch: run.runBranch,
    tasks: Object.fromEntries(Object.entries(run.tasks).map(([id, entry]) => [id, entry.status])),
    diagnostics: run.diagnostics ? { failed: run.diagnostics.failed, tests: run.diagnostics.tests || null } : null,
  }));
  const latest = { modules: readResult(root, runId, 'modules'), integration: readResult(root, runId, 'integration') };
  const prDraftPath = path.join(pipelineDir(root), 'runs', `${runId}-pr.md`);
  fs.mkdirSync(path.dirname(prDraftPath), { recursive: true });
  fs.writeFileSync(prDraftPath, prDraft({ runBranch, base, commits, shortstat, runs, latest }), 'utf8');
  return {
    ok: true,
    runId,
    runBranch,
    base,
    mergeBase,
    behind,
    currentBranch: currentBranch(root) || null,
    commits,
    filesChanged,
    shortstat,
    runs,
    latest,
    prDraftPath,
  };
}

const COMMANDS = {
  validate: cmdValidate,
  'commit-planning': cmdCommitPlanning,
  prepare: cmdPrepare,
  claim: cmdClaim,
  'integrate-task': cmdIntegrateTask,
  diagnostics: cmdDiagnostics,
  status: cmdStatus,
  clean: cmdClean,
  finish: cmdFinish,
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
