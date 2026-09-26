const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  agentMatchesId,
  classifyAgentLifecycle,
  findAgent,
  findLaunchedAgent,
  launchBackgroundAgent,
  normalizeAgentRecord,
  parseAgentsJson,
  parseLaunchOutput,
  readJobState,
} = require('../src/claudeAgents');

// Captured from Claude Code 2.1.212 `claude --bg`.
const REAL_LAUNCH_OUTPUT = [
  'Starting background service…',
  'backgrounded · 26386b61 · probe-agent',
  '  claude agents             list sessions',
  '  claude attach 26386b61    open in this terminal',
  '  claude logs 26386b61      show recent output',
  '  claude stop 26386b61      stop this session',
].join('\n');

// Captured from Claude Code 2.1.212 `claude agents --json --all`.
const REAL_AGENTS_JSON = JSON.stringify([
  {
    pid: 37320,
    id: '26386b61',
    cwd: 'C:\\work\\bgprobe',
    kind: 'background',
    startedAt: 1790435974932,
    sessionId: '26386b61-31b4-4104-8a58-48b2e9c2b35d',
    name: 'probe-agent',
    status: 'idle',
    state: 'blocked',
  },
  {
    pid: 36508,
    cwd: 'C:\\work\\bgprobe',
    kind: 'interactive',
    startedAt: 1790435753353,
    sessionId: 'a00ebc04-12ac-4434-86a7-8c46fb86c5f0',
    name: 'interactive session',
    status: 'busy',
  },
]);

test('parseLaunchOutput reads the id from real `claude --bg` output', () => {
  assert.equal(parseLaunchOutput(REAL_LAUNCH_OUTPUT), '26386b61');
  assert.equal(parseLaunchOutput('backgrounded - b3f4fff3 - main-architect\n'), 'b3f4fff3');
  assert.equal(parseLaunchOutput('Run claude attach b3f4fff3 to reconnect.\n'), 'b3f4fff3');
});

test('parseLaunchOutput refuses to guess from unmarked or conflicting ids', () => {
  assert.equal(parseLaunchOutput('Starting background service…\nerror code deadbeef01\n'), null);
  assert.equal(parseLaunchOutput('commit abc1234 created'), null);
  assert.equal(parseLaunchOutput('backgrounded · 11111111 · a\nclaude attach 22222222'), null);
  assert.equal(parseLaunchOutput(''), null);
});

test('parseAgentsJson normalizes real CLI records and wrapped shapes', () => {
  const records = parseAgentsJson(REAL_AGENTS_JSON);
  assert.equal(records.length, 2);
  assert.equal(records[0].shortId, '26386b61');
  assert.equal(records[0].sessionId, '26386b61-31b4-4104-8a58-48b2e9c2b35d');
  assert.equal(records[0].state, 'blocked');
  assert.equal(records[1].shortId, 'a00ebc04');

  const wrapped = parseAgentsJson(JSON.stringify({ agents: [{ sessionId: 'abcdef12-0000-0000-0000-000000000000' }] }));
  assert.equal(wrapped[0].shortId, 'abcdef12');
  assert.deepEqual(parseAgentsJson(''), []);
});

test('parseAgentsJson throws a descriptive error on unexpected output', () => {
  assert.throws(() => parseAgentsJson('Usage: claude agents'), /not JSON/);
  assert.throws(() => parseAgentsJson('{"unexpected":true}'), /output shape/);
});

test('agentMatchesId matches short id, full uuid, and uuid prefix', () => {
  const [record] = parseAgentsJson(REAL_AGENTS_JSON);
  assert.ok(agentMatchesId(record, '26386b61'));
  assert.ok(agentMatchesId(record, '26386b61-31b4-4104-8a58-48b2e9c2b35d'));
  assert.ok(agentMatchesId(record, '26386B61'));
  assert.ok(!agentMatchesId(record, '26386b62'));
  assert.equal(findAgent([record], 'missing1'), null);
});

