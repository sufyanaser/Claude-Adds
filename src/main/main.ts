import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActionResult, PlanPick, Snapshot } from '../shared/types';
import { detectCli } from './discovery/cli';
import { discover } from './discovery/discover';
import { clearPlans, planFromGit, planFromTool, runPlan, type PlanContext } from './install/plan';

// Tests run against a throwaway profile and home instead of the real ones.
if (process.env.CLAUDE_ADDS_USER_DATA) app.setPath('userData', process.env.CLAUDE_ADDS_USER_DATA);
const home = () => process.env.CLAUDE_ADDS_HOME || homedir();

const stateFile = () => join(app.getPath('userData'), 'state.json');
const planContext = (): PlanContext => ({ homeDir: home(), userDataDir: app.getPath('userData'), env: process.env });

async function readProjectDir(): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(stateFile(), 'utf8')) as { projectDir?: unknown };
    return typeof state.projectDir === 'string' ? state.projectDir : null;
  } catch {
    return null;
  }
}

async function writeProjectDir(projectDir: string | null): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(stateFile(), JSON.stringify({ projectDir }), 'utf8');
}

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

/** Opens a terminal with the CLI's own sign-in flow. Credentials stay inside the CLI. */
async function openLogin(): Promise<ActionResult> {
  if (process.env.CLAUDE_ADDS_CLAUDE_BIN || process.env.CLAUDE_ADDS_HOME) return { ok: false, message: 'تسجيل الدخول معطّل في وضع الاختبار.' };
  const cli = await detectCli(home(), process.env);
  if (!cli.available) return { ok: false, message: cli.reason ?? 'Claude CLI غير متاح.' };
  if (process.platform !== 'win32') return { ok: false, message: 'نفّذ claude auth login في الطرفية.' };
  spawn('cmd.exe', ['/c', 'start', 'Claude login', 'cmd', '/k', 'claude auth login'], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, message: 'فُتحت طرفية لتسجيل الدخول عبر Claude CLI. أكمل الدخول في المتصفح ثم حدّث البيانات.' };
}

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
ipcMain.handle('account:login', () => openLogin());

// The renderer names a URL or a tool id. Commands are always built here.
ipcMain.handle('plan:git', (_event, url: unknown) =>
  typeof url === 'string' ? planFromGit(url, planContext()) : { ok: false, message: 'الرابط غير صالح.' },
);
ipcMain.handle('plan:tool', (_event, toolId: unknown) =>
  planFromTool(typeof toolId === 'string' ? lastSnapshot?.tools.find((tool) => tool.id === toolId) : undefined, planContext()),
);
ipcMain.handle('plan:run', (_event, planId: unknown, picks: unknown) =>
  typeof planId === 'string' && isPicks(picks) ? runPlan(planId, picks, planContext()) : [],
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
  const result = await dialog.showOpenDialog({ title: 'اختيار مجلد المشروع', properties: ['openDirectory'] });
  const chosen = result.canceled ? null : (result.filePaths[0] ?? null);
  if (chosen) await writeProjectDir(chosen);
  return chosen;
});

ipcMain.handle('project:clear', () => writeProjectDir(null));

void app.whenReady().then(async () => {
  await clearPlans(app.getPath('userData'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
