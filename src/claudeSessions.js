const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const MAX_PREVIEW_LENGTH = 180;

function getClaudeProjectsRoot(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'projects');
}

function stripTrailingSeparators(value) {
  return value.replace(/[\\/]+$/, '');
}

function normalizePathForCompare(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  let normalized = stripTrailingSeparators(path.resolve(value));
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function isSameOrChildPath(candidatePath, parentPath) {
  const candidate = normalizePathForCompare(candidatePath);
  const parent = normalizePathForCompare(parentPath);
  if (!candidate || !parent) {
    return false;
  }

  if (candidate === parent) {
    return true;
  }

  const separator = process.platform === 'win32' ? '\\' : path.sep;
  return candidate.startsWith(parent + separator);
}

function slugPathVariants(projectPath) {
  if (!projectPath) {
    return new Set();
  }

  const resolved = stripTrailingSeparators(path.resolve(projectPath));
  const withoutDrive = resolved.replace(/^[A-Za-z]:/, '');
  const slashNormalized = resolved.replace(/\\/g, '/');

  return new Set(
    [
      resolved.replace(/[\\/]+/g, '-').replace(/:/g, ''),
      resolved.replace(/[:\\/]+/g, '-'),
      resolved.replace(/[:\\/]/g, '-'),
      slashNormalized.replace(/\//g, '-').replace(/:/g, ''),
      `-${resolved.replace(/[:\\/]+/g, '-').replace(/^-+/, '')}`,
      `-${withoutDrive.replace(/[\\/]+/g, '-').replace(/^-+/, '')}`,
    ]
      .filter(Boolean)
      .map((item) => item.toLowerCase()),
  );
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextContent(content) {
  if (!content) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextContent(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof content !== 'object') {
    return String(content);
  }

  if (content.type === 'text') {
    return content.text || '';
  }

  if (content.type === 'thinking') {
    return content.thinking || '';
  }

  if (content.type === 'tool_use') {
    const name = content.name || 'tool';
    const input = content.input ? ` ${compactJson(content.input)}` : '';
    return `[tool: ${name}]${input}`;
  }

  if (content.type === 'tool_result') {
    const resultText = extractTextContent(content.content);
    return resultText ? `[tool result]\n${resultText}` : '[tool result]';
  }

  if (content.type === 'image') {
    return '[image]';
  }

  if (content.text) {
    return String(content.text);
  }

  if (content.content) {
    return extractTextContent(content.content);
  }

  return '';
}

function getRecordRole(record) {
  if (record.type === 'user' || record.type === 'assistant' || record.type === 'system') {
    return record.type;
  }

  if (record.message?.role) {
    return record.message.role;
  }

  if (record.type === 'summary') {
    return 'summary';
  }

  return record.type || 'event';
}

function getRecordText(record) {
  if (record.summary) {
    return record.summary;
  }

  if (record.message?.content !== undefined) {
    return extractTextContent(record.message.content);
  }

  if (record.content !== undefined) {
    return extractTextContent(record.content);
  }

  if (record.text) {
    return String(record.text);
  }

  return '';
}

function getRecordTimestamp(record) {
  const candidates = [
    record.timestamp,
    record.createdAt,
    record.created_at,
    record.message?.created_at,
    record.message?.timestamp,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const timestamp = Date.parse(candidate);
    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }

  return null;
}

function parseJsonl(raw) {
  const records = [];
  let invalidLines = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      records.push(JSON.parse(trimmed));
    } catch {
      invalidLines += 1;
    }
  }

  return { records, invalidLines };
}

function makePreview(text, maxLength = MAX_PREVIEW_LENGTH) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function summarizeRecords(filePath, projectDirName, raw, fileStat) {
  const { records, invalidLines } = parseJsonl(raw);
  const timestamps = records.map(getRecordTimestamp).filter(Boolean).sort();
  const firstTimestamp = timestamps[0] || fileStat.birthtime.toISOString();
  const lastTimestamp = timestamps[timestamps.length - 1] || fileStat.mtime.toISOString();
  const cwd = records.find((record) => record.cwd)?.cwd || null;
  const sessionId =
    records.find((record) => record.sessionId)?.sessionId || path.basename(filePath, '.jsonl');
  const gitBranch = records.find((record) => record.gitBranch)?.gitBranch || null;
  const version = records.find((record) => record.version)?.version || null;
  const messageRecords = records.filter((record) => {
    const role = getRecordRole(record);
    return role === 'user' || role === 'assistant';
  });
  const firstUser = messageRecords.find((record) => getRecordRole(record) === 'user');
  const lastMessage = [...messageRecords].reverse().find((record) => getRecordText(record));
  const summaryRecord = records.find((record) => record.type === 'summary' && record.summary);
  const title = makePreview(
    getRecordText(firstUser) || summaryRecord?.summary || `Session ${sessionId.slice(0, 8)}`,
    96,
  );

  return {
    id: sessionId,
    filePath,
    projectDirName,
    cwd,
    gitBranch,
    version,
    title,
    preview: makePreview(getRecordText(lastMessage) || title),
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp,
    messageCount: messageRecords.length,
    eventCount: records.length,
    invalidLines,
    sizeBytes: fileStat.size,
    isRecent: Date.now() - Date.parse(lastTimestamp) < 24 * 60 * 60 * 1000,
  };
}

async function summarizeSessionFile(filePath, projectDirName) {
  const [raw, fileStat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
  return summarizeRecords(filePath, projectDirName, raw, fileStat);
}

async function collectSessionFiles(projectsRoot) {
  const rootEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  const sessionFiles = [];

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectDir = path.join(projectsRoot, entry.name);
    let childEntries = [];
    try {
      childEntries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of childEntries) {
      if (child.isFile() && child.name.toLowerCase().endsWith('.jsonl')) {
        sessionFiles.push({
          filePath: path.join(projectDir, child.name),
          projectDirName: entry.name,
        });
      }
    }
  }

  return sessionFiles;
}

function matchesSelectedProject(summary, selectedProjectPath, selectedProjectSlugs) {
  if (summary.cwd && isSameOrChildPath(summary.cwd, selectedProjectPath)) {
    return true;
  }

  return selectedProjectSlugs.has(String(summary.projectDirName || '').toLowerCase());
}

async function listProjectSessions(selectedProjectPath, options = {}) {
  const projectsRoot = options.projectsRoot || getClaudeProjectsRoot(options.homeDir);
  const selectedProjectSlugs = slugPathVariants(selectedProjectPath);
  const normalizedProjectPath = normalizePathForCompare(selectedProjectPath);

  if (!normalizedProjectPath) {
    throw new Error('Project path is required.');
  }

  try {
    const stat = await fs.stat(selectedProjectPath);
    if (!stat.isDirectory()) {
      throw new Error('Selected path is not a directory.');
    }
  } catch (error) {
    throw new Error(`Cannot access selected project folder: ${error.message}`);
  }

  try {
    await fs.access(projectsRoot);
  } catch {
    return {
      projectPath: selectedProjectPath,
      projectsRoot,
      sessions: [],
      missingClaudeProjects: true,
    };
  }

  const sessionFiles = await collectSessionFiles(projectsRoot);
  const summaries = [];

  for (const sessionFile of sessionFiles) {
    try {
      const summary = await summarizeSessionFile(sessionFile.filePath, sessionFile.projectDirName);
      if (matchesSelectedProject(summary, selectedProjectPath, selectedProjectSlugs)) {
        summaries.push(summary);
      }
    } catch {
      continue;
    }
  }

  summaries.sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt));

  return {
    projectPath: selectedProjectPath,
    projectsRoot,
    sessions: summaries,
    missingClaudeProjects: false,
  };
}

