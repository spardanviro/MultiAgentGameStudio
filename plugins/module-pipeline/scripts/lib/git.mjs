// Git operations for a pipeline run. Each run works on branch
// multiagent-runs/<runId>; every accepted module becomes one commit there, so
// worktrees created from its tip already contain earlier modules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, samePath } from './paths.mjs';

// Paths that belong to the pipeline or the Claude harness, never to the user.
const IGNORED_PREFIXES = ['.multiagent/', '.claude/worktrees/'];
const EXCLUDE_LINES = ['/.multiagent/', '/.claude/worktrees/'];

export function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (options.allowFail) {
      return null;
    }
    const stderr = String(error.stderr || '').trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

export function getRunBranchName(runId) {
  return `multiagent-runs/${runId}`;
}

export function projectTopLevel(cwd) {
  return canonicalPath(git(cwd, ['rev-parse', '--show-toplevel']).trim());
}

export function head(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

export function currentBranch(cwd) {
  return git(cwd, ['branch', '--show-current']).trim();
}

/** Keep pipeline and harness folders out of `git status` via .git/info/exclude. */
export function ensureExcluded(root) {
  const excludePath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = EXCLUDE_LINES.filter((line) => !present.has(line));
  if (!missing.length) {
    return false;
  }
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludePath, `${prefix}# module-pipeline run data\n${missing.join('\n')}\n`, 'utf8');
  return true;
}

// `git status --porcelain -z`: "XY path\0"; renames/copies add the original
// path as an extra field.
function parsePorcelainZ(output) {
  const fields = output.split('\0');
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) {
      continue;
    }
    files.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') {
      files.push(fields[index + 1]);
      index += 1;
    }
  }
  return files;
}

/**
 * False for an entry git lists but could never track: a device node, a
 * socket, a pipe. Claude Code's Bash sandbox on Linux binds /dev/null over
 * the configuration paths it protects (.mcp.json, .claude/skills, .bashrc and
 * more) in the working directory. Inside the sandbox they look like untracked
 * files; they are not project content, and `git add` refuses them.
 */
export function isTrackable(root, file) {
  try {
    const stat = fs.lstatSync(path.join(root, file));
    return stat.isFile() || stat.isSymbolicLink() || stat.isDirectory();
  } catch {
    return true; // deleted or unreadable: still a change worth reporting
  }
}

/**
 * True when the folder holds the sandbox's placeholder entries, so commands
 * here run inside Claude Code's Bash sandbox.
 */
export function hasSandboxPlaceholders(root) {
  return ['.mcp.json', '.claude/commands', '.claude/skills', '.claude/settings.local.json'].some((entry) => !isTrackable(root, entry));
}

/** Uncommitted changes agents would not see (their worktrees start at HEAD). */
export function listUncommitted(root) {
  const output = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return [...new Set(parsePorcelainZ(output))].filter(
    (file) => file && !IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix)) && isTrackable(root, file),
  );
}

export function commitFiles(root, files, message) {
  git(root, ['add', '-A', '--', ...files]);
  git(root, ['commit', '-m', message]);
  return head(root);
}

/**
 * Put the project on the run branch, creating it from HEAD the first time.
 */
export function ensureRunBranch(root, runBranch) {
  const current = currentBranch(root);
  if (current === runBranch) {
    return { created: false, previousBranch: current };
  }
  const exists = git(root, ['branch', '--list', runBranch]).trim();
  if (exists) {
    throw new Error(
      `The project is on "${current || 'a detached HEAD'}", but run branch ${runBranch} already exists. Run \`git switch ${runBranch}\` first.`,
    );
  }
  git(root, ['switch', '-c', runBranch]);
  return { created: true, previousBranch: current || null };
}

/** A readable error when commits would fail for lack of user.name / user.email, else null. */
export function gitIdentityProblem(root) {
  const missing = ['user.name', 'user.email'].filter((key) => !git(root, ['config', key], { allowFail: true })?.trim());
  return missing.length
    ? `git has no ${missing.join(' / ')} for ${root}, so commits would fail. Set them, e.g. git -C "${root}" config user.name "Your Name" and git -C "${root}" config user.email "you@example.com".`
    : null;
}

