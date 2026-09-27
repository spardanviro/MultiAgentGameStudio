// Detached agent runner process. Started by src/agentProcess.js as
//   <node or electron with ELECTRON_RUN_AS_NODE=1> agentRunner.mjs <spec.json>
// It survives the manager app closing, and reports through files next to the
// spec: status.json (lifecycle, result, scope denials) and agent.log.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from './agentRunnerCore.mjs';

const WRITE_RETRIES = 5;
const WRITE_RETRY_DELAY_MS = 50;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Atomic replace; Windows can refuse the rename while a reader has the file
// open, so retry briefly and fall back to a direct write.
async function writeJsonAtomic(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, text, 'utf8');
  for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        throw error;
      }
      await delay(WRITE_RETRY_DELAY_MS);
    }
  }
  await fs.writeFile(filePath, text, 'utf8');
  await fs.rm(tmpPath, { force: true });
}

async function main() {
  const specPath = path.resolve(process.argv[2] || '');
  const dir = path.dirname(specPath);
  const statusPath = path.join(dir, 'status.json');
  const logPath = path.join(dir, 'agent.log');
  const appendLog = (line) => fs.appendFile(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  const writeStatus = (status) => writeJsonAtomic(statusPath, status);

  // Only needed to start this script under Electron; the Claude subprocess
  // inherits the environment and must not see it.
  delete process.env.ELECTRON_RUN_AS_NODE;

  let spec;
  try {
    spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
  } catch (error) {
    await writeStatus({
      version: 1,
      pid: process.pid,
      state: 'failed',
      detail: `Runner could not read spec ${specPath}: ${error.message}`,
      updatedAt: new Date().toISOString(),
    });
    return 1;
  }

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    await runAgent({ spec, query, writeStatus, appendLog });
    return 0;
  } catch (error) {
    await appendLog(`runner crashed: ${error.stack || error.message}`);
    await writeStatus({
      version: 1,
      pid: process.pid,
      sessionId: spec.sessionId,
      state: 'failed',
      detail: `Agent runner crashed: ${error.message}`,
      updatedAt: new Date().toISOString(),
    });
    return 1;
  }
}

main().then((code) => process.exit(code));
