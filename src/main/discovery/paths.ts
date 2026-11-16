import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface PathProbe {
  exists(path: string): boolean;
  list(path: string): string[];
}

const realProbe: PathProbe = {
  exists: existsSync,
  list: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

/**
 * Folders where the platform CLIs are commonly installed. An app started from
 * Finder or the Start menu may not have them on PATH even though a terminal does.
 */
export function candidateDirs(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, probe: PathProbe = realProbe): string[] {
  const dirs: string[] = [];
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) {
      dirs.push(join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'), join(env.LOCALAPPDATA, 'agy', 'bin'), join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    }
    dirs.push(join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'), join(home, '.codex', 'bin'), join(home, '.claude', 'local'), join(home, '.antigravity', 'bin'));
    // nvm and fnm keep one bin folder per Node version.
    for (const base of [join(home, '.nvm', 'versions', 'node'), join(home, '.local', 'share', 'fnm', 'node-versions'), join(home, 'Library', 'Application Support', 'fnm', 'node-versions')]) {
      for (const version of probe.list(base)) {
        dirs.push(join(base, version, 'bin'), join(base, version, 'installation', 'bin'));
      }
    }
  }
  return [...new Set(dirs)].filter((dir) => probe.exists(dir));
}

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, `${name}.ps1`, `${name}.bat`] : [name];
}

/** First known folder outside PATH that holds the command, or null. */
export function findOutsidePath(name: string, home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, probe: PathProbe = realProbe): string | null {
  const onPath = new Set((env.PATH ?? env.Path ?? '').split(delimiter).map((dir) => dir.toLowerCase()));
  for (const dir of candidateDirs(home, platform, env, probe)) {
    if (onPath.has(dir.toLowerCase())) continue;
    if (executableNames(name, platform).some((file) => probe.exists(join(dir, file)))) return dir;
  }
  return null;
}

/**
 * Adds folders to this process's PATH only. Shell profile files are never
 * touched, and the change ends when the app closes.
 */
export function addToPath(dirs: string[], env: NodeJS.ProcessEnv): string[] {
  const key = env.PATH !== undefined || env.Path === undefined ? 'PATH' : 'Path';
  const current = (env[key] ?? '').split(delimiter).filter(Boolean);
  const known = new Set(current.map((dir) => dir.toLowerCase()));
  const added = dirs.filter((dir) => !known.has(dir.toLowerCase()));
  if (added.length > 0) env[key] = [...current, ...added].join(delimiter);
  return added;
}