/** Make sure the run branch exists without moving the main checkout off its current branch. */
export function ensureRunBranchExists(root, runBranch) {
  if (branchTip(root, runBranch)) {
    return { created: false };
  }
  return { created: true, ...ensureRunBranch(root, runBranch) };
}

/** The worktree that has `branch` checked out, or null. */
export function worktreeForBranch(root, branch) {
  const output = git(root, ['worktree', 'list', '--porcelain']);
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length);
    } else if (line === `branch refs/heads/${branch}` && current) {
      return canonicalPath(current);
    }
  }
  return null;
}

export function isMainCheckoutOn(root, branch) {
  const holder = worktreeForBranch(root, branch);
  return Boolean(holder && samePath(holder, root));
}

export function isClean(worktree) {
  const output = git(worktree, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return !parsePorcelainZ(output).some((file) => file && isTrackable(worktree, file));
}

/** Move a clean worktree to `commit`; used to start agents from the run branch tip. */
export function syncWorktreeTo(worktree, commit) {
  if (head(worktree) === commit) {
    return false;
  }
  if (!isClean(worktree)) {
    throw new Error(`The worktree already has changes and does not start at the run branch tip ${commit.slice(0, 12)}.`);
  }
  git(worktree, ['reset', '--quiet', '--hard', commit]);
  return true;
}

/**
 * A detached worktree at the run branch tip, used to commit and check the
 * run while the main checkout is on another branch.
 */
export function ensureMergeWorktree(root, mergePath, tip) {
  const usable =
    fs.existsSync(path.join(mergePath, '.git')) &&
    git(mergePath, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) !== null;
  if (!usable) {
    // Missing, or a leftover folder git no longer knows as a worktree.
    fs.rmSync(mergePath, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
    fs.mkdirSync(path.dirname(mergePath), { recursive: true });
    git(root, ['worktree', 'add', '--detach', mergePath, tip]);
    return mergePath;
  }
  git(mergePath, ['reset', '--quiet', '--hard']);
  git(mergePath, ['clean', '-fdq']);
  git(mergePath, ['checkout', '--quiet', '--detach', tip]);
  return mergePath;
}

/**
 * Commit a patch on the run branch. When the main checkout is on the run
 * branch the patch is committed there (project hooks see its installed
 * dependencies). Otherwise it is committed in the detached merge worktree
 * and the branch ref is moved, leaving the main checkout alone.
 */
export function commitPatchOnRunBranch(root, runBranch, mergePath, patchPath, message) {
  const holder = worktreeForBranch(root, runBranch);
  if (holder && samePath(holder, root)) {
    return { commit: applyAndCommitPatch(root, patchPath, message), via: 'main-checkout' };
  }
  if (holder) {
    throw new Error(`Run branch ${runBranch} is checked out in ${holder}; switch that worktree away from it or back to the main checkout.`);
  }
  const tip = branchTip(root, runBranch);
  if (!tip) {
    throw new Error(`Run branch ${runBranch} does not exist.`);
  }
  ensureMergeWorktree(root, mergePath, tip);
  const commit = applyAndCommitPatch(mergePath, patchPath, message);
  git(root, ['update-ref', `refs/heads/${runBranch}`, commit, tip]);
  return { commit, via: 'merge-worktree' };
}

/**
 * Where the run branch's files can be read and built: the main checkout when
 * it is on the run branch, otherwise the merge worktree moved to the tip.
 */
export function runBranchCheckout(root, runBranch, mergePath) {
  if (isMainCheckoutOn(root, runBranch)) {
    return root;
  }
  const tip = branchTip(root, runBranch);
  if (!tip) {
    throw new Error(`Run branch ${runBranch} does not exist.`);
  }
  return ensureMergeWorktree(root, mergePath, tip);
}

export function mergedBranches(root, pattern, target) {
  const output = git(root, ['branch', '--format=%(refname:short)', '--list', pattern, '--merged', target]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function listBranches(root, pattern) {
  const output = git(root, ['branch', '--format=%(refname:short)', '--list', pattern]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Files changed in a worktree relative to its base commit, including untracked ones. */
export function changedFiles(worktree, base) {
  const tracked = git(worktree, ['diff', '--name-only', '-z', base]).split('\0');
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter((file) => file && isTrackable(worktree, file));
  return [...new Set([...tracked, ...untracked].map((file) => file.trim()).filter(Boolean))].sort();
}

/** Binary patch of the allowed changes in a worktree, relative to its base. */
export function createPatch(worktree, base, allowedChanged, patchPath) {
  if (!allowedChanged.length) {
    return null;
  }
  git(worktree, ['add', '-N', '--', ...allowedChanged]);
  const diff = git(worktree, ['diff', '--binary', base, '--', ...allowedChanged]);
  if (!diff.trim()) {
    return null;
  }
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, diff, 'utf8');
  return patchPath;
}

export function branchTip(root, branch) {
  return git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })?.trim() || null;
}

export function changedBetween(root, base, tip) {
  return git(root, ['diff', '--name-only', '-z', base, tip]).split('\0').map((file) => file.trim()).filter(Boolean).sort();
}

// Added plus deleted lines in `git diff --numstat` output; binary files count as one line.
function sumNumstat(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((total, line) => {
      const [added, deleted] = line.split('\t');
      return total + (added === '-' ? 1 : Number(added) + Number(deleted));
    }, 0);
}

/** Lines changed in a worktree relative to its base, limited to files (untracked files included). */
export function changedLineCount(worktree, base, files) {
  if (!files.length) {
    return 0;
  }
  git(worktree, ['add', '-N', '--', ...files]);
  return sumNumstat(git(worktree, ['diff', '--numstat', base, '--', ...files]));
}

/** Lines changed between two commits, limited to files. */
export function changedLineCountBetween(root, base, tip, files) {
  return files.length ? sumNumstat(git(root, ['diff', '--numstat', base, tip, '--', ...files])) : 0;
}

/** Binary patch of committed changes between two commits, limited to files. */
export function createPatchBetween(root, base, tip, files, patchPath) {
  const diff = git(root, ['diff', '--binary', base, tip, '--', ...files]);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, diff, 'utf8');
  return patchPath;
}

export function deleteBranch(root, branch) {
  return git(root, ['branch', '-D', branch], { allowFail: true }) !== null;
}

/**
 * Apply a patch to index + working tree and commit it. Project hooks still
 * run; if the commit fails the patch is reverted and the error rethrown.
 */
export function applyAndCommitPatch(root, patchPath, message) {
  if (git(root, ['diff', '--cached', '--name-only']).trim()) {
    throw new Error('The project has staged changes; commit or unstage them before merging modules.');
  }
  git(root, ['apply', '--check', '--index', '--whitespace=nowarn', patchPath]);
  git(root, ['apply', '--index', '--whitespace=nowarn', patchPath]);
  try {
    git(root, ['commit', '-m', message]);
  } catch (error) {
    git(root, ['apply', '-R', '--index', '--whitespace=nowarn', patchPath]);
    throw new Error(`Patch could not be committed, so it was reverted (${error.message}). Check git user.name/user.email and project hooks.`);
  }
  return head(root);
}

/** Remove a finished worktree and its branch; failures are reported, not thrown. */
export function removeWorktree(root, worktree) {
  const branch = git(worktree, ['branch', '--show-current'], { allowFail: true })?.trim() || null;
  // Claude Code locks agent worktrees; a second --force removes locked ones too.
  // Inside Claude Code's sandbox git deletes the folder but reports a failure, because the sandbox
  // holds entries in the worktree's metadata folder; the folder being gone is what counts.
  const removed =
    git(root, ['worktree', 'remove', '--force', '--force', worktree], { allowFail: true }) !== null || !fs.existsSync(worktree);
  if (removed) {
    git(root, ['worktree', 'prune'], { allowFail: true });
  }
  if (removed && branch) {
    git(root, ['branch', '-D', branch], { allowFail: true });
  }
  return { removed, branch };
}
