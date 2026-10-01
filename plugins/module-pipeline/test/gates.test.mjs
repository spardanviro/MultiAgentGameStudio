// 0.8.1: fixes from an outside review of the gates (shell scope, review consistency, the lock, diagnostics counts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyLine } from '../scripts/lib/diagnostics.mjs';
import { pidNamespace, pipelineDir, withLock } from '../scripts/lib/state.mjs';
import { findProtectedWrite, lexShell } from '../scripts/lib/shell.mjs';
import { decide } from '../scripts/scope-hook.mjs';
import { PLUGIN_ROOT, cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';
import { prepareArgs, runWorkflow } from './workflow-harness.mjs';

const IMPLEMENTER = 'module-pipeline:module-implementer';
const PASS = { verdict: 'pass', summary: 'Looks right.', rework_items: [] };

function implementer({ taskId, write: writeFile }) {
  writeFile(`src/${taskId}/${taskId}_impl.gd`, `class_name ${taskId}\n`);
  writeFile(`work/modules/${taskId}/module_report.md`, `${taskId} done.\n`);
  return { summary: `${taskId} built`, testsRun: 'none', blockers: [] };
}

const shell = (cwd, command, agentType = IMPLEMENTER) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, agent_type: agentType });
const denied = (output) => output?.hookSpecificOutput?.permissionDecision === 'deny';

// ---- 1. the shell and the main checkout ---------------------------------------

/** A project with a claimed writer worktree inside it, where Claude Code puts them. */
function writerInProject() {
  const { root, manifest } = makeProject();
  cli(root, 'prepare', manifest);
  const worktree = path.join(root, '.claude', 'worktrees', 'wf-1');
  git(root, 'worktree', 'add', '-q', '-b', 'agent/wf-1', worktree, 'HEAD');
  cli(worktree, 'claim', '--run', 'run-001', '--task', 'player');
  return { root, worktree, main: root.replace(/\\/g, '/'), own: worktree.replace(/\\/g, '/') };
}

test('a writer\'s shell command is refused when its text shows a write into the main checkout', () => {
  const { root, worktree, main } = writerInProject();
  const refused = (command) => {
    const output = decide(shell(worktree, command));
    assert.equal(denied(output), true, `should be refused: ${command}`);
    return output.hookSpecificOutput.permissionDecisionReason;
  };

  assert.match(refused(`echo x > ${main}/src/enemy/enemy.gd`), /would change .*enemy\.gd, which is in the main project checkout.*Reading the main checkout is fine/);
  refused(`cd "${main}" && echo x > src/enemy/enemy.gd`);
  refused(`rm -rf ${main}/src`);
  refused(`cp src/player/a.gd ${main}/src/player/a.gd`);
  refused(`mv ${main}/src/player/player.gd .`);
  refused(`mkdir -p ${main}/src/new && touch ${main}/src/new/a.gd`);
  refused(`sed -i 's/a/b/' ${main}/README.md`);
  refused(`npm test 2>&1 | tee ${main}/test.log`);
  refused(`git -C '${root}' checkout main`);
  refused(`cd ${main} && git reset --hard`);
  refused('echo x > ../../../README.md');
  refused('cd ../../.. && rm README.md');
  refused('touch ../wf-2/src/enemy/a.gd');
  refused(`cat > ${main}/notes.txt <<EOF\nhello\nEOF`);
  if (process.platform === 'win32') {
    refused(`echo x > /${main[0].toLowerCase()}${main.slice(2).toUpperCase()}/README.md`);
  }
});

