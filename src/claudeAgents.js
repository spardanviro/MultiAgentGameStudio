// Shared helpers for Claude Code CLI background agents (`claude --bg`,
// `claude agents --json`, and the daemon job files under ~/.claude/jobs).
//
// Observed with Claude Code 2.1.x:
// - `claude --bg` prints `backgrounded · <shortId> · <name>` plus
//   `claude attach|logs|stop <shortId>` hints, and ignores `--session-id`.
// - `claude agents --json --all` returns an array of
//   { id: <shortId>, sessionId: <uuid>, name, cwd, kind, startedAt (ms), state, status }.
//   `state` is the job lifecycle (e.g. "blocked"); `status` is process activity
//   (e.g. "idle"/"busy") and must not be read as completion when `state` exists.
// - Job files live at <claude config dir>/jobs/<shortId>/state.json, keyed by
//   the short id (daemonShort), not the full session UUID.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SHORT_ID_LENGTH = 8;
const LAUNCH_LOOKUP_SKEW_MS = 5000;
const AGENTS_LIST_TIMEOUT_MS = 120000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TOKEN = '([A-Za-z0-9][A-Za-z0-9_-]{5,63})';
const LAUNCH_ID_PATTERNS = [
  new RegExp(`\\bbackgrounded\\b\\s*[·•|:\\-–—]\\s*${ID_TOKEN}`, 'gi'),
  new RegExp(`\\bclaude\\s+(?:attach|logs|stop)\\s+${ID_TOKEN}`, 'gi'),
  new RegExp(`\\bbackground\\s+session\\s+${ID_TOKEN}`, 'gi'),
];
const DONE_STATES = new Set(['done', 'complete', 'completed', 'finished', 'stopped', 'exited', 'idle', 'succeeded']);
const FAILED_STATES = new Set(['failed', 'error', 'errored', 'crashed', 'killed']);
const ACTIVE_STATES = new Set(['working', 'running', 'busy', 'starting', 'queued', 'thinking']);

function lower(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ''));
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function normalizePathForCompare(value) {
  if (!value) {
    return null;
  }
  const resolved = path.resolve(String(value)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Extract the background agent id from `claude --bg` output. Only accepts ids
 * next to an explicit marker; returns null when nothing (or conflicting ids)
 * matched so callers fall back to `claude agents --json`.
 * @param {string} output
 * @returns {string|null}
 */
function parseLaunchOutput(output) {
  const text = String(output || '');
  const found = new Set();
  for (const pattern of LAUNCH_ID_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * @param {object} raw entry from `claude agents --json`
 * @returns {{shortId: string|null, sessionId: string|null, name: string|null, cwd: string|null,
 *   kind: string|null, startedAt: number|null, state: string|null, status: string|null,
 *   waitingFor: string|null}|null}
 */
function normalizeAgentRecord(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const sessionId = firstString(raw.sessionId, raw.session_id, raw.uuid);
  const shortId =
    firstString(raw.id, raw.shortId, raw.daemonShort, raw.agentId, raw.agent_id) ||
    (sessionId ? sessionId.slice(0, SHORT_ID_LENGTH) : null);
  if (!shortId && !sessionId) {
    return null;
  }
  return {
    shortId,
    sessionId,
    name: firstString(raw.name),
    cwd: firstString(raw.cwd),
    kind: lower(raw.kind),
    startedAt: toEpochMs(raw.startedAt ?? raw.started_at ?? raw.createdAt),
    state: lower(raw.state),
    status: lower(raw.status),
    waitingFor: firstString(raw.waitingFor, raw.waiting_for),
  };
}

/**
 * Parse `claude agents --json` stdout. Accepts a bare array or an object that
 * wraps the list; throws on anything else so format changes surface loudly.
 * @param {string} stdout
 */
function parseAgentsJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Unexpected \`claude agents --json\` output (not JSON): ${text.slice(0, 200)}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed?.agents || parsed?.sessions || parsed?.items || null;
  if (!Array.isArray(list)) {
    throw new Error(`Unexpected \`claude agents --json\` output shape: ${text.slice(0, 200)}`);
  }
  return list.map(normalizeAgentRecord).filter(Boolean);
}

async function listClaudeAgents(cwd, options = {}) {
  if (!options.runner) {
    throw new Error('listClaudeAgents requires a command runner.');
  }
  const result = await options.runner('claude', ['agents', '--json', '--all', '--cwd', cwd], {
    cwd,
    timeoutMs: AGENTS_LIST_TIMEOUT_MS,
  });
  return parseAgentsJson(result.stdout);
}

function agentMatchesId(record, id) {
  const needle = lower(id);
  if (!record || !needle) {
    return false;
  }
  const shortId = lower(record.shortId);
  const sessionId = lower(record.sessionId);
  if (needle === shortId || needle === sessionId) {
    return true;
  }
  if (sessionId && needle.length >= SHORT_ID_LENGTH && sessionId.startsWith(needle)) {
    return true;
  }
  return Boolean(shortId && isUuid(needle) && needle.startsWith(shortId));
}

function findAgent(records, id) {
  return (records || []).find((record) => agentMatchesId(record, id)) || null;
}

/**
 * Find the background agent a launch just created, by name + cwd + start time.
 */
function findLaunchedAgent(records, { name, cwd, since }) {
  const wantedCwd = normalizePathForCompare(cwd);
  const earliest = typeof since === 'number' ? since - LAUNCH_LOOKUP_SKEW_MS : null;
  const candidates = (records || [])
    .filter((record) => record.kind !== 'interactive')
    .filter((record) => !name || record.name === name)
    .filter((record) => !wantedCwd || normalizePathForCompare(record.cwd) === wantedCwd)
    .filter((record) => earliest === null || (record.startedAt !== null && record.startedAt >= earliest))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return candidates[0] || null;
}

/**
 * Start `claude --bg ...` and resolve the new agent's short id, first from the
 * launch output, then from `claude agents --json` if the output was unparseable.
 * @returns {Promise<{sessionId: string|null, source: 'output'|'agents'|null, output: string, lookupError: string|null}>}
 */
async function launchBackgroundAgent({ runner, args, cwd, env, name, timeoutMs = 120000 }) {
  const launchedAt = Date.now();
  const result = await runner('claude', args, { cwd, env, timeoutMs });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const parsedId = parseLaunchOutput(output);
  if (parsedId) {
    return { sessionId: parsedId, source: 'output', output, lookupError: null };
  }

  try {
    const records = await listClaudeAgents(cwd, { runner });
    const match = findLaunchedAgent(records, { name, cwd, since: launchedAt });
    return {
      sessionId: match?.shortId || null,
      source: match ? 'agents' : null,
      output,
      lookupError: match ? null : 'No matching background agent found in `claude agents --json`.',
    };
  } catch (error) {
    return { sessionId: null, source: null, output, lookupError: error.message };
  }
}

function getClaudeConfigDir(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) {
    return path.resolve(env.CLAUDE_CONFIG_DIR);
  }
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude');
}

