import { describe, expect, it } from 'vitest';
import { mergeIdentical } from '../../src/main/discovery/merge';
import { addToPath, candidateDirs, findOutsidePath, type PathProbe } from '../../src/main/discovery/paths';
import { findAlternatives } from '../../src/shared/alternatives';
import { EMPTY_FILTERS, applyFilters, matchesQuery, normalize, searchGroups, sortTools, statusCounts, statusIn, tabCounts } from '../../src/shared/query';
import type { Tool } from '../../src/shared/types';

function tool(partial: Partial<Tool> & Pick<Tool, 'id' | 'kind' | 'name' | 'status'>): Tool {
  return {
    title: partial.name,
    category: 'other',
    scope: 'user',
    source: 'knowledge-work-plugins',
    inCatalog: true,
    mine: true,
    envs: [{ env: 'claude-code', scope: 'user', status: partial.status, evidence: 'test' }],
    evidence: { source: 'test', checkedAt: '2026-01-01T00:00:00.000Z' },
    description: '',
    ar: { summary: '', when: '', example: '', generic: true },
    related: [],
    commands: [],
    ...partial,
  };
}

const tools: Tool[] = [
  tool({ id: 'plugin:sales', kind: 'plugin', name: 'sales', title: 'المبيعات', category: 'sales', status: 'enabled', description: 'Prospect and prep calls.', keywords: 'forecast Weekly sales forecast' }),
  tool({ id: 'plugin:figma', kind: 'plugin', name: 'figma', category: 'design', status: 'available', scope: 'catalog', mine: false, envs: [{ env: 'claude', scope: 'catalog', status: 'available', evidence: 'catalog' }, { env: 'claude-code', scope: 'catalog', status: 'available', evidence: 'catalog' }] }),
  tool({ id: 'skill:sales:call-prep', kind: 'skill', name: 'call-prep', category: 'sales', status: 'enabled', parentId: 'plugin:sales' }),
  tool({ id: 'command:sales:forecast', kind: 'command', name: 'forecast', category: 'sales', status: 'enabled', parentId: 'plugin:sales', description: 'Weekly sales forecast' }),
  tool({
    id: 'connector:claude.ai Slack',
    kind: 'connector',
    name: 'Slack',
    status: 'needs-auth',
    scope: 'account',
    source: 'claude.ai',
    envs: [
      { env: 'claude', scope: 'account', status: 'configured', evidence: 'account' },
      { env: 'claude-code', scope: 'account', status: 'needs-auth', evidence: 'claude mcp list' },
    ],
  }),
  tool({ id: 'skill:agents-skills:antislop', kind: 'skill', name: 'antislop', status: 'enabled', source: 'agents-skills', inCatalog: false, envs: [{ env: 'codex', scope: 'user', status: 'discovered', evidence: 'dir' }, { env: 'gemini', scope: 'user', status: 'enabled', evidence: 'gemini skills list' }] }),
];

describe('normalize', () => {
  it('folds Arabic letter variants and diacritics', () => {
    expect(normalize('إضافَة')).toBe(normalize('اضافه'));
    expect(normalize('مُعدّ')).toBe('معد');
    expect(normalize('  Sales   PLUGIN ')).toBe('sales plugin');
  });
});