test('reading the main checkout and every other command pass untouched', () => {
  const { root, worktree, main, own } = writerInProject();
  const allowed = (command, agentType = IMPLEMENTER, cwd = worktree) =>
    assert.equal(decide(shell(cwd, command, agentType)), null, `should pass: ${command}`);

  allowed('npm test && git status && git commit -q -m wip');
  allowed(`cat ${main}/docs/spec.md && ls ${main}/src && grep -r Player ${main}/src`);
  allowed(`git -C ${main} log --oneline -3`);
  allowed(`cd ${main} && git log --oneline -3 && ls`);
  allowed(`NODE_PATH=${main}/node_modules npm test`);
  allowed(`ln -s ${main}/node_modules node_modules`);
  allowed(`cp ${main}/.env .env && cp -r ${main}/node_modules .`);
  allowed(`echo "never run rm -rf ${main}" > notes.txt`);
  allowed(`cat > notes.md <<'EOF'\nrm -rf ${main}/src\ncd ${main} && touch x\nEOF\necho done > out.txt`);
  allowed(`(cd ${main} && ls); touch local.txt`);
  allowed(`x=$(cd ${main} && pwd); mkdir -p build`);
  allowed('rm -rf "$BUILD_DIR/out" && rm -rf $(pwd)/tmp');
  allowed(`# rm -rf ${main}\nls`);
  allowed(`rm -rf ${main}-old ${main}.bak`);
  allowed(`echo x > ${own}/src/player/a.gd && rm -f "${own}/src/player/b.gd"`);
  allowed(`echo log > "${os.tmpdir().replace(/\\/g, '/')}/probe.log"`);
  allowed(`node "${PLUGIN_ROOT.replace(/\\/g, '/')}/scripts/pipeline.mjs" claim --run run-001 --task player`);
  allowed('echo x 2>&1 >/dev/null && cmd > out.txt 2>> err.txt');
  allowed(`rm -rf ${main}/src`, 'module-pipeline:module-reviewer', root);
  allowed(`rm -rf ${main}/src`, null, root);
});

test('the shell reader splits commands, redirections, quotes, here-documents and subshells', () => {
  assert.deepEqual(lexShell(`A=1 rm -rf "a b" 'c d' e\\ f > out.txt 2>> err.txt && git -C x status | tee log; (cd y)`), [
    { words: ['A=1', 'rm', '-rf', 'a b', 'c d', 'e f'], writes: ['out.txt', 'err.txt'] },
    { words: ['git', '-C', 'x', 'status'], writes: [] },
    { words: ['tee', 'log'], writes: [] },
    { group: 'open' },
    { words: ['cd', 'y'], writes: [] },
    { group: 'close' },
  ]);
  assert.deepEqual(lexShell('cat <<-EOF > a.txt\n\trm x\n\tEOF\nls # not > here\nwc -l < in.txt'), [
    { words: ['cat'], writes: ['a.txt'] },
    { words: ['ls'], writes: [] },
    { words: ['wc', '-l'], writes: [] },
  ]);
});

test('a carve-out inside the protected folder is honored; a folder that contains it is not', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
  const inHome = (rest) => path.join(home, rest);
  const options = { cwd: inHome('.claude/worktrees/wf-1'), protectedRoot: home, allowed: [inHome('.claude/worktrees/wf-1'), inHome('tmp'), path.dirname(home)] };
  const hit = (command) => findProtectedWrite(command, options);
  assert.equal(hit('touch a.txt && echo x > "' + inHome('tmp/build.log').replace(/\\/g, '/') + '"'), null);
  assert.equal(hit('touch ' + inHome('notes.txt').replace(/\\/g, '/')).path, inHome('notes.txt'));
  assert.equal(hit('rm -rf ../wf-2').command, 'rm -rf ../wf-2');
});

test('the hook file sends shell commands through the scope hook before they run', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.match(hooks.PreToolUse[0].matcher, /(^|\|)Bash($|\|)/);
  assert.equal(hooks.PostToolUse[0].matcher, 'Bash');
});