async function readJobState(id, options = {}) {
  if (!id) {
    return null;
  }
  const jobsRoot = path.join(getClaudeConfigDir(options.env || process.env), 'jobs');
  const candidates = [...new Set([id, isUuid(id) ? id.slice(0, SHORT_ID_LENGTH) : null].filter(Boolean))];
  for (const candidate of candidates) {
    if (!SAFE_ID_PATTERN.test(candidate)) {
      continue;
    }
    try {
      return JSON.parse(await fs.readFile(path.join(jobsRoot, candidate, 'state.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Failed to read Claude job state for ${candidate}: ${error.message}`);
      }
    }
  }
  return null;
}

/**
 * Reduce an agents-list record and/or job state file to one lifecycle phase.
 * The live agents list wins over the job file; `status` is only consulted when
 * the CLI did not report a `state`. A job file with `firstTerminalAt` set
 * counts as finished unless the lifecycle is explicitly active.
 * @returns {{phase: 'blocked'|'done'|'failed'|'running'|'unknown', detail: string|null}}
 */
function classifyAgentLifecycle(record, jobState) {
  const jobLifecycle = lower(jobState?.state);
  const lifecycle = record?.state || jobLifecycle;
  const jobBlocked = !record?.state && Boolean(jobState?.needs);
  const blockedDetail =
    firstString(jobState?.needs, jobState?.detail, record?.waitingFor) || 'Claude background session is blocked.';

  if (lifecycle === 'blocked' || record?.waitingFor || jobBlocked) {
    return { phase: 'blocked', detail: blockedDetail };
  }
  if (lifecycle) {
    if (DONE_STATES.has(lifecycle)) {
      return { phase: 'done', detail: null };
    }
    if (FAILED_STATES.has(lifecycle)) {
      return { phase: 'failed', detail: firstString(jobState?.detail) || `Claude background session ${lifecycle}.` };
    }
    if (jobState?.firstTerminalAt && !ACTIVE_STATES.has(lifecycle)) {
      return { phase: 'done', detail: null };
    }
    return { phase: 'running', detail: null };
  }
  if (record?.status && DONE_STATES.has(record.status)) {
    return { phase: 'done', detail: null };
  }
  if (record?.status && FAILED_STATES.has(record.status)) {
    return { phase: 'failed', detail: `Claude background session ${record.status}.` };
  }
  return record ? { phase: 'running', detail: null } : { phase: 'unknown', detail: null };
}

module.exports = {
  agentMatchesId,
  classifyAgentLifecycle,
  findAgent,
  findLaunchedAgent,
  getClaudeConfigDir,
  launchBackgroundAgent,
  listClaudeAgents,
  normalizeAgentRecord,
  parseAgentsJson,
  parseLaunchOutput,
  readJobState,
};
