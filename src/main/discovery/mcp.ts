import type { ToolStatus } from '../../shared/types';
import { redactCommand, redactUrl } from './redact';

export interface McpEntry {
  /** Name exactly as the CLI prints it, used for `claude mcp get`. */
  rawName: string;
  origin: 'claude.ai' | 'plugin' | 'user';
  plugin?: string;
  server: string;
  transport: 'http' | 'stdio' | 'none';
  /** Already redacted. */
  endpoint: string;
  status: ToolStatus;
  detail: string;
}

function mapStatus(text: string): { status: ToolStatus; detail: string } {
  const detail = text.replace(/^[^\p{L}]+/u, '').trim();
  if (/needs authentication/i.test(text)) return { status: 'needs-auth', detail };
  if (/not configured/i.test(text)) return { status: 'not-configured', detail };
  if (/tools fetch failed/i.test(text)) return { status: 'unverified', detail };
  if (/failed|pending approval|disabled|error/i.test(text)) return { status: 'unverified', detail };
  if (/connected/i.test(text)) return { status: 'connected', detail };
  return { status: 'unverified', detail };
}

/**
 * Parses the text of `claude mcp list`. Each server line looks like
 * `<name>: <url or command> - <symbol> <status>`.
 */
export function parseMcpList(text: string): McpEntry[] {
  const entries: McpEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const nameEnd = line.indexOf(': ');
    const statusStart = line.lastIndexOf(' - ');
    // Log lines such as "[mcp-sdk] ..." are not servers.
    if (nameEnd <= 0 || statusStart < nameEnd || line.startsWith('[')) continue;

    const rawName = line.slice(0, nameEnd).trim();
    const target = line.slice(nameEnd + 2, statusStart).trim();
    const { status, detail } = mapStatus(line.slice(statusStart + 3));

    let origin: McpEntry['origin'] = 'user';
    let server = rawName;
    let plugin: string | undefined;
    if (rawName.startsWith('claude.ai ')) {
      origin = 'claude.ai';
      server = rawName.slice('claude.ai '.length);
    } else if (rawName.startsWith('plugin:')) {
      const parts = rawName.split(':');
      origin = 'plugin';
      plugin = parts[1];
      server = parts.slice(2).join(':');
    }

    const urlMatch = /^(https?:\/\/\S+)/i.exec(target);
    const transport: McpEntry['transport'] = urlMatch ? 'http' : target ? 'stdio' : 'none';
    const endpoint = urlMatch?.[1] ? redactUrl(urlMatch[1]) : target ? redactCommand(target) : '';

    entries.push({ rawName, origin, plugin, server, transport, endpoint, status, detail });
  }
  return entries;
}
