#!/usr/bin/env node
// module-pipeline CLI. Every command prints one JSON object on stdout, on one
// line (add --pretty to indent it).
//
//   validate <manifest>                       check a manifest, plan waves, count agents per role and effort
//   commit-planning <manifest>                commit the architect's output on the run branch
//   prepare <manifest> [--stage integration]  check the project, return pending waves / the integration task,
//                                             the stage's workflow script (copied into the project) and its args
//   claim --run <id> --task <id>              (inside an agent worktree) bind the worktree to a task, print the task
//   integrate-task --run <id> --task <id>     audit a task's worktree and commit its changes on the run branch
//   diagnostics --run <id>                    run the manifest's compile and test commands on the run branch
//   record --from <workflow-output-file>      after a stage's workflow: run the module stage's diagnostics, write
//                                             the result and the report, print the summary and the next step
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
  changedLineCount,
  changedLineCountBetween,
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
  gitIdentityProblem,
  head,
  hasSandboxPlaceholders,
  isTrackable,
  isMainCheckoutOn,
  listBranches,
  listUncommitted,
  filesBetween,
  prunableWorktrees,
  mergedBranches,
  projectTopLevel,
  removeWorktree,
  runBranchCheckout,
  syncWorktreeTo,
  worktreeForBranch,
} from './lib/git.mjs';
import { estimateRun, findMissingPromptFiles, findTask, loadManifest, planWaves } from './lib/manifest.mjs';
import { canonicalPath, samePath } from './lib/paths.mjs';
import { diagnosticsLine, openItems, reportMarkdown } from './lib/report.mjs';
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
  RESULT_STAGES,
  resultPath,
  runStatePath,
  saveRunState,
  withLock,
  writeClaim,
  writeJsonAtomic,
} from './lib/state.mjs';

class UsageError extends Error {}

const RUN_BRANCH_PATTERN = 'multiagent-runs/*';
// The plugin folder, with forward slashes so it can be quoted in any shell.
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const REWORK_SUFFIX = /(-r\d+)+$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// How many review items `record` prints; the report file holds all of them.
const MAX_RECORD_ITEMS = 30;

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

/** The project's files as committed on a branch, for when the main checkout is on another one. */
function committedFiles(root, ref) {
  return {
    exists: (rel) => git(root, ['cat-file', '-e', `${ref}:${rel.replace(/\/+$/, '')}`], { allowFail: true }) !== null,
    read: (rel) => git(root, ['show', `${ref}:${rel}`]),
  };
}

const relativeTo = (root, file) => path.relative(root, file).replace(/\\/g, '/');

/**
 * The manifest a command was given, and where the files it names are read.
 * Planning output is committed on the run branch. While the main checkout is
 * on that branch the working tree is the place to look; while it is on
 * another branch (the user switched away, or the sandbox keeps the main
 * checkout read-only) the manifest and its files come from the run branch.
 * @returns {{manifest: object, files: object|undefined, source: 'working-tree'|'run-branch'}}
 */
function resolveManifest(positional) {
  if (!positional[0]) {
    throw new UsageError('A manifest path is required.');
  }
  // Canonical, so it compares with git's paths whatever spelling the caller used (Windows 8.3 short names).
  const absolute = canonicalPath(path.resolve(positional[0]));
  if (fs.existsSync(absolute)) {
    const manifest = loadManifest(absolute);
    const root = manifest.projectRoot;
    const branch = getRunBranchName(manifest.runId);
    const rel = relativeTo(root, absolute);
    const onBranch = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
    if (onBranch && !isMainCheckoutOn(root, branch)) {
      const files = committedFiles(root, branch);
      if (files.exists(rel)) {
        return { manifest: loadManifest(absolute, files.read(rel)), files, source: 'run-branch' };
      }
    }
    return { manifest, files: undefined, source: 'working-tree' };
  }
  let root = null;
  try {
    root = projectTopLevel(process.cwd());
  } catch {
    root = null;
  }
  const rel = root ? relativeTo(root, absolute) : '..';
  if (!rel.startsWith('..')) {
    for (const branch of listBranches(root, RUN_BRANCH_PATTERN)) {
      const files = committedFiles(root, branch);
      if (!files.exists(rel)) {
        continue;
      }
      // Rework branches carry the earlier runs' manifests too: the one that names this branch is the run's own.
      const manifest = loadManifest(absolute, files.read(rel));
      if (getRunBranchName(manifest.runId) === branch) {
        return { manifest, files, source: 'run-branch' };
      }
    }
  }
  throw new UsageError(`Manifest not found: ${absolute}. It is not in the working tree, and no run branch holds it.`);
}

