// Pipeline state under <project>/.multiagent/pipeline/:
//   runs/<runId>.json      task outcomes for a run (survives sessions)
//   claims/<hash>.json     which task a worktree belongs to (read by the hook)
//   patches/<run>/<task>.patch
//   merge/<runId>/         detached worktree for commits while the main checkout is elsewhere
//   lock                   serializes merges into the project
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { canonicalPath, pathKey } from './paths.mjs';

const LOCK_WAIT_MS = 120000;
// A holder touches its lock this often while it works...
const LOCK_BEAT_MS = 2000;
// ...so a lock nobody touched for this long has lost its holder.
const LOCK_SILENT_MS = 30 * 1000;
// For a lock without a heartbeat (written by an old version, or unreadable).
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

// Workflow results the skills record beside a run's state, as <run>-<stage>-result.json.
export const RESULT_STAGES = ['modules', 'integration', 'patch'];
const RESULT_FILE = new RegExp(`-(${RESULT_STAGES.join('|')})-result\\.json$`);

export function resultPath(root, runId, stage) {
  return path.join(pipelineDir(root), 'runs', `${runId}-${stage}-result.json`);
}

/** The run's state, or null when there is none (or the file is not a run state). */
export function loadRunState(root, runId) {
  const state = readJson(runStatePath(root, runId));
  return state && typeof state.runId === 'string' && state.tasks && typeof state.tasks === 'object' ? state : null;
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
    .filter((name) => name.endsWith('.json') && !RESULT_FILE.test(name))
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

/**
 * The process-id namespace this process runs in, or null where there is no
 * such thing. Claude Code's Bash sandbox on Linux gives every command its own
 * namespace, so one pipeline command cannot see the process of another.
 */
export function pidNamespace() {
  try {
    return fs.readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

/** Who holds the lock file, or null when it is gone. Old versions wrote only the pid. */
function readLock(lockPath) {
  let text;
  let ageMs;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let holder = {};
  try {
    const parsed = JSON.parse(text);
    holder = typeof parsed === 'number' ? { pid: parsed } : parsed || {};
  } catch {
    holder = {};
  }
  return {
    pid: Number.isInteger(holder.pid) ? holder.pid : null,
    host: holder.host || os.hostname(),
    pidns: holder.pidns ?? null,
    beats: holder.beats === true,
    token: holder.token || text,
    ageMs, // time since the file was written or its holder last touched it
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

/**
 * A lock is stale when its holder is gone. How long it has been held says
 * nothing: a merge commit runs the project's git hooks, which may build or
 * test for longer than any fixed limit.
 *
 * - A holder this process can see (same machine, same pid namespace) is asked
 *   directly: alive keeps the lock, gone frees it at once.
 * - A holder it cannot see (another sandbox or machine) is judged by its
 *   heartbeat: the holder touches the file every few seconds while it works,
 *   so a file left untouched for LOCK_SILENT_MS has no holder any more.
 * - A lock without a heartbeat (an old version, an unreadable file) falls
 *   back to its age.
 */
function lockIsStale(lock) {
  if (lock.pid !== null && lock.host === os.hostname() && lock.pidns === pidNamespace()) {
    return !processIsAlive(lock.pid);
  }
  return lock.ageMs > (lock.beats ? LOCK_SILENT_MS : LOCK_STALE_MS);
}

const HEARTBEAT = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
setInterval(() => {
  try {
    if (JSON.parse(fs.readFileSync(workerData.lockPath, 'utf8')).token === workerData.token) {
      const now = new Date();
      fs.utimesSync(workerData.lockPath, now, now);
    }
  } catch {}
}, workerData.beatMs);
`;

/**
 * Touches the lock file every beatMs from another thread, because the thread
 * that holds the lock is busy in synchronous git calls. Null when threads are
 * not available; the lock then says it has no heartbeat.
 */
function startHeartbeat(lockPath, token, beatMs) {
  try {
    const worker = new Worker(HEARTBEAT, { eval: true, workerData: { lockPath, token, beatMs } });
    worker.on('error', () => {});
    worker.unref();
    return worker;
  } catch {
    return null;
  }
}

/**
 * Run fn while holding the project's pipeline lock (merges touch one index).
 * @param {{waitMs?: number, beatMs?: number}} [options] how long to wait for another holder; how often to touch the lock
 */
export function withLock(root, fn, { waitMs = LOCK_WAIT_MS, beatMs = LOCK_BEAT_MS } = {}) {
  const lockPath = path.join(pipelineDir(root), 'lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const heartbeat = startHeartbeat(lockPath, token, beatMs);
  const holder = { pid: process.pid, host: os.hostname(), pidns: pidNamespace(), beats: Boolean(heartbeat), token, startedAt: new Date().toISOString() };
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      try {
        fs.writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx' });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        const lock = readLock(lockPath);
        if (!lock) {
          continue;
        }
        // Remove a stale lock only if it is still the one that was judged stale.
        if (lockIsStale(lock) && readLock(lockPath)?.token === lock.token) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${Math.round(waitMs / 1000)} s waiting for ${lockPath}, held by process ${lock.pid ?? 'unknown'} on ${lock.host} ` +
              `and last touched ${Math.round(lock.ageMs / 1000)} s ago. If no pipeline command is still running, delete that file and retry.`,
          );
        }
        sleepSync(LOCK_POLL_MS);
      }
    }
    try {
      return fn();
    } finally {
      // Release only our own lock: after a takeover the file belongs to someone else.
      if (readLock(lockPath)?.token === token) {
        fs.rmSync(lockPath, { force: true });
      }
    }
  } finally {
    heartbeat?.terminate();
  }
}
