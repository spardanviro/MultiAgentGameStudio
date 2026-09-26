const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { getProjectLogPath, logEvent, readLogs } = require('../src/managerLogger');

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
  assert.ok(logs.appLogPath.endsWith(path.join('.multiagent-manager', 'logs', 'manager.log')));
});
