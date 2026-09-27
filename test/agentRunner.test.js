const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const loadCore = () => import('../src/agentRunnerCore.mjs');

const CWD = path.resolve('/work/project');
const BASE_SPEC = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  resume: false,
  cwd: CWD,
  projectConfigRoot: path.resolve('/main/project'),
  prompt: 'Do the task.',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'acceptEdits',
  allowedPaths: ['src/player/', 'work/modules/player/report.md'],
  interfaceRequest: 'work/modules/player/request.md',
};

function fakeQuery(messages, capture = {}) {
  return ({ prompt, options }) => {
    capture.prompt = prompt;
    capture.options = options;
    return (async function* stream() {
      for (const message of messages) {
        if (message instanceof Error) {
          throw message;
        }
        yield message;
      }
    })();
  };
}

async function run(messages, spec = BASE_SPEC) {
  const { runAgent } = await loadCore();
  const writes = [];
  const log = [];
  const capture = {};
  const status = await runAgent({
    spec,
    query: fakeQuery(messages, capture),
    writeStatus: async (value) => writes.push(JSON.parse(JSON.stringify(value))),
    appendLog: async (line) => log.push(line),
    pid: 77,
    heartbeatMs: 60000,
  });
  return { status, writes, log, capture };
}

const SUCCESS = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 4,
  duration_ms: 1200,
  total_cost_usd: 0.05,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
  permission_denials: [{ tool_name: 'Bash', tool_use_id: 'x', tool_input: {} }],
  result: 'ok',
};

test('runAgent reports done with a result summary and passes SDK options', async () => {
  const { status, writes, log, capture } = await run([
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5', permissionMode: 'acceptEdits', claude_code_version: '2.1.283' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/player/a.gd' } }] } },
    SUCCESS,
  ]);

  assert.equal(writes[0].state, 'running');
  assert.equal(status.state, 'done');
  assert.equal(status.pid, 77);
  assert.equal(status.claudeCodeVersion, '2.1.283');
  assert.deepEqual(status.result.usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 1 });
  assert.deepEqual(status.result.permissionDenials, ['Bash']);
  assert.ok(log.some((line) => line.includes('→ Edit src/player/a.gd')));

  assert.equal(capture.prompt, 'Do the task.');
  assert.equal(capture.options.sessionId, BASE_SPEC.sessionId);
  assert.equal(capture.options.resume, undefined);
  assert.equal(capture.options.permissionPrompts, 'none');
  assert.equal(capture.options.projectConfigRoot, BASE_SPEC.projectConfigRoot);
  assert.equal(capture.options.effort, 'high');
  assert.equal(capture.options.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
});

test('runAgent resumes by session id instead of setting a new one', async () => {
  const { capture } = await run([SUCCESS], { ...BASE_SPEC, resume: true });
  assert.equal(capture.options.resume, BASE_SPEC.sessionId);
  assert.equal(capture.options.sessionId, undefined);
});

test('runAgent classifies authentication errors as blocked on login', async () => {
  const { status } = await run([
    { type: 'assistant', error: 'authentication_failed', message: { content: [] } },
    { ...SUCCESS, is_error: true, result: 'Failed to authenticate: OAuth session expired' },
    new Error('Claude Code returned an error result: Failed to authenticate'),
  ]);
  assert.equal(status.state, 'blocked');
  assert.equal(status.blockReason, 'login');
});

test('runAgent classifies a rejected rate limit as blocked on rate_limit', async () => {
  const { status } = await run([
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 123 } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['request failed'], permission_denials: [] },
  ]);
  assert.equal(status.state, 'blocked');
  assert.equal(status.blockReason, 'rate_limit');
});

test('runAgent reports other failures as failed with detail', async () => {
  const { status } = await run([
    { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['max turns reached'], permission_denials: [] },
  ]);
  assert.equal(status.state, 'failed');
  assert.match(status.detail, /max turns reached/);
});

test('runAgent without allowedPaths installs no scope hook', async () => {
  const { capture } = await run([SUCCESS], { ...BASE_SPEC, allowedPaths: null });
  assert.equal(capture.options.hooks, undefined);
});

test('scope hook allows in-scope writes and denies everything else with a redirect', async () => {
  const { createScopeHook } = await loadCore();
  const denials = [];
  const hook = createScopeHook({
    cwd: CWD,
    allowedPaths: BASE_SPEC.allowedPaths,
    interfaceRequest: BASE_SPEC.interfaceRequest,
    onDeny: (denial) => denials.push(denial),
  });

  assert.deepEqual(await hook({ tool_name: 'Write', tool_input: { file_path: path.join(CWD, 'src/player/new_file.gd') } }), {});
  assert.deepEqual(await hook({ tool_name: 'Edit', tool_input: { file_path: 'work/modules/player/report.md' } }), {});

  const outside = await hook({ tool_name: 'Edit', tool_input: { file_path: 'src/enemy/enemy.gd' } });
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /src\/enemy\/enemy\.gd is outside your allowed files/);
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /work\/modules\/player\/request\.md/);

  const escaping = await hook({ tool_name: 'Write', tool_input: { file_path: path.resolve(CWD, '..', 'other', 'x.gd') } });
  assert.equal(escaping.hookSpecificOutput.permissionDecision, 'deny');

  const notebook = await hook({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'notes/a.ipynb' } });
  assert.equal(notebook.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(denials.map((denial) => denial.path), ['src/enemy/enemy.gd', path.resolve(CWD, '..', 'other', 'x.gd'), 'notes/a.ipynb']);
});

test('runAgent records scope denials in status', async () => {
  const { runAgent } = await loadCore();
  const statuses = [];
  const query = ({ options }) =>
    (async function* stream() {
      const hook = options.hooks.PreToolUse[0].hooks[0];
      await hook({ tool_name: 'Edit', tool_input: { file_path: 'src/enemy/enemy.gd' } });
      yield SUCCESS;
    })();

  const status = await runAgent({
    spec: BASE_SPEC,
    query,
    writeStatus: async (value) => statuses.push(value.scopeDenials.length),
    appendLog: async () => {},
    heartbeatMs: 60000,
  });
  assert.equal(status.state, 'done');
  assert.deepEqual(status.scopeDenials.map((denial) => denial.path), ['src/enemy/enemy.gd']);
});

test('classifyFailureText recognizes login and rate limit wording', async () => {
  const { classifyFailureText } = await loadCore();
  assert.equal(classifyFailureText('Failed to authenticate: OAuth session expired'), 'login');
  assert.equal(classifyFailureText("You've hit your session limit · resets 7:40pm"), 'rate_limit');
  assert.equal(classifyFailureText('Tool crashed'), null);
});
