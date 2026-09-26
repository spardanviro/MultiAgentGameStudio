const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  detectCompileCommand,
  extractDiagnostics,
  normalizeCompileCommand,
  runDiagnostics,
} = require('../src/diagnostics');

test('extractDiagnostics captures errors and warnings from compile output', () => {
  const items = extractDiagnostics([
    {
      name: 'compile stderr',
      text: [
        'Assets/Scripts/Player.cs(12,5): error CS0103: The name hp does not exist',
        'Assets/Scripts/Enemy.cs(2,1): warning CS0168: unused variable',
      ].join('\n'),
    },
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].severity, 'error');
  assert.equal(items[1].severity, 'warning');
});

test('normalizeCompileCommand supports argv lists and simple strings', () => {
  assert.deepEqual(normalizeCompileCommand(['npm', 'test']), { command: 'npm', args: ['test'] });
  assert.deepEqual(normalizeCompileCommand('dotnet build Game.csproj'), {
    command: 'dotnet',
    args: ['build', 'Game.csproj'],
  });
});

test('detectCompileCommand adapts to common language project files', async () => {
  const nodeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-node-'));
  await fs.writeFile(
    path.join(nodeRoot, 'package.json'),
    JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { typescript: '^5.0.0' } }),
    'utf8',
  );
  assert.deepEqual(await detectCompileCommand(nodeRoot), {
    command: 'npm',
    args: ['run', 'build'],
    detectedLanguage: 'typescript',
    detectedReason: 'package.json scripts.build',
  });

  const csharpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-csharp-'));
  await fs.writeFile(path.join(csharpRoot, 'Game.csproj'), '<Project />', 'utf8');
  assert.deepEqual(await detectCompileCommand(csharpRoot), {
    command: 'dotnet',
    args: ['build', 'Game.csproj'],
    detectedLanguage: 'csharp',
    detectedReason: '.csproj file',
  });

  const rustRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-rust-'));
  await fs.writeFile(path.join(rustRoot, 'Cargo.toml'), '[package]\nname="game"\n', 'utf8');
  assert.deepEqual(await detectCompileCommand(rustRoot), {
    command: 'cargo',
    args: ['check'],
    detectedLanguage: 'rust',
    detectedReason: 'Cargo.toml',
  });
});

test('runDiagnostics auto-detects compile command when manifest leaves it empty', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-auto-'));
  await fs.writeFile(path.join(root, 'go.mod'), 'module game\n', 'utf8');
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return {
      command,
      args,
      cwd: options.cwd,
      exitCode: 0,
      failed: false,
      error: null,
      stdout: '',
      stderr: '',
      durationMs: 7,
    };
  };

  const result = await runDiagnostics(root, 'run-001', {}, { runner });

  assert.deepEqual(calls[0], { command: 'go', args: ['test', './...'], cwd: root });
  assert.equal(result.compile.detectedLanguage, 'go');
  assert.equal(result.compile.detectedReason, 'go.mod');
});

test('runDiagnostics writes markdown and json reports for main architect', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-test-'));
  const runner = async (command, args, options) => ({
    command,
    args,
    cwd: options.cwd,
    exitCode: 1,
    failed: true,
    error: 'compile failed',
    stdout: '',
    stderr: 'Assets/Scripts/Card.cs(8,10): error CS1002: ; expected\nwarning CS0219: assigned but unused\n',
    durationMs: 12,
  });

  const result = await runDiagnostics(
    root,
    'run-001',
    {
      compileCommand: ['unity-compile-check'],
    },
    { runner },
  );

  const report = await fs.readFile(result.reportPath, 'utf8');
  const json = JSON.parse(await fs.readFile(result.jsonPath, 'utf8'));

  assert.equal(result.counts.error, 1);
  assert.equal(result.counts.warning, 1);
  assert.match(report, /Report For Main Architect/);
  assert.match(report, /CS1002/);
  assert.equal(json.counts.error, 1);
});
