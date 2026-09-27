// Test doubles for the agent runner (src/agentProcess.js).
const fs = require('node:fs/promises');
const path = require('node:path');

const FAKE_PID = 4242;

/**
 * A launchAgent replacement that records launches instead of spawning.
 */
function createFakeLauncher() {
  const launches = [];
  const launchAgent = async ({ dir, spec, env }) => {
    launches.push({ dir, spec, env });
    await fs.mkdir(dir, { recursive: true });
    return { pid: FAKE_PID, logPath: path.join(dir, 'agent.log'), statusPath: path.join(dir, 'status.json') };
  };
  return { launches, launchAgent };
}

/**
 * Write the status.json a runner would produce.
 */
async function writeRunnerStatus(dir, status) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'status.json'),
    JSON.stringify({ version: 1, pid: FAKE_PID, updatedAt: new Date().toISOString(), ...status }, null, 2),
    'utf8',
  );
}

const runnerAlive = { isAlive: () => true };
const runnerDead = { isAlive: () => false };

module.exports = {
  FAKE_PID,
  createFakeLauncher,
  runnerAlive,
  runnerDead,
  writeRunnerStatus,
};
