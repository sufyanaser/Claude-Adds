import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAuthStatus } from '../../src/main/discovery/account';
import { loadCatalog, parseCatalog } from '../../src/main/discovery/catalog';
import { parseFrontmatter, readServerDefs } from '../../src/main/discovery/contents';
import { parseMcpList } from '../../src/main/discovery/mcp';
import { parsePluginList, pluginStatus } from '../../src/main/discovery/plugins';
import { MASK, redactCommand, redactUrl } from '../../src/main/discovery/redact';

describe('redaction', () => {
  it('drops credentials, query and fragment from URLs', () => {
    expect(redactUrl('https://user:pw@mcp.example.com/v1/mcp?api_key=abc#frag')).toBe('https://mcp.example.com/v1/mcp');
  });

  it('masks opaque path segments', () => {
    expect(redactUrl('https://mcp.example.com/u/abcdefghijklmnopqrstuvwxyz0123456789/mcp')).toBe(
      `https://mcp.example.com/u/${MASK}/mcp`,
    );
  });

  it('masks secrets in command lines and keeps ordinary arguments', () => {
    const out = redactCommand('npx -y @scope/server@latest --api-key sk-live-1234567890 TOKEN=abc123 --port 3000');
    expect(out).toBe(`npx -y @scope/server@latest --api-key ${MASK} TOKEN=${MASK} --port 3000`);
  });

  it('masks bearer values and known token prefixes', () => {
    expect(redactCommand('curl -H Authorization: Bearer abc.def')).not.toContain('abc.def');
    expect(redactCommand('run ghp_abcdefghijklmnop')).toBe(`run ${MASK}`);
  });

  it('keeps Windows executable paths readable', () => {
    const path = 'C:\\Users\\me\\.local\\bin\\graphify-mcp.exe';
    expect(redactCommand(path)).toBe(path);
  });
});

describe('parseMcpList', () => {
  const sample = [
    'Checking MCP server health…',
    '',
    'claude.ai Webflow: https://mcp.webflow.com/mcp - √ Connected',
    'claude.ai parallax: https://api.parallax.kr/mcp - ! Connected · tools fetch failed — Request timed out',
    'plugin:bio-research:biorender: https://mcp.services.biorender.com/mcp (HTTP) - ! Needs authentication',
    'plugin:engineering:gmail:  - Not configured',
    'plugin:desktop-commander:desktop-commander: npx -y @wonderwhy-er/desktop-commander@latest - √ Connected',
    'figcraft: C:\\tools\\figcraft-cli.exe --token sk-secret-value-123 - × Failed to connect — CONNECTION_CLOSED: Connection closed',
  ].join('\n');
  const entries = parseMcpList(sample);

  it('skips non-server lines', () => {
    expect(entries).toHaveLength(6);
  });

  it('classifies origin, plugin and server', () => {
    expect(entries[0]).toMatchObject({ origin: 'claude.ai', server: 'Webflow', status: 'connected', transport: 'http' });
    expect(entries[2]).toMatchObject({ origin: 'plugin', plugin: 'bio-research', server: 'biorender', status: 'needs-auth' });
    expect(entries[4]).toMatchObject({ origin: 'plugin', plugin: 'desktop-commander', transport: 'stdio', status: 'connected' });
  });

  it('never reports a failed tool fetch or a failed connection as connected', () => {
    expect(entries[1]?.status).toBe('unverified');
    expect(entries[5]?.status).toBe('unverified');
    expect(entries[5]?.detail).toContain('CONNECTION_CLOSED');
  });

  it('marks placeholder servers as not configured', () => {
    expect(entries[3]).toMatchObject({ status: 'not-configured', transport: 'none', endpoint: '' });
  });

  it('redacts secrets in stdio command lines', () => {
    expect(entries[5]?.endpoint).not.toContain('sk-secret-value-123');
  });
});

describe('plugins', () => {
  const list = JSON.stringify([
    { id: 'bio-research@knowledge-work-plugins', version: '1.2.0', scope: 'user', enabled: true, installPath: 'C:\\p' },
    { id: 'engineering@synced', version: '1.2.0', scope: 'synced', enabled: false },
  ]);

  it('parses ids, scopes and enablement', () => {
    const plugins = parsePluginList(list);
    expect(plugins[0]).toMatchObject({ name: 'bio-research', marketplace: 'knowledge-work-plugins', scope: 'user', enabled: true });
    expect(plugins[1]).toMatchObject({ name: 'engineering', marketplace: 'synced', scope: 'account', enabled: false });
  });

  it('rejects output that is not a list', () => {
    expect(() => parsePluginList('{"error":"x"}')).toThrow();
  });

  it('derives status from evidence only', () => {
    const [enabled, disabled] = parsePluginList(list);
    expect(pluginStatus(enabled, true)).toBe('enabled');
    expect(pluginStatus(disabled, true)).toBe('disabled');
    expect(pluginStatus(undefined, true)).toBe('available');
    // Without the CLI an absent plugin may still be synced from the account.
    expect(pluginStatus(undefined, false)).toBe('unverified');
    // In the install registry, but nothing says whether it is switched on.
    expect(pluginStatus({ ...enabled!, enabled: null }, false)).toBe('installed');
  });
});