test('record reports files left uncommitted in the main checkout', async () => {
  const { root, manifest } = makeProject();
  const { result } = await runWorkflow('implement-modules', { root, args: prepareArgs(root, manifest), scenario: { implement: implementer, review: () => PASS } });
  write(root, '.multiagent/out.json', JSON.stringify({ result }));
  const output = path.join(root, '.multiagent', 'out.json');
  assert.equal(cli(root, 'record', '--from', output).json.strayChanges, undefined, 'a clean run leaves nothing behind');

  write(root, 'src/enemy/written_by_shell.gd', 'not merged by the pipeline\n');
  const recorded = cli(root, 'record', '--from', output).json;
  assert.deepEqual(recorded.strayChanges, ['src/enemy/written_by_shell.gd']);
  assert.equal(recorded.status, 'passed', 'reported, not judged: it may be build output or the user\'s own edit');
  assert.match(fs.readFileSync(recorded.reportPath, 'utf8'), /## Uncommitted files in the main checkout\n\nNo pipeline merge wrote these\.[\s\S]*- src\/enemy\/written_by_shell\.gd/);
});

// ---- 2. the review and the status agree ---------------------------------------

test('integrate workflow: a partial or missing feature blocks the run unless it is deferred on record', async () => {
  const { root, manifest } = makeProject();
  await runWorkflow('implement-modules', { root, args: prepareArgs(root, manifest), scenario: { implement: implementer, review: () => PASS } });
  const coverage = (hud) => [{ feature: 'Player moves', status: 'done', owner: 'player' }, { feature: 'HUD tracks health', owner: 'hud', ...hud }];
  const review = (hud) => ({ verdict: 'pass', summary: 'Meets the spec.', spec_coverage: coverage(hud), rule_checks: [], rework_items: [] });
  let reviewPrompt = '';

  const first = await runWorkflow('integrate-system', {
    root,
    args: prepareArgs(root, manifest, '--stage', 'integration'),
    scenario: {
      integrate: ({ write: writeFile }) => {
        writeFile('src/game/main.gd', 'extends Node\n');
        return { summary: 'wired', testsRun: 'none', blockers: [] };
      },
      systemReview: (prompt) => {
        reviewPrompt = prompt;
        return review({ status: 'partial', note: 'the bar never updates' });
      },
    },
  });
  assert.match(reviewPrompt, /A `partial` or `missing` feature blocks the run/);
  assert.equal(first.result.status, 'rework_required', 'a "pass" verdict cannot hide an unfinished feature');
  assert.deepEqual(first.result.coverageGaps.map((row) => row.feature), ['HUD tracks health']);
  assert.equal(first.result.next, 'rework');

  write(root, '.multiagent/integration.json', JSON.stringify({ result: first.result }));
  const recorded = cli(root, 'record', '--from', path.join(root, '.multiagent', 'integration.json')).json;
  assert.deepEqual(recorded.coverageGaps.map((row) => row.feature), ['HUD tracks health']);
  assert.match(fs.readFileSync(recorded.reportPath, 'utf8'), /\| HUD tracks health \| partial \| hud \| the bar never updates \|\n\n1 feature\(s\) are partial or missing and not deferred/);

  const rerun = (hud) => runWorkflow('integrate-system', { root, args: prepareArgs(root, manifest, '--stage', 'integration'), scenario: { systemReview: () => review(hud) } });
  assert.equal((await rerun({ status: 'missing' })).result.status, 'rework_required');
  const deferred = await rerun({ status: 'partial', deferred: true, note: 'reports/rework/run-001-r1_decisions.md' });
  assert.equal(deferred.result.status, 'passed');
  assert.deepEqual(deferred.result.coverageGaps, []);
  assert.equal((await rerun({ status: 'done' })).result.status, 'passed');
});

// ---- 3. the lock --------------------------------------------------------------

function lockFile(root) {
  const file = path.join(pipelineDir(root), 'lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function hold(root, holder, ageMs = 0) {
  const file = lockFile(root);
  fs.writeFileSync(file, typeof holder === 'string' ? holder : JSON.stringify(holder));
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
  return file;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
/** A holder this process can see: same machine, same pid namespace. */
const visible = (pid, token) => ({ pid, host: os.hostname(), pidns: pidNamespace(), beats: true, token });
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a lock whose holder is still running is never taken over, however long it has been held', () => {
  const { root } = makeProject();
  const file = hold(root, visible(process.pid, 'slow-git-hook'), HOUR);
  let ran = false;
  assert.throws(
    () => withLock(root, () => { ran = true; }, { waitMs: 300 }),
    new RegExp(`Timed out after 0 s waiting for .*held by process ${process.pid} on .* and last touched 36\\d\\d s ago\\. If no pipeline command is still running, delete that file`),
  );
  assert.equal(ran, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'slow-git-hook', 'the holder keeps its lock');
});

test('a lock whose holder is gone is taken over at once', () => {
  const { root } = makeProject();
  const file = hold(root, visible(deadPid(), 'crashed'));
  const started = Date.now();
  assert.equal(withLock(root, () => 'done', { waitMs: 5000 }), 'done');
  assert.ok(Date.now() - started < 15000, 'no waiting for the 30 s of silence a hidden holder gets');
  assert.equal(fs.existsSync(file), false, 'released afterwards');
});

test('a holder in another sandbox or on another machine is judged by its heartbeat, not by its pid', () => {
  const { root } = makeProject();
  // Each sandboxed command has its own pid namespace: this pid means nothing here, alive or not.
  for (const elsewhere of [{ pidns: 'pid:[4026532294]' }, { host: 'another-machine' }]) {
    const holder = { ...visible(process.pid, 'elsewhere'), ...elsewhere };
    hold(root, holder, 5000);
    assert.throws(() => withLock(root, () => {}, { waitMs: 300 }), /Timed out .* last touched \d+ s ago/, 'touched a moment ago: its holder is working');
    hold(root, { ...visible(deadPid(), 'elsewhere'), ...elsewhere }, 5000);
    assert.throws(() => withLock(root, () => {}, { waitMs: 300 }), /Timed out/, 'a pid that is free here says nothing about a holder elsewhere');
    hold(root, holder, MINUTE);
    assert.equal(withLock(root, () => 'taken'), 'taken', 'silent for a minute: its holder is gone');
  }
});

test('a lock without a heartbeat falls back to its age', () => {
  const { root } = makeProject();
  for (const legacy of ['not a pid', { pid: process.pid, host: 'another-machine', token: 'old' }]) {
    hold(root, legacy, MINUTE);
    assert.throws(() => withLock(root, () => {}, { waitMs: 300 }), /Timed out/, 'a minute is not enough without a heartbeat');
    hold(root, legacy, HOUR);
    assert.equal(withLock(root, () => 'taken'), 'taken');
  }
});

test('the holder keeps touching its lock while it works, even when its thread is blocked', () => {
  const { root } = makeProject();
  const file = lockFile(root);
  /** Blocks this thread, as a synchronous git call does, until the lock file is touched again. */
  const waitForTouch = (since) => {
    for (let waited = 0; waited < 20000; waited += 100) {
      sleepSync(100);
      const touched = fs.statSync(file).mtimeMs;
      if (touched > since) {
        return touched;
      }
    }
    return null;
  };
  const touches = withLock(
    root,
    () => {
      const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(holder.beats, true);
      assert.equal(holder.pidns, pidNamespace());
      const first = waitForTouch(fs.statSync(file).mtimeMs);
      return [first, first && waitForTouch(first)];
    },
    { beatMs: 200 },
  );
  assert.ok(touches[0] && touches[1], 'the lock file was touched twice while its holder never yielded');
  assert.equal(fs.existsSync(file), false);
});

test('releasing never deletes a lock that now belongs to someone else', () => {
  const { root } = makeProject();
  const file = lockFile(root);
  withLock(root, () => {
    fs.writeFileSync(file, JSON.stringify(visible(process.pid, 'someone-else')));
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'someone-else');
  fs.rmSync(file);
  assert.throws(() => withLock(root, () => { throw new Error('inside'); }), /inside/);
  assert.equal(fs.existsSync(file), false, 'released after a failure too');
});

// ---- 4. counts in build output ------------------------------------------------

test('a summary line is judged by its numbers, so one count does not hide the other', () => {
  assert.equal(classifyLine('1 error, 0 warnings'), 'error');
  assert.equal(classifyLine('0 errors, 2 warnings'), 'warning');
  assert.equal(classifyLine('0 errors, 0 warnings'), null);
  assert.equal(classifyLine('Build succeeded. 0 Warning(s)'), null);
  assert.equal(classifyLine('    3 Error(s)'), 'error');
  assert.equal(classifyLine('✖ 3 problems (1 error, 2 warnings)'), 'error');
  assert.equal(classifyLine('error: could not compile `game` due to 1 previous error; 2 warnings emitted'), 'error');
  assert.equal(classifyLine('warning: `game` (lib) generated 3 warnings'), 'warning');
  assert.equal(classifyLine('src/a.ts(3,1): error TS2304: Cannot find name'), 'error');
  assert.equal(classifyLine('warning: unused variable'), 'warning');
  assert.equal(classifyLine('Compiling game v0.1.0'), null);
  assert.equal(classifyLine('   '), null);
});

test('diagnostics count the errors and the warnings of mixed summary lines', () => {
  const manifestText = fs.readFileSync(path.join(makeProject().root, 'tasks', 'task_manifest.yaml'), 'utf8').replace(
    'compile_command: null',
    `compile_command: ["node", "-e", "console.log('1 error, 0 warnings'); console.log('0 errors, 2 warnings'); console.log('0 errors, 0 warnings')"]`,
  );
  const { root, manifest } = makeProject(manifestText);
  cli(root, 'prepare', manifest);
  const result = cli(root, 'diagnostics', '--run', 'run-001').json;
  assert.equal(result.errorCount, 1);
  assert.equal(result.warningCount, 1);
  assert.equal(result.failed, true, 'an error line fails the build even when the command exits 0');
  assert.equal(git(root, 'status', '--porcelain'), '');
});