/** The manifest of a run that already started, read from the run branch when the main checkout is elsewhere. */
function loadRunManifest(root, state) {
  if (!isMainCheckoutOn(root, state.runBranch)) {
    const files = committedFiles(root, state.runBranch);
    const rel = relativeTo(root, state.manifestPath);
    if (files.exists(rel)) {
      return loadManifest(state.manifestPath, files.read(rel));
    }
  }
  return loadManifest(state.manifestPath);
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
    supportFolder: task.supportFolder || null,
    promptFile: task.promptFile,
    report: task.moduleReport || task.integrationReport || task.patchReport,
    interfaceRequest: task.interfaceRequest,
    allowedFiles: task.allowedFiles,
    acceptance: task.acceptance,
    dependsOn: task.dependsOn || [],
    effort: task.effort,
    ...(task.maxChangedLines ? { maxChangedLines: task.maxChangedLines } : {}),
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

/**
 * Copies a stage's workflow script into the project and returns the copy's
 * path. Claude Code runs a workflow script only from a folder the session can
 * read, which the plugin cache is not; `.multiagent/` is git-ignored.
 */
function stageWorkflowScript(root, name) {
  const target = path.join(pipelineDir(root), 'workflows', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_ROOT, 'workflows', name), target);
  return target.replace(/\\/g, '/');
}

/**
 * Problems that would break a workflow run before any agent starts. prepare
 * runs in the Claude Code session's directory, and Claude Code creates agent
 * worktrees from that directory's repository, so it must be the project.
 */
