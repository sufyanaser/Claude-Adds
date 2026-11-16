import { KIND_LABEL, SCOPE_LABEL, STATUS_LABEL, STATUS_ORDER, TAB_KINDS, TAB_LABEL, categoryLabel, envLabel, sourceLabel } from './labels';
import type { EnvId, Tool, ToolScope, ToolStatus } from './types';

/** The three fixed tabs. Commands live inside their plugin and are found through it. */
export type TabKind = 'plugin' | 'skill' | 'connector';

export interface Filters {
  /** 'mine' lists what exists here; 'catalog' lists what can be added. */
  view: 'mine' | 'catalog';
  env: EnvId | 'all';
  kind: TabKind;
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
  kind: 'plugin',
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

/** Everything a tool can be found by: name, identifier, function, labels, and its commands. */
export function haystack(tool: Tool): string {
  let value = haystacks.get(tool);
  if (value === undefined) {
    value = normalize(
      [
        tool.name,
        tool.title,
        tool.id,
        tool.description,
        tool.ar.summary,
        tool.ar.when,
        tool.keywords ?? '',
        KIND_LABEL[tool.kind],
        tool.kind === 'command' ? '' : TAB_LABEL[tool.kind],
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

const inEnv = (tool: Tool, env: EnvId | 'all') => env === 'all' || tool.envs.some((placement) => placement.env === env);

function matchesFacets(tool: Tool, filters: Filters): boolean {
  return (
    tool.kind === filters.kind &&
    inEnv(tool, filters.env) &&
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
 * matching catalog entries of the same tab. Without a query the catalog stays out of the way.
 */
export function searchGroups(tools: Tool[], filters: Filters): { mine: Tool[]; catalog: Tool[] } {
  if (filters.view === 'catalog') return { mine: [], catalog: applyFilters(tools, filters) };
  const mine = applyFilters(tools, filters);
  const catalog = filters.query.trim() ? applyFilters(tools, { ...filters, view: 'catalog', status: 'all', scope: 'all', source: 'all' }) : [];
  return { mine, catalog };
}

export interface TabCount {
  kind: TabKind;
  /** Tools of this tab in the chosen view and platform, before search and filters. */
  total: number;
  /** Tools left after search and filters. */
  shown: number;
}

/** Counts for the three tabs. `total` and `shown` differ only when a search or filter is active. */
export function tabCounts(tools: Tool[], filters: Filters): TabCount[] {
  const mine = filters.view === 'mine';
  return TAB_KINDS.map((kind) => {
    const pool = tools.filter((tool) => tool.mine === mine && tool.kind === kind && inEnv(tool, filters.env));
    const same = kind === filters.kind;
    // Filters other than the search belong to the open tab only.
    const narrowed: Filters = same ? { ...filters, kind } : { ...EMPTY_FILTERS, view: filters.view, env: filters.env, query: filters.query, kind };
    return { kind, total: pool.length, shown: pool.filter((tool) => matchesFacets(tool, narrowed)).length };
  });
}

/** Status counts of the open tab in the chosen platform, in display order. */
export function statusCounts(tools: Tool[], filters: Filters): Array<{ status: ToolStatus; count: number }> {
  const mine = filters.view === 'mine';
  const counts = new Map<ToolStatus, number>();
  for (const tool of tools) {
    if (tool.mine !== mine || tool.kind !== filters.kind || !inEnv(tool, filters.env)) continue;
    const status = statusIn(tool, filters.env);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return STATUS_ORDER.filter((status) => counts.has(status)).map((status) => ({ status, count: counts.get(status) ?? 0 }));
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
