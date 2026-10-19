import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { runFix } from '../dist/session/orchestrator.js';
import { terminatePersistentEdge } from '../dist/browser/edge.js';
import { appendSteeringMessage } from '../dist/session/steering.js';
import { ensureProjectInitialized } from '../dist/context/project-setup.js';
import { refreshTree } from '../dist/context/tree.js';
import { loadConfig } from '../dist/config/loader.js';
import { NOVA_VERSION } from '../dist/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let mainWindow;
let activeTask = false;
let activeTaskPromise;
let quittingAfterTask = false;
let currentProjectRoot;
let currentProviderId;
let activeSessionId;
let activeAbortController;
const pendingApprovals = new Map();
const pendingAnswers = new Map();
let requestCounter = 0;
let autoUpdater;
const allowedProviders = new Set(['chatgpt-web', 'claude-web', 'gemini-web', 'mock']);

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
async function initializeAutoUpdater() {
  try {
    // Load lazily so a missing/incompatible updater cannot prevent the desktop app
    // itself from opening. electron-updater resolves Electron's app at import time.
    ({ autoUpdater } = await import('electron-updater'));
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => send('nova:update-status', { state: 'checking' }));
    autoUpdater.on('update-available', info => send('nova:update-status', { state: 'available', version: info.version }));
    autoUpdater.on('update-not-available', info => send('nova:update-status', { state: 'current', version: info.version }));
    autoUpdater.on('download-progress', progress => send('nova:update-status', { state: 'downloading', percent: Math.round(progress.percent) }));
    autoUpdater.on('update-downloaded', info => send('nova:update-status', { state: 'downloaded', version: info.version }));
    autoUpdater.on('error', error => send('nova:update-status', { state: 'error', message: error.message }));
    if (app.isPackaged) void autoUpdater.checkForUpdates().catch(error => send('nova:update-status', { state: 'error', message: error.message }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Nova updater indisponible : ${message}`);
    send('nova:update-status', { state: 'unavailable', message });
  }
}
function validateProjectRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 2048) throw new Error('Chemin de projet invalide.');
  return path.resolve(value);
}
function safeExternalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['github.com', 'www.npmjs.com', 'npmjs.com'].includes(url.hostname)) throw new Error('URL externe refusée.');
  return url.toString();
}
function askApproval(request) {
  const id = String(++requestCounter);
  return new Promise(resolve => {
    pendingApprovals.set(id, resolve);
    send('nova:approval-request', { id, request });
  });
}
function askAnswer(question, sessionId) {
  const id = String(++requestCounter);
  return new Promise(resolve => {
    pendingAnswers.set(id, resolve);
    send('nova:question', { id, question, sessionId });
  });
}
async function installGlobalCli() {
  if (process.env.NOVA_SKIP_GLOBAL_INSTALL === '1') return { skipped: true };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(npm, args, { windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => stdout += d.toString());
    child.stderr?.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout || `npm exited ${code}`)));
  });
  try { await run(['list', '-g', '@xvortex/nova-agent', '--depth=0']); return { installed: true, alreadyPresent: true }; }
  catch {
    send('nova:install-progress', { state: 'installing', message: 'Installation de @xvortex/nova-agent…' });
    try {
      await run(['install', '-g', '@xvortex/nova-agent']);
      send('nova:install-progress', { state: 'installed', message: 'Nova Agent CLI installé.' });
      return { installed: true };
    } catch (error) {
      send('nova:install-progress', { state: 'error', message: `Installation globale impossible : ${error.message}. Vérifie Node.js/npm et la connexion réseau.` });
      return { installed: false, error: error.message };
    }
  }
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#101113', title: 'Nova Agent',
    icon: path.join(__dirname, 'assets', 'nova.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(safeExternalUrl(url)); } catch {}
    return { action: 'deny' };
  });
  if (isDev) void mainWindow.loadURL(process.env.NOVA_DESKTOP_URL || 'http://localhost:5173');
  else void mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = undefined; });
}
app.whenReady().then(async () => {
  createWindow();
  void initializeAutoUpdater();
  await installGlobalCli();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (quittingAfterTask) return;
  event.preventDefault();
  activeAbortController?.abort();
  for (const resolve of pendingApprovals.values()) resolve('reject');
  for (const resolve of pendingAnswers.values()) resolve(null);
  pendingApprovals.clear(); pendingAnswers.clear();
  const task = activeTaskPromise;
  void Promise.resolve(task).then(() => undefined, () => undefined)
    .then(() => terminatePersistentEdge())
    .catch(error => console.error(`Impossible de fermer Edge proprement : ${error.message}`))
    .finally(() => { quittingAfterTask = true; app.quit(); });
});

ipcMain.handle('nova:pick-project', async () => {
  if (activeTask) throw new Error('Termine la tâche Nova en cours avant de changer de projet.');
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Ouvrir un projet', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const projectRoot = validateProjectRoot(result.filePaths[0]);
  await ensureProjectInitialized(projectRoot);
  const [{ tree, scan }, config] = await Promise.all([refreshTree(projectRoot), loadConfig(projectRoot)]);
  if ((currentProjectRoot && currentProjectRoot !== projectRoot)
    || (currentProviderId && currentProviderId !== config.defaultProvider)) await terminatePersistentEdge();
  currentProjectRoot = projectRoot;
  currentProviderId = config.defaultProvider;
  return { projectRoot, tree, files: scan.entries.map(e => ({ path: e.path, type: e.type })), providerId: config.defaultProvider, version: NOVA_VERSION };
});
ipcMain.handle('nova:refresh-tree', async (_event, root) => {
  const projectRoot = validateProjectRoot(root);
  await ensureProjectInitialized(projectRoot);
  const { tree, scan } = await refreshTree(projectRoot);
  return { tree, files: scan.entries.map(e => ({ path: e.path, type: e.type })) };
});
ipcMain.handle('nova:run-task', async (_event, input) => {
  if (activeTask) throw new Error('Une tâche Nova est déjà en cours.');
  const projectRoot = validateProjectRoot(input?.projectRoot);
  if (typeof input?.problem !== 'string' || !input.problem.trim() || input.problem.length > 10000) throw new Error('Décris une tâche (10 000 caractères maximum).');
  if (input.providerId && !allowedProviders.has(input.providerId)) throw new Error('Fournisseur non autorisé.');
  const rawProblem = input.problem.trim();
  const initCommand = rawProblem.match(/^\/init(?:\s+([\s\S]+))?$/i);
  if (initCommand && !initCommand[1]?.trim()) throw new Error('Utilisation : /init suivi de ta demande pour initialiser une nouvelle discussion.');
  const problem = initCommand ? initCommand[1].trim() : rawProblem;
  activeTask = true;
  activeAbortController = new AbortController();
  const controller = activeAbortController;
  const task = (async () => {
    const config = await loadConfig(projectRoot);
    const providerId = input.providerId || config.defaultProvider;
    if ((currentProjectRoot && currentProjectRoot !== projectRoot)
      || (currentProviderId && currentProviderId !== providerId)) await terminatePersistentEdge();
    currentProjectRoot = projectRoot;
    currentProviderId = providerId;
    const session = await runFix({ projectRoot, problem, providerId, noApply: false, signal: controller.signal, forceInitialPrompt: Boolean(initCommand), callbacks: {
      onEvent: event => {
        if (event.type === 'session') activeSessionId = event.session.id;
        send('nova:event', event);
      },
      requestApproval: askApproval,
      requestAnswer: askAnswer,
    } });
    return { sessionId: session.id, state: session.state, error: session.error };
  })();
  activeTaskPromise = task;
  try { return await task; }
  finally {
    activeTask = false;
    activeTaskPromise = undefined;
    activeAbortController = undefined;
    activeSessionId = undefined;
  }
});
ipcMain.handle('nova:steer', async (_event, input) => {
  if (!activeTask || !activeSessionId || !currentProjectRoot) throw new Error('Aucune session active à guider.');
  if (typeof input?.message !== 'string' || !input.message.trim() || input.message.length > 10000) throw new Error('Écris une consigne (10 000 caractères maximum).');
  await appendSteeringMessage(currentProjectRoot, activeSessionId, input.message);
  return { ok: true, sessionId: activeSessionId };
});
ipcMain.handle('nova:stop-task', async () => {
  if (!activeTask || !activeAbortController) throw new Error('Aucune tâche Nova à arrêter.');
  activeAbortController.abort();
  return { ok: true };
});
ipcMain.handle('nova:approval-decision', async (_event, input) => {
  if (!input || typeof input.id !== 'string' || !['approve', 'reject', 'approve-session'].includes(input.decision)) throw new Error('Décision invalide.');
  const resolve = pendingApprovals.get(input.id);
  if (!resolve) throw new Error('Cette demande d’autorisation a expiré.');
  pendingApprovals.delete(input.id); resolve(input.decision); return { ok: true };
});
ipcMain.handle('nova:answer', async (_event, input) => {
  if (!input || typeof input.id !== 'string' || typeof input.answer !== 'string' || input.answer.length > 10000) throw new Error('Réponse invalide.');
  const resolve = pendingAnswers.get(input.id);
  if (!resolve) throw new Error('Cette question a expiré.');
  pendingAnswers.delete(input.id); resolve(input.answer); return { ok: true };
});
ipcMain.handle('nova:open-external', async (_event, value) => { await shell.openExternal(safeExternalUrl(value)); return { ok: true }; });
ipcMain.handle('nova:install-cli', async () => installGlobalCli());
ipcMain.handle('nova:check-updates', async () => { if (!app.isPackaged) return { state: 'dev-build' }; if (!autoUpdater) return { state: 'unavailable' }; const result = await autoUpdater.checkForUpdates(); return { state: result?.updateInfo ? 'checked' : 'checking', version: result?.updateInfo?.version }; });
ipcMain.handle('nova:download-update', async () => { if (!autoUpdater) throw new Error('Le module de mise à jour est indisponible. Réinstallez Nova Agent.'); await autoUpdater.downloadUpdate(); return { ok: true }; });
ipcMain.handle('nova:install-update', async () => { if (!autoUpdater) throw new Error('Le module de mise à jour est indisponible. Réinstallez Nova Agent.'); autoUpdater.quitAndInstall(false, true); return { ok: true }; });
ipcMain.handle('nova:app-info', async () => ({ appVersion: app.getVersion(), novaVersion: NOVA_VERSION, packaged: app.isPackaged }));