describe('tabs and search', () => {
  const plugins = { ...EMPTY_FILTERS };
  const skills = { ...EMPTY_FILTERS, kind: 'skill' as const };
  const mcp = { ...EMPTY_FILTERS, kind: 'connector' as const };

  it('each tab lists only its own kind, and commands are never a row', () => {
    expect(applyFilters(tools, plugins).map((t) => t.id)).toEqual(['plugin:sales']);
    expect(applyFilters(tools, skills).map((t) => t.id)).toEqual(['skill:sales:call-prep', 'skill:agents-skills:antislop']);
    expect(applyFilters(tools, mcp).map((t) => t.id)).toEqual(['connector:claude.ai Slack']);
  });

  it('finds a plugin by one of its commands, by identifier and by function', () => {
    expect(applyFilters(tools, { ...plugins, query: 'forecast' }).map((t) => t.id)).toEqual(['plugin:sales']);
    expect(applyFilters(tools, { ...plugins, query: 'plugin:sales' }).map((t) => t.id)).toEqual(['plugin:sales']);
    expect(applyFilters(tools, { ...plugins, query: 'prospect' }).map((t) => t.id)).toEqual(['plugin:sales']);
  });

  it('finds tools by Arabic title, tab name and status', () => {
    expect(matchesQuery(tools[0]!, 'المبيعات')).toBe(true);
    expect(applyFilters(tools, { ...mcp, query: 'mcp' }).map((t) => t.id)).toEqual(['connector:claude.ai Slack']);
    expect(applyFilters(tools, { ...mcp, query: 'يتطلب مصادقه' }).map((t) => t.id)).toEqual(['connector:claude.ai Slack']);
  });

  it('lists my tools first and catalog matches of the same tab after them', () => {
    const groups = searchGroups(tools, { ...plugins, query: 'إضافة' });
    expect(groups.mine.map((t) => t.id)).toEqual(['plugin:sales']);
    expect(groups.catalog.map((t) => t.id)).toEqual(['plugin:figma']);
    expect(searchGroups(tools, plugins).catalog).toEqual([]);
  });
});

describe('counts per tab and platform', () => {
  it('counts each tab for the chosen platform, and separates the total from the filtered count', () => {
    expect(tabCounts(tools, EMPTY_FILTERS)).toEqual([
      { kind: 'plugin', total: 1, shown: 1 },
      { kind: 'skill', total: 2, shown: 2 },
      { kind: 'connector', total: 1, shown: 1 },
    ]);
    expect(tabCounts(tools, { ...EMPTY_FILTERS, env: 'codex' })).toEqual([
      { kind: 'plugin', total: 0, shown: 0 },
      { kind: 'skill', total: 1, shown: 1 },
      { kind: 'connector', total: 0, shown: 0 },
    ]);
    const searched = tabCounts(tools, { ...EMPTY_FILTERS, kind: 'skill', query: 'antislop' });
    expect(searched.find((t) => t.kind === 'skill')).toEqual({ kind: 'skill', total: 2, shown: 1 });
    expect(searched.find((t) => t.kind === 'plugin')).toEqual({ kind: 'plugin', total: 1, shown: 0 });
  });

  it('a status filter narrows only the open tab', () => {
    const counts = tabCounts(tools, { ...EMPTY_FILTERS, kind: 'skill', status: 'discovered', env: 'codex' });
    expect(counts.find((t) => t.kind === 'skill')).toEqual({ kind: 'skill', total: 1, shown: 1 });
    expect(tabCounts(tools, { ...EMPTY_FILTERS, kind: 'skill', status: 'disabled' }).find((t) => t.kind === 'skill')?.shown).toBe(0);
    expect(tabCounts(tools, { ...EMPTY_FILTERS, kind: 'skill', status: 'disabled' }).find((t) => t.kind === 'plugin')?.shown).toBe(1);
  });

  it('the catalog covers Claude as well as Claude Code', () => {
    expect(tabCounts(tools, { ...EMPTY_FILTERS, view: 'catalog', env: 'claude' })[0]).toEqual({ kind: 'plugin', total: 1, shown: 1 });
    expect(tabCounts(tools, { ...EMPTY_FILTERS, view: 'catalog', env: 'gemini' })[0]).toEqual({ kind: 'plugin', total: 0, shown: 0 });
  });

  it('reads status per platform', () => {
    const slack = tools[4]!;
    expect(statusIn(slack, 'all')).toBe('needs-auth');
    expect(statusIn(slack, 'claude')).toBe('configured');
    expect(statusCounts(tools, { ...EMPTY_FILTERS, kind: 'skill', env: 'codex' })).toEqual([{ status: 'discovered', count: 1 }]);
    expect(statusCounts(tools, { ...EMPTY_FILTERS, kind: 'skill', env: 'gemini' })).toEqual([{ status: 'enabled', count: 1 }]);
  });

  it('sorts by name in both directions without mutating the input', () => {
    const asc = sortTools(tools, { key: 'name', dir: 'asc' }).map((t) => t.name);
    expect(asc).toEqual(['antislop', 'call-prep', 'figma', 'forecast', 'sales', 'Slack']);
    expect(sortTools(tools, { key: 'name', dir: 'desc' }).map((t) => t.name)).toEqual([...asc].reverse());
    expect(tools[0]?.name).toBe('sales');
  });
});

