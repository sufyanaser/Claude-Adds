import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActionResult, Snapshot } from '../shared/types';
import { detectCli, runCli } from './discovery/cli';
import { discover } from './discovery/discover';
import { redactCommand } from './discovery/redact';

// Lets tests run against a throwaway profile instead of the real one.
if (process.env.CLAUDE_ADDS_USER_DATA) app.setPath('userData', process.env.CLAUDE_ADDS_USER_DATA);

const stateFile = () => join(app.getPath('userData'), 'state.json');

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
let lastSnapshot: Snapshot | null = null;

function loadSnapshot(): Promise<Snapshot> {
  inFlight ??= (async () => {
    try {
      lastSnapshot = await discover({
        homeDir: homedir(),
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
 * Installs through the official CLI. The arguments come from the snapshot this
 * process built, so the renderer can only name a tool, never a command.
 * `-y` is never passed: a plugin that needs a marketplace-declared command
 * confirmed is refused by the CLI and reported back instead.
 */
async function installTool(toolId: unknown): Promise<ActionResult> {
  const plan = typeof toolId === 'string' ? lastSnapshot?.tools.find((tool) => tool.id === toolId)?.install : undefined;
  if (!plan) return { ok: false, message: 'هذه الأداة غير قابلة للتثبيت المباشر في آخر تحديث للبيانات.' };
  const cwd = homedir();
  const cli = await detectCli(cwd, process.env);
  if (!cli.available) return { ok: false, message: cli.reason ?? 'Claude CLI غير متاح.' };

  const run = await runCli(cli, plan.args, cwd, 300000);
  if (run.ok) return { ok: true, message: `تم تثبيت ${plan.plugin} في نطاق المستخدم. أعد تشغيل جلسات Claude المفتوحة لتظهر فيها.` };
  const output = redactCommand((run.stderr || run.stdout).trim().split(/\r?\n/).slice(-4).join(' ')).slice(0, 400);
  return { ok: false, message: `فشل تثبيت ${plan.plugin} (${run.error ?? ''}). ${output}` };
}

/** Opens a terminal with the CLI's own sign-in flow. Credentials stay inside the CLI. */
async function openLogin(): Promise<ActionResult> {
  if (process.env.CLAUDE_ADDS_CLAUDE_BIN) return { ok: false, message: 'تسجيل الدخول معطّل عند استخدام مسار CLI بديل.' };
  const cli = await detectCli(homedir(), process.env);
  if (!cli.available) return { ok: false, message: cli.reason ?? 'Claude CLI غير متاح.' };
  if (process.platform !== 'win32') return { ok: false, message: 'نفّذ claude auth login في الطرفية.' };
  spawn('cmd.exe', ['/c', 'start', 'Claude login', 'cmd', '/k', 'claude auth login'], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, message: 'فُتحت طرفية لتسجيل الدخول عبر Claude CLI. أكمل الدخول في المتصفح ثم حدّث البيانات.' };
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 940,
    minHeight: 600,
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
ipcMain.handle('plugin:install', (_event, toolId: unknown) => installTool(toolId));
ipcMain.handle('account:login', () => openLogin());

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

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
