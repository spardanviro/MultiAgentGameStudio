const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_LOG_BYTES = 900000;
const MAX_ITEMS = 200;

function nowIso() {
  return new Date().toISOString();
}

function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function tokenizeCommand(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;
  while ((match = regex.exec(text))) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens.length ? { command: tokens[0], args: tokens.slice(1) } : null;
}

function normalizeCompileCommand(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      return null;
    }
    return {
      command: String(value[0]),
      args: value.slice(1).map(String),
    };
  }
  if (typeof value === 'string') {
    return tokenizeCommand(value);
  }
  if (typeof value === 'object' && value.command) {
    return {
      command: String(value.command),
      args: Array.isArray(value.args) ? value.args.map(String) : [],
    };
  }
  return null;
}

async function readJsonIfExists(filePath) {
  if (!(await fileExists(filePath))) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function detectCompileCommand(projectRoot) {
  const packageJson = await readJsonIfExists(path.join(projectRoot, 'package.json'));
  if (packageJson?.scripts) {
    if (packageJson.scripts.build) {
      return {
        command: 'npm',
        args: ['run', 'build'],
        detectedLanguage: packageJson.devDependencies?.typescript || packageJson.dependencies?.typescript
          ? 'typescript'
          : 'javascript',
        detectedReason: 'package.json scripts.build',
      };
    }
    if (packageJson.scripts.typecheck) {
      return {
        command: 'npm',
        args: ['run', 'typecheck'],
        detectedLanguage: 'typescript',
        detectedReason: 'package.json scripts.typecheck',
      };
    }
    if (packageJson.scripts.test) {
      return {
        command: 'npm',
        args: ['test'],
        detectedLanguage: 'javascript',
        detectedReason: 'package.json scripts.test',
      };
    }
  }

  const rootFiles = await fs.readdir(projectRoot);
  const solution = rootFiles.find((name) => name.toLowerCase().endsWith('.sln'));
  if (solution) {
    return {
      command: 'dotnet',
      args: ['build', solution],
      detectedLanguage: 'csharp',
      detectedReason: '.sln file',
    };
  }
  const csproj = rootFiles.find((name) => name.toLowerCase().endsWith('.csproj'));
  if (csproj) {
    return {
      command: 'dotnet',
      args: ['build', csproj],
      detectedLanguage: 'csharp',
      detectedReason: '.csproj file',
    };
  }

  if (await fileExists(path.join(projectRoot, 'Cargo.toml'))) {
    return {
      command: 'cargo',
      args: ['check'],
      detectedLanguage: 'rust',
      detectedReason: 'Cargo.toml',
    };
  }

  if (await fileExists(path.join(projectRoot, 'go.mod'))) {
    return {
      command: 'go',
      args: ['test', './...'],
      detectedLanguage: 'go',
      detectedReason: 'go.mod',
    };
  }

  if (
    (await fileExists(path.join(projectRoot, 'pyproject.toml'))) ||
    (await fileExists(path.join(projectRoot, 'requirements.txt')))
  ) {
    return {
      command: 'python',
      args: ['-m', 'compileall', '.'],
      detectedLanguage: 'python',
      detectedReason: 'pyproject.toml or requirements.txt',
    };
  }

  if (await fileExists(path.join(projectRoot, 'tsconfig.json'))) {
    return {
      command: 'npx',
      args: ['tsc', '--noEmit'],
      detectedLanguage: 'typescript',
      detectedReason: 'tsconfig.json',
    };
  }

  return null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          command,
          args,
          cwd: options.cwd,
          exitCode: typeof error?.code === 'number' ? error.code : 0,
          failed: Boolean(error),
          error: error?.message || null,
          stdout: stdout || '',
          stderr: stderr || '',
          durationMs: Date.now() - startedAt,
        });
      },
    );
  });
}

function getUnityEditorLogPath() {
  const base =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
  return base ? path.join(base, 'Unity', 'Editor', 'Editor.log') : null;
}

function resolveLogPath(projectRoot, entry) {
  if (!entry) {
    return null;
  }
  const text = String(entry);
  if (path.isAbsolute(text)) {
    return path.resolve(text);
  }
  return path.resolve(projectRoot, text);
}

