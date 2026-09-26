const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const appState = require('./appState');
const {
  getClaudeProjectsRoot,
  listProjectSessions,
  readSessionTranscript,
} = require('./claudeSessions');
const { buildClaudeInvocation } = require('./claudeCli');
const { APP_LOG_PATH, getProjectLogPath, logEvent, readLogs } = require('./managerLogger');
const diagnostics = require('./diagnostics');
const multiAgent = require('./multiAgent');
const modelOptions = require('./modelOptions');
const planning = require('./planning');
const providerProfiles = require('./providerProfiles');

let mainWindow;
let nextTerminalId = 1;
const terminalProcesses = new Map();

async function rememberRunResult(result) {
  const run = result?.run || result;
  if (run?.projectRoot && run?.runId) {
    await appState.rememberRun(run.projectRoot, run.runId);
  }
  return result;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    title: 'Claude MultiAgent Manager',
    backgroundColor: '#f7f5ef',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  logEvent('app.window.created', { appLogPath: APP_LOG_PATH });
}

async function chooseProjectFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose project folder',
    buttonLabel: 'Choose Project',
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const projectPath = result.filePaths[0];
  await appState.rememberProject(projectPath);
  return {
    path: projectPath,
    name: path.basename(projectPath) || projectPath,
  };
}

async function chooseManifestFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import task_manifest.yaml',
    buttonLabel: 'Import Manifest',
    properties: ['openFile'],
    filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return result.filePaths[0];
}

