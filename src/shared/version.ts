export type UpdateChannel = 'stable' | 'dev';

export interface ReleaseInfo {
  tag: string;
  prerelease: boolean;
  draft: boolean;
  url: string;
  assets: Array<{ name: string; url: string; size: number; digest?: string }>;
}

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

export function parseVersion(text: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(text.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/** Semantic version order: 0.3.0-dev.2 < 0.3.0-dev.10 < 0.3.0 < 0.3.1-dev.1. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  // A release outranks its own pre-releases.
  if (left.pre.length === 0 || right.pre.length === 0) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const diff = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.pre.length ?? 0) > 0;
}

/**
 * Newest release the channel allows that is newer than the running version.
 * The stable channel never moves to a pre-release.
 */
export function pickUpdate(current: string, releases: ReleaseInfo[], channel: UpdateChannel): ReleaseInfo | null {
  const candidates = releases
    .filter((release) => !release.draft && parseVersion(release.tag) !== null)
    .filter((release) => channel === 'dev' || (!release.prerelease && !isPrerelease(release.tag)))
    .filter((release) => compareVersions(release.tag, current) > 0)
    .sort((a, b) => compareVersions(b.tag, a.tag));
  return candidates[0] ?? null;
}
