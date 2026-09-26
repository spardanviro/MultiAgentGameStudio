const path = require('node:path');

// Machine-local app data (logs, app state, provider profiles, model options).
// MULTIAGENT_MANAGER_HOME overrides the location; the test runner sets it to a
// temp dir so tests never write into the real app data folder.
const DEFAULT_APP_DATA_DIR = path.resolve(__dirname, '..', '.multiagent-manager');
const APP_DATA_DIR_ENV = 'MULTIAGENT_MANAGER_HOME';

function getAppDataDir(env = process.env) {
  const override = env[APP_DATA_DIR_ENV];
  return override ? path.resolve(override) : DEFAULT_APP_DATA_DIR;
}

function getAppDataPath(...segments) {
  return path.join(getAppDataDir(), ...segments);
}

module.exports = {
  APP_DATA_DIR_ENV,
  DEFAULT_APP_DATA_DIR,
  getAppDataDir,
  getAppDataPath,
};
