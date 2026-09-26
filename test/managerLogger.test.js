const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { DEFAULT_APP_DATA_DIR, getAppDataDir } = require('../src/appPaths');
const { getAppLogPath, getProjectLogPath, logEvent, readLogs } = require('../src/managerLogger');

test('manager logger writes project log and reads it back', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-log-project-'));
  await logEvent('test.event', { projectRoot, value: 42 }, { projectRoot });

  const projectLogPath = getProjectLogPath(projectRoot);
  const projectLog = await fs.readFile(projectLogPath, 'utf8');
  const logs = await readLogs({ projectRoot });

  assert.match(projectLog, /test\.event/);
  assert.match(projectLog, /"value":42/);
  assert.equal(logs.projectLogPath, projectLogPath);
  assert.match(logs.projectLog, /test\.event/);
  assert.equal(logs.appLogPath, path.join(getAppDataDir(), 'logs', 'manager.log'));
});

test('app log is redirected away from the real app data dir during tests', async () => {
  assert.notEqual(getAppDataDir(), DEFAULT_APP_DATA_DIR);
  await logEvent('test.isolation', { marker: 'isolated' });

  const appLog = await fs.readFile(getAppLogPath(), 'utf8');
  assert.match(appLog, /test.isolation/);
  assert.ok(!getAppLogPath().startsWith(DEFAULT_APP_DATA_DIR));
});

test('getAppDataDir honors MULTIAGENT_MANAGER_HOME and falls back to the repo dir', () => {
  assert.equal(getAppDataDir({ MULTIAGENT_MANAGER_HOME: 'C:/custom/home' }), path.resolve('C:/custom/home'));
  assert.equal(getAppDataDir({}), DEFAULT_APP_DATA_DIR);
});
