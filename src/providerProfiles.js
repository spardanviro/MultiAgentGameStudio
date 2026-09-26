const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');

const { getAppDataPath } = require('./appPaths');

function getProviderProfilesPath() {
  return getAppDataPath('provider-profiles.json');
}

function getProviderSecretKeyPath() {
  return getAppDataPath('provider-secret.key');
}
const DEFAULT_PROVIDER_ID = 'claude-subscription';
const DEFAULT_PROFILE = {
  id: DEFAULT_PROVIDER_ID,
  label: 'Claude Subscription',
  type: 'claude_code_default',
  models: ['opus', 'sonnet', 'haiku', 'fable'],
};
const DEFAULT_API_KEY_FIELD = 'ANTHROPIC_AUTH_TOKEN';
const API_KEY_FIELDS = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
const PROVIDER_PRESETS = [
  {
    id: 'claude-subscription',
    label: 'Claude Subscription',
    type: 'claude_code_default',
    category: 'official',
    description: 'Use the Claude Code CLI logged-in subscription account.',
    models: ['opus', 'sonnet', 'haiku', 'fable'],
  },
  {
    id: 'anthropic-api',
    label: 'Anthropic API',
    type: 'anthropic_compatible_gateway',
    category: 'official',
    baseUrl: 'https://api.anthropic.com',
    apiKeyField: 'ANTHROPIC_API_KEY',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'opus',
      'sonnet',
      'haiku',
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'anthropic_compatible_gateway',
    category: 'cn_official',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    envDefaults: {
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    },
    modelsUrl: 'https://api.deepseek.com/models',
  },
  {
    id: 'kimi-coding',
    label: 'Kimi For Coding',
    type: 'anthropic_compatible_gateway',
    category: 'cn_official',
    baseUrl: 'https://api.kimi.com/coding',
    models: ['kimi-k2.7-code', 'kimi-k2-0711-preview'],
    envDefaults: {
      ANTHROPIC_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.7-code',
    },
  },
  {
    id: 'moonshot-kimi',
    label: 'Kimi Moonshot',
    type: 'anthropic_compatible_gateway',
    category: 'cn_official',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    models: ['kimi-k2.7-code'],
    envDefaults: {
      ANTHROPIC_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.7-code',
    },
  },
  {
    id: 'volcengine-agentplan',
    label: 'Volcengine Agentplan',
    type: 'anthropic_compatible_gateway',
    category: 'cn_official',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    models: ['ark-code-latest'],
    envDefaults: {
      ANTHROPIC_MODEL: 'ark-code-latest',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ark-code-latest',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'ark-code-latest',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'ark-code-latest',
    },
  },
  {
    id: 'byteplus-modelark',
    label: 'BytePlus ModelArk',
    type: 'anthropic_compatible_gateway',
    category: 'cn_official',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding',
    models: ['ark-code-latest'],
    envDefaults: {
      ANTHROPIC_MODEL: 'ark-code-latest',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ark-code-latest',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'ark-code-latest',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'ark-code-latest',
    },
  },
  {
    id: 'bailian',
    label: 'Alibaba Bailian',
    type: 'anthropic_compatible_gateway',
    category: 'cn_official',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    models: [],
  },
  {
    id: 'siliconflow-cn',
    label: 'SiliconFlow CN',
    type: 'anthropic_compatible_gateway',
    category: 'aggregator',
    baseUrl: 'https://api.siliconflow.cn',
    models: ['Pro/MiniMaxAI/MiniMax-M2.7', 'MiniMaxAI/MiniMax-M2.7'],
    envDefaults: {
      ANTHROPIC_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.7',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.7',
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'anthropic_compatible_gateway',
    category: 'aggregator',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-chat',
    ],
  },
  {
    id: 'gemini-native',
    label: 'Gemini Native',
    type: 'anthropic_compatible_gateway',
    category: 'third_party',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKeyField: 'ANTHROPIC_API_KEY',
    apiKeyEnv: 'GEMINI_API_KEY',
    models: ['gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    envDefaults: {
      ANTHROPIC_MODEL: 'gemini-3.5-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gemini-3.5-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gemini-3.5-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gemini-3.5-flash',
    },
  },
  {
    id: 'custom-compatible',
    label: 'Custom Anthropic-Compatible',
    type: 'anthropic_compatible_gateway',
    category: 'custom',
    baseUrl: '',
    apiKeyField: DEFAULT_API_KEY_FIELD,
    apiKeyEnv: '',
    models: [],
  },
];

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function safeProfileId(value) {
  const id = String(value || '').trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error('Provider profile id must use only letters, numbers, ".", "_", or "-".');
  }
  return id;
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return '';
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('Provider baseUrl must start with http:// or https://.');
  }
  return baseUrl;
}

function normalizeApiKeyField(value) {
  const field = String(value || DEFAULT_API_KEY_FIELD).trim();
  if (!API_KEY_FIELDS.has(field)) {
    throw new Error(`Unsupported API key field: ${field}.`);
  }
  return field;
}