describe('catalog', () => {
  const body = JSON.stringify({
    name: 'knowledge-work-plugins',
    plugins: [
      { name: 'sales', displayName: 'Sales', source: './sales', description: 'Sell.' },
      {
        name: 'figma',
        category: 'design',
        source: { source: 'url', url: 'https://github.com/figma/mcp-server-guide.git', sha: 'abc' },
        homepage: 'javascript:alert(1)',
      },
      {
        name: 'miro',
        source: { source: 'git-subdir', url: 'https://github.com/miroapp/miro-ai.git', path: 'claude-plugins/miro', ref: 'main' },
      },
    ],
  });

  it('builds documentation links per source type and ignores non-https homepages', () => {
    const [sales, figma, miro] = parseCatalog(body);
    expect(sales).toMatchObject({ localPath: 'sales', docsUrl: 'https://github.com/anthropics/knowledge-work-plugins/tree/main/sales' });
    expect(figma?.docsUrl).toBe('https://github.com/figma/mcp-server-guide');
    expect(miro?.docsUrl).toBe('https://github.com/miroapp/miro-ai/tree/main/claude-plugins/miro');
  });

  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-adds-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ok = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const down = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  it('keeps the last good copy and its date when a refresh fails', async () => {
    const cacheFile = join(dir, 'catalog-cache.json');
    const first = await loadCatalog({ url: 'https://x', cacheFile, now: '2026-01-01T00:00:00.000Z', fetchImpl: ok });
    expect(first).toMatchObject({ fromCache: false, fetchedAt: '2026-01-01T00:00:00.000Z' });

    const second = await loadCatalog({ url: 'https://x', cacheFile, now: '2026-02-01T00:00:00.000Z', fetchImpl: down });
    expect(second.fromCache).toBe(true);
    expect(second.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second.entries).toHaveLength(3);
    expect(second.error).toBe('network down');
  });

  it('reports failure without inventing data when there is no cache', async () => {
    const result = await loadCatalog({ url: 'https://x', cacheFile: join(dir, 'none.json'), now: 'n', fetchImpl: down });
    expect(result).toMatchObject({ entries: [], fetchedAt: null, fromCache: false, error: 'network down' });
  });
});

describe('account', () => {
  it('keeps only sign-in state, method, email and organization', () => {
    const info = parseAuthStatus(
      JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.test', orgName: 'Org', orgId: 'org-123', accessToken: 'sk-zzz' }),
    );
    expect(info).toEqual({ loggedIn: true, method: 'claude.ai', email: 'a@b.test', organization: 'Org' });
  });

  it('reports unknown instead of guessing', () => {
    expect(parseAuthStatus('not json')).toEqual({ loggedIn: null });
    expect(parseAuthStatus('{}')).toEqual({ loggedIn: null });
    expect(parseAuthStatus('{"loggedIn":false}')).toMatchObject({ loggedIn: false });
  });
});

describe('plugin contents', () => {
  it('reads quoted and folded frontmatter values', () => {
    expect(parseFrontmatter('---\nname: "audit"\ndescription: "Checks: numbers"\n---\nbody')).toEqual({
      name: 'audit',
      description: 'Checks: numbers',
    });
    expect(parseFrontmatter('---\nname: spec\ndescription: >\n  Write a spec\n  from an idea.\n---')).toEqual({
      name: 'spec',
      description: 'Write a spec from an idea.',
    });
    expect(parseFrontmatter('no frontmatter')).toEqual({});
  });

  it('never exposes env, headers or oauth values from MCP config', () => {
    const defs = readServerDefs({
      mcpServers: {
        slack: { type: 'http', url: 'https://mcp.slack.com/mcp?token=zzz', oauth: { clientId: 'id-123' }, headers: { Authorization: 'Bearer zzz' } },
        local: { command: 'node', args: ['server.js', '--secret', 'hunter2'], env: { API_KEY: 'hunter3' } },
        gmail: { type: 'http', url: '' },
      },
    });
    const flat = JSON.stringify(defs);
    for (const secret of ['zzz', 'id-123', 'hunter2', 'hunter3']) expect(flat).not.toContain(secret);
    expect(defs.map((d) => d.transport)).toEqual(['http', 'stdio', 'none']);
  });
});
