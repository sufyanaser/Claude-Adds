import { contextBridge, ipcRenderer } from 'electron';
import type { ClaudeAddsApi } from '../shared/types';

const api: ClaudeAddsApi = {
  load: () => ipcRenderer.invoke('snapshot:load'),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
  open: (url) => ipcRenderer.invoke('external:open', url),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  clearProject: () => ipcRenderer.invoke('project:clear'),
  login: () => ipcRenderer.invoke('account:login'),
  planFromGit: (url) => ipcRenderer.invoke('plan:git', url),
  planFromTool: (toolId) => ipcRenderer.invoke('plan:tool', toolId),
  runPlan: (planId, picks) => ipcRenderer.invoke('plan:run', planId, picks),
};

contextBridge.exposeInMainWorld('claudeAdds', api);
