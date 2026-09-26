const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildClaudeInvocation, resolveClaudeCommand } = require('../src/claudeCli');

test('resolveClaudeCommand prefers command-line shim under APPDATA npm install', () => {
  const appData = 'C:\\Users\\Nero\\AppData\\Roaming';
  const cmdShim = path.join(appData, 'npm', 'claude.cmd');
  const internalExe = path.join(
    appData,
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );

  const resolved = resolveClaudeCommand({
    platform: 'win32',
    env: {
      APPDATA: appData,
      Path: '',
    },
    exists: (candidate) => candidate === cmdShim || candidate === internalExe,
  });

  assert.equal(resolved, cmdShim);
});

test('buildClaudeInvocation wraps cmd shims through cmd.exe on Windows', () => {
  const appData = 'C:\\Users\\Nero\\AppData\\Roaming';
  const cmdShim = path.join(appData, 'npm', 'claude.cmd');
  const invocation = buildClaudeInvocation(['--bg', '--name', 'main-architect'], {
    platform: 'win32',
    env: {
      APPDATA: appData,
      Path: '',
    },
    exists: (candidate) => candidate === cmdShim,
  });

  assert.equal(invocation.command, 'cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 4), ['/d', '/c', 'call', cmdShim]);
  assert.equal(invocation.args[4], '--bg');
});

test('buildClaudeInvocation can run PowerShell shim when only ps1 exists', () => {
  const appData = 'C:\\Users\\Nero\\AppData\\Roaming';
  const psShim = path.join(appData, 'npm', 'claude.ps1');
  const invocation = buildClaudeInvocation(['agents', '--json'], {
    platform: 'win32',
    env: {
      APPDATA: appData,
      Path: '',
    },
    exists: (candidate) => candidate === psShim,
  });

  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(invocation.args[4], psShim);
});
