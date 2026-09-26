const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildProviderEnvAsync,
  extractGatewayModels,
  getProviderPresets,
  getProviderProfiles,
  modelsEndpointFor,
  profileFromPreset,
  refreshProviderModels,
  upsertProviderProfileFromPreset,
  upsertProviderProfile,
} = require('../src/providerProfiles');

test('provider profiles include default Claude subscription profile', async () => {
  const filePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-')), 'profiles.json');

  const result = await getProviderProfiles({ filePath });

  assert.equal(result.profiles[0].id, 'claude-subscription');
  assert.equal(result.profiles[0].type, 'claude_code_default');
});

test('provider presets expose vendor defaults without requiring manual base url entry', () => {
  const presets = getProviderPresets();
  const deepseek = presets.find((preset) => preset.id === 'deepseek');
  const profile = profileFromPreset('deepseek', { apiKey: 'sk-test' });

  assert.ok(presets.some((preset) => preset.id === 'claude-subscription'));
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.deepEqual(deepseek.models, ['deepseek-v4-pro', 'deepseek-v4-flash']);
  assert.equal(profile.apiKeyField, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(profile.envDefaults.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-pro');
});

test('upsertProviderProfileFromPreset saves encrypted key and provider defaults', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-preset-'));
  const filePath = path.join(dir, 'profiles.json');
  const secretKeyPath = path.join(dir, 'provider-secret.key');

  await upsertProviderProfileFromPreset(
    {
      presetId: 'gemini-native',
      apiKey: 'gemini-secret',
    },
    { filePath, secretKeyPath },
  );
  const saved = await fs.readFile(filePath, 'utf8');
  const config = await getProviderProfiles({ filePath });
  const profile = config.profiles.find((entry) => entry.id === 'gemini-native');
  const env = await buildProviderEnvAsync(profile, {}, { secretKeyPath });

  assert.doesNotMatch(saved, /gemini-secret/);
  assert.equal(profile.baseUrl, 'https://generativelanguage.googleapis.com');
  assert.equal(profile.apiKeyField, 'ANTHROPIC_API_KEY');
  assert.equal(env.ANTHROPIC_API_KEY, 'gemini-secret');
  assert.equal(env.ANTHROPIC_MODEL, 'gemini-3.5-flash');
});

test('upsertProviderProfile saves gateway profile without storing a raw key', async () => {
  const filePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-')), 'profiles.json');

  const result = await upsertProviderProfile(
    {
      id: 'openrouter',
      label: 'OpenRouter',
      type: 'anthropic_compatible_gateway',
      baseUrl: 'https://openrouter.example/api',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      models: ['google/gemini-pro'],
    },
    { filePath },
  );
  const saved = await fs.readFile(filePath, 'utf8');

  assert.ok(result.profiles.some((profile) => profile.id === 'openrouter'));
  assert.match(saved, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(saved, /sk-/);
});

test('buildProviderEnv injects isolated Anthropic-compatible gateway env', async () => {
  const env = await buildProviderEnvAsync(
    {
      id: 'gateway',
      type: 'anthropic_compatible_gateway',
      baseUrl: 'https://gateway.example',
      apiKeyEnv: 'GATEWAY_KEY',
    },
    { PATH: 'x', GATEWAY_KEY: 'secret-token' },
  );

  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'secret-token');
  assert.equal(env.PATH, 'x');
});

test('stored API key is encrypted and usable without environment variables', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-secret-'));
  const filePath = path.join(dir, 'profiles.json');
  const secretKeyPath = path.join(dir, 'provider-secret.key');

  await upsertProviderProfile(
    {
      id: 'saved-key',
      label: 'Saved Key',
      type: 'anthropic_compatible_gateway',
      baseUrl: 'https://gateway.example',
      apiKey: 'sk-secret-value',
      models: ['model-a'],
    },
    { filePath, secretKeyPath },
  );
  const saved = await fs.readFile(filePath, 'utf8');
  const config = await getProviderProfiles({ filePath });
  const profile = config.profiles.find((entry) => entry.id === 'saved-key');
  const env = await buildProviderEnvAsync(profile, { PATH: 'x' }, { secretKeyPath });

  assert.doesNotMatch(saved, /sk-secret-value/);
  assert.equal(profile.hasStoredApiKey, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-secret-value');
});

test('upsertProviderProfile preserves stored key when key input is blank', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-preserve-secret-'));
  const filePath = path.join(dir, 'profiles.json');
  const secretKeyPath = path.join(dir, 'provider-secret.key');

  await upsertProviderProfile(
    {
      id: 'saved-key',
      label: 'Saved Key',
      type: 'anthropic_compatible_gateway',
      baseUrl: 'https://gateway.example',
      apiKey: 'sk-secret-value',
      models: ['model-a'],
    },
    { filePath, secretKeyPath },
  );
  await upsertProviderProfile(
    {
      id: 'saved-key',
      label: 'Renamed',
      type: 'anthropic_compatible_gateway',
      baseUrl: 'https://gateway.example',
      models: ['model-b'],
    },
    { filePath, secretKeyPath },
  );
  const config = await getProviderProfiles({ filePath });
  const profile = config.profiles.find((entry) => entry.id === 'saved-key');
  const env = await buildProviderEnvAsync(profile, {}, { secretKeyPath });

  assert.equal(profile.label, 'Renamed');
  assert.deepEqual(profile.models, ['model-b']);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-secret-value');
});

test('refreshProviderModels fetches gateway models endpoint', async () => {
  const filePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-')), 'profiles.json');
  await upsertProviderProfile(
    {
      id: 'gateway',
      label: 'Gateway',
      type: 'anthropic_compatible_gateway',
      baseUrl: 'https://gateway.example/v1',
      apiKeyEnv: 'GATEWAY_KEY',
      models: [],
    },
    { filePath },
  );

  const result = await refreshProviderModels('gateway', {
    filePath,
    env: { GATEWAY_KEY: 'secret-token' },
    fetcher: async (url, options) => {
      assert.equal(url, 'https://gateway.example/v1/models');
      assert.equal(options.headers.authorization, 'Bearer secret-token');
      return {
        data: [{ id: 'vendor/model-a' }, { id: 'vendor/model-b' }],
      };
    },
  });
  const profile = result.profiles.find((entry) => entry.id === 'gateway');

  assert.deepEqual(profile.models, ['vendor/model-a', 'vendor/model-b']);
});

test('extractGatewayModels supports common endpoint shapes', () => {
  assert.deepEqual(extractGatewayModels({ data: [{ id: 'a' }, 'b'] }), ['a', 'b']);
  assert.deepEqual(extractGatewayModels({ models: [{ name: 'c' }] }), ['c']);
  assert.equal(modelsEndpointFor('https://gateway.example'), 'https://gateway.example/v1/models');
});
