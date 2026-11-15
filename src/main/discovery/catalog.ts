import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CATALOG_REPO = 'anthropics/knowledge-work-plugins';
export const CATALOG_MARKETPLACE = 'knowledge-work-plugins';
export const DEFAULT_CATALOG_URL = `https://raw.githubusercontent.com/${CATALOG_REPO}/main/.claude-plugin/marketplace.json`;

export interface CatalogEntry {
  name: string;
  displayName: string;
  description: string;
  category: string;
  /** Path inside the catalog repo for plugins hosted there. */
  localPath?: string;
  docsUrl?: string;
  /** Where the plugin's files come from: the catalog repo or an external one. */
  origin: string;
}

export interface CatalogResult {
  entries: CatalogEntry[];
  /** When the data being shown was fetched successfully. */
  fetchedAt: string | null;
  fromCache: boolean;
  error?: string;
}

function httpsOnly(url: unknown): string | undefined {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : undefined;
}

function sourceDocs(source: unknown): { localPath?: string; docsUrl?: string } {
  if (typeof source === 'string') {
    const localPath = source.replace(/^\.\//, '').replace(/\/$/, '');
    return { localPath, docsUrl: `https://github.com/${CATALOG_REPO}/tree/main/${localPath}` };
  }
  if (source && typeof source === 'object') {
    const src = source as Record<string, unknown>;
    const repo = httpsOnly(src.url)?.replace(/\.git$/, '');
    if (!repo) return {};
    if (typeof src.path === 'string') {
      const ref = typeof src.ref === 'string' ? src.ref : 'main';
      return { docsUrl: `${repo}/tree/${ref}/${src.path}` };
    }
    return { docsUrl: repo };
  }
  return {};
}

export function parseCatalog(json: string): CatalogEntry[] {
  const data = JSON.parse(json) as { plugins?: unknown };
  if (!Array.isArray(data.plugins)) throw new Error('marketplace.json has no plugins array');
  const entries: CatalogEntry[] = [];
  for (const item of data.plugins as Array<Record<string, unknown>>) {
    if (typeof item?.name !== 'string') continue;
    const { localPath, docsUrl } = sourceDocs(item.source);
    entries.push({
      name: item.name,
      displayName: typeof item.displayName === 'string' ? item.displayName : item.name,
      description: typeof item.description === 'string' ? item.description : '',
      category: typeof item.category === 'string' ? item.category : '',
      localPath,
      docsUrl: httpsOnly(item.homepage) ?? docsUrl,
      origin: docsUrl ?? `https://github.com/${CATALOG_REPO}`,
    });
  }
  return entries;
}

interface CacheFile {
  fetchedAt: string;
  body: string;
}

export interface CatalogOptions {
  url: string;
  cacheFile: string;
  now: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Downloads the catalog. On any failure the last good copy stays in use and
 * keeps its own date, so the UI can show how old the data is.
 */
export async function loadCatalog(options: CatalogOptions): Promise<CatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let error: string;
  try {
    const response = await fetchImpl(options.url, { signal: AbortSignal.timeout(options.timeoutMs ?? 15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    const entries = parseCatalog(body);
    await mkdir(dirname(options.cacheFile), { recursive: true });
    await writeFile(options.cacheFile, JSON.stringify({ fetchedAt: options.now, body } satisfies CacheFile), 'utf8');
    return { entries, fetchedAt: options.now, fromCache: false };
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  try {
    const cached = JSON.parse(await readFile(options.cacheFile, 'utf8')) as CacheFile;
    return { entries: parseCatalog(cached.body), fetchedAt: cached.fetchedAt, fromCache: true, error };
  } catch {
    return { entries: [], fetchedAt: null, fromCache: false, error };
  }
}