function sessionProblems(root) {
  const problems = [];
  let sessionRoot = null;
  try {
    sessionRoot = projectTopLevel(process.cwd());
  } catch {
    sessionRoot = null;
  }
  if (!sessionRoot || !samePath(sessionRoot, root)) {
    problems.push(
      `The Claude Code session is in ${process.cwd()}, not in the project ${root}. Agent worktrees are created from the ` +
        `session's repository, so move the session into ${root} (and keep it there) before running the pipeline.`,
    );
  }
  const identity = gitIdentityProblem(root);
  if (identity) {
    problems.push(identity);
  }
  return problems;
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

/**
 * What the planning session must know when it runs inside the Bash sandbox:
 * left alone, it sees the placeholders in `git status`, expects the commit to
 * fail on them and hides them with ignore rules that later hide real files.
 */
function planningSandboxNote(root) {
  return hasSandboxPlaceholders(root)
    ? {
        sandboxNote:
          'This shell is sandboxed. The untracked entries `git status` lists that are not files or folders (.bashrc, .mcp.json, .claude/skills, …) are placeholders the sandbox creates, not project content. commit-planning skips them: leave them alone, and add no .gitignore or .git/info/exclude lines for them.',
      }
    : {};
}

// ---- commands -----------------------------------------------------------------

function cmdValidate({ positional }) {
  const { manifest, files } = resolveManifest(positional);
  const errors = findMissingPromptFiles(manifest, files);
  return {
    ok: errors.length === 0,
    errors,
    warnings: manifest.warnings,
    runId: manifest.runId,
    projectRoot: manifest.projectRoot,
    mode: manifest.patch ? 'patch' : 'modules',
    patch: manifest.patch ? taskInfo(manifest.patch) : null,
    modules: manifest.tasks.map((task) => ({ id: task.id, owns: task.ownedFolder || task.ownedScript })),
    sharedLayer: manifest.sharedLayer,
    sizing: manifest.sizing,
    waves: planWaves(manifest.tasks).map((wave) => wave.map((task) => task.id)),
    integration: Boolean(manifest.integration),
    generatedFiles: manifest.generatedFiles,
    diagnostics: { compile: manifest.diagnostics.compileCommand, tests: manifest.diagnostics.testCommand },
    estimate: estimateRun(manifest),
    ...planningSandboxNote(manifest.projectRoot),
  };
}

function cmdCommitPlanning({ positional }) {
  const manifest = requireManifestArg(positional);
  ensureProjectRepo(manifest);
  const root = manifest.projectRoot;
  const identity = gitIdentityProblem(root);
  if (identity) {
    return { ok: false, errors: [identity] };
  }
  ensureExcluded(root);
  const branch = ensureRunBranch(root, getRunBranchName(manifest.runId));
  const files = listUncommitted(root);
  if (!files.length) {
    return { ok: true, committed: false, branch: getRunBranchName(manifest.runId), createdBranch: branch.created, ...planningSandboxNote(root) };
  }
  const commit = commitFiles(root, files, `module-pipeline(${manifest.runId}): planning output`);
  const readOnly = readOnlyEntries(root, mergeTargets(manifest));
  return {
    ok: true,
    committed: true,
    commit,
    files,
    branch: getRunBranchName(manifest.runId),
    createdBranch: branch.created,
    ...planningSandboxNote(root),
    ...(readOnly.length
      ? {
          readOnlyNote:
            `The main checkout is now on ${getRunBranchName(manifest.runId)}, and this shell cannot write it (${readOnly.slice(0, 6).join(', ')}${readOnly.length > 6 ? ', …' : ''}). ` +
            'Before /module-pipeline:run, the user has to switch it to another branch from their own terminal (for example `git switch main`); a `git switch` from this shell would leave the files behind.',
        }
      : {}),
  };
}

/**
 * True when an earlier invocation's implementer finished this module but the
 * run stopped (a usage limit, a closed session) before its reviewer merged
 * it: the newest claim's worktree, or its branch, holds the module report,
 * which the implementer writes last. Such a module goes straight to its
 * reviewer instead of being implemented again. A module whose merge was
 * already attempted (a violation, say) is never resumed.
 */
function finishedUnmerged(root, state, task) {
  if (state.tasks[task.id]) {
    return false;
  }
  const [claim] = listClaims(root)
    .filter((entry) => entry.runId === state.runId && entry.taskId === task.id)
    .sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt)));
  if (!claim) {
    return false;
  }
  if (fs.existsSync(claim.worktree)) {
    return fs.existsSync(path.join(claim.worktree, task.moduleReport));
  }
  return Boolean(claim.branch) && git(root, ['cat-file', '-e', `${claim.branch}:${task.moduleReport}`], { allowFail: true }) !== null;
}

const READ_ONLY_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);

/**
 * The top-level entries of the checkout under which this process may not
 * write `paths` (files, folders or scope patterns, relative to the root).
 * Only the paths that will be written are looked at: the sandbox also keeps
 * its own list read-only (.vscode, .idea, .mcp.json and more), and a project
 * that tracks one of those is not read-only for the pipeline. Where the
 * sandbox denies a path that does not exist yet, it puts a placeholder there
 * that is neither a file nor a folder; nothing can be created below it.
 */
function readOnlyEntries(root, paths) {
  const blocked = new Set();
  for (const target of paths) {
    const segments = [];
    for (const segment of String(target).split('/').filter(Boolean)) {
      if (/[*?[]/.test(segment)) {
        break;
      }
      segments.push(segment);
    }
    const top = segments[0];
    if (!top || blocked.has(top)) {
      continue;
    }
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const rel = segments.slice(0, depth).join('/');
      if (!isTrackable(root, rel)) {
        blocked.add(top);
        break;
      }
      try {
        fs.accessSync(path.join(root, rel), fs.constants.W_OK);
      } catch (error) {
        // A file git replaces by removing it, so its own mode says nothing; a read-only mount does.
        const isFolder = fs.statSync(path.join(root, rel), { throwIfNoEntry: false })?.isDirectory();
        if (error.code === 'EROFS' || (isFolder && READ_ONLY_CODES.has(error.code))) {
          blocked.add(top);
        }
        break; // not there yet (the folder above decides, and it is writable), or decided
      }
    }
  }
  return [...blocked].sort();
}

