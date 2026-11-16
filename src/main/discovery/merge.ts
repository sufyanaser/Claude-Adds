import { STATUS_ORDER } from '../../shared/labels';
import type { EnvPlacement, Tool } from '../../shared/types';

const stronger = (a: EnvPlacement, b: EnvPlacement) => (STATUS_ORDER.indexOf(a.status) <= STATUS_ORDER.indexOf(b.status) ? a : b);

/**
 * Folds records that are provably the same tool into one. Proof is strict:
 * the same kind and name, and the same fingerprint (identical SKILL.md text
 * for a skill, identical endpoint for a connector). A shared name alone is
 * never enough, so look-alikes from different sources stay separate.
 */
export function mergeIdentical(tools: Tool[]): Tool[] {
  const firstByKey = new Map<string, Tool>();
  const merged: Tool[] = [];
  for (const tool of tools) {
    const mergeable = tool.mine && !tool.parentId && Boolean(tool.fingerprint) && (tool.kind === 'skill' || tool.kind === 'connector');
    if (!mergeable) {
      merged.push(tool);
      continue;
    }
    const key = `${tool.kind}|${tool.name.toLowerCase()}|${tool.fingerprint}`;
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, tool);
      merged.push(tool);
      continue;
    }
    for (const placement of tool.envs) {
      const index = first.envs.findIndex((existing) => existing.env === placement.env && existing.scope === placement.scope);
      if (index < 0) first.envs.push(placement);
      else first.envs[index] = stronger(first.envs[index] as EnvPlacement, placement);
    }
    first.copies = [...(first.copies ?? []), { source: tool.source, location: tool.location ?? '' }];
    first.status = first.envs.reduce(stronger).status;
  }
  return merged;
}
