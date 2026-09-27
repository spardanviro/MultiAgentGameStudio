// Run the manifest's compile/diagnostics command in the project and count
// errors and warnings in its output.
import { spawnSync } from 'node:child_process';

const MAX_LINES = { error: 40, warning: 20 };
const ZERO_COUNT = /\b0 (errors?|warnings?)\b/i;

function quoteForCmd(arg) {
  return /^[\w./:=@-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`;
}

export function classifyLine(line) {
  if (!line.trim() || ZERO_COUNT.test(line)) {
    return null;
  }
  if (/\b(error|fatal)\b|\bERR!|\berror[A-Z]{1,3}\d+/i.test(line)) {
    return 'error';
  }
  if (/\bwarn(ing)?\b/i.test(line)) {
    return 'warning';
  }
  return null;
}

/**
 * @param {string} root project root (cwd for the command)
 * @param {{compileCommand: string|string[]|null, timeoutMs: number}} config
 */
export function runDiagnostics(root, config) {
  const command = config.compileCommand;
  if (!command || (Array.isArray(command) && !command.length)) {
    return { ran: false, reason: 'No diagnostics.compile_command in the manifest.' };
  }

  const options = { cwd: root, encoding: 'utf8', timeout: config.timeoutMs, windowsHide: true };
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

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const lines = { error: [], warning: [] };
  for (const line of output.split(/\r?\n/)) {
    const kind = classifyLine(line);
    if (kind) {
      lines[kind].push(line.trim());
    }
  }
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const exitCode = typeof result.status === 'number' ? result.status : null;
  return {
    ran: true,
    command: Array.isArray(command) ? command.join(' ') : command,
    exitCode,
    timedOut,
    spawnError: result.error && !timedOut ? result.error.message : null,
    errorCount: lines.error.length,
    warningCount: lines.warning.length,
    errors: lines.error.slice(0, MAX_LINES.error),
    warnings: lines.warning.slice(0, MAX_LINES.warning),
    failed: timedOut || Boolean(result.error) || exitCode !== 0 || lines.error.length > 0,
    output,
  };
}
