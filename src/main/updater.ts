import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateState } from '../shared/types';
import { isPrerelease, pickUpdate, type ReleaseInfo, type UpdateChannel } from '../shared/version';

export const REPO = 'sufyanaser/Claude-Adds';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

export interface UpdaterOptions {
  currentVersion: string;
  /** True for the installed Windows build, which can replace itself. */
  canSelfInstall: boolean;
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  prefs: { channel?: UpdateChannel; auto?: boolean };
  savePrefs(prefs: { channel: UpdateChannel; auto: boolean }): Promise<void>;
  onChange(state: UpdateState): void;
  quit(): void;
}

/** Reads the public release list. Only tag, flags, page URL and asset names, sizes and digests are kept. */
export function parseReleases(json: string): ReleaseInfo[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('unexpected release list shape');
  return (data as Array<Record<string, unknown>>)
    .filter((item) => typeof item?.tag_name === 'string')
    .map((item) => ({
      tag: item.tag_name as string,
      prerelease: item.prerelease === true,
      draft: item.draft === true,
      url: typeof item.html_url === 'string' ? item.html_url : `https://github.com/${REPO}/releases`,
      assets: (Array.isArray(item.assets) ? (item.assets as Array<Record<string, unknown>>) : [])
        .filter((asset) => typeof asset?.name === 'string' && typeof asset?.browser_download_url === 'string')
        .map((asset) => ({
          name: asset.name as string,
          url: asset.browser_download_url as string,
          size: typeof asset.size === 'number' ? asset.size : 0,
          digest: typeof asset.digest === 'string' ? asset.digest : undefined,
        })),
    }));
}

export class Updater {
  private state: UpdateState;
  private installer: string | null = null;
  private busy = false;

  constructor(private readonly options: UpdaterOptions) {
    this.state = {
      current: options.currentVersion,
      // A development build follows development builds unless told otherwise.
      channel: options.prefs.channel ?? (isPrerelease(options.currentVersion) ? 'dev' : 'stable'),
      auto: options.prefs.auto ?? true,
      mode: options.canSelfInstall ? 'installer' : 'manual',
      status: 'idle',
    };
  }

  get(): UpdateState {
    return { ...this.state };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.get());
  }

  async setPrefs(prefs: { channel?: UpdateChannel; auto?: boolean }): Promise<UpdateState> {
    const channel = prefs.channel === 'dev' || prefs.channel === 'stable' ? prefs.channel : this.state.channel;
    const auto = typeof prefs.auto === 'boolean' ? prefs.auto : this.state.auto;
    const channelChanged = channel !== this.state.channel;
    this.set({ channel, auto });
    await this.options.savePrefs({ channel, auto });
    if (channelChanged) void this.check();
    return this.get();
  }

  /** Looks for a newer release. With automatic updates on, the installer is downloaded right away. */
  async check(): Promise<UpdateState> {
    if (this.busy) return this.get();
    this.busy = true;
    this.set({ status: 'checking', message: undefined });
    try {
      const response = await fetch(this.options.env.CLAUDE_ADDS_UPDATE_API || RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-adds-updater' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const update = pickUpdate(this.state.current, parseReleases(await response.text()), this.state.channel);
      const checkedAt = new Date().toISOString();
      if (!update) {
        this.set({ status: 'none', latest: undefined, url: undefined, checkedAt });
      } else {
        this.set({ status: 'available', latest: update.tag.replace(/^v/, ''), url: update.url, checkedAt });
        if (this.state.mode === 'installer' && this.state.auto) await this.download(update);
      }
    } catch (cause) {
      this.set({ status: 'error', message: cause instanceof Error ? cause.message : String(cause), checkedAt: new Date().toISOString() });
    }
    this.busy = false;
    return this.get();
  }

  /** Downloads the Windows installer from this repository's releases only, and checks it before use. */
  private async download(release: ReleaseInfo): Promise<void> {
    const asset = release.assets.find((item) => /-setup\.exe$/i.test(item.name));
    const allowed = this.options.env.CLAUDE_ADDS_UPDATE_API ? true : asset?.url.startsWith(DOWNLOAD_PREFIX);
    if (!asset || !allowed) {
      this.set({ status: 'available', message: 'هذا الإصدار لا يحتوي مُثبِّت Windows. حدّث يدويًا من صفحة الإصدار.' });
      return;
    }
    this.set({ status: 'downloading' });
    const dir = join(this.options.userDataDir, 'updates');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const file = join(dir, asset.name.replace(/[^A-Za-z0-9._-]/g, '_'));

    const response = await fetch(asset.url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));

    const size = (await stat(file)).size;
    const digest = `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
    const sizeOk = asset.size === 0 || asset.size === size;
    const digestOk = !asset.digest || asset.digest.toLowerCase() === digest;
    if (!sizeOk || !digestOk) {
      await rm(file, { force: true });
      throw new Error('الملف المنزَّل لا يطابق الحجم أو البصمة المعلنة في الإصدار، فحُذف.');
    }
    this.installer = file;
    this.set({ status: 'ready', message: asset.digest ? 'تحققت بصمة SHA-256 للمُثبِّت.' : 'تحقق حجم المُثبِّت. الإصدار لا يعلن بصمة.' });
  }

  /** Runs the downloaded installer silently and quits. The installer restarts the app when asked to. */
  install(restart: boolean): boolean {
    if (!this.installer || this.state.status !== 'ready') return false;
    const args = ['--updated', '/S'];
    if (restart) args.push('--force-run');
    spawn(this.installer, args, { detached: true, stdio: 'ignore' }).unref();
    this.installer = null;
    if (restart) this.options.quit();
    return true;
  }

  /** Called while the app is closing: a downloaded update is applied without a restart. */
  installOnQuit(): void {
    if (this.state.auto) this.install(false);
  }
}