async function readTail(filePath, maxBytes = MAX_LOG_BYTES) {
  if (!filePath || !(await fileExists(filePath))) {
    return null;
  }
  const stat = await fs.stat(filePath);
  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      path: filePath,
      size: stat.size,
      truncated: stat.size > maxBytes,
      text: buffer.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

function classifyLine(line) {
  const text = String(line || '');
  if (!text.trim()) {
    return null;
  }
  if (/\bwarning\b|warning\s+CS\d{4}/i.test(text)) {
    return 'warning';
  }
  if (/\b(error|fatal|failed|exception)\b|error\s+CS\d{4}|CS\d{4}\s*:/i.test(text)) {
    return 'error';
  }
  return null;
}

function extractDiagnostics(sources) {
  const items = [];
  for (const source of sources) {
    const lines = String(source.text || '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const severity = classifyLine(lines[index]);
      if (!severity) {
        continue;
      }
      items.push({
        severity,
        source: source.name,
        line: index + 1,
        message: lines[index].trim(),
      });
      if (items.length >= MAX_ITEMS) {
        return items;
      }
    }
  }
  return items;
}

function formatMarkdown(result) {
  const command = result.compile?.command
    ? `${result.compile.command} ${(result.compile.args || []).join(' ')}`.trim()
    : 'not configured';
  const lines = [
    `# Compile Diagnostics - ${result.runId}`,
    '',
    `Generated: ${result.generatedAt}`,
    `Project: ${result.projectRoot}`,
    `Compile command: ${command}`,
    `Detected language: ${result.compile?.detectedLanguage || 'explicit/unknown'}`,
    `Detection reason: ${result.compile?.detectedReason || 'explicit configuration or not detected'}`,
    `Exit code: ${result.compile?.exitCode ?? 'n/a'}`,
    `Errors: ${result.counts.error}`,
    `Warnings: ${result.counts.warning}`,
    '',
    '## Report For Main Architect',
    '',
    result.counts.error || result.counts.warning
      ? 'Use these diagnostics to decide whether to create a rework manifest, reassign a module agent, change contracts, or ask the user for runtime context.'
      : 'No errors or warnings were detected in the captured compile output/logs.',
    '',
    '## Diagnostics',
    '',
  ];

  if (!result.items.length) {
    lines.push('No diagnostics found.');
  } else {
    for (const item of result.items) {
      lines.push(`- [${item.severity}] ${item.source}:${item.line} ${item.message}`);
    }
  }

  lines.push('', '## Sources', '');
  for (const source of result.sources) {
    lines.push(`- ${source.name}: ${source.path || 'command output'}${source.truncated ? ' (tail truncated)' : ''}`);
  }

  return `${lines.join('\n')}\n`;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function runDiagnostics(projectRoot, runId, config = {}, options = {}) {
  const runner = options.runner || runCommand;
  const generatedAt = nowIso();
  let compileCommand = normalizeCompileCommand(config.compile_command || config.compileCommand);
  const detection = compileCommand ? null : await detectCompileCommand(projectRoot);
  if (!compileCommand && detection) {
    compileCommand = {
      command: detection.command,
      args: detection.args,
    };
  }
  const compile = compileCommand
    ? await runner(compileCommand.command, compileCommand.args, {
        cwd: projectRoot,
        timeoutMs: Number(config.timeout_ms || config.timeoutMs || DEFAULT_TIMEOUT_MS),
      })
    : null;

  const sources = [];
  if (compile) {
    sources.push({
      name: 'compile stdout',
      path: null,
      truncated: false,
      text: compile.stdout,
    });
    sources.push({
      name: 'compile stderr',
      path: null,
      truncated: false,
      text: compile.stderr,
    });
  }

  const logFiles = Array.isArray(config.log_files || config.logFiles)
    ? config.log_files || config.logFiles
    : [];
  const resolvedLogFiles = logFiles.map((entry) => resolveLogPath(projectRoot, entry)).filter(Boolean);

  if (config.include_unity_editor_log || config.includeUnityEditorLog) {
    const unityLog = getUnityEditorLogPath();
    if (unityLog) {
      resolvedLogFiles.push(unityLog);
    }
  }

  for (const logFile of [...new Set(resolvedLogFiles.map((entry) => path.resolve(entry)))]) {
    const tail = await readTail(logFile, Number(config.max_log_bytes || config.maxLogBytes || MAX_LOG_BYTES));
    if (tail) {
      sources.push({
        name: toPosixPath(path.relative(projectRoot, tail.path)).startsWith('..')
          ? tail.path
          : toPosixPath(path.relative(projectRoot, tail.path)),
        path: tail.path,
        truncated: tail.truncated,
        text: tail.text,
      });
    }
  }

  const items = extractDiagnostics(sources);
  const counts = {
    error: items.filter((item) => item.severity === 'error').length,
    warning: items.filter((item) => item.severity === 'warning').length,
  };
  const result = {
    runId,
    projectRoot,
    generatedAt,
    compile: compile
      ? {
          command: compile.command,
          args: compile.args,
          cwd: compile.cwd,
          exitCode: compile.exitCode,
          failed: compile.failed,
          error: compile.error,
          durationMs: compile.durationMs,
          detectedLanguage: detection?.detectedLanguage || null,
          detectedReason: detection?.detectedReason || null,
        }
      : null,
    counts,
    items,
    sources: sources.map((source) => ({
      name: source.name,
      path: source.path,
      truncated: source.truncated,
    })),
  };

  const jsonPath = path.join(projectRoot, '.multiagent', 'runs', runId, 'diagnostics', 'latest.json');
  const reportPath = path.join(projectRoot, 'reports', 'diagnostics', `${runId}_latest.md`);
  result.jsonPath = jsonPath;
  result.reportPath = reportPath;

  await writeJson(jsonPath, result);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, formatMarkdown(result), 'utf8');
  return result;
}

module.exports = {
  detectCompileCommand,
  extractDiagnostics,
  formatMarkdown,
  normalizeCompileCommand,
  runDiagnostics,
};
