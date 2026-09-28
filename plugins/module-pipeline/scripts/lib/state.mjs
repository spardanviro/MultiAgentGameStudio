// Pipeline state under <project>/.multiagent/pipeline/:
//   runs/<runId>.json      task outcomes for a run (survives sessions)
//   claims/<hash>.json     which task a worktree belongs to (read by the hook)
//   patches/<run>/<task>.patch
//   merge/<runId>/         detached worktree for commits while the main checkout is elsewhere
//   lock                   serializes merges into the project
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, pathKey } from './paths.mjs';

const LOCK_WAIT_MS = 120000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 100;

export function pipelineDir(root) {
  return path.join(root, '.multiagent', 'pipeline');
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function runStatePath(root, runId) {
  return path.join(pipelineDir(root), 'runs', `${runId}.json`);
}

export function loadRunState(root, runId) {
  return readJson(runStatePath(root, runId));
}

export function saveRunState(root, state) {
  writeJsonAtomic(runStatePath(root, state.runId), { ...state, updatedAt: new Date().toISOString() });
}

export function patchPath(root, runId, taskId) {
  return path.join(pipelineDir(root), 'patches', runId, `${taskId}.patch`);
}

/** Detached worktree used to commit and check a run while the main checkout is elsewhere. */
export function mergeWorktreePath(root, runId) {
  return path.join(pipelineDir(root), 'merge', runId);
}

export function listRunIds(root) {
  const dir = path.join(pipelineDir(root), 'runs');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !/-(modules|integration)-result\.json$/.test(name))
    .map((name) => name.slice(0, -5));
}

// ---- claims -----------------------------------------------------------------

export function claimPath(root, worktreeRoot) {
  const hash = crypto.createHash('sha1').update(pathKey(worktreeRoot)).digest('hex').slice(0, 16);
  return path.join(pipelineDir(root), 'claims', `${hash}.json`);
}

export function readClaim(root, worktreeRoot) {
  return readJson(claimPath(root, worktreeRoot));
}

export function writeClaim(root, claim) {
  writeJsonAtomic(claimPath(root, claim.worktree), claim);
}

export function removeClaim(root, worktreeRoot) {
  fs.rmSync(claimPath(root, worktreeRoot), { force: true });
}

export function listClaims(root) {
  const dir = path.join(pipelineDir(root), 'claims');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter(Boolean);
}

/**
 * Walk up from `start` to the directory holding `.git`. For a linked
 * worktree `.git` is a file pointing at <main>/.git/worktrees/<name>.
 * @returns {{root: string, isLinkedWorktree: boolean, gitDir: string}|null}
 */
export function findGitRoot(start) {
  let dir = canonicalPath(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) {
      return { root: dir, isLinkedWorktree: false, gitDir: dotGit };
    }
    if (stat?.isFile()) {
      const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
      if (match) {
        return { root: dir, isLinkedWorktree: true, gitDir: canonicalPath(path.resolve(dir, match[1].trim())) };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** The main project root that owns a linked worktree. */
export function projectRootForWorktree(gitInfo) {
  if (!gitInfo.isLinkedWorktree) {
    return gitInfo.root;
  }
  const commondirFile = path.join(gitInfo.gitDir, 'commondir');
  const commonDir = fs.existsSync(commondirFile)
    ? path.resolve(gitInfo.gitDir, fs.readFileSync(commondirFile, 'utf8').trim())
    : path.resolve(gitInfo.gitDir, '..', '..');
  return canonicalPath(path.dirname(commonDir));
}

// ---- lock -------------------------------------------------------------------

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run fn while holding the project's pipeline lock (merges touch one index). */
export function withLock(root, fn) {
  const lockPath = path.join(pipelineDir(root), 'lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${lockPath}`);
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}
