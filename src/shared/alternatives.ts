import { categoryLabel, sourceLabel } from './labels';
import type { Tool } from './types';

export interface Alternative {
  tool: Tool;
  reason: string;
}

const STOP = new Set(
  'with that this from your into when using used uses user users tool tools skill skills plugin plugins claude code agent agents across them their they have will work works data files file make build help helps more than also such each only over what where which while about based before after through other others every need needs like just then into onto create creates creating manage manages managing guide guidance best practices support supports provides provide including include includes'.split(
    ' ',
  ),
);

/** Words that say what a tool is for. Short and generic words are dropped. */
export function functionTokens(tool: Tool): Set<string> {
  const words = `${tool.name} ${tool.description}`.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
  return new Set(words.filter((word) => !STOP.has(word)));
}

function serviceKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const USABLE = new Set(['connected', 'enabled', 'installed', 'discovered', 'configured', 'needs-auth', 'disabled']);
const SPECIFIC = (category: string) => category !== 'other' && category !== 'personal';

function sameFamily(a: Tool, b: Tool): boolean {
  return a.id === b.id || a.parentId === b.id || b.parentId === a.id || (a.parentId !== undefined && a.parentId === b.parentId);
}

/**
 * Suggests up to `max` of the user's own tools that clearly cover the same
 * need. A suggestion is made only on strong evidence: the same service, the
 * same name from another source, or the same category with shared key words.
 */
export function findAlternatives(target: Tool, tools: Tool[], max = 2): Alternative[] {
  const targetTokens = functionTokens(target);
  const targetNameTokens = new Set(target.name.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []);
  const scored: Array<Alternative & { score: number }> = [];

  for (const tool of tools) {
    if (!tool.mine || !USABLE.has(tool.status) || sameFamily(target, tool)) continue;
    const bothConnectors = target.kind === 'connector' && tool.kind === 'connector';
    const bothPlugins = target.kind === 'plugin' && tool.kind === 'plugin';
    const bothSkills = (target.kind === 'skill' || target.kind === 'command') && (tool.kind === 'skill' || tool.kind === 'command');
    if (!bothConnectors && !bothPlugins && !bothSkills) continue;

    if (bothConnectors) {
      if (serviceKey(tool.name) !== serviceKey(target.name)) continue;
      scored.push({ tool, score: tool.status === 'connected' ? 100 : 90, reason: `يتصل بالخدمة نفسها (${tool.name})` });
      continue;
    }

    if (tool.name.toLowerCase() === target.name.toLowerCase()) {
      scored.push({ tool, score: 80, reason: `الاسم نفسه من مصدر آخر: ${sourceLabel(tool.source)}` });
      continue;
    }

    const shared = [...functionTokens(tool)].filter((token) => targetTokens.has(token));
    const sharedInName = shared.filter((token) => targetNameTokens.has(token) || tool.name.toLowerCase().includes(token));
    const sameCategory = tool.category === target.category && SPECIFIC(tool.category);
    // Clear overlap: two function words inside the same specific category, or five anywhere.
    const clear = (sameCategory && shared.length >= 2) || shared.length >= 5;
    if (!clear) continue;
    const words = (sharedInName.length > 0 ? sharedInName : shared).slice(0, 3).join('، ');
    scored.push({
      tool,
      score: shared.length + (sameCategory ? 3 : 0) + sharedInName.length * 2,
      reason: sameCategory ? `الفئة نفسها (${categoryLabel(tool.category)}) ووظيفة مشتركة: ${words}` : `وظيفة مشتركة: ${words}`,
    });
  }

  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .filter(({ tool }) => {
      const key = `${tool.kind}:${tool.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max)
    .map(({ tool, reason }) => ({ tool, reason }));
}
