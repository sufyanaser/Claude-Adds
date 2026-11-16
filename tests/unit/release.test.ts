import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup } from '../../src/main/backup';
import { parseReleases } from '../../src/main/updater';
import type { Snapshot, Tool } from '../../src/shared/types';
import { compareVersions, pickUpdate, type ReleaseInfo } from '../../src/shared/version';

describe('version order', () => {
  it('orders releases and development builds', () => {
    const sorted = ['0.3.0', '0.3.0-dev.10', '0.2.1', '0.3.1-dev.1', '0.3.0-dev.2', 'v0.10.0'].sort(compareVersions);
    expect(sorted).toEqual(['0.2.1', '0.3.0-dev.2', '0.3.0-dev.10', '0.3.0', '0.3.1-dev.1', 'v0.10.0']);
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
  });
});

describe('choosing an update', () => {
  const release = (tag: string, prerelease = false, draft = false): ReleaseInfo => ({ tag, prerelease, draft, url: `https://example.test/${tag}`, assets: [] });
  const releases = [release('v0.3.0-dev.7', true), release('v0.3.0'), release('v0.3.1-dev.2', true), release('v0.2.1'), release('v9.0.0', false, true), release('nightly')];

  it('keeps the stable channel on official releases', () => {
    expect(pickUpdate('0.2.1', releases, 'stable')?.tag).toBe('v0.3.0');
    expect(pickUpdate('0.3.0', releases, 'stable')).toBeNull();
  });

  it('lets the development channel follow every build', () => {
    expect(pickUpdate('0.3.0', releases, 'dev')?.tag).toBe('v0.3.1-dev.2');
    expect(pickUpdate('0.3.0-dev.7', releases, 'dev')?.tag).toBe('v0.3.1-dev.2');
  });

  it('never offers a draft, an older version or an unparseable tag', () => {
    expect(pickUpdate('0.3.1-dev.2', releases, 'dev')).toBeNull();
    expect(pickUpdate('8.0.0', releases, 'dev')).toBeNull();
  });

  it('reads only the fields it needs from the release list', () => {
    const parsed = parseReleases(
      JSON.stringify([
        { tag_name: 'v0.3.0', prerelease: false, draft: false, html_url: 'https://github.com/o/r/releases/tag/v0.3.0', author: { login: 'someone' }, assets: [{ name: 'a-setup.exe', browser_download_url: 'https://github.com/o/r/releases/download/v0.3.0/a-setup.exe', size: 10, digest: 'sha256:abc', uploader: { login: 'x' } }] },
        { name: 'no tag' },
      ]),
    );
    expect(parsed).toEqual([{ tag: 'v0.3.0', prerelease: false, draft: false, url: 'https://github.com/o/r/releases/tag/v0.3.0', assets: [{ name: 'a-setup.exe', url: 'https://github.com/o/r/releases/download/v0.3.0/a-setup.exe', size: 10, digest: 'sha256:abc' }] }]);
    expect(() => parseReleases('{"message":"rate limited"}')).toThrow();
  });
});

describe('backup', () => {
  let home = '';
  let out = '';
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'claude-adds-bk-home-'));
    out = await mkdtemp(join(tmpdir(), 'claude-adds-bk-out-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  });

  const tool = (partial: Partial<Tool> & Pick<Tool, 'id' | 'kind' | 'name' | 'source'>): Tool => ({
    title: partial.name,
    category: 'personal',
    status: 'discovered',
    scope: 'user',
    inCatalog: false,
    mine: true,
    envs: [{ env: 'claude-code', scope: 'user', status: 'discovered', evidence: 'file' }],
    evidence: { source: 'file', checkedAt: '2026-01-01T00:00:00.000Z' },
    description: '',
    ar: { summary: '', when: '', example: '', generic: true },
    related: [],
    commands: [],
    ...partial,
  });

  it('writes the inventory and copies owned skills, leaving credentials out', async () => {
    const skillDir = join(home, '.claude', 'skills', 'notes');
    await mkdir(join(skillDir, 'refs'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: notes\ndescription: d\n---');
    await writeFile(join(skillDir, 'refs', 'a.md'), 'ref');
    await writeFile(join(skillDir, '.env'), 'API_KEY=super-secret-value');
    await writeFile(join(skillDir, 'server.pem'), 'PRIVATE');
    await symlink(home, join(skillDir, 'link'), 'junction').catch(() => {});

    const snapshot = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      tools: [
        tool({ id: 'skill:user-skills:notes', kind: 'skill', name: 'notes', source: 'user-skills', location: join(skillDir, 'SKILL.md') }),
        tool({ id: 'skill:synced:acct', kind: 'skill', name: 'acct', source: 'synced', location: join(home, 'synced', 'acct', 'SKILL.md') }),
        tool({ id: 'plugin:sales', kind: 'plugin', name: 'sales', source: 'synced', status: 'enabled', commands: [{ kind: 'usage', label: 'x', text: 'claude plugin details sales@synced', where: 'shell' }] }),
        tool({ id: 'plugin:figma', kind: 'plugin', name: 'figma', source: 'knowledge-work-plugins', mine: false, status: 'available' }),
      ],
    } as unknown as Snapshot;

    const result = await createBackup(out, snapshot, '0.3.0', new Date(2026, 0, 2, 3, 4, 5));
    expect(result).toMatchObject({ ok: true, tools: 3, skills: 1 });
    expect(result.path).toBe(join(out, 'Claude-Adds-backup-2026-01-02_03-04-05'));

    const copied = join(result.path!, 'skills', 'user-skills', 'notes');
    expect((await readdir(copied)).sort()).toEqual(['SKILL.md', 'refs']);
    expect(existsSync(join(copied, 'refs', 'a.md'))).toBe(true);

    const manifest = JSON.parse(await readFile(join(result.path!, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('claude-adds-backup/1');
    expect(manifest.tools.map((t: { id: string }) => t.id)).toEqual(['skill:user-skills:notes', 'skill:synced:acct', 'plugin:sales']);
    expect(manifest.tools[2].commands).toEqual(['claude plugin details sales@synced']);
    expect(manifest.copiedSkills).toHaveLength(1);

    const everything = (await readFile(join(result.path!, 'manifest.json'), 'utf8')) + (await readFile(join(result.path!, 'README.txt'), 'utf8'));
    expect(everything).not.toContain('super-secret-value');
  });

  it('refuses a missing export path', async () => {
    const result = await createBackup(join(out, 'does-not-exist'), { generatedAt: 'x', tools: [] } as unknown as Snapshot, '0.3.0');
    expect(result.ok).toBe(false);
  });
});
