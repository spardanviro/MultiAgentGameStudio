// Run the manifest's compile command and test command in a checkout of the
// run branch. Compile output is scanned for errors and warnings; tests are
// judged by their exit code.
import { spawnSync } from 'node:child_process';

const MAX_LINES = { error: 40, warning: 20 };
const TEST_TAIL_LINES = 40;
// A count in a summary line: "1 error", "0 warnings", "2 Warning(s)".
const COUNT = /\b(\d+)\s+(error|warning)s?\b/gi;

function quoteForCmd(arg) {
  return /^[\w./:=@-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`;
}

/**
 * 'error', 'warning' or null for one line of build output. In a summary line
 * the numbers decide: "1 error, 0 warnings" is an error and "0 errors, 2
 * warnings" a warning, while "0 errors, 0 warnings" is neither.
 */
export function classifyLine(line) {
  if (!line.trim()) {
    return null;
  }
  const counts = [...line.matchAll(COUNT)];
  if (counts.length) {
    const counted = (kind) => counts.some(([, count, word]) => word.toLowerCase() === kind && Number(count) > 0);
    // What is left once the counts are taken out is judged like any other line.
    const rest = classifyLine(line.replace(COUNT, ' '));
    return counted('error') || rest === 'error' ? 'error' : counted('warning') || rest === 'warning' ? 'warning' : null;
  }
  if (/\b(error|fatal)\b|\bERR!|\berror[A-Z]{1,3}\d+/i.test(line)) {
    return 'error';
  }
  if (/\bwarn(ing)?\b/i.test(line)) {
    return 'warning';
  }
  return null;
}

const hasCommand = (command) => Boolean(command) && !(Array.isArray(command) && !command.length);

function runCommand(root, command, timeoutMs) {
  const options = { cwd: root, encoding: 'utf8', timeout: timeoutMs, windowsHide: true };
  let result;
  if (Array.isArray(command)) {
    result = spawnSync(command[0], command.slice(1), options);
    // Windows shims such as npm.cmd only start through the shell.
    if (result.error?.code === 'ENOENT' && process.platform === 'win32') {
      result = spawnSync([command[0], ...command.slice(1).map(quoteForCmd)].join(' '), { ...options, shell: true });
    }
  } else {
    result = spawnSync(command, { ...options, shell: true });
  }
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const exitCode = typeof result.status === 'number' ? result.status : null;
  return {
    command: Array.isArray(command) ? command.join(' ') : command,
    exitCode,
    timedOut,
    spawnError: result.error && !timedOut ? result.error.message : null,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
    exitFailed: timedOut || Boolean(result.error) || exitCode !== 0,
  };
}

function summarizeCompile(run) {
  const lines = { error: [], warning: [] };
  for (const line of run.output.split(/\r?\n/)) {
    const kind = classifyLine(line);
    if (kind) {
      lines[kind].push(line.trim());
    }
  }
  return {
    command: run.command,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    errorCount: lines.error.length,
    warningCount: lines.warning.length,
    errors: lines.error.slice(0, MAX_LINES.error),
    warnings: lines.warning.slice(0, MAX_LINES.warning),
    failed: run.exitFailed || lines.error.length > 0,
  };
}

function summarizeTests(run) {
  const tail = run.output.split(/\r?\n/).filter((line) => line.trim()).slice(-TEST_TAIL_LINES);
  return {
    command: run.command,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    failed: run.exitFailed,
    tail,
  };
}

/**
 * @param {string} root checkout of the run branch (cwd for the commands)
 * @param {{compileCommand: string|string[]|null, testCommand?: string|string[]|null, timeoutMs: number}} config
 */
export function runDiagnostics(root, config) {
  const wantsCompile = hasCommand(config.compileCommand);
  const wantsTests = hasCommand(config.testCommand);
  if (!wantsCompile && !wantsTests) {
    return { ran: false, reason: 'No diagnostics.compile_command or diagnostics.test_command in the manifest.' };
  }

  const sections = [];
  let compile = null;
  if (wantsCompile) {
    const run = runCommand(root, config.compileCommand, config.timeoutMs);
    sections.push(`$ ${run.command}\n${run.output}`);
    compile = summarizeCompile(run);
  }
  let tests = null;
  if (wantsTests && compile?.failed) {
    tests = { command: Array.isArray(config.testCommand) ? config.testCommand.join(' ') : config.testCommand, skipped: true, failed: false, reason: 'The compile step failed.' };
  } else if (wantsTests) {
    const run = runCommand(root, config.testCommand, config.timeoutMs);
    sections.push(`$ ${run.command}\n${run.output}`);
    tests = summarizeTests(run);
  }

  return {
    ran: true,
    command: compile?.command ?? null,
    exitCode: compile?.exitCode ?? null,
    timedOut: Boolean(compile?.timedOut),
    spawnError: compile?.spawnError ?? null,
    errorCount: compile?.errorCount ?? 0,
    warningCount: compile?.warningCount ?? 0,
    errors: compile?.errors ?? [],
    warnings: compile?.warnings ?? [],
    tests,
    failed: Boolean(compile?.failed || tests?.failed),
    output: sections.join('\n\n'),
  };
}