function normalizeEnvDefaults(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && String(item).trim())
      .map(([key, item]) => [key, String(item)]),
  );
}

function normalizeProfile(profile = {}) {
  const id = safeProfileId(profile.id || DEFAULT_PROVIDER_ID);
  const type = profile.type === 'anthropic_compatible_gateway'
    ? 'anthropic_compatible_gateway'
    : 'claude_code_default';
  const normalized = {
    id,
    label: String(profile.label || id),
    type,
    models: unique(profile.models || []),
  };

  if (type === 'anthropic_compatible_gateway') {
    normalized.baseUrl = normalizeBaseUrl(profile.baseUrl);
    normalized.apiKeyEnv = String(profile.apiKeyEnv || '').trim();
    normalized.apiKeyField = normalizeApiKeyField(profile.apiKeyField);
    normalized.encryptedApiKey = profile.encryptedApiKey || null;
    normalized.presetId = profile.presetId ? String(profile.presetId) : null;
    normalized.envDefaults = normalizeEnvDefaults(profile.envDefaults);
    normalized.modelsUrl = profile.modelsUrl ? normalizeBaseUrl(profile.modelsUrl) : '';
    if (!normalized.baseUrl) {
      throw new Error(`${id}.baseUrl is required for gateway provider profiles.`);
    }
    if (!normalized.apiKeyEnv && !normalized.encryptedApiKey) {
      throw new Error(`${id} requires either apiKeyEnv or a stored API key.`);
    }
  }

  return normalized;
}

function getProviderPresets() {
  return PROVIDER_PRESETS.map((preset) => ({ ...preset, envDefaults: { ...(preset.envDefaults || {}) } }));
}

function getProviderPreset(presetId) {
  return getProviderPresets().find((preset) => preset.id === presetId) || null;
}

