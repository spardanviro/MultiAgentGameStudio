const fs = require('node:fs/promises');
const path = require('node:path');

const APP_LOG_PATH = path.resolve(__dirname, '..', '.multiagent-manager', 'logs', 'manager.log');
const PROJECT_LOG_RELATIVE_PATH = path.join('.multiagent', 'logs', 'manager.log');
const DEFAULT_TAIL_BYTES = 240000;

function nowIso() {
  return new Date().toISOString();
}

function getProjectLogPath(projectRoot) {
  return projectRoot ? path.join(path.resolve(projectRoot), PROJECT_LOG_RELATIVE_PATH) : null;
}

function serializeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
    command: error.cmd,
    stdout: trimLarge(error.stdout),
    stderr: trimLarge(error.stderr),
    stack: trimLarge(error.stack, 6000),
  };
}

function trimLarge(value, maxLength = 4000) {
  if (value == null) {
    return value;
  }
  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}

function sanitize(value, depth = 0) {
  if (depth > 5) {
    return '[max-depth]';
  }
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? trimLarge(value) : value;
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sanitize(entry, depth + 1);
  }
  return output;
}

async function appendLine(filePath, line) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${line}\n`, 'utf8');
}

async function logEvent(event, payload = {}, options = {}) {
  const projectRoot = options.projectRoot || payload.projectRoot || payload.options?.projectRoot || null;
  const entry = {
    ts: nowIso(),
    level: options.level || payload.level || 'info',
    event,
    projectRoot,
    ...sanitize(payload),
  };
  const line = JSON.stringify(entry);
  const paths = [APP_LOG_PATH, getProjectLogPath(projectRoot)].filter(Boolean);

  for (const filePath of paths) {
    try {
      await appendLine(filePath, line);
    } catch (error) {
      console.error(`[manager-log] failed to write ${filePath}: ${error.message}`);
    }
  }

  return entry;
}

async function readTail(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function readLogs(options = {}) {
  const projectRoot = options.projectRoot || null;
  const maxBytes = options.maxBytes || DEFAULT_TAIL_BYTES;
  const projectLogPath = getProjectLogPath(projectRoot);
  return {
    appLogPath: APP_LOG_PATH,
    projectLogPath,
    appLog: await readTail(APP_LOG_PATH, maxBytes),
    projectLog: projectLogPath ? await readTail(projectLogPath, maxBytes) : '',
  };
}

module.exports = {
  APP_LOG_PATH,
  PROJECT_LOG_RELATIVE_PATH,
  getProjectLogPath,
  logEvent,
  readLogs,
  serializeError,
};
