import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Reading<T> {
  data: T | null;
  /** When `data` was read successfully. */
  at: string | null;
  /** True when `data` comes from an earlier run because this one failed. */
  stale: boolean;
}

/**
 * Remembers the last successful reading of each source, so a failed refresh
 * can still show what was true before, with its date. Only already-redacted,
 * parsed results are stored here.
 */
export class LastGood {
  private entries: Record<string, { at: string; data: unknown }> = {};

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.entries = JSON.parse(await readFile(this.file, 'utf8')) as typeof this.entries;
    } catch {
      this.entries = {};
    }
  }

  use<T>(key: string, fresh: T | null, now: string): Reading<T> {
    if (fresh !== null) {
      this.entries[key] = { at: now, data: fresh };
      return { data: fresh, at: now, stale: false };
    }
    const kept = this.entries[key];
    return kept ? { data: kept.data as T, at: kept.at, stale: true } : { data: null, at: null, stale: false };
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.entries), 'utf8');
  }
}

export function staleNote(source: string, stale: boolean): string {
  return stale ? `${source} (آخر نتيجة ناجحة)` : source;
}
