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

// Never read the developer's real ~/.claude/jobs from tests.
if (!process.env.CLAUDE_CONFIG_DIR) {
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-claude-config-'));
}

// Tests must inject a fake launcher; never start real agent runner processes.
process.env.MULTIAGENT_MANAGER_NO_AGENT_SPAWN = '1';