describe('merging identical tools across platforms', () => {
  const skill = (id: string, source: string, env: Tool['envs'][number]['env'], fingerprint: string, status: Tool['status'] = 'discovered') =>
    tool({ id, kind: 'skill', name: 'antislop', status, source, inCatalog: false, fingerprint, location: `/${source}/antislop/SKILL.md`, envs: [{ env, scope: 'user', status, evidence: source }] });

  it('folds copies with the same content into one record with every platform', () => {
    const merged = mergeIdentical([skill('skill:user-skills:antislop', 'user-skills', 'claude-code', 'aaa'), skill('skill:agents-skills:antislop', 'agents-skills', 'codex', 'aaa'), skill('skill:gemini-skills:antislop', 'gemini-skills', 'gemini', 'aaa', 'enabled')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('skill:user-skills:antislop');
    expect(merged[0]?.envs.map((p) => p.env)).toEqual(['claude-code', 'codex', 'gemini']);
    expect(merged[0]?.status).toBe('enabled');
    expect(merged[0]?.copies?.map((c) => c.source)).toEqual(['agents-skills', 'gemini-skills']);
  });

  it('keeps same-named tools apart when their content differs', () => {
    const merged = mergeIdentical([skill('skill:user-skills:antislop', 'user-skills', 'claude-code', 'aaa'), skill('skill:agents-skills:antislop', 'agents-skills', 'codex', 'bbb')]);
    expect(merged.map((t) => t.id)).toEqual(['skill:user-skills:antislop', 'skill:agents-skills:antislop']);
  });

  it('never merges catalog entries, plugin children or tools without a fingerprint', () => {
    const child = { ...skill('skill:sales:x', 'synced', 'claude-code', 'aaa'), parentId: 'plugin:sales' };
    const plain = { ...skill('skill:a:x', 'a', 'codex', 'aaa'), fingerprint: undefined };
    expect(mergeIdentical([skill('skill:user-skills:antislop', 'user-skills', 'claude-code', 'aaa'), child, plain])).toHaveLength(3);
  });
});

describe('finding a CLI outside PATH', () => {
  const files = new Set(['/opt/homebrew/bin', '/opt/homebrew/bin/codex', '/Users/me/.nvm/versions/node/v22.1.0/bin', '/Users/me/.nvm/versions/node/v22.1.0/bin/gemini', '/usr/local/bin']);
  const probe: PathProbe = {
    exists: (path) => files.has(path.replace(/\\/g, '/')),
    list: (path) => (path.replace(/\\/g, '/') === '/Users/me/.nvm/versions/node' ? ['v22.1.0'] : []),
  };
  const env = { PATH: '/usr/bin:/bin' };

  it('looks in the usual install folders, including one per Node version', () => {
    const dirs = candidateDirs('/Users/me', 'darwin', env, probe).map((d) => d.replace(/\\/g, '/'));
    expect(dirs).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/Users/me/.nvm/versions/node/v22.1.0/bin']);
  });

  it('reports the folder that holds the command, or null', () => {
    expect(findOutsidePath('codex', '/Users/me', 'darwin', env, probe)?.replace(/\\/g, '/')).toBe('/opt/homebrew/bin');
    expect(findOutsidePath('gemini', '/Users/me', 'darwin', env, probe)?.replace(/\\/g, '/')).toBe('/Users/me/.nvm/versions/node/v22.1.0/bin');
    expect(findOutsidePath('agy', '/Users/me', 'darwin', env, probe)).toBeNull();
  });

  it('adds folders to this process only, once', () => {
    const target: NodeJS.ProcessEnv = { PATH: ['one', 'two'].join(process.platform === 'win32' ? ';' : ':') };
    expect(addToPath(['two', 'three'], target)).toEqual(['three']);
    expect(target.PATH?.split(process.platform === 'win32' ? ';' : ':')).toEqual(['one', 'two', 'three']);
    expect(addToPath(['three'], target)).toEqual([]);
  });
});

describe('alternatives', () => {
  const mine: Tool[] = [
    tool({ id: 'connector:claude.ai Notion', kind: 'connector', name: 'Notion', status: 'connected', source: 'claude.ai' }),
    tool({ id: 'connector:plugin:x:gmail', kind: 'connector', name: 'gmail', status: 'not-configured' }),
    tool({ id: 'plugin:engineering', kind: 'plugin', name: 'engineering', category: 'engineering', status: 'enabled', description: 'Code review, incident response and architecture decisions.' }),
    tool({ id: 'skill:user-skills:antislop', kind: 'skill', name: 'antislop', status: 'discovered', source: 'user-skills' }),
    tool({ id: 'plugin:sales', kind: 'plugin', name: 'sales', category: 'sales', status: 'enabled', description: 'Prospecting and call prep.' }),
  ];

  it('suggests my connector for the same service', () => {
    const target = tool({ id: 'connector:plugin:engineering:notion', kind: 'connector', name: 'notion', status: 'available', mine: false, parentId: 'plugin:engineering-x' });
    const found = findAlternatives(target, mine);
    expect(found.map((a) => a.tool.id)).toEqual(['connector:claude.ai Notion']);
    expect(found[0]?.reason).toContain('الخدمة نفسها');
  });

  it('never suggests a placeholder or an unverified tool', () => {
    const target = tool({ id: 'connector:plugin:y:gmail', kind: 'connector', name: 'gmail', status: 'available', mine: false });
    expect(findAlternatives(target, mine)).toEqual([]);
  });

  it('suggests a same-named skill from another source when it was not merged', () => {
    const target = tool({ id: 'skill:agents-skills:antislop', kind: 'skill', name: 'antislop', status: 'discovered', source: 'agents-skills' });
    expect(findAlternatives(target, [...mine, target]).map((a) => a.tool.id)).toEqual(['skill:user-skills:antislop']);
  });

  it('needs a clear shared function, not just a shared category', () => {
    const related = tool({ id: 'plugin:qodo', kind: 'plugin', name: 'qodo', category: 'engineering', status: 'available', mine: false, description: 'Automated code review for pull requests with architecture checks.' });
    expect(findAlternatives(related, mine).map((a) => a.tool.id)).toEqual(['plugin:engineering']);
    const unrelated = tool({ id: 'plugin:render', kind: 'plugin', name: 'render', category: 'engineering', status: 'available', mine: false, description: 'Deploy web services and databases.' });
    expect(findAlternatives(unrelated, mine)).toEqual([]);
  });

  it('does not suggest a tool from the same plugin family', () => {
    const child = tool({ id: 'skill:engineering:code-review', kind: 'skill', name: 'code-review', category: 'engineering', status: 'enabled', parentId: 'plugin:engineering', description: 'Code review for architecture decisions.' });
    const sibling = tool({ id: 'skill:engineering:architecture', kind: 'skill', name: 'architecture', category: 'engineering', status: 'enabled', parentId: 'plugin:engineering', description: 'Architecture decisions and code review.' });
    expect(findAlternatives(child, [...mine, sibling])).toEqual([]);
  });
});