async function chooseDesignDocFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose AI implementation spec',
    buttonLabel: 'Choose Spec Doc',
    properties: ['openFile'],
    filters: [
      { name: 'Spec Documents', extensions: ['md', 'markdown', 'txt', 'doc'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return result.filePaths[0];
}

function getSessionRoot() {
  return getClaudeProjectsRoot();
}

function ensureSessionPathInsideClaudeProjects(sessionFilePath) {
  const projectsRoot = path.resolve(getSessionRoot());
  const resolvedFilePath = path.resolve(sessionFilePath);
  const relative = path.relative(projectsRoot, resolvedFilePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Session file is outside Claude projects storage.');
  }

  return resolvedFilePath;
}

function sendTerminalEvent(terminalId, type, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('terminal:event', {
    terminalId,
    type,
    ...payload,
  });
}

function startTerminalProcess({ mode, sessionId, cwd }) {
  if (!sessionId) {
    throw new Error('Claude session id is required.');
  }

  const terminalId = `term-${nextTerminalId++}`;
  const args = mode === 'logs' ? ['logs', sessionId] : ['attach', sessionId];
  const invocation = buildClaudeInvocation(args);
  logEvent('terminal.start', {
    mode,
    sessionId,
    cwd,
    resolvedCommand: invocation.displayCommand,
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    windowsHide: true,
  });

  terminalProcesses.set(terminalId, child);
  sendTerminalEvent(terminalId, 'start', {
    command: invocation.displayCommand,
    cwd,
  });

  child.stdout.on('data', (chunk) => {
    sendTerminalEvent(terminalId, 'data', { stream: 'stdout', text: chunk.toString() });
  });

  child.stderr.on('data', (chunk) => {
    sendTerminalEvent(terminalId, 'data', { stream: 'stderr', text: chunk.toString() });
  });

  child.on('error', (error) => {
    logEvent(
      'terminal.error',
      {
        mode,
        sessionId,
        cwd,
        error,
      },
      { level: 'error' },
    );
    sendTerminalEvent(terminalId, 'error', { text: error.message });
  });

  child.on('close', (code) => {
    logEvent('terminal.exit', { mode, sessionId, cwd, code }, { level: code ? 'warn' : 'info' });
    terminalProcesses.delete(terminalId);
    sendTerminalEvent(terminalId, 'exit', { code });
  });

  return { terminalId };
}

function logPlanningFailure(label, payload) {
  console.error(`[${new Date().toISOString()}] ${label}`);
  console.error(
    JSON.stringify(
      {
        projectRoot: payload?.projectRoot || payload?.options?.projectRoot || null,
        specDocPath:
          payload?.specDocPath ||
          payload?.options?.specDocPath ||
          payload?.designDocPath ||
          payload?.options?.designDocPath ||
          null,
        runId: payload?.runId || payload?.options?.runId || null,
        architectName: payload?.architectName || payload?.options?.architectName || null,
        model: payload?.model || payload?.options?.model || null,
        status: payload?.status || null,
        promptPath: payload?.promptPath || null,
        baseCommit: payload?.baseCommit || null,
        claudeSessionId: payload?.claudeSessionId || null,
        error: payload?.error || payload?.message || null,
        stderr: payload?.stderr || null,
        stdout: payload?.stdout || null,
      },
      null,
      2,
    ),
  );
  logEvent(
    label.replace(':', '.').replace(/\s+/g, '.'),
    {
      projectRoot: payload?.projectRoot || payload?.options?.projectRoot || null,
      specDocPath:
        payload?.specDocPath ||
        payload?.options?.specDocPath ||
        payload?.designDocPath ||
        payload?.options?.designDocPath ||
        null,
      runId: payload?.runId || payload?.options?.runId || null,
      architectName: payload?.architectName || payload?.options?.architectName || null,
      model: payload?.model || payload?.options?.model || null,
      status: payload?.status || null,
      promptPath: payload?.promptPath || null,
      baseCommit: payload?.baseCommit || null,
      claudeSessionId: payload?.claudeSessionId || null,
      error: payload?.error || payload?.message || null,
      stderr: payload?.stderr || null,
      stdout: payload?.stdout || null,
    },
    { level: 'error' },
  );
}

function isMissingDefaultManifest(error, projectRoot) {
  if (error?.code !== 'ENOENT') {
    return false;
  }
  const expectedPath = path.join(projectRoot, 'tasks', 'task_manifest.yaml');
  return path.resolve(error.path || '') === path.resolve(expectedPath);
}

function registerSessionHandlers() {
  ipcMain.handle('project:choose', chooseProjectFolder);

  ipcMain.handle('sessions:list', async (_event, projectPath) => {
    return listProjectSessions(projectPath);
  });

  ipcMain.handle('sessions:read', async (_event, sessionFilePath) => {
    ensureSessionPathInsideClaudeProjects(sessionFilePath);
    return readSessionTranscript(sessionFilePath);
  });

  ipcMain.handle('sessions:showInFolder', async (_event, sessionFilePath) => {
    const resolvedFilePath = ensureSessionPathInsideClaudeProjects(sessionFilePath);
    await fs.access(resolvedFilePath);
    shell.showItemInFolder(resolvedFilePath);
    return true;
  });
}

function registerPlanningHandlers() {
  ipcMain.handle('planning:chooseDesignDoc', chooseDesignDocFile);

  ipcMain.handle('planning:checkGit', async (_event, projectRoot) => {
    const result = await planning.getGitProjectStatus(projectRoot);
    await logEvent('planning.checkGit', result, { projectRoot });
    return result;
  });

  ipcMain.handle('planning:initializeGit', async (_event, projectRoot) => {
    await logEvent('planning.initializeGit.start', { projectRoot }, { projectRoot });
    const result = await planning.initializeGitBaseline(projectRoot);
    await logEvent('planning.initializeGit.result', result, { projectRoot });
    return result;
  });

  ipcMain.handle('planning:startArchitect', async (_event, options) => {
    try {
      const invocation = buildClaudeInvocation(['--version']);
      console.log(`[${new Date().toISOString()}] planning:startArchitect using Claude CLI`);
      console.log(invocation.displayCommand);
      await logEvent(
        'planning.startArchitect.start',
        {
          options,
          claudeVersionCommand: invocation.displayCommand,
          appLogPath: APP_LOG_PATH,
          projectLogPath: getProjectLogPath(options?.projectRoot),
        },
        { projectRoot: options?.projectRoot },
      );
      const result = await planning.startArchitectFromSpecDoc(options);
      if (result?.status === 'failed') {
        logPlanningFailure('planning:startArchitect failed', { ...result, options });
      } else {
        await logEvent('planning.startArchitect.result', result, {
          projectRoot: options?.projectRoot,
          level: result?.status === 'running' ? 'info' : 'warn',
        });
      }
      return result;
    } catch (error) {
      logPlanningFailure('planning:startArchitect threw', {
        options,
        message: error.message,
        stderr: error.stderr,
        stdout: error.stdout,
      });
      throw error;
    }
  });

  ipcMain.handle('planning:loadLatest', async (_event, projectRoot) => {
    const result = await planning.loadLatestPlanningState(projectRoot);
    await logEvent('planning.loadLatest', { projectRoot, found: Boolean(result), result }, { projectRoot });
    return result;
  });

  ipcMain.handle('planning:loadState', async (_event, projectRoot, runId) => {
    return planning.loadPlanningState(projectRoot, runId);
  });
}

function registerMultiAgentHandlers() {
  ipcMain.handle('multiagent:importManifest', async () => {
    const manifestPath = await chooseManifestFile();
    if (!manifestPath) {
      return null;
    }
    await logEvent('multiagent.importManifest.start', { manifestPath });
    const result = await multiAgent.importManifest(manifestPath);
    await logEvent('multiagent.importManifest.result', {
      manifestPath,
      runId: result?.runId,
      projectRoot: result?.projectRoot,
      agents: result?.agents?.length,
    });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:loadDefaultManifest', async (_event, projectRoot) => {
    try {
      const result = await multiAgent.loadDefaultManifest(projectRoot);
      await logEvent(
        'multiagent.loadDefaultManifest.result',
        { projectRoot, found: true, runId: result?.runId, agents: result?.agents?.length },
        { projectRoot },
      );
      return rememberRunResult(result);
    } catch (error) {
      if (isMissingDefaultManifest(error, projectRoot)) {
        await logEvent(
          'multiagent.loadDefaultManifest.missing',
          { projectRoot, manifestPath: path.join(projectRoot, 'tasks', 'task_manifest.yaml') },
          { projectRoot },
        );
        return null;
      }
      await logEvent(
        'multiagent.loadDefaultManifest.failure',
        { projectRoot, error },
        { projectRoot, level: 'error' },
      );
      throw error;
    }
  });

  ipcMain.handle('multiagent:sync', async (_event, projectRoot, runId) => {
    const result = await multiAgent.syncRun(projectRoot, runId);
    await logEvent('multiagent.sync.result', {
      projectRoot,
      runId,
      counts: result?.counts,
      lastSyncError: result?.lastSyncError,
    }, { projectRoot, level: result?.lastSyncError ? 'warn' : 'info' });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:loadRun', async (_event, projectRoot, runId) => {
    const result = await multiAgent.loadRun(projectRoot, runId);
    await logEvent('multiagent.loadRun.result', {
      projectRoot,
      runId,
      agents: result?.agents?.length,
    }, { projectRoot });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:loadLatestRun', async (_event, projectRoot) => {
    const result = await multiAgent.loadLatestRun(projectRoot);
    await logEvent('multiagent.loadLatestRun.result', {
      projectRoot,
      found: Boolean(result),
      runId: result?.runId || null,
      agents: result?.agents?.length || 0,
    }, { projectRoot });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:recoverRun', async (_event, projectRoot, runId) => {
    const result = await multiAgent.recoverRun(projectRoot, runId);
    await logEvent('multiagent.recoverRun.result', {
      projectRoot,
      runId,
      recovery: result?.recovery,
    }, { projectRoot, level: result?.recovery?.errors?.length ? 'warn' : 'info' });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:startTask', async (_event, projectRoot, runId, taskId) => {
    await logEvent('multiagent.startTask.start', { projectRoot, runId, taskId }, { projectRoot });
    const result = await multiAgent.startTask(projectRoot, runId, taskId);
    const agent = result?.agents?.find((entry) => entry.taskId === taskId);
    await logEvent('multiagent.startTask.result', { projectRoot, runId, taskId, agent }, {
      projectRoot,
      level: agent?.status === 'failed' ? 'error' : 'info',
    });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:startAllReady', async (_event, projectRoot, runId) => {
    await logEvent('multiagent.startAllReady.start', { projectRoot, runId }, { projectRoot });
    const result = await multiAgent.startAllReady(projectRoot, runId);
    await logEvent('multiagent.startAllReady.result', { projectRoot, runId, counts: result?.counts }, {
      projectRoot,
    });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:advanceModuleReview', async (_event, projectRoot, runId) => {
    await logEvent('multiagent.advanceModuleReview.start', { projectRoot, runId }, { projectRoot });
    const result = await multiAgent.advanceModuleReviewIfReady(projectRoot, runId);
    await logEvent('multiagent.advanceModuleReview.result', {
      projectRoot,
      runId,
      advanced: result?.advanced,
      reason: result?.reason,
      reviewTaskId: result?.reviewTaskId,
      blockers: result?.blockers,
    }, { projectRoot, level: result?.advanced ? 'info' : 'warn' });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:advanceWorkflow', async (_event, projectRoot, runId, options = {}) => {
    await logEvent('multiagent.advanceWorkflow.start', { projectRoot, runId, options }, { projectRoot });
    const result = await multiAgent.advanceWorkflow(projectRoot, runId, options);
    await logEvent('multiagent.advanceWorkflow.result', {
      projectRoot,
      runId,
      advanced: result?.advanced,
      reason: result?.reason,
      stopReason: result?.stopReason,
      events: result?.events,
    }, { projectRoot, level: result?.advanced ? 'info' : 'warn' });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:preflight', async (_event, projectRoot, runId) => {
    const result = await multiAgent.preflightRun(projectRoot, runId);
    await logEvent('multiagent.preflight.result', { projectRoot, runId, result }, {
      projectRoot,
      level: result?.ok ? 'info' : 'warn',
    });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:auditTask', async (_event, projectRoot, runId, taskId) => {
    const result = await multiAgent.auditTask(projectRoot, runId, taskId);
    const agent = result?.agents?.find((entry) => entry.taskId === taskId);
    await logEvent('multiagent.auditTask.result', { projectRoot, runId, taskId, agent }, {
      projectRoot,
      level: agent?.status === 'policy_violation' ? 'warn' : 'info',
    });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:applyPatch', async (_event, projectRoot, runId, taskId) => {
    const result = await multiAgent.applyPatch(projectRoot, runId, taskId);
    await logEvent('multiagent.applyPatch.result', { projectRoot, runId, taskId }, { projectRoot });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:rejectPatch', async (_event, projectRoot, runId, taskId) => {
    const result = await multiAgent.rejectPatch(projectRoot, runId, taskId);
    await logEvent('multiagent.rejectPatch.result', { projectRoot, runId, taskId }, { projectRoot });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:cleanAcceptedWorktrees', async (_event, projectRoot, runId) => {
    const result = await multiAgent.cleanAcceptedWorktrees(projectRoot, runId);
    await logEvent('multiagent.cleanAcceptedWorktrees.result', {
      projectRoot,
      runId,
      cleaned: result?.cleaned,
    }, { projectRoot });
    return rememberRunResult(result);
  });

  ipcMain.handle('multiagent:readArtifacts', async (_event, projectRoot, runId, taskId) => {
    return multiAgent.readAgentArtifacts(projectRoot, runId, taskId);
  });
}

function registerLogHandlers() {
  ipcMain.handle('logs:read', async (_event, projectRoot) => {
    return readLogs({ projectRoot });
  });

  ipcMain.handle('logs:showInFolder', async (_event, projectRoot) => {
    const logPath = projectRoot ? getProjectLogPath(projectRoot) : APP_LOG_PATH;
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    try {
      await fs.access(logPath);
    } catch {
      await fs.writeFile(logPath, '', 'utf8');
    }
    shell.showItemInFolder(logPath);
    return logPath;
  });
}

function registerDiagnosticsHandlers() {
  ipcMain.handle('diagnostics:run', async (_event, projectRoot, runId) => {
    const state = await multiAgent.loadState(projectRoot, runId);
    await logEvent('diagnostics.run.start', {
      projectRoot,
      runId,
      config: state.manifest?.diagnostics || null,
    }, { projectRoot });
    const result = await diagnostics.runDiagnostics(projectRoot, runId, state.manifest?.diagnostics || {});
    await logEvent('diagnostics.run.result', {
      projectRoot,
      runId,
      counts: result.counts,
      reportPath: result.reportPath,
      jsonPath: result.jsonPath,
    }, { projectRoot, level: result.counts.error ? 'warn' : 'info' });
    return rememberRunResult(result);
  });
}

function registerAppStateHandlers() {
  ipcMain.handle('appState:get', async () => appState.readAppState());
}

function registerModelOptionsHandlers() {
  ipcMain.handle('modelOptions:get', async () => {
    const result = await modelOptions.getModelOptions();
    await logEvent('modelOptions.get', {
      modelCount: result.models?.length || 0,
      effortCount: result.efforts?.length || 0,
      updatedAt: result.updatedAt,
      error: result.error || null,
    });
    return result;
  });

  ipcMain.handle('modelOptions:refresh', async () => {
    await logEvent('modelOptions.refresh.start', {
      sources: [...modelOptions.MODEL_SOURCES, ...modelOptions.EFFORT_SOURCES],
    });
    const result = await modelOptions.refreshModelOptions();
    await logEvent(
      'modelOptions.refresh.result',
      {
        modelCount: result.models?.length || 0,
        effortCount: result.efforts?.length || 0,
        updatedAt: result.updatedAt,
        error: result.error || null,
      },
      { level: result.error ? 'warn' : 'info' },
    );
    return result;
  });
}

function registerProviderProfileHandlers() {
  ipcMain.handle('providerProfiles:getPresets', async () => {
    const presets = providerProfiles.getProviderPresets();
    await logEvent('providerProfiles.getPresets', {
      presetCount: presets.length,
    });
    return presets;
  });

  ipcMain.handle('providerProfiles:get', async () => {
    const result = await providerProfiles.getProviderProfiles();
    await logEvent('providerProfiles.get', {
      profileCount: result.profiles.length,
      updatedAt: result.updatedAt,
    });
    return providerProfiles.toPublicProviderProfiles(result);
  });

  ipcMain.handle('providerProfiles:upsert', async (_event, profile) => {
    const result = await providerProfiles.upsertProviderProfile(profile);
    await logEvent('providerProfiles.upsert', {
      profileId: profile?.id || null,
      profileType: profile?.type || null,
      profileCount: result.profiles.length,
    });
    return providerProfiles.toPublicProviderProfiles(result);
  });

  ipcMain.handle('providerProfiles:upsertPreset', async (_event, input) => {
    const result = await providerProfiles.upsertProviderProfileFromPreset(input);
    await logEvent('providerProfiles.upsertPreset', {
      presetId: input?.presetId || null,
      profileId: input?.id || input?.presetId || null,
      profileCount: result.profiles.length,
    });
    return providerProfiles.toPublicProviderProfiles(result);
  });

  ipcMain.handle('providerProfiles:refreshModels', async (_event, profileId) => {
    const result = await providerProfiles.refreshProviderModels(profileId);
    await logEvent('providerProfiles.refreshModels', {
      profileId,
      profileCount: result.profiles.length,
      profile: result.profiles.find((entry) => entry.id === profileId) || null,
    });
    return providerProfiles.toPublicProviderProfiles(result);
  });
}

function registerTerminalHandlers() {
  ipcMain.handle('terminal:start', async (_event, options) => {
    return startTerminalProcess(options);
  });

  ipcMain.handle('terminal:input', async (_event, terminalId, text) => {
    const child = terminalProcesses.get(terminalId);
    if (!child) {
      return false;
    }
    child.stdin.write(text);
    return true;
  });

  ipcMain.handle('terminal:stop', async (_event, terminalId) => {
    const child = terminalProcesses.get(terminalId);
    if (!child) {
      return false;
    }
    child.kill();
    terminalProcesses.delete(terminalId);
    return true;
  });
}

function registerIpcHandlers() {
  registerSessionHandlers();
  registerPlanningHandlers();
  registerMultiAgentHandlers();
  registerLogHandlers();
  registerDiagnosticsHandlers();
  registerModelOptionsHandlers();
  registerProviderProfileHandlers();
  registerTerminalHandlers();
  registerAppStateHandlers();
}

app.whenReady().then(() => {
  registerIpcHandlers();
  logEvent('app.ready', { appLogPath: APP_LOG_PATH });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  for (const child of terminalProcesses.values()) {
    child.kill();
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
