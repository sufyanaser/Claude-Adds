import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActionResult, BackupResult, DiagnoseTarget, FixId, PlanPick, Snapshot } from '../shared/types';
import { applyFix, authConnector, diagnose, verifyTool, type DiagnoseContext } from './diagnose';
import { addToPath, candidateDirs } from './discovery/paths';
import type { UpdateChannel } from '../shared/version';
import { createBackup } from './backup';
import { Updater } from './updater';
import { detectCli } from './discovery/cli';
import { discover } from './discovery/discover';
import { clearPlans, planFromGit, planFromTool, runPlan, type PlanContext } from './install/plan';

/**
 * On macOS and Linux an app opened from the desktop does not inherit the
 * terminal's PATH, so `claude`, `codex`, `gemini` and `agy` would look missing.
 * The login shell is asked for its PATH once at startup.
 */
function inheritShellPath(): void {
  if (process.platform === 'win32') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const output = execFileSync(shell, ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const path = output.trim().split('\n').pop();
    if (path) process.env.PATH = path;
  } catch {
    // Keep the inherited PATH. Missing tools are then reported as not found.
  }
}
inheritShellPath();
// The login shell can fail or be slow, so the usual install folders are added as well.
// This changes PATH for this process only; shell profile files are never edited.
if (process.platform !== 'win32' && !process.env.CLAUDE_ADDS_HOME) {
  addToPath(candidateDirs(homedir(), process.platform, process.env), process.env);
}

// Tests run against a throwaway profile and home instead of the real ones.
if (process.env.CLAUDE_ADDS_USER_DATA) app.setPath('userData', process.env.CLAUDE_ADDS_USER_DATA);
const home = () => process.env.CLAUDE_ADDS_HOME || homedir();

const stateFile = () => join(app.getPath('userData'), 'state.json');
const planContext = (): PlanContext => ({ homeDir: home(), userDataDir: app.getPath('userData'), env: process.env });

interface Settings {
  projectDir?: string | null;
  backupDir?: string | null;
  updateChannel?: UpdateChannel;
  autoUpdate?: boolean;
}

/** Small settings file: folder choices and update preferences. Never credentials. */
async function readSettings(): Promise<Settings> {
  try {
    const data: unknown = JSON.parse(await readFile(stateFile(), 'utf8'));
    return data && typeof data === 'object' ? (data as Settings) : {};
  } catch {
    return {};
  }
}

async function saveSettings(patch: Settings): Promise<void> {
  const next = { ...(await readSettings()), ...patch };
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(stateFile(), JSON.stringify(next), 'utf8');
}

async function readProjectDir(): Promise<string | null> {
  const value = (await readSettings()).projectDir;
  return typeof value === 'string' ? value : null;
}

const writeProjectDir = (projectDir: string | null) => saveSettings({ projectDir });

