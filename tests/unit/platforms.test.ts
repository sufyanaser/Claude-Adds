import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LastGood } from '../../src/main/discovery/lastgood';
import { parseAgyMcp, parseAgyPlugins, parseCodexMcp, parseCodexPlugins, parseGeminiMcp, parseGeminiSkills } from '../../src/main/discovery/platforms';
import { scanRepo, validateGitUrl } from '../../src/main/install/plan';

describe('Codex inventory', () => {
  it('reads servers without exposing env or header values', () => {
    const servers = parseCodexMcp(
      JSON.stringify([
        { name: 'local', enabled: true, transport: { type: 'stdio', command: 'node', args: ['s.js', '--token', 'sk-live-abcdef123456'], env: { KEY: 'hunter2' } } },
        { name: 'remote', enabled: false, transport: { type: 'streamable_http', url: 'https://x.test/mcp?key=zzz', http_headers: { Authorization: 'Bearer zzz' } } },
      ]),
    );
    expect(servers.map((s) => [s.name, s.status])).toEqual([['local', 'enabled'], ['remote', 'disabled']]);
    const flat = JSON.stringify(servers);
    for (const secret of ['sk-live-abcdef123456', 'hunter2', 'zzz']) expect(flat).not.toContain(secret);
    expect(servers[1]?.endpoint).toBe('https://x.test/mcp');
  });

  it('keeps only installed plugins from the full marketplace listing', () => {
    const text = [
      'Marketplace `openai-bundled`',
      'PLUGIN                          STATUS              VERSION        SOURCE',
      'browser@openai-bundled          installed, enabled  26.1111.21308  C:\\x\\browser',
      'chrome@openai-bundled           installed, disabled  26.1111.21308  C:\\x\\chrome',
      'figma@openai-curated            not installed       1.0.0          https://example.test',
    ].join('\n');
    expect(parseCodexPlugins(text)).toEqual([
      { id: 'browser@openai-bundled', name: 'browser', source: 'openai-bundled', enabled: true, version: '26.1111.21308' },
      { id: 'chrome@openai-bundled', name: 'chrome', source: 'openai-bundled', enabled: false, version: '26.1111.21308' },
    ]);
  });
});

describe('Gemini inventory', () => {
  it('separates a confirmed connection from anything else', () => {
    const servers = parseGeminiMcp(['Configured MCP servers:', '', '✓ reason: C:\\bin\\reason.exe mcp (stdio) - Connected', '✗ docs: https://d.test/mcp?t=1 (http) - Disconnected'].join('\n'));
    expect(servers.map((s) => [s.name, s.status])).toEqual([['reason', 'connected'], ['docs', 'unverified']]);
    expect(servers[1]?.endpoint).toBe('https://d.test/mcp');
    expect(servers[1]?.note).toContain('Disconnected');
  });

  it('reads skill switches and locations, ignoring log lines', () => {
    const text = [
      'Ripgrep is not available. Falling back to GrepTool.',
      'Discovered Agent Skills:',
      '',
      'antislop [Enabled]',
      '  Description: Anti Slop rules.',
      '  Location:    C:\\Users\\me\\.agents\\skills\\antislop\\SKILL.md',
      'old-skill [Disabled]',
      '  Description: Old.',
      '  Location:    C:\\Users\\me\\.gemini\\skills\\old-skill\\SKILL.md',
    ].join('\n');
    expect(parseGeminiSkills(text)).toEqual([
      { name: 'antislop', enabled: true, location: 'C:\\Users\\me\\.agents\\skills\\antislop\\SKILL.md' },
      { name: 'old-skill', enabled: false, location: 'C:\\Users\\me\\.gemini\\skills\\old-skill\\SKILL.md' },
    ]);
  });
});

describe('Antigravity inventory', () => {
  it('reads the server table and the plugin list', () => {
    expect(parseAgyMcp('NAME        TYPE   STATUS   COMMAND/URL\nmarkitdown  stdio  enabled  C:\\bin\\markitdown-mcp.exe\nweb  http  disabled  https://w.test/mcp').map((s) => [s.name, s.status])).toEqual([
      ['markitdown', 'enabled'],
      ['web', 'disabled'],
    ]);
    const plugins = parseAgyPlugins(JSON.stringify([{ name: 'oab', enabled: true, version: '0.1.0', source: 'antigravity', skills: ['agent-bridge'], mcpServers: ['open-agent-bridge'] }]));
    expect(plugins[0]).toMatchObject({ name: 'oab', enabled: true, version: '0.1.0' });
    expect(plugins[0]?.detail).toContain('agent-bridge');
  });
});

describe('last good readings', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-adds-lg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the earlier result with its date when a refresh fails', async () => {
    const file = join(dir, 'last-good.json');
    const first = new LastGood(file);
    await first.load();
    expect(first.use('k', ['a'], '2026-01-01T00:00:00.000Z')).toEqual({ data: ['a'], at: '2026-01-01T00:00:00.000Z', stale: false });
    await first.save();

    const second = new LastGood(file);
    await second.load();
    expect(second.use<string[]>('k', null, '2026-02-01T00:00:00.000Z')).toEqual({ data: ['a'], at: '2026-01-01T00:00:00.000Z', stale: true });
    expect(second.use<string[]>('never', null, 'now')).toEqual({ data: null, at: null, stale: false });
  });
});

describe('Git sources', () => {
  it('accepts only https URLs without credentials', () => {
    expect(validateGitUrl('https://github.com/anthropics/skills', false)).toEqual({ ok: true, url: 'https://github.com/anthropics/skills' });
    expect(validateGitUrl('https://github.com/a/b?x=1#y', false)).toEqual({ ok: true, url: 'https://github.com/a/b' });
    for (const bad of ['', 'git@github.com:a/b.git', 'http://github.com/a/b', 'https://user:token@github.com/a/b', 'file:///c:/x', 'C:\\Windows']) {
      expect(validateGitUrl(bad, false).ok).toBe(false);
    }
  });

  let repo = '';
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'claude-adds-repo-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('classifies repository contents by their manifest files', async () => {
    await mkdir(join(repo, '.claude-plugin'), { recursive: true });
    await writeFile(join(repo, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'm', plugins: [{ name: 'alpha', description: 'A' }, { name: '../evil', description: 'x' }] }));
    await writeFile(join(repo, 'gemini-extension.json'), JSON.stringify({ name: 'ext', description: 'E' }));
    await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { svc: { command: 'node', env: { K: 'secret-value' } } } }));
    await mkdir(join(repo, 'skills', 'good'), { recursive: true });
    await writeFile(join(repo, 'skills', 'good', 'SKILL.md'), '---\nname: good\ndescription: Does good.\n---\nbody');
    await mkdir(join(repo, 'skills', 'bad'), { recursive: true });
    await writeFile(join(repo, 'skills', 'bad', 'SKILL.md'), 'no frontmatter');
    await mkdir(join(repo, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'pkg', 'SKILL.md'), '---\nname: pkg\ndescription: x\n---');

    const found = await scanRepo(repo);
    expect(found.marketplace?.plugins.map((p) => p.name)).toEqual(['alpha']);
    expect(found.extension?.name).toBe('ext');
    expect(found.servers).toEqual(['svc']);
    expect(found.skills.map((s) => [s.name, s.valid]).sort()).toEqual([['bad', false], ['good', true]]);
    expect(JSON.stringify(found)).not.toContain('secret-value');
  });
});
