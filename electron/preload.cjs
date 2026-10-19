const { contextBridge, ipcRenderer } = require('electron');

const api = Object.freeze({
  pickProject: () => ipcRenderer.invoke('nova:pick-project'),
  refreshTree: root => ipcRenderer.invoke('nova:refresh-tree', root),
  runTask: input => ipcRenderer.invoke('nova:run-task', input),
  decideApproval: input => ipcRenderer.invoke('nova:approval-decision', input),
  answerQuestion: input => ipcRenderer.invoke('nova:answer', input),
  openExternal: url => ipcRenderer.invoke('nova:open-external', url),
  installCli: () => ipcRenderer.invoke('nova:install-cli'),
  checkUpdates: () => ipcRenderer.invoke('nova:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('nova:download-update'),
  installUpdate: () => ipcRenderer.invoke('nova:install-update'),
  appInfo: () => ipcRenderer.invoke('nova:app-info'),
  onEvent: callback => subscribe('nova:event', callback),
  onApprovalRequest: callback => subscribe('nova:approval-request', callback),
  onQuestion: callback => subscribe('nova:question', callback),
  onInstallProgress: callback => subscribe('nova:install-progress', callback),
  onUpdateStatus: callback => subscribe('nova:update-status', callback),
});
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('novaDesktop', api);
