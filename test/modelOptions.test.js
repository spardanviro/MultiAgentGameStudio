const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractEfforts,
  extractEffortsFromClaudeHelp,
  extractModels,
  extractModelsFromApiResponse,
  fetchAnthropicModels,
  mergeOptions,
} = require('../src/modelOptions');

test('extractModels reads current and preview Claude model ids from docs text', () => {
  const text = [
    'Claude API ID claude-fable-5 claude-opus-4-8 claude-sonnet-5 claude-haiku-4-5-20251001',
    '`claude-mythos-preview` and `claude-opus-4-7` are also referenced.',
    'Ignore non-model mentions like claude-api and platform-claude-docs.',
  ].join('\n');

  const models = extractModels(text);

  assert.ok(models.includes('claude-fable-5'));
  assert.ok(models.includes('claude-opus-4-8'));
  assert.ok(models.includes('claude-sonnet-5'));
  assert.ok(models.includes('claude-haiku-4-5-20251001'));
  assert.ok(models.includes('claude-mythos-preview'));
  assert.ok(models.includes('claude-opus-4-7'));
  assert.equal(models.includes('claude-api'), false);
});

test('extractEfforts reads API and Claude Code effort labels', () => {
  const text = '`max` `xhigh` `high` `medium` `low` plus Claude Code `ultracode` and CLI `extra`.';

  assert.deepEqual(extractEfforts(text), ['extra', 'high', 'low', 'max', 'medium', 'ultracode', 'xhigh']);
});

test('mergeOptions keeps builtin CLI fallbacks alongside scraped docs options', () => {
  const options = mergeOptions(['claude-opus-4-8'], ['xhigh', 'max'], ['https://example.test/docs']);
  const modelIds = options.models.map((entry) => entry.id);
  const effortIds = options.efforts.map((entry) => entry.id);

  assert.ok(modelIds.includes('claude-opus-4-8'));
  assert.ok(modelIds.includes('opus'));
  assert.ok(effortIds.includes('xhigh'));
  assert.ok(effortIds.includes('extra'));
  assert.ok(effortIds.includes('ultracode'));
  assert.equal(options.sources[0], 'https://example.test/docs');
});

test('extractModelsFromApiResponse reads official models endpoint shape', () => {
  const models = extractModelsFromApiResponse({
    data: [
      { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
    ],
  });

  assert.deepEqual(models, ['claude-opus-4-8', 'claude-sonnet-5']);
});

test('fetchAnthropicModels follows official endpoint pagination', async () => {
  const calls = [];
  const models = await fetchAnthropicModels('key-test', {
    fetcher: async (url, options) => {
      calls.push({ url, headers: options.headers });
      if (!url.includes('after_id=')) {
        return {
          data: [{ id: 'claude-opus-4-8' }],
          has_more: true,
          last_id: 'claude-opus-4-8',
        };
      }
      return {
        data: [{ id: 'claude-sonnet-5' }],
        has_more: false,
      };
    },
  });

  assert.deepEqual(models, ['claude-opus-4-8', 'claude-sonnet-5']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-api-key'], 'key-test');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
});

test('extractEffortsFromClaudeHelp reads local Claude Code CLI choices', () => {
  const help = '--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)';

  assert.deepEqual(extractEffortsFromClaudeHelp(help), ['high', 'low', 'max', 'medium', 'xhigh']);
});
