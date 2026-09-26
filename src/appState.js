const fs = require('node:fs/promises');
const path = require('node:path');
const { getAppDataPath } = require('./appPaths');

function getAppStatePath() {
  return getAppDataPath('app-state.json');
}

async function readAppState() {
  try {
    return JSON.parse(await fs.readFile(getAppStatePath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeAppState(state) {
  const statePath = getAppStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(`${statePath}.tmp`, statePath);
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
  getAppStatePath,
  readAppState,
  rememberProject,
  rememberRun,
  updateAppState,
};