/** Every path the stages of this manifest write when they merge: module folders, tests, reports, glue files. */
function mergeTargets(manifest) {
  return [...manifest.tasks, manifest.integration, manifest.patch].filter(Boolean).flatMap((entry) => entry.allowedFiles || []);
}

/**
 * For the stages that change the main checkout (rework switches it to the
 * run branch, finish merges into the base branch). With read-only paths git
 * still moves the branch and reports success, but leaves the files as they
 * were: the checkout ends up half switched. So the session is told not to try.
 */
function readOnlyCheckout(root, files) {
  const readOnly = readOnlyEntries(root, files);
  return readOnly.length
    ? {
        readOnly,
        readOnlyNote:
          `This shell cannot change these paths of the main checkout (${readOnly.slice(0, 6).join(', ')}${readOnly.length > 6 ? ', …' : ''}): Claude Code's sandbox denies writing them. ` +
          'Do not run `git switch`, `git checkout` or `git merge` here: git would move the branch and report success while leaving the files as they were. ' +
          'Give the user the exact commands to run in their own terminal, and continue once they say it is done.',
      }
    : {};
}

function cmdPrepare({ positional, flags }) {
  const { manifest, files, source } = resolveManifest(positional);
  ensureProjectRepo(manifest);
  const root = manifest.projectRoot;
  ensureExcluded(root);

  const runBranch = getRunBranchName(manifest.runId);
  const errors = [...sessionProblems(root), ...findMissingPromptFiles(manifest, files)];
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
  // A merge commits in the main checkout while it is on the run branch. Where
  // the sandbox makes project paths read-only (sandbox.filesystem.denyWrite),
  // that fails halfway through `git apply`, so say it before any agent starts.
  const readOnly = isMainCheckoutOn(root, runBranch) ? readOnlyEntries(root, mergeTargets(manifest)) : [];
  if (readOnly.length) {
    errors.push(
      `The main checkout is on the run branch, but it cannot be written here (${readOnly.slice(0, 6).join(', ')}${readOnly.length > 6 ? ', …' : ''}): ` +
        "Claude Code's sandbox denies writing these paths. Merges would fail. Switch the main checkout to another branch " +
        '(for example `git switch main`, from your own terminal: the sandbox stops a sandboxed git from changing these paths too) ' +
        'and run this again. The pipeline then merges in its own worktree under .multiagent/.',
    );
  }
  if (errors.length) {
    // `uncommitted` lets the session ask the user and run commit-planning without a git call of its own.
    return { ok: false, errors, uncommitted, readOnly, runBranch };
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
    manifestSource: source,
    goal: manifest.goal,
    spec: manifest.project.spec,
    model: manifest.model,
    efforts: manifest.efforts,
    warnings: manifest.warnings,
    sizing: manifest.sizing,
    estimate: estimateRun(manifest, new Set(merged)),
  };
  // What the stage's workflow needs, passed to it unchanged as its args. The
  // agents read everything else from the claim and merge output.
  const workflowBase = {
    pluginRoot: PLUGIN_ROOT,
    runId: manifest.runId,
    runBranch: state.runBranch,
    goal: manifest.goal,
    model: manifest.model,
    efforts: manifest.efforts,
    rules: manifest.sharedLayer?.rules || null,
  };

  if (manifest.patch) {
    if (flags.stage === 'integration') {
      return { ok: false, errors: ['A patch run has no integration stage; its reviewer runs the diagnostics.'] };
    }
    const patch = merged.includes(manifest.patch.id) ? null : taskInfo(manifest.patch);
    return {
      ...base,
      mode: 'patch',
      patch,
      workflowScript: stageWorkflowScript(root, 'patch-run.js'),
      sharedLayer: manifest.sharedLayer,
      workflowArgs: {
        ...workflowBase,
        mode: 'patch',
        patch: patch ? { effort: patch.effort, maxChangedLines: patch.maxChangedLines } : null,
      },
    };
  }

  if (flags.stage === 'integration') {
    if (!manifest.integration) {
      return { ok: false, errors: ['The manifest has no integration section.'] };
    }
    const unmerged = manifest.tasks.filter((task) => !merged.includes(task.id)).map((task) => task.id);
    if (unmerged.length) {
      return { ok: false, errors: [`Modules not merged yet: ${unmerged.join(', ')}. Finish /module-pipeline:run first.`] };
    }
    const integration = state.tasks.integration?.status === 'merged' ? null : taskInfo(manifest.integration);
    return {
      ...base,
      integration,
      // The module stage's recorded gate; anything but `passed` deserves a question before integrating.
      modulesStatus: readResult(root, manifest.runId, 'modules')?.status || null,
      modules: manifest.tasks.map((task) => task.id),
      workflowScript: stageWorkflowScript(root, 'integrate-system.js'),
      workflowArgs: {
        ...workflowBase,
        spec: manifest.project.spec,
        manifest: manifest.manifestPath.replace(/\\/g, '/'),
        integration: integration ? { effort: integration.effort } : null,
        modules: manifest.tasks.map((task) => task.id),
      },
    };
  }

  const waves = planWaves(manifest.tasks, new Set(merged)).map((wave) => wave.map(taskInfo));
  const resumable = new Set(manifest.tasks.filter((task) => finishedUnmerged(root, state, task)).map((task) => task.id));
  return {
    ...base,
    skipped: merged,
    resumable: [...resumable],
    sharedLayer: manifest.sharedLayer,
    waves,
    workflowScript: stageWorkflowScript(root, 'implement-modules.js'),
    workflowArgs: {
      ...workflowBase,
      skipped: merged,
      waves: waves.map((wave) =>
        wave.map((task) => ({
          id: task.id,
          dependsOn: task.dependsOn.filter((id) => !merged.includes(id)),
          effort: task.effort,
          ...(resumable.has(task.id) ? { resume: true } : {}),
        })),
      ),
    },
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
  const manifest = loadRunManifest(root, state);
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
  // The agent's task, so the workflow prompt only has to name it.
  return {
    ok: true,
    // In Claude Code's Bash sandbox the worktree holds device-node placeholders that git cannot add.
    ...(hasSandboxPlaceholders(gitInfo.root)
      ? { sandboxNote: 'This shell is sandboxed. `git add -A` fails here on placeholder entries the sandbox creates (.mcp.json, .claude/…): name the paths you add, or do not commit at all; uncommitted work in your allowed files is merged as it is.' }
      : {}),
    worktree: claim.worktree,
    base: claim.base,
    syncedToRunBranch: synced,
    task: taskInfo(task),
    sharedLayer: manifest.sharedLayer?.taskId === taskId ? null : manifest.sharedLayer?.paths || null,
    rules: manifest.sharedLayer?.rules || null,
  };
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

/** The files a patch's size is measured by: what it fixes, not the report the patcher writes about it. */
function sizedFiles(task, files) {
  const paperwork = new Set([task.patchReport, task.interfaceRequest].filter(Boolean));
  return files.filter((file) => !paperwork.has(file));
}

// A patch run is for small fixes; a larger one belongs on the full module path.
// Its worktree is kept so the work is not lost.
function sizeProblem(task, changedLines) {
  if (task.kind !== 'patch' || changedLines <= task.maxChangedLines) {
    return null;
  }
  return {
    status: 'too_large',
    changedLines,
    maxChangedLines: task.maxChangedLines,
    reason: `The patch changes ${changedLines} lines, more than its limit of ${task.maxChangedLines}. Rework it on the module path.`,
  };
}

/** A merged patch says how large it was, so the report need not count again. */
const patchSize = (task, changedLines) => (task.kind === 'patch' ? { changedLines, maxChangedLines: task.maxChangedLines } : {});

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
  const changedLines = changedLineCountBetween(root, claim.base, tip, sizedFiles(task, inScope));
  const tooLarge = sizeProblem(task, changedLines);
  if (tooLarge) {
    return { ...tooLarge, files: inScope, branch: claim.branch };
  }
  const patch = createPatchBetween(root, claim.base, tip, inScope, patchPath(root, state.runId, task.id));
  const { commit, via } = commitTask(root, state, task, patch);
  deleteBranch(root, claim.branch);
  dropClaims(root, claims);
  return { status: 'merged', commit, via, files: inScope, dropped, recoveredFromBranch: claim.branch, ...patchSize(task, changedLines) };
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
  const changedLines = changedLineCount(claim.worktree, claim.base, sizedFiles(task, inScope));
  const tooLarge = sizeProblem(task, changedLines);
  if (tooLarge) {
    return { ...tooLarge, files: inScope, worktree: claim.worktree };
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
  return { status: 'merged', commit, via, files: inScope, dropped, ...patchSize(task, changedLines) };
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
    const manifest = loadRunManifest(root, state);
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
    // The reviewer runs this merge, then reviews against the task below.
    return {
      ok: outcome.status === 'merged',
      taskId,
      ...outcome,
      task: taskInfo(task),
      sharedLayer: manifest.sharedLayer?.taskId === taskId ? null : manifest.sharedLayer?.paths || null,
      rules: manifest.sharedLayer?.rules || null,
    };
  });
}

