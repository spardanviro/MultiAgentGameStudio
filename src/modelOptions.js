const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const { promisify } = require('node:util');

const { getAppDataPath } = require('./appPaths');
const { buildClaudeInvocation } = require('./claudeCli');

const execFileAsync = promisify(execFile);

const MODEL_API_ENDPOINT = 'https://api.anthropic.com/v1/models';

const MODEL_SOURCES = [
  'https://platform.claude.com/docs/en/about-claude/models/overview',
];
const EFFORT_SOURCES = [
  'https://platform.claude.com/docs/en/build-with-claude/effort',
];

const BUILTIN_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'opus',
  'sonnet',
  'haiku',
];

const BUILTIN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'extra', 'max', 'ultracode'];

function nowIso() {
  return new Date().toISOString();
}

function getOptionsPath() {
  return getAppDataPath('model-options.json');
}

function labelForModel(id) {
  return String(id)
    .replace(/^claude-/, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeModelEntry(id, source = 'builtin') {
  return {
    id,
    label: labelForModel(id),
    source,
  };
}

function normalizeEffortEntry(id, source = 'builtin') {
  return {
    id,
    label: id,
    source,
  };
}

function fallbackOptions() {
  return {
    models: BUILTIN_MODELS.map((id) => normalizeModelEntry(id)),
    efforts: BUILTIN_EFFORTS.map((id) => normalizeEffortEntry(id)),
    updatedAt: null,
    sources: [],
    error: null,
  };
}

function fetchText(url, options = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'MultiAgentSystem/0.1', ...(options.headers || {}) } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          resolve(fetchText(new URL(response.headers.location, url).toString(), options));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          response.resume();
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, options));
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
}

function extractModels(text) {
  const models = [];
  const modelPattern = /\bclaude-[a-z0-9]+(?:-[a-z0-9]+){1,6}\b/g;

  for (const match of String(text || '').matchAll(modelPattern)) {
    const value = match[0];
    if (/\d/.test(value) || /-(fable|mythos|opus|sonnet|haiku|preview)\b/.test(value)) {
      models.push(value);
    }
  }

  return uniqueSorted(models);
}

function extractEfforts(text) {
  const allowed = new Set(['low', 'medium', 'high', 'xhigh', 'extra', 'max', 'ultracode']);
  const values = [];

  for (const match of String(text || '').matchAll(/`?\b(low|medium|high|xhigh|extra|max|ultracode)\b`?/gi)) {
    const value = match[1].toLowerCase();
    if (allowed.has(value)) {
      values.push(value);
    }
  }

  return uniqueSorted(values);
}

function extractEffortsFromClaudeHelp(text) {
  const help = String(text || '');
  const effortLine = help
    .split(/\r?\n/)
    .find((line) => line.includes('--effort') || line.includes('Effort level'));
  const choicesMatch =
    help.match(/--effort[\s\S]{0,240}?\(([^)]+)\)/i) ||
    help.match(/Effort level[\s\S]{0,240}?\(([^)]+)\)/i);

  if (!choicesMatch && !effortLine) {
    return [];
  }

  return extractEfforts(choicesMatch ? choicesMatch[1] : effortLine);
}

function extractModelsFromApiResponse(response) {
  const data = Array.isArray(response?.data) ? response.data : [];
  return uniqueSorted(data.map((entry) => entry?.id).filter(Boolean));
}

async function fetchAnthropicModels(apiKey, options = {}) {
  if (!apiKey) {
    return [];
  }

  const fetcher = options.fetcher || fetchJson;
  const models = [];
  let url = `${MODEL_API_ENDPOINT}?limit=1000`;

  for (let page = 0; page < 10 && url; page += 1) {
    const response = await fetcher(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    models.push(...extractModelsFromApiResponse(response));
    const lastId = response?.last_id || response?.data?.at?.(-1)?.id;
    url = response?.has_more && lastId ? `${MODEL_API_ENDPOINT}?limit=1000&after_id=${encodeURIComponent(lastId)}` : null;
  }

  return uniqueSorted(models);
}

async function readClaudeHelp(options = {}) {
  if (options.cliHelpText !== undefined) {
    return options.cliHelpText;
  }
  const invocation = buildClaudeInvocation(['--help']);
  const result = await execFileAsync(invocation.command, invocation.args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function mergeOptions(scrapedModels, scrapedEfforts, sources = []) {
  const models = uniqueSorted([...scrapedModels, ...BUILTIN_MODELS]).map((id) =>
    normalizeModelEntry(id, scrapedModels.includes(id) ? 'docs' : 'builtin'),
  );
  const efforts = uniqueSorted([...scrapedEfforts, ...BUILTIN_EFFORTS]).map((id) =>
    normalizeEffortEntry(id, scrapedEfforts.includes(id) ? 'docs' : 'builtin'),
  );

  return {
    models,
    efforts,
    updatedAt: nowIso(),
    sources,
    error: null,
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function getModelOptions() {
  const cached = await readJsonIfExists(getOptionsPath());
  return cached || fallbackOptions();
}

async function refreshModelOptions(options = {}) {
  const fetcher = options.fetcher || fetchText;
  const apiFetcher = options.apiFetcher || fetchJson;
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || null;
  const sources = [];
  const modelTexts = [];
  const effortTexts = [];
  const apiModels = [];
  const cliEfforts = [];

  try {
    if (apiKey) {
      apiModels.push(...(await fetchAnthropicModels(apiKey, { fetcher: apiFetcher })));
      sources.push(MODEL_API_ENDPOINT);
    }

    for (const url of MODEL_SOURCES) {
      modelTexts.push(await fetcher(url));
      sources.push(url);
    }
    for (const url of EFFORT_SOURCES) {
      effortTexts.push(await fetcher(url));
      sources.push(url);
    }

    try {
      cliEfforts.push(...extractEffortsFromClaudeHelp(await readClaudeHelp(options)));
      sources.push('claude --help');
    } catch {
      // Claude CLI is optional for refreshing option metadata.
    }

    const scrapedModels = uniqueSorted([...apiModels, ...modelTexts.flatMap(extractModels)]);
    const scrapedEfforts = uniqueSorted([...cliEfforts, ...effortTexts.flatMap(extractEfforts)]);
    const result = mergeOptions(scrapedModels, scrapedEfforts, sources);
    await writeJson(getOptionsPath(), result);
    return result;
  } catch (error) {
    const fallback = await getModelOptions();
    return {
      ...fallback,
      error: error.message,
    };
  }
}

module.exports = {
  BUILTIN_EFFORTS,
  BUILTIN_MODELS,
  EFFORT_SOURCES,
  MODEL_API_ENDPOINT,
  MODEL_SOURCES,
  extractEfforts,
  extractEffortsFromClaudeHelp,
  extractModels,
  extractModelsFromApiResponse,
  fallbackOptions,
  fetchAnthropicModels,
  getModelOptions,
  mergeOptions,
  refreshModelOptions,
};
