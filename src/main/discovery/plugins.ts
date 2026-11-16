import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolScope, ToolStatus } from '../../shared/types';

export interface InstalledPlugin {
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  scope: ToolScope;
  /** null when the source cannot tell whether the plugin is enabled. */
  enabled: boolean | null;
  installPath?: string;
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@');
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: '' };
}

export function mapScope(scope: unknown): ToolScope {
  switch (scope) {
    case 'user':
    case 'project':
    case 'local':
    case 'managed':
      return scope;
    case 'synced':
      return 'account';
    default:
      return 'unknown';
  }
}

/** Parses the output of `claude plugin list --json`. */
export function parsePluginList(json: string): InstalledPlugin[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('unexpected plugin list shape');
  const plugins: InstalledPlugin[] = [];
  for (const item of data as Array<Record<string, unknown>>) {
    if (typeof item?.id !== 'string') continue;
    plugins.push({
      id: item.id,
      ...splitId(item.id),
      version: typeof item.version === 'string' ? item.version : undefined,
      scope: mapScope(item.scope),
      enabled: typeof item.enabled === 'boolean' ? item.enabled : null,
      installPath: typeof item.installPath === 'string' ? item.installPath : undefined,
    });
  }
  return plugins;
}

/**
 * Fallback when the CLI is unavailable: reads the plugin registry and the
 * `enabledPlugins` key of the user settings. Only those two keys are touched.
 */
export async function readInstalledFromFiles(claudeDir: string): Promise<InstalledPlugin[]> {
  const registry = JSON.parse(
    await readFile(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'),
  ) as { plugins?: Record<string, Array<Record<string, unknown>>> };

  let enabledMap: Record<string, unknown> | null;
  try {
    const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8')) as {
      enabledPlugins?: Record<string, unknown>;
    };
    enabledMap = settings.enabledPlugins ?? {};
  } catch {
    enabledMap = null;
  }

  const plugins: InstalledPlugin[] = [];
  for (const [id, installs] of Object.entries(registry.plugins ?? {})) {
    const first = installs[0];
    if (!first) continue;
    const scope = mapScope(first.scope);
    plugins.push({
      id,
      ...splitId(id),
      version: typeof first.version === 'string' ? first.version : undefined,
      scope,
      // settings.json only records user-scope enablement.
      enabled: enabledMap && scope === 'user' ? enabledMap[id] === true : null,
      installPath: typeof first.installPath === 'string' ? first.installPath : undefined,
    });
  }
  return plugins;
}

/**
 * `hasFullList` is true when the installed list came from the CLI (now or from
 * the last good run). Only then does absence prove the plugin is not installed.
 */
export function pluginStatus(installed: InstalledPlugin | undefined, hasFullList: boolean): ToolStatus {
  if (!installed) return hasFullList ? 'available' : 'unverified';
  // Listed in the install registry, but nothing says whether it is switched on.
  if (installed.enabled === null) return 'installed';
  return installed.enabled ? 'enabled' : 'disabled';
}
