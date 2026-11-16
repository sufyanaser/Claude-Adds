import { KIND_LABEL, SCOPE_LABEL, STATUS_LABEL, STATUS_ORDER, categoryLabel, envLabel, sourceLabel } from './labels';
import type { EnvId, Tool, ToolKind, ToolScope, ToolStatus } from './types';

export interface Filters {
  /** 'mine' lists what exists here; 'catalog' lists what can be added. */
  view: 'mine' | 'catalog';
  env: EnvId | 'all';
  kind: ToolKind | 'all';
  status: ToolStatus | 'all';
  category: string;
  source: string;
  scope: ToolScope | 'all';
  query: string;
}

export type SortKey = 'name' | 'type' | 'status' | 'scope';

export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const EMPTY_FILTERS: Filters = {
  view: 'mine',
  env: 'all',
  kind: 'all',
  status: 'all',
  category: 'all',
  source: 'all',
  scope: 'all',
  query: '',
};

/**
 * Folds case, Arabic diacritics, tatweel and the common letter variants so
 * "إضافة", "اضافه" and "أضافة" all match each other.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

const haystacks = new WeakMap<Tool, string>();

export function haystack(tool: Tool): string {
  let value = haystacks.get(tool);
  if (value === undefined) {
    value = normalize(
      [
        tool.name,
        tool.title,
        tool.description,
        tool.ar.summary,
        tool.ar.when,
        KIND_LABEL[tool.kind],
        categoryLabel(tool.category),
        tool.category,
        STATUS_LABEL[tool.status],
        SCOPE_LABEL[tool.scope],
        sourceLabel(tool.source),
        tool.source,
        ...tool.envs.map((placement) => envLabel(placement.env)),
      ].join(' '),
    );
    haystacks.set(tool, value);
  }
  return value;
}

export function matchesQuery(tool: Tool, query: string): boolean {
  const terms = normalize(query).split(' ').filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(tool);
  return terms.every((term) => text.includes(term));
}

/** Status of a tool in one environment, or its overall status when no environment is chosen. */
export function statusIn(tool: Tool, env: EnvId | 'all'): ToolStatus {
  if (env === 'all') return tool.status;
  const placements = tool.envs.filter((placement) => placement.env === env);
  if (placements.length === 0) return tool.status;
  return placements.reduce((best, placement) =>
    STATUS_ORDER.indexOf(placement.status) < STATUS_ORDER.indexOf(best.status) ? placement : best,
  ).status;
}

function matchesFacets(tool: Tool, filters: Filters): boolean {
  return (
    (filters.env === 'all' || tool.envs.some((placement) => placement.env === filters.env)) &&
    (filters.kind === 'all' || tool.kind === filters.kind) &&
    (filters.status === 'all' || statusIn(tool, filters.env) === filters.status) &&
    (filters.category === 'all' || tool.category === filters.category) &&
    (filters.source === 'all' || tool.source === filters.source) &&
    (filters.scope === 'all' || tool.scope === filters.scope) &&
    matchesQuery(tool, filters.query)
  );
}

export function applyFilters(tools: Tool[], filters: Filters): Tool[] {
  const mine = filters.view === 'mine';
  return tools.filter((tool) => tool.mine === mine && matchesFacets(tool, filters));
}

/**
 * Search results for the home screen: what the user already has first, then
 * matching catalog entries. Without a query the catalog stays out of the way.
 */
export function searchGroups(tools: Tool[], filters: Filters): { mine: Tool[]; catalog: Tool[] } {
  if (filters.view === 'catalog') return { mine: [], catalog: applyFilters(tools, filters) };
  const mine = applyFilters(tools, filters);
  const catalog = filters.query.trim() ? applyFilters(tools, { ...filters, view: 'catalog', status: 'all', scope: 'all', source: 'all' }) : [];
  return { mine, catalog };
}

function sortValue(tool: Tool, key: SortKey, env: EnvId | 'all'): string {
  switch (key) {
    case 'name':
      return tool.name.toLowerCase();
    case 'type':
      return `${KIND_LABEL[tool.kind]} ${categoryLabel(tool.category)}`;
    case 'status':
      return String(STATUS_ORDER.indexOf(statusIn(tool, env))).padStart(2, '0');
    case 'scope':
      return `${SCOPE_LABEL[tool.scope]} ${sourceLabel(tool.source)}`;
  }
}

export function sortTools(tools: Tool[], sort: Sort, env: EnvId | 'all' = 'all'): Tool[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...tools].sort((a, b) => {
    const primary = sortValue(a, sort.key, env).localeCompare(sortValue(b, sort.key, env), 'ar');
    if (primary !== 0) return primary * factor;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/** Counts per kind and status for the tools given, in display order. */
export function summarize(tools: Tool[], env: EnvId | 'all'): Array<{ kind: ToolKind; total: number; statuses: Array<{ status: ToolStatus; count: number }> }> {
  const kinds: ToolKind[] = ['plugin', 'skill', 'command', 'connector'];
  return kinds.map((kind) => {
    const counts = new Map<ToolStatus, number>();
    let total = 0;
    for (const tool of tools) {
      if (tool.kind !== kind) continue;
      const status = statusIn(tool, env);
      counts.set(status, (counts.get(status) ?? 0) + 1);
      total++;
    }
    return {
      kind,
      total,
      statuses: STATUS_ORDER.filter((status) => counts.has(status)).map((status) => ({ status, count: counts.get(status) ?? 0 })),
    };
  });
}