/** Folder picker. Tests answer it through an environment variable instead of a dialog. */
async function pickFolder(title: string): Promise<string | null> {
  if (process.env.CLAUDE_ADDS_PICK_DIR) return process.env.CLAUDE_ADDS_PICK_DIR;
  const result = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

let updater: Updater | null = null;
let lastBackupPath: string | null = null;

let inFlight: Promise<Snapshot> | null = null;
let queued: Promise<Snapshot> | null = null;
let lastSnapshot: Snapshot | null = null;

function runDiscovery(): Promise<Snapshot> {
  inFlight = (async () => {
    try {
      lastSnapshot = await discover({
        homeDir: home(),
        userDataDir: app.getPath('userData'),
        projectDir: await readProjectDir(),
        env: process.env,
      });
      return lastSnapshot;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * A request that arrives while an inventory is running may follow a change
 * the running one started too early to see (an install that just finished).
 * It therefore waits for a fresh inventory instead of sharing the old one.
 */
function loadSnapshot(): Promise<Snapshot> {
  if (!inFlight) return runDiscovery();
  queued ??= inFlight
    .catch(() => undefined)
    .then(() => {
      queued = null;
      return runDiscovery();
    });
  return queued;
}

/**
 * Starts the CLI's own sign-in in the background, with no terminal window.
 * The CLI opens the official page in the browser and keeps the credentials.
 */
async function openLogin(): Promise<ActionResult> {
  if (process.env.CLAUDE_ADDS_CLAUDE_BIN || process.env.CLAUDE_ADDS_HOME) return { ok: false, message: 'تسجيل الدخول معطّل في وضع الاختبار.' };
  const cli = await detectCli(home(), process.env);
  if (!cli.available) return { ok: false, message: cli.reason ?? 'Claude CLI غير متاح.' };
  const child = spawn('claude', ['auth', 'login'], { shell: true, windowsHide: true, stdio: 'ignore' });
  const early = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
  if (early !== null && early !== 0) {
    return { ok: false, message: 'تعذّر بدء تسجيل الدخول في الخلفية. نفّذ claude auth login في الطرفية مرة واحدة ثم حدّث البيانات.' };
  }
  child.once('exit', () => void loadSnapshot().then(() => notifyInventoryChanged()));
  return { ok: true, message: 'بدأ تسجيل الدخول في الخلفية. أكمل الدخول في صفحة المتصفح، وتُحدَّث البيانات بعده تلقائيًا.' };
}

function notifyInventoryChanged(): void {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('inventory:changed'));
}

const diagnoseContext = (): DiagnoseContext => ({
  homeDir: home(),
  env: process.env,
  snapshot: () => lastSnapshot,
  reload: () => loadSnapshot(),
  login: async () => ({ ...(await openLogin()), evidence: ['claude auth login'] }),
  openExternal: (url) => shell.openExternal(url),
});

function isPicks(value: unknown): value is PlanPick[] {
  return Array.isArray(value) && value.length <= 200 && value.every((pick) => typeof pick?.itemId === 'string' && typeof pick?.env === 'string');
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'Claude Adds',
    autoHideMenuBar: true,
    backgroundColor: '#f6f4ef',
    icon: join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('snapshot:load', () => loadSnapshot());
ipcMain.handle('snapshot:last', () => lastSnapshot);
ipcMain.handle('account:login', () => openLogin());

// The renderer names a URL or a tool id. Commands are always built here.
ipcMain.handle('plan:git', (_event, url: unknown) =>
  typeof url === 'string' ? planFromGit(url, planContext()) : { ok: false, message: 'الرابط غير صالح.' },
);
ipcMain.handle('plan:tool', (_event, toolId: unknown) =>
  planFromTool(typeof toolId === 'string' ? lastSnapshot?.tools.find((tool) => tool.id === toolId) : undefined, planContext()),
);
// Installs run here in the main process, in the background, and report each stage to the window.
ipcMain.handle('plan:run', (event, planId: unknown, picks: unknown) =>
  typeof planId === 'string' && isPicks(picks)
    ? runPlan(planId, picks, planContext(), (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('job:progress', progress);
      })
    : [],
);

function isTarget(value: unknown): value is DiagnoseTarget {
  const target = value as DiagnoseTarget | null;
  return Boolean(target) && (target?.kind === 'source' || target?.kind === 'tool') && typeof target.id === 'string' && target.id.length < 300;
}
const FIXES: FixId[] = ['path', 'retry', 'login', 'enable', 'copy-skill'];

ipcMain.handle('diagnose:run', (_event, target: unknown) =>
  isTarget(target) ? diagnose(target, diagnoseContext()) : { title: '', issue: 'no-source', cause: 'هدف التشخيص غير صالح.', evidence: [] },
);
ipcMain.handle('diagnose:fix', (_event, target: unknown, fix: unknown) =>
  isTarget(target) && FIXES.includes(fix as FixId) ? applyFix(target, fix as FixId, diagnoseContext()) : { ok: false, message: 'إجراء غير صالح.', evidence: [] },
);
ipcMain.handle('tool:verify', (_event, toolId: unknown) =>
  typeof toolId === 'string' ? verifyTool(toolId, diagnoseContext()) : { ok: false, message: 'معرّف غير صالح.', evidence: [] },
);
ipcMain.handle('connector:auth', (_event, toolId: unknown) =>
  typeof toolId === 'string' ? authConnector(toolId, diagnoseContext()) : { ok: false, message: 'معرّف غير صالح.', evidence: [] },
);

ipcMain.handle('clipboard:copy', (_event, text: unknown) => {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2000) return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('external:open', async (_event, url: unknown) => {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  await shell.openExternal(parsed.toString());
  return true;
});

ipcMain.handle('project:choose', async () => {
  const chosen = await pickFolder('اختيار مجلد المشروع');
  if (chosen) await writeProjectDir(chosen);
  return chosen;
});

ipcMain.handle('project:clear', () => writeProjectDir(null));

ipcMain.handle('update:state', () => updater?.get() ?? null);
ipcMain.handle('update:check', () => updater?.check() ?? null);
ipcMain.handle('update:install', () => updater?.install(true) ?? false);
ipcMain.handle('update:prefs', (_event, prefs: unknown) => {
  const input = (prefs ?? {}) as { channel?: unknown; auto?: unknown };
  return updater?.setPrefs({
    channel: input.channel === 'dev' || input.channel === 'stable' ? input.channel : undefined,
    auto: typeof input.auto === 'boolean' ? input.auto : undefined,
  });
});

ipcMain.handle('backup:dir', async () => (await readSettings()).backupDir ?? null);
ipcMain.handle('backup:choose', async () => {
  const chosen = await pickFolder('اختيار مسار تصدير النسخة الاحتياطية');
  if (chosen) await saveSettings({ backupDir: chosen });
  return chosen;
});
ipcMain.handle('backup:run', async (): Promise<BackupResult> => {
  const destination = (await readSettings()).backupDir;
  if (!destination) return { ok: false, message: 'اختر مسار التصدير أولًا.' };
  // The backup uses the inventory already on screen, or takes one if none exists yet.
  const snapshot = lastSnapshot ?? (await loadSnapshot());
  const result = await createBackup(destination, snapshot, app.getVersion());
  if (result.ok && result.path) lastBackupPath = result.path;
  return result;
});
ipcMain.handle('backup:open', async () => {
  if (!lastBackupPath) return false;
  return (await shell.openPath(lastBackupPath)) === '';
});

void app.whenReady().then(async () => {
  await clearPlans(app.getPath('userData'));
  const settings = await readSettings();
  updater = new Updater({
    currentVersion: app.getVersion(),
    // The portable build unpacks to a temporary folder on every start, so it cannot replace itself.
    canSelfInstall: process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE,
    userDataDir: app.getPath('userData'),
    env: process.env,
    prefs: { channel: settings.updateChannel, auto: settings.autoUpdate },
    savePrefs: (prefs) => saveSettings({ updateChannel: prefs.channel, autoUpdate: prefs.auto }),
    onChange: (state) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('update:changed', state)),
    quit: () => app.quit(),
  });
  // Check shortly after launch, then every three hours while the app stays open.
  if (!process.env.CLAUDE_ADDS_NO_UPDATE_CHECK) {
    setTimeout(() => void updater?.check(), 8000);
    setInterval(() => void updater?.check(), 3 * 60 * 60 * 1000);
  }
  app.on('before-quit', () => updater?.installOnQuit());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
