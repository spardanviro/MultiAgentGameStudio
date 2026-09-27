// Git choreography for a run: each run works on its own branch
// (multiagent-runs/<runId>), every accepted patch becomes a commit there, and
// agent worktrees start from that branch's tip so later agents see earlier
// work. `runner` is multiAgent's command runner (injected for tests).
const fs = require('node:fs/promises');
const path = require('node:path');

const MANAGER_DIR_PREFIX = '.multiagent/';
const EXCLUDE_LINE = '/.multiagent/';

function getRunBranchName(runId) {
  return `multiagent-runs/${runId}`;
}

/**
 * Keep the manager's own folder (state, patches, worktrees) out of
 * `git status` via .git/info/exclude, without touching the project's
 * .gitignore.
 */
async function ensureManagerDirExcluded(projectRoot, runner) {
  const result = await runner('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: projectRoot });
  const reported = result.stdout.trim();
  if (!/info[\\/]exclude$/.test(reported)) {
    return false;
  }
  const excludePath = path.resolve(projectRoot, reported);
  let current = '';
  try {
    current = await fs.readFile(excludePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_LINE || line.trim() === '.multiagent/')) {
    return false;
  }
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await fs.appendFile(excludePath, `${prefix}# Claude MultiAgent Manager run data\n${EXCLUDE_LINE}\n`, 'utf8');
  return true;
}

// `git status --porcelain -z` entries are "XY path"; a rename or copy is
// followed by an extra field holding the original path. Both sides are
// returned so a rename can be staged.
function parsePorcelainZ(output) {
  const fields = output.split('\0');
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) {
      continue;
    }
    files.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') {
      files.push(fields[index + 1]);
      index += 1;
    }
  }
  return files;
}

/**
 * Uncommitted changes that agents would not see (their worktrees start from
 * HEAD), ignoring the manager's own folder.
 */
async function listUncommittedChanges(projectRoot, runner) {
  const result = await runner('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: projectRoot });
  return [...new Set(parsePorcelainZ(result.stdout))].filter((file) => file && !file.startsWith(MANAGER_DIR_PREFIX));
}

/**
 * Make sure the project is on the run branch, creating it from the current
 * HEAD the first time. Returns the branch the project was on before.
 */
async function ensureRunBranch(projectRoot, runBranch, runner) {
  const current = (await runner('git', ['branch', '--show-current'], { cwd: projectRoot })).stdout.trim();
  if (current === runBranch) {
    return { created: false, previousBranch: current };
  }
  const existing = (await runner('git', ['branch', '--list', runBranch], { cwd: projectRoot })).stdout.trim();
  if (existing) {
    throw new Error(
      `The project is on "${current || 'a detached HEAD'}", but this run's branch ${runBranch} already exists. ` +
        `Run \`git switch ${runBranch}\` in the project before continuing.`,
    );
  }
  await runner('git', ['switch', '-c', runBranch], { cwd: projectRoot });
  return { created: true, previousBranch: current || null };
}

async function hasStagedChanges(projectRoot, runner) {
  const result = await runner('git', ['diff', '--cached', '--name-only'], { cwd: projectRoot });
  return Boolean(result.stdout.trim());
}

async function getHead(projectRoot, runner) {
  return (await runner('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })).stdout.trim();
}

/**
 * Apply a patch to index + working tree and commit it. If the commit fails
 * (for example no git identity), the patch is reversed so the project is left
 * as it was.
 * @returns {Promise<string>} the new commit
 */
async function applyAndCommitPatch(projectRoot, patchPath, message, runner) {
  if (await hasStagedChanges(projectRoot, runner)) {
    throw new Error('Patch safety check failed: the project has staged changes. Commit or unstage them first.');
  }
  await runner('git', ['apply', '--check', '--index', '--whitespace=nowarn', patchPath], { cwd: projectRoot });
  await runner('git', ['apply', '--index', '--whitespace=nowarn', patchPath], { cwd: projectRoot });
  try {
    await runner('git', ['commit', '-m', message], { cwd: projectRoot, timeoutMs: 120000 });
  } catch (error) {
    await runner('git', ['apply', '-R', '--index', '--whitespace=nowarn', patchPath], { cwd: projectRoot });
    throw new Error(
      `Patch applied but could not be committed, so it was reverted: ${error.stderr || error.message}. ` +
        'Check that git user.name and user.email are configured for this project.',
    );
  }
  return getHead(projectRoot, runner);
}

/**
 * Commit everything uncommitted (outside .multiagent/), e.g. the Main
 * Architect's scaffold and prompts, so agents start from it.
 * @returns {Promise<{committed: boolean, commit: string, files: string[]}>}
 */
async function commitWorkingTree(projectRoot, message, runner) {
  const files = await listUncommittedChanges(projectRoot, runner);
  if (!files.length) {
    return { committed: false, commit: await getHead(projectRoot, runner), files };
  }
  await runner('git', ['add', '-A', '--', ...files], { cwd: projectRoot });
  await runner('git', ['commit', '-m', message], { cwd: projectRoot, timeoutMs: 120000 });
  return { committed: true, commit: await getHead(projectRoot, runner), files };
}

module.exports = {
  applyAndCommitPatch,
  commitWorkingTree,
  ensureManagerDirExcluded,
  ensureRunBranch,
  getRunBranchName,
  listUncommittedChanges,
};