function requireRunState(root, runId) {
  const state = loadRunState(root, runId);
  if (!state) {
    throw new Error(`No pipeline run ${runId} in ${root}.`);
  }
  return state;
}

/** Runs the manifest's compile and test commands on the run branch and stores the outcome in the run state. */
function diagnose(root, runId) {
  const state = requireRunState(root, runId);
  const manifest = loadRunManifest(root, state);
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
  return { ...result, checkout, logPath };
}

function cmdDiagnostics({ flags }) {
  const result = diagnose(projectTopLevel(process.cwd()), requireFlag(flags, 'run'));
  return { ok: !result.failed, ...result };
}

// ---- record -------------------------------------------------------------------

/**
 * The stage result inside a file: the output file of the workflow run (which
 * wraps it in `result`), or the bare result object.
 */
function readStageResult(file) {
  let parsed;
  try {
    const text = fs.readFileSync(file, 'utf8');
    parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (error) {
    throw new Error(`Could not read a JSON result from ${file}: ${error.message}`);
  }
  const result = parsed?.result?.stage ? parsed.result : parsed;
  if (!RESULT_STAGES.includes(result?.stage) || !SAFE_RUN_ID.test(String(result.runId)) || typeof result.status !== 'string') {
    throw new Error(
      `${file} does not hold a stage result. Pass the output file the workflow's completion notice names, ` +
        'or a file with the object the workflow returned (stage, runId, status, …).',
    );
  }
  return result;
}

/** Source lines each module changed on the run branch, to compare with the plan's estimate. */
function moduleSizes(root, state, manifest) {
  const tip = branchTip(root, state.runBranch);
  if (!manifest || !state.baseCommit || !tip) {
    return null;
  }
  const perModule = manifest.tasks.map((task) => ({
    id: task.id,
    lines: changedLineCountBetween(root, state.baseCommit, tip, [task.ownedFolder || task.ownedScript]),
  }));
  return {
    estimatedLines: manifest.project.estimatedLines,
    builtLines: perModule.reduce((total, entry) => total + entry.lines, 0),
    perModule,
  };
}

const NEXT_COMMAND = {
  integrate: (runId, manifest) => `/module-pipeline:integrate ${manifest}`,
  finish: (runId) => `/module-pipeline:finish ${runId}`,
  rework: (runId) => `/module-pipeline:rework ${runId}`,
};

/**
 * Finishes a stage after its workflow returned: runs the diagnostics of the
 * module stage, writes the result and the report beside the run state, and
 * prints only what the session has to tell the user.
 */
function cmdRecord({ flags }) {
  const result = readStageResult(path.resolve(requireFlag(flags, 'from')));
  const { stage, runId } = result;
  const root = projectTopLevel(process.cwd());
  const state = requireRunState(root, runId);
  let manifest = null;
  try {
    manifest = loadRunManifest(root, state);
  } catch {
    manifest = null;
  }

  if (stage === 'modules') {
    const anyMerged = Object.values(state.tasks).some((entry) => entry.status === 'merged');
    if (anyMerged) {
      const { checkout, warnings, ...diagnostics } = diagnose(root, runId);
      result.diagnostics = { ...diagnostics, warnings: (warnings || []).slice(0, 5) };
      if (result.status === 'passed' && diagnostics.failed) {
        result.status = 'diagnostics_failed';
      }
    }
    result.size = moduleSizes(root, state, manifest);
  }
  const passed = result.status === 'passed';
  result.next = !passed ? 'rework' : stage === 'modules' && manifest?.integration ? 'integrate' : 'finish';
  // prepare required a clean checkout, and merges commit what they apply, so
  // anything uncommitted on the run branch now was written around the
  // pipeline: by a build or test command, an agent's shell, or the user.
  result.strayChanges = isMainCheckoutOn(root, state.runBranch) ? listUncommitted(root) : [];

  const reportPath = path.join(pipelineDir(root), 'runs', `${runId}-${stage}-report.md`);
  writeJsonAtomic(resultPath(root, runId, stage), result);
  fs.writeFileSync(reportPath, reportMarkdown(result), 'utf8');

  const items = openItems(result);
  const manifestArg = path.relative(root, state.manifestPath).replace(/\\/g, '/');
  return {
    ok: true,
    stage,
    runId,
    status: result.status,
    next: result.next,
    nextCommand: NEXT_COMMAND[result.next](runId, manifestArg),
    modules: (result.modules || []).map((module) => ({ task: module.task, status: module.status, reason: module.reason || module.error || undefined })),
    merge: stage === 'modules' ? undefined : (result.integration || result.merge || null),
    diagnostics: diagnosticsLine(result.diagnostics),
    items: items.slice(0, MAX_RECORD_ITEMS),
    itemCount: items.length,
    blockingCount: items.filter((item) => item.blocking).length,
    ruleViolations: result.ruleViolations || undefined,
    coverageGaps: result.coverageGaps || undefined,
    strayChanges: result.strayChanges.length ? result.strayChanges.slice(0, MAX_RECORD_ITEMS) : undefined,
    size: result.size || undefined,
    resultPath: resultPath(root, runId, stage),
    reportPath,
  };
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
    // rework switches the main checkout to the run branch it was asked about.
    ...(flags.run ? readOnlyCheckout(root, runs.flatMap((run) => filesBetween(root, 'HEAD', run.runBranch))) : {}),
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
        git(root, ['worktree', 'remove', '--force', '--force', worktree], { allowFail: true });
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
    // Inside the Bash sandbox git cannot delete these records; they are harmless, and one
    // `git worktree prune` from the user's own terminal removes them.
    const prunable = prunableWorktrees(root);
    let branches = null;
    if (flags.branches) {
      const into = detectBaseBranch(root, optionalFlag(flags, 'into'));
      branches = { into, ...cleanBranches(root, matches, into, dryRun) };
    }
    return { ok: true, dryRun, run: runFilter, claims, mergeWorktrees, branches, ...(prunable.length ? { prunable } : {}) };
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
  const result = readJson(resultPath(root, runId, stage));
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
  const open = [
    ...(latest.modules?.blockingItems || []),
    ...(latest.integration?.blockingItems || []),
    ...(latest.patch?.blockingItems || []),
  ];
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
  const latest = Object.fromEntries(RESULT_STAGES.map((stage) => [stage, readResult(root, runId, stage)]));
  const prDraftPath = path.join(pipelineDir(root), 'runs', `${runId}-pr.md`);
  fs.mkdirSync(path.dirname(prDraftPath), { recursive: true });
  fs.writeFileSync(prDraftPath, prDraft({ runBranch, base, commits, shortstat, runs, latest }), 'utf8');
  return {
    ok: true,
    runId,
    family: runId.replace(REWORK_SUFFIX, ''),
    runBranch,
    base,
    mergeBase,
    behind,
    currentBranch: currentBranch(root) || null,
    uncommitted: listUncommitted(root),
    // A merge into the base branch writes what the run changed, and first what differs between here and the base.
    ...readOnlyCheckout(root, [...filesChanged, ...filesBetween(root, 'HEAD', base)]),
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
  record: cmdRecord,
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
  // Compact by default: agents read it and sometimes copy parts of it, and
  // every byte costs time. --pretty indents for humans.
  const pretty = process.argv.includes('--pretty');
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`);
  process.exitCode = code;
}
