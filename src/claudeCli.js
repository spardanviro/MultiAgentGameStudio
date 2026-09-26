const fs = require('node:fs');
const path = require('node:path');

function getEnvPath(env = process.env) {
  return env.PATH || env.Path || env.path || '';
}

function pathExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getClaudeCandidates(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const candidates = [];

  if (env.CLAUDE_CODE_PATH) {
    candidates.push(path.resolve(env.CLAUDE_CODE_PATH));
  }

  if (platform === 'win32') {
    const appData = env.APPDATA || env.AppData;
    if (appData) {
      candidates.push(
        path.join(appData, 'npm', 'claude.cmd'),
        path.join(appData, 'npm', 'claude.bat'),
        path.join(appData, 'npm', 'claude.ps1'),
        path.join(appData, 'npm', 'claude.exe'),
        path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      );
    }
  }

  const executableNames =
    platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];
  const pathDirs = getEnvPath(env).split(path.delimiter).filter(Boolean);
  for (const directory of pathDirs) {
    for (const executableName of executableNames) {
      candidates.push(path.join(directory, executableName));
    }
  }

  candidates.push('claude');
  return unique(candidates);
}

function resolveClaudeCommand(options = {}) {
  const exists = options.exists || pathExists;
  const candidates = getClaudeCandidates(options);
  return candidates.find((candidate) => candidate === 'claude' || exists(candidate)) || 'claude';
}

function buildClaudeInvocation(args = [], options = {}) {
  const platform = options.platform || process.platform;
  const command = resolveClaudeCommand(options);

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/c', 'call', command, ...args],
      displayCommand: `${command} ${args.join(' ')}`.trim(),
    };
  }

  if (platform === 'win32' && /\.ps1$/i.test(command)) {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
      displayCommand: `${command} ${args.join(' ')}`.trim(),
    };
  }

  return {
    command,
    args,
    displayCommand: `${command} ${args.join(' ')}`.trim(),
  };
}

module.exports = {
  buildClaudeInvocation,
  getClaudeCandidates,
  resolveClaudeCommand,
};
