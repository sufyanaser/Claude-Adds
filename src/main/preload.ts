import { contextBridge, ipcRenderer } from 'electron';
import type { ClaudeAddsApi } from '../shared/types';

const api: ClaudeAddsApi = {
  load: () => ipcRenderer.invoke('snapshot:load'),
  install: (toolId) => ipcRenderer.invoke('plugin:install', toolId),
  login: () => ipcRenderer.invoke('account:login'),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
  open: (url) => ipcRenderer.invoke('external:open', url),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  clearProject: () => ipcRenderer.invoke('project:clear'),
};

contextBridge.exposeInMainWorld('claudeAdds', api);