async function readSessionTranscript(sessionFilePath, options = {}) {
  const projectsRoot = path.resolve(options.projectsRoot || getClaudeProjectsRoot(options.homeDir));
  const resolvedFilePath = path.resolve(sessionFilePath);
  const relative = path.relative(projectsRoot, resolvedFilePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Session file is outside Claude projects storage.');
  }

  const [raw, fileStat] = await Promise.all([fs.readFile(resolvedFilePath, 'utf8'), fs.stat(resolvedFilePath)]);
  const projectDirName = path.basename(path.dirname(resolvedFilePath));
  const summary = summarizeRecords(resolvedFilePath, projectDirName, raw, fileStat);
  const { records, invalidLines } = parseJsonl(raw);

  const messages = records.map((record, index) => ({
    id: record.uuid || record.message?.id || `${summary.id}-${index}`,
    role: getRecordRole(record),
    timestamp: getRecordTimestamp(record),
    text: getRecordText(record),
    cwd: record.cwd || null,
    type: record.type || null,
    raw: {
      toolUseId: record.toolUseID || record.tool_use_id || null,
      parentUuid: record.parentUuid || null,
      sessionId: record.sessionId || null,
    },
  }));

  return {
    summary,
    messages,
    invalidLines,
  };
}

module.exports = {
  collectSessionFiles,
  extractTextContent,
  getClaudeProjectsRoot,
  listProjectSessions,
  normalizePathForCompare,
  parseJsonl,
  readSessionTranscript,
  slugPathVariants,
  summarizeRecords,
};
