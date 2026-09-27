const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeManager', {
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  listSessions: (projectPath) => ipcRenderer.invoke('sessions:list', projectPath),
  readSession: (sessionFilePath) => ipcRenderer.invoke('sessions:read', sessionFilePath),
  showSessionInFolder: (sessionFilePath) =>
    ipcRenderer.invoke('sessions:showInFolder', sessionFilePath),
  logs: {
    read: (projectRoot) => ipcRenderer.invoke('logs:read', projectRoot),
    showInFolder: (projectRoot) => ipcRenderer.invoke('logs:showInFolder', projectRoot),
  },
  diagnostics: {
    run: (projectRoot, runId) => ipcRenderer.invoke('diagnostics:run', projectRoot, runId),
  },
  appState: {
    get: () => ipcRenderer.invoke('appState:get'),
  },
  modelOptions: {
    get: () => ipcRenderer.invoke('modelOptions:get'),
    refresh: () => ipcRenderer.invoke('modelOptions:refresh'),
  },
  providerProfiles: {
    getPresets: () => ipcRenderer.invoke('providerProfiles:getPresets'),
    get: () => ipcRenderer.invoke('providerProfiles:get'),
    upsert: (profile) => ipcRenderer.invoke('providerProfiles:upsert', profile),
    upsertPreset: (input) => ipcRenderer.invoke('providerProfiles:upsertPreset', input),
    refreshModels: (profileId) => ipcRenderer.invoke('providerProfiles:refreshModels', profileId),
  },
  planning: {
    chooseDesignDoc: () => ipcRenderer.invoke('planning:chooseDesignDoc'),
    checkGit: (projectRoot) => ipcRenderer.invoke('planning:checkGit', projectRoot),
    initializeGit: (projectRoot) => ipcRenderer.invoke('planning:initializeGit', projectRoot),
    startArchitect: (options) => ipcRenderer.invoke('planning:startArchitect', options),
    loadLatest: (projectRoot) => ipcRenderer.invoke('planning:loadLatest', projectRoot),
    loadState: (projectRoot, runId) => ipcRenderer.invoke('planning:loadState', projectRoot, runId),
  },
  multiAgent: {
    importManifest: () => ipcRenderer.invoke('multiagent:importManifest'),
    loadDefaultManifest: (projectRoot) =>
      ipcRenderer.invoke('multiagent:loadDefaultManifest', projectRoot),
    loadRun: (projectRoot, runId) => ipcRenderer.invoke('multiagent:loadRun', projectRoot, runId),
    loadLatestRun: (projectRoot) => ipcRenderer.invoke('multiagent:loadLatestRun', projectRoot),
    recoverRun: (projectRoot, runId) => ipcRenderer.invoke('multiagent:recoverRun', projectRoot, runId),
    sync: (projectRoot, runId) => ipcRenderer.invoke('multiagent:sync', projectRoot, runId),
    startTask: (projectRoot, runId, taskId) =>
      ipcRenderer.invoke('multiagent:startTask', projectRoot, runId, taskId),
    startAllReady: (projectRoot, runId) =>
      ipcRenderer.invoke('multiagent:startAllReady', projectRoot, runId),
    advanceModuleReview: (projectRoot, runId) =>
      ipcRenderer.invoke('multiagent:advanceModuleReview', projectRoot, runId),
    advanceWorkflow: (projectRoot, runId, options) =>
      ipcRenderer.invoke('multiagent:advanceWorkflow', projectRoot, runId, options),
    dispatchRework: (projectRoot, runId) => ipcRenderer.invoke('multiagent:dispatchRework', projectRoot, runId),
    importReworkManifest: (projectRoot, runId) =>
      ipcRenderer.invoke('multiagent:importReworkManifest', projectRoot, runId),
    waiveGate: (projectRoot, runId, gateId, note) =>
      ipcRenderer.invoke('multiagent:waiveGate', projectRoot, runId, gateId, note),
    preflight: (projectRoot, runId) => ipcRenderer.invoke('multiagent:preflight', projectRoot, runId),
    auditTask: (projectRoot, runId, taskId) =>
      ipcRenderer.invoke('multiagent:auditTask', projectRoot, runId, taskId),
    applyPatch: (projectRoot, runId, taskId) =>
      ipcRenderer.invoke('multiagent:applyPatch', projectRoot, runId, taskId),
    rejectPatch: (projectRoot, runId, taskId) =>
      ipcRenderer.invoke('multiagent:rejectPatch', projectRoot, runId, taskId),
    commitWorkingTree: (projectRoot, runId) =>
      ipcRenderer.invoke('multiagent:commitWorkingTree', projectRoot, runId),
    cleanAcceptedWorktrees: (projectRoot, runId) =>
      ipcRenderer.invoke('multiagent:cleanAcceptedWorktrees', projectRoot, runId),
    readArtifacts: (projectRoot, runId, taskId) =>
      ipcRenderer.invoke('multiagent:readArtifacts', projectRoot, runId, taskId),
  },
  terminal: {
    start: (options) => ipcRenderer.invoke('terminal:start', options),
    input: (terminalId, text) => ipcRenderer.invoke('terminal:input', terminalId, text),
    stop: (terminalId) => ipcRenderer.invoke('terminal:stop', terminalId),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('terminal:event', listener);
      return () => ipcRenderer.removeListener('terminal:event', listener);
    },
  },
});
