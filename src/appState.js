const fs = require('node:fs/promises');
const path = require('node:path');

const APP_STATE_PATH = path.resolve(__dirname, '..', '.multiagent-manager', 'app-state.json');

async function readAppState() {
  try {
    return JSON.parse(await fs.readFile(APP_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function writeAppState(state) {
  await fs.mkdir(path.dirname(APP_STATE_PATH), { recursive: true });
  await fs.writeFile(`${APP_STATE_PATH}.tmp`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(`${APP_STATE_PATH}.tmp`, APP_STATE_PATH);
}

async function updateAppState(patch) {
  const state = await readAppState();
  const next = {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeAppState(next);
  return next;
}

async function rememberProject(projectRoot) {
  if (!projectRoot) {
    return readAppState();
  }
  return updateAppState({
    lastProjectRoot: path.resolve(projectRoot),
  });
}

async function rememberRun(projectRoot, runId) {
  if (!projectRoot || !runId) {
    return readAppState();
  }
  return updateAppState({
    lastProjectRoot: path.resolve(projectRoot),
    lastRunId: runId,
  });
}

module.exports = {
  APP_STATE_PATH,
  readAppState,
  rememberProject,
  rememberRun,
  updateAppState,
};
