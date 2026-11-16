import { describe, expect, it } from 'vitest';
import { findAlternatives } from '../../src/shared/alternatives';
import { EMPTY_FILTERS, applyFilters, matchesQuery, normalize, searchGroups, sortTools, statusIn, summarize } from '../../src/shared/query';
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
  tool({ id: 'plugin:sales', kind: 'plugin', name: 'sales', title: 'المبيعات', category: 'sales', status: 'enabled', description: 'Prospect and prep calls.' }),
  tool({ id: 'plugin:figma', kind: 'plugin', name: 'figma', category: 'design', status: 'available', scope: 'catalog', mine: false, ar: { summary: 'إضافة Figma ضمن فئة التصميم.', when: '', example: '', generic: true } }),
  tool({ id: 'skill:sales:call-prep', kind: 'skill', name: 'call-prep', category: 'sales', status: 'enabled', parentId: 'plugin:sales' }),
  tool({ id: 'command:sales:forecast', kind: 'command', name: 'forecast', category: 'sales', status: 'enabled', parentId: 'plugin:sales' }),
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
  tool({ id: 'skill:agents-skills:antislop', kind: 'skill', name: 'antislop', status: 'discovered', source: 'agents-skills', inCatalog: false, envs: [{ env: 'codex', scope: 'user', status: 'discovered', evidence: 'dir' }, { env: 'gemini', scope: 'user', status: 'enabled', evidence: 'gemini skills list' }] }),
];

describe('normalize', () => {
  it('folds Arabic letter variants and diacritics', () => {
    expect(normalize('إضافَة')).toBe(normalize('اضافه'));
    expect(normalize('مُعدّ')).toBe('معد');
    expect(normalize('  Sales   PLUGIN ')).toBe('sales plugin');
  });
});

describe('search', () => {
  const all = { ...EMPTY_FILTERS };

  it('finds my tools by English name, description and environment', () => {
    expect(applyFilters(tools, { ...all, query: 'prospect' }).map((t) => t.id)).toEqual(['plugin:sales']);
    expect(applyFilters(tools, { ...all, query: 'codex' }).map((t) => t.id)).toEqual(['skill:agents-skills:antislop']);
  });

  it('finds tools by Arabic title, kind and status', () => {
    expect(matchesQuery(tools[0]!, 'المبيعات')).toBe(true);
    expect(applyFilters(tools, { ...all, query: 'موصل' }).map((t) => t.id)).toEqual(['connector:claude.ai Slack']);
    expect(applyFilters(tools, { ...all, query: 'يتطلب مصادقه' }).map((t) => t.id)).toEqual(['connector:claude.ai Slack']);
  });

  it('lists my tools first and catalog matches after them', () => {
    const groups = searchGroups(tools, { ...all, query: 'إضافة' });
    expect(groups.mine.map((t) => t.id)).toEqual(['plugin:sales']);
    expect(groups.catalog.map((t) => t.id)).toEqual(['plugin:figma']);
  });

  it('keeps the catalog out of the home screen when there is no query', () => {
    expect(searchGroups(tools, all).catalog).toEqual([]);
    expect(searchGroups(tools, { ...all, view: 'catalog' }).catalog.map((t) => t.id)).toEqual(['plugin:figma']);
  });
});

describe('environments, kinds and counts', () => {
  it('filters by environment and reads the status of that environment', () => {
    const slack = tools[4]!;
    expect(statusIn(slack, 'all')).toBe('needs-auth');
    expect(statusIn(slack, 'claude')).toBe('configured');
    expect(applyFilters(tools, { ...EMPTY_FILTERS, env: 'claude' }).map((t) => t.id)).toEqual(['connector:claude.ai Slack']);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, env: 'gemini', status: 'enabled' }).map((t) => t.id)).toEqual(['skill:agents-skills:antislop']);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, env: 'chatgpt' })).toEqual([]);
  });

  it('counts commands apart from skills', () => {
    const mine = tools.filter((t) => t.mine);
    const summary = summarize(mine, 'all');
    expect(summary.find((g) => g.kind === 'skill')?.total).toBe(2);
    expect(summary.find((g) => g.kind === 'command')?.total).toBe(1);
    expect(summary.find((g) => g.kind === 'plugin')?.statuses).toEqual([{ status: 'enabled', count: 1 }]);
  });

  it('counts by the status in the chosen environment', () => {
    const summary = summarize(tools.filter((t) => t.mine && t.envs.some((p) => p.env === 'codex')), 'codex');
    expect(summary.find((g) => g.kind === 'skill')?.statuses).toEqual([{ status: 'discovered', count: 1 }]);
  });

  it('sorts by name in both directions without mutating the input', () => {
    const asc = sortTools(tools, { key: 'name', dir: 'asc' }).map((t) => t.name);
    expect(asc).toEqual(['antislop', 'call-prep', 'figma', 'forecast', 'sales', 'Slack']);
    expect(sortTools(tools, { key: 'name', dir: 'desc' }).map((t) => t.name)).toEqual([...asc].reverse());
    expect(tools[0]?.name).toBe('sales');
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

  it('suggests the same skill found in another source', () => {
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
