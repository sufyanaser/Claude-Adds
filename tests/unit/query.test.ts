import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, applyFilters, countByStatus, matchesQuery, normalize, sortTools } from '../../src/shared/query';
import type { Tool } from '../../src/shared/types';

function tool(partial: Partial<Tool> & Pick<Tool, 'id' | 'kind' | 'name' | 'status'>): Tool {
  return {
    title: partial.name,
    category: 'other',
    scope: 'user',
    source: 'knowledge-work-plugins',
    inCatalog: true,
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
  tool({ id: 'plugin:figma', kind: 'plugin', name: 'figma', category: 'design', status: 'available', scope: 'catalog', ar: { summary: 'إضافة Figma ضمن فئة التصميم.', when: '', example: '', generic: true } }),
  tool({ id: 'skill:sales:call-prep', kind: 'skill', name: 'call-prep', category: 'sales', status: 'enabled', parentId: 'plugin:sales' }),
  tool({ id: 'connector:slack', kind: 'connector', name: 'slack', status: 'needs-auth', scope: 'account', source: 'claude.ai' }),
];

describe('normalize', () => {
  it('folds Arabic letter variants and diacritics', () => {
    expect(normalize('إضافَة')).toBe(normalize('اضافه'));
    expect(normalize('مُعدّ')).toBe('معد');
    expect(normalize('  Sales   PLUGIN ')).toBe('sales plugin');
  });
});

describe('search', () => {
  it('finds tools by English name and description', () => {
    expect(applyFilters(tools, { ...EMPTY_FILTERS, query: 'prospect' }).map((t) => t.id)).toEqual(['plugin:sales']);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, query: 'FIGMA' }).map((t) => t.id)).toEqual(['plugin:figma']);
  });

  it('finds tools by Arabic title, category, kind and status', () => {
    expect(matchesQuery(tools[0]!, 'المبيعات')).toBe(true);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, query: 'التصميم' }).map((t) => t.id)).toEqual(['plugin:figma']);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, query: 'موصل' }).map((t) => t.id)).toEqual(['connector:slack']);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, query: 'يتطلب مصادقه' }).map((t) => t.id)).toEqual(['connector:slack']);
  });

  it('requires every term to match', () => {
    expect(applyFilters(tools, { ...EMPTY_FILTERS, query: 'sales مهارة' }).map((t) => t.id)).toEqual(['skill:sales:call-prep']);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, query: 'sales figma' })).toEqual([]);
  });
});

describe('filters and sorting', () => {
  it('combines kind, status, scope and source filters', () => {
    expect(applyFilters(tools, { ...EMPTY_FILTERS, kind: 'plugin', status: 'available' }).map((t) => t.id)).toEqual(['plugin:figma']);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, scope: 'account', source: 'claude.ai' }).map((t) => t.id)).toEqual(['connector:slack']);
    expect(applyFilters(tools, { ...EMPTY_FILTERS, category: 'sales' })).toHaveLength(2);
  });

  it('sorts by name in both directions without mutating the input', () => {
    const asc = sortTools(tools, { key: 'name', dir: 'asc' }).map((t) => t.name);
    expect(asc).toEqual(['call-prep', 'figma', 'sales', 'slack']);
    expect(sortTools(tools, { key: 'name', dir: 'desc' }).map((t) => t.name)).toEqual([...asc].reverse());
    expect(tools[0]?.name).toBe('sales');
  });

  it('counts statuses per kind for the overview', () => {
    expect(countByStatus(tools, 'plugin')).toEqual([
      { status: 'enabled', count: 1 },
      { status: 'available', count: 1 },
    ]);
    expect(countByStatus(tools, 'connector')).toEqual([{ status: 'needs-auth', count: 1 }]);
  });
});
