// Preloaded by `npm test` (node --import) into every test process so app-level
// logs, app state and provider config land in a throwaway dir instead of the
// real .multiagent-manager folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_DATA_DIR_ENV } = require('../src/appPaths');

if (!process.env[APP_DATA_DIR_ENV]) {
  process.env[APP_DATA_DIR_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-app-data-'));
}
