// Git operations for a pipeline run. Each run works on branch
// multiagent-runs/<runId>; every accepted module becomes one commit there, so
// worktrees created from its tip already contain earlier modules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  return path.resolve(git(cwd, ['rev-parse', '--show-toplevel']).trim());
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

/** Uncommitted changes agents would not see (their worktrees start at HEAD). */
export function listUncommitted(root) {
  const output = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return [...new Set(parsePorcelainZ(output))].filter(
    (file) => file && !IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix)),
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

/** Files changed in a worktree relative to its base commit, including untracked ones. */
export function changedFiles(worktree, base) {
  const tracked = git(worktree, ['diff', '--name-only', '-z', base]).split('\0');
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
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
  const removed = git(root, ['worktree', 'remove', '--force', worktree], { allowFail: true }) !== null;
  if (removed && branch) {
    git(root, ['branch', '-D', branch], { allowFail: true });
  }
  return { removed, branch };
}
