// Manager side of the agent runner: start detached src/agentRunner.mjs
// processes and read the status files they write. Replaces scraping
// `claude --bg` output, `claude agents --json`, and ~/.claude/jobs.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUNNER_PATH = path.join(__dirname, 'agentRunner.mjs');
const SPEC_FILE = 'spec.json';
const STATUS_FILE = 'status.json';
const LOG_FILE = 'agent.log';
// A runner that never wrote a pid is considered gone after this long.
const STARTING_GRACE_MS = 120000;
// Set by the test runner so no test can start a real (billed) Claude session.
const NO_SPAWN_ENV = 'MULTIAGENT_MANAGER_NO_AGENT_SPAWN';

const BLOCK_REASON_STATUS = {
  login: 'blocked_login',
  rate_limit: 'blocked_rate_limit',
};

function getAgentPaths(dir) {
  return {
    dir,
    specPath: path.join(dir, SPEC_FILE),
    statusPath: path.join(dir, STATUS_FILE),
    logPath: path.join(dir, LOG_FILE),
  };
}

function newSessionId() {
  return crypto.randomUUID();
}

/**
 * Start a detached runner for one agent session.
 * `env` goes to the process environment only (it may hold provider API keys),
 * never into spec.json.
 * @param {{dir: string, spec: object, env?: object, spawnImpl?: Function, execPath?: string}} params
 * @returns {Promise<{pid: number|null, logPath: string, statusPath: string}>}
 */
async function launchAgentProcess({ dir, spec, env = process.env, spawnImpl = spawn, execPath = process.execPath }) {
  if (spawnImpl === spawn && process.env[NO_SPAWN_ENV] === '1') {
    throw new Error(`${NO_SPAWN_ENV}=1: refusing to start a real agent runner (inject launchAgent in tests).`);
  }
  const paths = getAgentPaths(dir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(paths.specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    paths.statusPath,
    `${JSON.stringify({ version: 1, pid: null, sessionId: spec.sessionId, state: 'starting', updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  const child = spawnImpl(execPath, [RUNNER_PATH, paths.specPath], {
    cwd: spec.cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  return { pid: child.pid ?? null, logPath: paths.logPath, statusPath: paths.statusPath };
}

async function readAgentStatus(dir) {
  if (!dir) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(getAgentPaths(dir).statusPath, 'utf8'));
  } catch (error) {
    // Missing, or caught mid-write by a non-atomic fallback write.
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * @returns {{phase: 'running'|'done'|'failed'|'blocked'|'lost'|'unknown', blockReason: string|null, detail: string|null}}
 */
function classifyAgentStatus(status, { isAlive = isProcessAlive, now = Date.now(), launchedPid = null } = {}) {
  if (!status) {
    return { phase: 'unknown', blockReason: null, detail: null };
  }
  const detail = status.detail || null;
  if (status.state === 'done') {
    return { phase: 'done', blockReason: null, detail };
  }
  if (status.state === 'failed') {
    return { phase: 'failed', blockReason: null, detail: detail || 'Agent session failed.' };
  }
  if (status.state === 'blocked') {
    return { phase: 'blocked', blockReason: status.blockReason || null, detail };
  }

  const pid = status.pid || launchedPid;
  if (pid) {
    return isAlive(pid)
      ? { phase: 'running', blockReason: null, detail: null }
      : { phase: 'lost', blockReason: null, detail: 'Agent runner process exited without reporting a result.' };
  }
  const age = now - (Date.parse(status.updatedAt) || 0);
  return age > STARTING_GRACE_MS
    ? { phase: 'lost', blockReason: null, detail: 'Agent runner never started.' }
    : { phase: 'running', blockReason: null, detail: null };
}

function blockedStatusFor(blockReason) {
  return BLOCK_REASON_STATUS[blockReason] || 'blocked_dialog';
}

module.exports = {
  NO_SPAWN_ENV,
  RUNNER_PATH,
  blockedStatusFor,
  classifyAgentStatus,
  getAgentPaths,
  isProcessAlive,
  launchAgentProcess,
  newSessionId,
  readAgentStatus,
};
