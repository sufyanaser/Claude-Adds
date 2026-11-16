import { contextBridge, ipcRenderer } from 'electron';
import type { ClaudeAddsApi } from '../shared/types';

const api: ClaudeAddsApi = {
  load: () => ipcRenderer.invoke('snapshot:load'),
  last: () => ipcRenderer.invoke('snapshot:last'),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
  open: (url) => ipcRenderer.invoke('external:open', url),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  clearProject: () => ipcRenderer.invoke('project:clear'),
  login: () => ipcRenderer.invoke('account:login'),
  planFromGit: (url) => ipcRenderer.invoke('plan:git', url),
  planFromTool: (toolId) => ipcRenderer.invoke('plan:tool', toolId),
  runPlan: (planId, picks) => ipcRenderer.invoke('plan:run', planId, picks),
  onProgress: (listener) => {
    ipcRenderer.on('job:progress', (_event, progress) => listener(progress));
  },
  diagnose: (target) => ipcRenderer.invoke('diagnose:run', target),
  applyFix: (target, fix) => ipcRenderer.invoke('diagnose:fix', target, fix),
  verifyTool: (toolId) => ipcRenderer.invoke('tool:verify', toolId),
  authConnector: (toolId) => ipcRenderer.invoke('connector:auth', toolId),
  onInventoryChanged: (listener) => {
    ipcRenderer.on('inventory:changed', () => listener());
  },
  updateState: () => ipcRenderer.invoke('update:state'),
  updatePrefs: (prefs) => ipcRenderer.invoke('update:prefs', prefs),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdate: (listener) => {
    ipcRenderer.on('update:changed', (_event, state) => listener(state));
  },
  backupDir: () => ipcRenderer.invoke('backup:dir'),
  chooseBackupDir: () => ipcRenderer.invoke('backup:choose'),
  runBackup: () => ipcRenderer.invoke('backup:run'),
  openBackup: () => ipcRenderer.invoke('backup:open'),
};

contextBridge.exposeInMainWorld('claudeAdds', api);
