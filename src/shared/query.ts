import { KIND_LABEL, SCOPE_LABEL, STATUS_LABEL, STATUS_ORDER, categoryLabel, sourceLabel } from './labels';
import type { Tool, ToolKind, ToolScope, ToolStatus } from './types';

export interface Filters {
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

export function applyFilters(tools: Tool[], filters: Filters): Tool[] {
  return tools.filter(
    (tool) =>
      (filters.kind === 'all' || tool.kind === filters.kind) &&
      (filters.status === 'all' || tool.status === filters.status) &&
      (filters.category === 'all' || tool.category === filters.category) &&
      (filters.source === 'all' || tool.source === filters.source) &&
      (filters.scope === 'all' || tool.scope === filters.scope) &&
      matchesQuery(tool, filters.query),
  );
}

function sortValue(tool: Tool, key: SortKey): string {
  switch (key) {
    case 'name':
      return tool.name.toLowerCase();
    case 'type':
      return `${KIND_LABEL[tool.kind]} ${categoryLabel(tool.category)}`;
    case 'status':
      return String(STATUS_ORDER.indexOf(tool.status)).padStart(2, '0');
    case 'scope':
      return `${SCOPE_LABEL[tool.scope]} ${sourceLabel(tool.source)}`;
  }
}

export function sortTools(tools: Tool[], sort: Sort): Tool[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...tools].sort((a, b) => {
    const primary = sortValue(a, sort.key).localeCompare(sortValue(b, sort.key), 'ar');
    if (primary !== 0) return primary * factor;
    return a.name.localeCompare(b.name);
  });
}

export function countByStatus(tools: Tool[], kind: ToolKind): Array<{ status: ToolStatus; count: number }> {
  const counts = new Map<ToolStatus, number>();
  for (const tool of tools) {
    if (tool.kind === kind) counts.set(tool.status, (counts.get(tool.status) ?? 0) + 1);
  }
  return STATUS_ORDER.filter((status) => counts.has(status)).map((status) => ({
    status,
    count: counts.get(status) ?? 0,
  }));
}
