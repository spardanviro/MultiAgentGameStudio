// Real temporary git repositories for integration tests.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * A committed repo with a player module, its test, and prompt files.
 */
async function makeTempGitRepo(prefix = 'multiagent-test-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await run('git', ['init'], { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await fs.mkdir(path.join(root, 'src', 'player'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests', 'player'), { recursive: true });
  await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(root, 'work', 'prompts'), { recursive: true });
  await fs.mkdir(path.join(root, 'work', 'modules', 'player_health'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'player', 'player_health.gd'), 'class_name PlayerHealth\n');
  await fs.writeFile(path.join(root, 'tests', 'player', 'test_player_health.gd'), '# test\n');
  await fs.writeFile(path.join(root, 'work', 'prompts', 'player_health.md'), 'Implement health.\n');
  await run('git', ['add', '.'], { cwd: root });
  await run('git', ['commit', '-m', 'init'], { cwd: root });
  return root;
}

async function git(root, ...args) {
  return (await run('git', args, { cwd: root })).stdout.trim();
}

module.exports = {
  git,
  makeTempGitRepo,
  run,
};
