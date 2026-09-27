const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  RUNNER_PATH,
  blockedStatusFor,
  classifyAgentStatus,
  launchAgentProcess,
  readAgentStatus,
} = require('../src/agentProcess');

test('launchAgentProcess writes spec and starting status, keeps env out of the spec', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-process-'));
  const spawned = [];
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, options });
    return { pid: 999, unref() {} };
  };

  const launch = await launchAgentProcess({
    dir,
    spec: { sessionId: 'abc', cwd: dir, prompt: 'x' },
    env: { SECRET_KEY: 'shh', PATH: 'p' },
    spawnImpl,
    execPath: 'node-or-electron',
  });

  const spec = JSON.parse(await fs.readFile(path.join(dir, 'spec.json'), 'utf8'));
  assert.equal(spec.sessionId, 'abc');
  assert.ok(!JSON.stringify(spec).includes('shh'));
  assert.equal((await readAgentStatus(dir)).state, 'starting');
  assert.equal(launch.pid, 999);
  assert.equal(launch.logPath, path.join(dir, 'agent.log'));

  const [{ command, args, options }] = spawned;
  assert.equal(command, 'node-or-electron');
  assert.deepEqual(args, [RUNNER_PATH, path.join(dir, 'spec.json')]);
  assert.equal(options.detached, true);
  assert.equal(options.env.SECRET_KEY, 'shh');
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('launchAgentProcess refuses to spawn a real runner under the test guard', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-process-guard-'));
  await assert.rejects(launchAgentProcess({ dir, spec: { sessionId: 'abc', cwd: dir } }), /refusing to start a real agent runner/);
});

test('readAgentStatus tolerates missing and half-written files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-status-'));
  assert.equal(await readAgentStatus(dir), null);
  await fs.writeFile(path.join(dir, 'status.json'), '{"state":', 'utf8');
  assert.equal(await readAgentStatus(dir), null);
});

test('classifyAgentStatus maps terminal states and checks runner liveness', () => {
  const alive = { isAlive: () => true };
  const dead = { isAlive: () => false };

  assert.equal(classifyAgentStatus(null).phase, 'unknown');
  assert.equal(classifyAgentStatus({ state: 'done' }).phase, 'done');
  assert.equal(classifyAgentStatus({ state: 'failed', detail: 'x' }).detail, 'x');
  assert.deepEqual(classifyAgentStatus({ state: 'blocked', blockReason: 'login', detail: 'd' }), {
    phase: 'blocked',
    blockReason: 'login',
    detail: 'd',
  });
  assert.equal(classifyAgentStatus({ state: 'running', pid: 5 }, alive).phase, 'running');
  assert.equal(classifyAgentStatus({ state: 'running', pid: 5 }, dead).phase, 'lost');
  assert.equal(classifyAgentStatus({ state: 'starting', pid: null }, { ...dead, launchedPid: 5 }).phase, 'lost');

  const now = Date.parse('2026-09-27T12:00:00Z');
  const fresh = { state: 'starting', pid: null, updatedAt: '2026-09-27T11:59:30Z' };
  const stale = { state: 'starting', pid: null, updatedAt: '2026-09-27T11:00:00Z' };
  assert.equal(classifyAgentStatus(fresh, { now }).phase, 'running');
  assert.equal(classifyAgentStatus(stale, { now }).phase, 'lost');
});

test('blockedStatusFor maps runner block reasons to agent statuses', () => {
  assert.equal(blockedStatusFor('login'), 'blocked_login');
  assert.equal(blockedStatusFor('rate_limit'), 'blocked_rate_limit');
  assert.equal(blockedStatusFor(null), 'blocked_dialog');
});