function profileFromPreset(presetId, overrides = {}) {
  const preset = getProviderPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown provider preset: ${presetId}`);
  }
  if (preset.type === 'claude_code_default') {
    return { ...DEFAULT_PROFILE };
  }
  return {
    id: safeProfileId(overrides.id || preset.id),
    label: String(overrides.label || preset.label),
    type: 'anthropic_compatible_gateway',
    presetId: preset.id,
    baseUrl: overrides.baseUrl || preset.baseUrl,
    apiKeyEnv: overrides.apiKeyEnv ?? preset.apiKeyEnv ?? '',
    apiKeyField: overrides.apiKeyField || preset.apiKeyField || DEFAULT_API_KEY_FIELD,
    apiKey: overrides.apiKey || '',
    models: overrides.models?.length ? overrides.models : preset.models || [],
    envDefaults: {
      ...(preset.envDefaults || {}),
      ...(overrides.envDefaults || {}),
    },
    modelsUrl: overrides.modelsUrl || preset.modelsUrl || '',
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function getSecretKey(options = {}) {
  const filePath = options.secretKeyPath || getProviderSecretKeyPath();
  try {
    return Buffer.from((await fs.readFile(filePath, 'utf8')).trim(), 'base64');
  } catch {
    const key = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    return key;
  }
}

async function encryptSecret(secret, options = {}) {
  const text = String(secret || '');
  if (!text) {
    return null;
  }
  const key = await getSecretKey(options);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

async function decryptSecret(payload, options = {}) {
  if (!payload) {
    return null;
  }
  if (typeof payload === 'string') {
    return payload;
  }
  const key = await getSecretKey(options);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function prepareProfileForSave(profile, options = {}) {
  const next = { ...profile };
  if (next.apiKey) {
    next.encryptedApiKey = await encryptSecret(next.apiKey, options);
    delete next.apiKey;
  }
  return normalizeProfile(next);
}

async function getProviderProfiles(options = {}) {
  const filePath = options.filePath || getProviderProfilesPath();
  const raw = await readJsonIfExists(filePath);
  const profiles = [DEFAULT_PROFILE];
  if (Array.isArray(raw?.profiles)) {
    for (const profile of raw.profiles) {
      const normalized = normalizeProfile(profile);
      if (normalized.id !== DEFAULT_PROVIDER_ID) {
        profiles.push(normalized);
      }
    }
  }
  return {
    profiles,
    updatedAt: raw?.updatedAt || null,
  };
}

async function saveProviderProfiles(profiles, options = {}) {
  const filePath = options.filePath || getProviderProfilesPath();
  const normalized = [];
  for (const profile of profiles) {
    const entry = await prepareProfileForSave(profile, options);
    if (entry.id !== DEFAULT_PROVIDER_ID) {
      normalized.push(entry);
    }
  }
  const value = {
    version: 1,
    profiles: normalized,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(filePath, value);
  return getProviderProfiles({ filePath });
}

async function upsertProviderProfile(profile, options = {}) {
  const current = await getProviderProfiles(options);
  const existing = current.profiles.find((entry) => entry.id === profile?.id);
  const input = { ...profile };
  if (!input.apiKey && !input.encryptedApiKey && existing?.encryptedApiKey) {
    input.encryptedApiKey = existing.encryptedApiKey;
  }
  const normalized = await prepareProfileForSave(input, options);
  if (normalized.id === DEFAULT_PROVIDER_ID) {
    throw new Error('The default Claude subscription profile cannot be overwritten.');
  }
  const next = current.profiles
    .filter((entry) => entry.id !== DEFAULT_PROVIDER_ID && entry.id !== normalized.id)
    .concat(normalized);
  return saveProviderProfiles(next, options);
}

async function upsertProviderProfileFromPreset(input = {}, options = {}) {
  const profile = profileFromPreset(input.presetId, input);
  if (profile.id === DEFAULT_PROVIDER_ID) {
    return getProviderProfiles(options);
  }
  return upsertProviderProfile(profile, options);
}

async function getProviderProfile(profileId, options = {}) {
  const id = profileId || DEFAULT_PROVIDER_ID;
  const config = await getProviderProfiles(options);
  return config.profiles.find((profile) => profile.id === id) || DEFAULT_PROFILE;
}

function buildProviderEnv(profile, baseEnv = process.env) {
  throw new Error('buildProviderEnv is async; use buildProviderEnvAsync.');
}

async function resolveProviderApiKey(profile, baseEnv = process.env, options = {}) {
  if (!profile || profile.type === 'claude_code_default') {
    return null;
  }
  if (profile.apiKeyEnv && baseEnv[profile.apiKeyEnv]) {
    return baseEnv[profile.apiKeyEnv];
  }
  return decryptSecret(profile.encryptedApiKey, options);
}

async function buildProviderEnvAsync(profile, baseEnv = process.env, options = {}) {
  if (!profile || profile.type === 'claude_code_default') {
    return baseEnv;
  }
  const apiKey = await resolveProviderApiKey(profile, baseEnv, options);
  if (!apiKey) {
    throw new Error(
      `Provider ${profile.id} requires a stored API key${profile.apiKeyEnv ? ` or environment variable ${profile.apiKeyEnv}` : ''}.`,
    );
  }
  return {
    ...baseEnv,
    ...(profile.envDefaults || {}),
    ANTHROPIC_BASE_URL: profile.baseUrl,
    [profile.apiKeyField || DEFAULT_API_KEY_FIELD]: apiKey,
  };
}

function toPublicProviderProfiles(config) {
  return {
    ...config,
    profiles: (config.profiles || []).map((profile) => {
      const { encryptedApiKey, apiKey, ...publicProfile } = profile;
      return {
        ...publicProfile,
        hasStoredApiKey: Boolean(encryptedApiKey || apiKey),
      };
    }),
  };
}

function modelsEndpointFor(baseUrl) {
  const clean = normalizeBaseUrl(baseUrl);
  if (/\/v1$/i.test(clean)) {
    return `${clean}/models`;
  }
  if (/\/v1\/models$/i.test(clean)) {
    return clean;
  }
  return `${clean}/v1/models`;
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = /^http:\/\//i.test(url) ? http : https;
    client
      .get(url, { headers: options.headers || {} }, (response) => {
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
        response.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function extractGatewayModels(response) {
  const values = Array.isArray(response?.data) ? response.data : Array.isArray(response?.models) ? response.models : [];
  return unique(
    values.map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      return entry?.id || entry?.name || entry?.model;
    }),
  );
}

async function refreshProviderModels(profileId, options = {}) {
  const profile = await getProviderProfile(profileId, options);
  if (profile.type === 'claude_code_default') {
    return getProviderProfiles(options);
  }

  const env = options.env || process.env;
  const apiKey = await resolveProviderApiKey(profile, env, options);
  if (!apiKey) {
    throw new Error(
      `Cannot refresh ${profile.id}: missing stored API key${profile.apiKeyEnv ? ` or ${profile.apiKeyEnv}` : ''}.`,
    );
  }

  const fetcher = options.fetcher || fetchJson;
  const response = await fetcher(profile.modelsUrl || modelsEndpointFor(profile.baseUrl), {
    headers: {
      'user-agent': 'MultiAgentSystem/0.1',
      'x-api-key': apiKey,
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
  });
  const models = extractGatewayModels(response);
  return upsertProviderProfile({ ...profile, models }, options);
}

module.exports = {
  API_KEY_FIELDS,
  DEFAULT_API_KEY_FIELD,
  DEFAULT_PROFILE,
  DEFAULT_PROVIDER_ID,
  PROVIDER_PRESETS,
  buildProviderEnv,
  buildProviderEnvAsync,
  decryptSecret,
  encryptSecret,
  extractGatewayModels,
  getProviderPreset,
  getProviderProfilesPath,
  getProviderPresets,
  getProviderProfile,
  getProviderProfiles,
  modelsEndpointFor,
  normalizeProfile,
  profileFromPreset,
  refreshProviderModels,
  resolveProviderApiKey,
  saveProviderProfiles,
  toPublicProviderProfiles,
  upsertProviderProfile,
  upsertProviderProfileFromPreset,
};