test('findLaunchedAgent picks the newest background agent by name, cwd, and start time', () => {
  const records = [
    normalizeAgentRecord({ id: 'old00001', name: 'main-architect', cwd: 'C:/p', kind: 'background', startedAt: 1000 }),
    normalizeAgentRecord({ id: 'new00002', name: 'main-architect', cwd: 'C:/p', kind: 'background', startedAt: 20000 }),
    normalizeAgentRecord({ id: 'other003', name: 'other-agent', cwd: 'C:/p', kind: 'background', startedAt: 30000 }),
  ];
  assert.equal(findLaunchedAgent(records, { name: 'main-architect', cwd: 'C:/p', since: 19000 }).shortId, 'new00002');
  assert.equal(findLaunchedAgent(records, { name: 'main-architect', cwd: 'C:/elsewhere', since: 0 }), null);
});

test('launchBackgroundAgent falls back to `claude agents --json` when output is unparseable', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args[0]);
    if (args[0] === 'agents') {
      return {
        stdout: JSON.stringify([
          { id: 'f00dcafe', name: 'task-agent', cwd: 'C:/wt', kind: 'background', startedAt: Date.now() },
        ]),
        stderr: '',
      };
    }
    return { stdout: 'Starting background service…\n', stderr: '' };
  };

  const launch = await launchBackgroundAgent({ runner, args: ['--bg'], cwd: 'C:/wt', name: 'task-agent' });
  assert.equal(launch.sessionId, 'f00dcafe');
  assert.equal(launch.source, 'agents');
  assert.deepEqual(calls, ['--bg', 'agents']);
});

test('launchBackgroundAgent reports a lookup error instead of inventing an id', async () => {
  const runner = async (command, args) =>
    args[0] === 'agents' ? { stdout: '[]', stderr: '' } : { stdout: 'something changed 1234abcd\n', stderr: '' };
  const launch = await launchBackgroundAgent({ runner, args: ['--bg'], cwd: 'C:/wt', name: 'task-agent' });
  assert.equal(launch.sessionId, null);
  assert.match(launch.lookupError, /No matching background agent/);
});

test('classifyAgentLifecycle does not treat idle process status as completion when state is blocked', () => {
  const [record] = parseAgentsJson(REAL_AGENTS_JSON);
  const result = classifyAgentLifecycle(record, { state: 'blocked', needs: 'login required — run /login · Login expired' });
  assert.equal(result.phase, 'blocked');
  assert.match(result.detail, /login required/);
});

test('classifyAgentLifecycle maps done, failed, running, and legacy status-only records', () => {
  assert.equal(classifyAgentLifecycle(normalizeAgentRecord({ id: 'aaaaaaaa', state: 'done' }), null).phase, 'done');
  assert.equal(classifyAgentLifecycle(normalizeAgentRecord({ id: 'aaaaaaaa', state: 'failed' }), null).phase, 'failed');
  assert.equal(classifyAgentLifecycle(normalizeAgentRecord({ id: 'aaaaaaaa', state: 'working' }), null).phase, 'running');
  assert.equal(classifyAgentLifecycle(normalizeAgentRecord({ id: 'aaaaaaaa', status: 'completed' }), null).phase, 'done');
  assert.equal(classifyAgentLifecycle(null, null).phase, 'unknown');
});

test('classifyAgentLifecycle treats a job with firstTerminalAt as done unless explicitly active', () => {
  const finishedJob = { state: 'waiting_input', firstTerminalAt: '2026-09-26T15:20:00.000Z' };
  assert.equal(classifyAgentLifecycle(null, finishedJob).phase, 'done');
  assert.equal(classifyAgentLifecycle(null, { ...finishedJob, state: 'working' }).phase, 'running');
});

test('classifyAgentLifecycle prefers the live agents list over a stale blocked job file', () => {
  const record = normalizeAgentRecord({ id: 'aaaaaaaa', state: 'working' });
  assert.equal(classifyAgentLifecycle(record, { state: 'blocked', needs: 'rate limited' }).phase, 'running');
});

test('readJobState resolves full session uuids to the short-id job directory', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-config-'));
  const jobDir = path.join(configDir, 'jobs', '26386b61');
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, 'state.json'), JSON.stringify({ state: 'blocked' }), 'utf8');
  const env = { CLAUDE_CONFIG_DIR: configDir };

  assert.equal((await readJobState('26386b61', { env })).state, 'blocked');
  assert.equal((await readJobState('26386b61-31b4-4104-8a58-48b2e9c2b35d', { env })).state, 'blocked');
  assert.equal(await readJobState('../../etc', { env }), null);
  assert.equal(await readJobState('ffffffff', { env }), null);
});
