import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactCommand, redactUrl } from './redact';

export interface SkillFile {
  name: string;
  description: string;
  path: string;
}

export interface ServerDef {
  name: string;
  transport: 'http' | 'stdio' | 'none';
  /** Already redacted. */
  endpoint: string;
}

export interface PluginContents {
  skills: SkillFile[];
  commands: SkillFile[];
  servers: ServerDef[];
}

const MAX_DESCRIPTION = 600;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^"([\s\S]*)"$/.exec(trimmed) ?? /^'([\s\S]*)'$/.exec(trimmed);
  return quoted?.[1] ?? trimmed;
}

/** Reads `name` and `description` from a SKILL.md or command frontmatter block. */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!block?.[1]) return {};
  const lines = block[1].split(/\r?\n/);
  const result: { name?: string; description?: string } = {};

  for (let i = 0; i < lines.length; i++) {
    const match = /^(name|description):\s*(.*)$/.exec(lines[i] ?? '');
    if (!match) continue;
    const key = match[1] as 'name' | 'description';
    let value = match[2] ?? '';
    if (/^[>|][+-]?$/.test(value.trim())) value = '';
    const continuation: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) {
      continuation.push((lines[++i] ?? '').trim());
    }
    const full = unquote([value, ...continuation].filter(Boolean).join(' '));
    result[key] = full.length > MAX_DESCRIPTION ? `${full.slice(0, MAX_DESCRIPTION)}…` : full;
  }
  return result;
}

async function listDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Finds `<dir>/<name>/SKILL.md` entries. */
export async function scanSkills(dir: string): Promise<SkillFile[]> {
  const skills: SkillFile[] = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name, 'SKILL.md');
    try {
      const meta = parseFrontmatter(await readFile(path, 'utf8'));
      skills.push({ name: meta.name || entry.name, description: meta.description ?? '', path });
    } catch {
      // No SKILL.md in this folder.
    }
  }
  return skills;
}

async function scanCommands(dir: string): Promise<SkillFile[]> {
  const commands: SkillFile[] = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(dir, entry.name);
    try {
      const meta = parseFrontmatter(await readFile(path, 'utf8'));
      commands.push({ name: entry.name.replace(/\.md$/, ''), description: meta.description ?? '', path });
    } catch {
      // Unreadable command file.
    }
  }
  return commands;
}

/**
 * Reads server names and public endpoints from an MCP config object.
 * `env`, `headers` and `oauth` are never read.
 */
export function readServerDefs(config: unknown): ServerDef[] {
  const servers = (config as { mcpServers?: unknown })?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const defs: ServerDef[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const def = (raw ?? {}) as Record<string, unknown>;
    if (typeof def.url === 'string' && def.url) {
      defs.push({ name, transport: 'http', endpoint: redactUrl(def.url) });
    } else if (typeof def.command === 'string' && def.command) {
      const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [];
      defs.push({ name, transport: 'stdio', endpoint: redactCommand([def.command, ...args].join(' ')) });
    } else {
      defs.push({ name, transport: 'none', endpoint: '' });
    }
  }
  return defs;
}

export async function readServerFile(path: string): Promise<ServerDef[]> {
  try {
    return readServerDefs(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return [];
  }
}

export async function readPluginContents(root: string): Promise<PluginContents> {
  const [skills, commands, servers] = await Promise.all([
    scanSkills(join(root, 'skills')),
    scanCommands(join(root, 'commands')),
    readServerFile(join(root, '.mcp.json')),
  ]);
  const skillNames = new Set(skills.map((skill) => skill.name));
  return { skills, commands: commands.filter((command) => !skillNames.has(command.name)), servers };
}
