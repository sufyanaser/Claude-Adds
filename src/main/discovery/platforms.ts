import { join } from 'node:path';
import type { EnvId, EnvPlacement, PlatformCapability, PlatformInfo, SourceHealth, Tool, ToolKind, ToolStatus } from '../../shared/types';
import { connectorNotes } from './arabic';
import { onPath, runTool } from './cli';
import { scanSkills } from './contents';
import { type LastGood, type Reading, staleNote } from './lastgood';
import { redactCommand, redactUrl } from './redact';

// ---------- Documented locations ----------

export interface SkillDir {
  key: string;
  parts: string[];
  envs: EnvId[];
  evidence: string;
}

/** User-level skill folders and the platforms that read them, per their official docs. */
export const SKILL_DIRS: SkillDir[] = [
  { key: 'agents-skills', parts: ['.agents', 'skills'], envs: ['codex', 'gemini'], evidence: 'مسار موثّق لمهارات المستخدم في Codex وGemini CLI: ~/.agents/skills' },
  { key: 'codex-skills', parts: ['.codex', 'skills'], envs: ['codex'], evidence: 'مجلد ~/.codex/skills القديم، غير مذكور في وثائق Codex الحالية' },
  { key: 'gemini-skills', parts: ['.gemini', 'skills'], envs: ['gemini'], evidence: 'مسار موثّق لمهارات المستخدم في Gemini CLI: ~/.gemini/skills' },
  { key: 'antigravity-skills', parts: ['.gemini', 'config', 'skills'], envs: ['antigravity'], evidence: 'مسار موثّق للمهارات العامة في Antigravity: ~/.gemini/config/skills' },
  { key: 'antigravity-legacy-skills', parts: ['.gemini', 'antigravity', 'skills'], envs: ['antigravity'], evidence: 'مجلد ~/.gemini/antigravity/skills القديم' },
];

/** Where a user-level skill is installed for each platform that documents such a folder. */
export const SKILL_TARGET: Partial<Record<EnvId, { parts: string[]; display: string; evidence: string }>> = {
  codex: { parts: ['.agents', 'skills'], display: '~/.agents/skills', evidence: 'وثائق Codex: مهارات المستخدم تُقرأ من $HOME/.agents/skills' },
  gemini: { parts: ['.gemini', 'skills'], display: '~/.gemini/skills', evidence: 'وثائق Gemini CLI: مهارات المستخدم تُقرأ من ~/.gemini/skills' },
  antigravity: { parts: ['.gemini', 'config', 'skills'], display: '~/.gemini/config/skills', evidence: 'وثائق Antigravity: المهارات العامة تُقرأ من ~/.gemini/config/skills' },
};

export const OFFICIAL_URL: Record<EnvId, string> = {
  claude: 'https://claude.ai/settings',
  'claude-code': 'https://code.claude.com/docs/en/discover-plugins',
  chatgpt: 'https://chatgpt.com/',
  codex: 'https://developers.openai.com/codex',
  gemini: 'https://geminicli.com/docs/',
  antigravity: 'https://antigravity.google/docs',
};

// ---------- Parsers ----------

export interface ListedServer {
  name: string;
  status: ToolStatus;
  endpoint: string;
  note?: string;
}

export interface ListedPlugin {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  version?: string;
  detail?: string;
}

export interface ListedSkill {
  name: string;
  enabled: boolean;
  location: string;
}

/** `codex mcp list --json`. Only name, switch, transport type and endpoint are read. */
export function parseCodexMcp(json: string): ListedServer[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('unexpected codex mcp list shape');
  return (data as Array<Record<string, unknown>>)
    .filter((item) => typeof item?.name === 'string')
    .map((item) => {
      const transport = (item.transport ?? {}) as Record<string, unknown>;
      const args = Array.isArray(transport.args) ? transport.args.filter((a): a is string => typeof a === 'string') : [];
      const endpoint =
        typeof transport.url === 'string'
          ? redactUrl(transport.url)
          : typeof transport.command === 'string'
            ? redactCommand([transport.command, ...args].join(' '))
            : '';
      return { name: item.name as string, status: item.enabled === false ? 'disabled' : 'enabled', endpoint };
    });
}

/** `codex plugin list` prints every marketplace plugin. Only installed rows are kept. */
export function parseCodexPlugins(text: string): ListedPlugin[] {
  const plugins: ListedPlugin[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)@(\S+)\s{2,}installed, (enabled|disabled)\s{2,}(\S+)/.exec(line);
    if (!match) continue;
    plugins.push({ id: `${match[1]}@${match[2]}`, name: match[1] ?? '', source: match[2] ?? '', enabled: match[3] === 'enabled', version: match[4] });
  }
  return plugins;
}

/** `gemini mcp list`: `<mark> <name>: <command or url> (<transport>) - <status>`. */
export function parseGeminiMcp(text: string): ListedServer[] {
  const servers: ListedServer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\S+\s+([^:]+):\s+(.*?)\s+\((stdio|sse|http)\)\s+-\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const target = match[2] ?? '';
    const state = (match[4] ?? '').trim();
    const connected = /^connected$/i.test(state);
    servers.push({
      name: (match[1] ?? '').trim(),
      status: connected ? 'connected' : /disabled/i.test(state) ? 'disabled' : 'unverified',
      endpoint: /^https?:\/\//i.test(target) ? redactUrl(target) : redactCommand(target),
      note: connected ? undefined : `رد Gemini CLI: ${state}`,
    });
  }
  return servers;
}

/** `gemini skills list`: a name line with `[Enabled]` or `[Disabled]`, then Description and Location. */
export function parseGeminiSkills(text: string): ListedSkill[] {
  const skills: ListedSkill[] = [];
  let current: ListedSkill | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const head = /^(\S+) \[(Enabled|Disabled)\]/.exec(raw);
    if (head) {
      current = { name: head[1] ?? '', enabled: head[2] === 'Enabled', location: '' };
      skills.push(current);
      continue;
    }
    const location = /^\s+Location:\s+(.+)$/.exec(raw);
    if (location && current) current.location = (location[1] ?? '').trim();
  }
  return skills;
}

/** `agy mcp list`: a table with NAME, TYPE, STATUS and COMMAND/URL columns. */
export function parseAgyMcp(text: string): ListedServer[] {
  const servers: ListedServer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(stdio|http|sse)\s+(enabled|disabled)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const target = (match[4] ?? '').trim();
    servers.push({
      name: match[1] ?? '',
      status: match[3] === 'enabled' ? 'enabled' : 'disabled',
      endpoint: /^https?:\/\//i.test(target) ? redactUrl(target) : redactCommand(target),
    });
  }
  return servers;
}

/** `agy plugin list --json`. */
export function parseAgyPlugins(json: string): ListedPlugin[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('unexpected agy plugin list shape');
  return (data as Array<Record<string, unknown>>)
    .filter((item) => typeof item?.name === 'string')
    .map((item) => {
      const names = (key: string) => (Array.isArray(item[key]) ? (item[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
      const parts = [
        names('skills').length ? `skills: ${names('skills').join(', ')}` : '',
        names('mcpServers').length ? `MCP servers: ${names('mcpServers').join(', ')}` : '',
      ].filter(Boolean);
      return {
        id: item.name as string,
        name: item.name as string,
        source: typeof item.source === 'string' ? item.source : 'antigravity',
        enabled: item.enabled !== false,
        version: typeof item.version === 'string' ? item.version : undefined,
        detail: parts.join('. '),
      };
    });
}

// ---------- Inventory ----------

export interface PlatformContext {
  homeDir: string;
  cwd: string;
  now: string;
  lastGood: LastGood;
  /** Tests with a redirected home skip the other CLIs, which would read the real one. */
  skipClis: boolean;
}

export interface PlatformResult {
  tools: Tool[];
  sources: SourceHealth[];
  platforms: PlatformInfo[];
}

const KIND_WORD: Record<ToolKind, string> = { plugin: 'إضافة', skill: 'مهارة', command: 'أمر', connector: 'موصل' };

function makeTool(input: {
  id: string;
  kind: ToolKind;
  name: string;
  status: ToolStatus;
  source: string;
  envs: EnvPlacement[];
  evidence: string;
  checkedAt: string;
  description?: string;
  note?: string;
  location?: string;
  version?: string;
  docsUrl: string;
  platformName: string;
}): Tool {
  const ar =
    input.kind === 'connector'
      ? connectorNotes(input.name, null, input.status)
      : {
          summary: `${KIND_WORD[input.kind]} ${input.name} في ${input.platformName}.`,
          when:
            input.kind === 'skill'
              ? 'تحمّلها المنصة تلقائيًا حين تطابق مهمتك الوصف الأصلي أدناه.'
              : 'حين تعمل داخل هذه المنصة على مهمة يغطيها الوصف الأصلي أدناه.',
          example: `افتح ${input.platformName} واطلب المهمة بكلماتك، وستُستخدم هذه الأداة حين تناسب الطلب.`,
          generic: true,
        };
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    title: input.name,
    category: input.kind === 'skill' ? 'personal' : 'other',
    status: input.status,
    statusNote: input.note,
    scope: 'user',
    source: input.source,
    inCatalog: false,
    mine: true,
    envs: input.envs,
    evidence: { source: input.evidence, checkedAt: input.checkedAt },
    description: input.description ?? '',
    ar,
    related: [],
    commands: [],
    docsUrl: input.docsUrl,
    version: input.version,
    location: input.location,
  };
}

interface Probe<T> {
  reading: Reading<T>;
  error: string;
}

async function probe<T>(ctx: PlatformContext, key: string, available: boolean, command: string, args: string[], parse: (text: string) => T): Promise<Probe<T>> {
  let fresh: T | null = null;
  let error = '';
  if (available) {
    const run = await runTool(command, args, ctx.cwd, 60000);
    if (run.ok) {
      try {
        fresh = parse(run.stdout);
      } catch {
        error = 'خرج الأمر بصيغة غير متوقعة';
      }
    } else {
      error = run.error ?? 'فشل الأمر';
    }
  } else {
    error = `الأمر ${command} غير موجود في PATH`;
  }
  return { reading: ctx.lastGood.use(key, fresh, ctx.now), error };
}

function capability(key: PlatformCapability['key'], label: string, state: PlatformCapability['state'], detail: string, evidence: string): PlatformCapability {
  return { key, label, state, detail, evidence };
}

function sourceFor(env: EnvId, label: string, probes: Array<Probe<unknown>>, detected: boolean, count: number, evidence: string, now: string): SourceHealth {
  const stale = probes.filter((p) => p.reading.stale);
  const missing = probes.filter((p) => p.reading.data === null);
  const reasons = [...new Set(probes.filter((p) => p.reading.stale || p.reading.data === null).map((p) => p.error).filter(Boolean))].join('، ');
  const state = stale.length === 0 && missing.length === 0 ? 'ok' : missing.length === probes.length && count === 0 ? 'failed' : 'degraded';
  const oldest = stale.map((p) => p.reading.at ?? now).sort()[0];
  return {
    id: env,
    env,
    label,
    state,
    message:
      state === 'ok'
        ? `${count} أداة مقروءة.`
        : stale.length > 0
          ? `تعذّر التحديث (${reasons}). تُعرض آخر نتيجة ناجحة مع ${count} أداة.`
          : detected
            ? `تعذّرت قراءة بعض المصادر (${reasons}). تُعرض ${count} أداة من الملفات.`
            : `${reasons}. تُعرض ${count} أداة مكتشفة من مجلدات المهارات فقط.`,
    evidence,
    checkedAt: now,
    dataDate: oldest,
    setupUrl: state === 'ok' ? undefined : OFFICIAL_URL[env],
  };
}

export async function discoverPlatforms(ctx: PlatformContext): Promise<PlatformResult> {
  const { now, homeDir, cwd } = ctx;
  const [hasCodex, hasGemini, hasAgy] = ctx.skipClis
    ? [false, false, false]
    : await Promise.all([onPath('codex', cwd), onPath('gemini', cwd), onPath('agy', cwd)]);

  const [codexVersion, geminiVersion, agyVersion, codexLogin, codexMcp, codexPlugins, geminiMcp, geminiSkills, agyMcp, agyPlugins] = await Promise.all([
    hasCodex ? runTool('codex', ['--version'], cwd, 20000) : null,
    hasGemini ? runTool('gemini', ['--version'], cwd, 30000) : null,
    hasAgy ? runTool('agy', ['--version'], cwd, 20000) : null,
    hasCodex ? runTool('codex', ['login', 'status'], cwd, 20000) : null,
    probe(ctx, 'codex.mcp', hasCodex, 'codex', ['mcp', 'list', '--json'], parseCodexMcp),
    probe(ctx, 'codex.plugins', hasCodex, 'codex', ['plugin', 'list'], parseCodexPlugins),
    probe(ctx, 'gemini.mcp', hasGemini, 'gemini', ['mcp', 'list'], parseGeminiMcp),
    probe(ctx, 'gemini.skills', hasGemini, 'gemini', ['skills', 'list'], parseGeminiSkills),
    probe(ctx, 'agy.mcp', hasAgy, 'agy', ['mcp', 'list'], parseAgyMcp),
    probe(ctx, 'agy.plugins', hasAgy, 'agy', ['plugin', 'list', '--json'], parseAgyPlugins),
  ]);

  const tools: Tool[] = [];
  const count: Record<'codex' | 'gemini' | 'antigravity', number> = { codex: 0, gemini: 0, antigravity: 0 };
  const add = (env: 'codex' | 'gemini' | 'antigravity', tool: Tool) => {
    tools.push(tool);
    count[env]++;
  };
  const place = (env: EnvId, status: ToolStatus, evidence: string): EnvPlacement => ({ env, scope: 'user', status, evidence });

  const servers = (env: 'codex' | 'gemini' | 'antigravity', prefix: string, p: Probe<ListedServer[]>, command: string, platformName: string) => {
    for (const server of p.reading.data ?? []) {
      const evidence = staleNote(command, p.reading.stale);
      add(
        env,
        makeTool({
          id: `${prefix}:mcp:${server.name}`,
          kind: 'connector',
          name: server.name,
          status: server.status,
          source: env,
          envs: [place(env, server.status, evidence)],
          evidence,
          checkedAt: p.reading.at ?? now,
          note: server.note,
          location: server.endpoint || undefined,
          docsUrl: OFFICIAL_URL[env],
          platformName,
        }),
      );
    }
  };
  const plugins = (env: 'codex' | 'antigravity', prefix: string, p: Probe<ListedPlugin[]>, command: string, platformName: string) => {
    for (const plugin of p.reading.data ?? []) {
      const status: ToolStatus = plugin.enabled ? 'enabled' : 'disabled';
      const evidence = staleNote(command, p.reading.stale);
      add(
        env,
        makeTool({
          id: `${prefix}:plugin:${plugin.id}`,
          kind: 'plugin',
          name: plugin.name,
          status,
          source: plugin.source,
          envs: [place(env, status, evidence)],
          evidence,
          checkedAt: p.reading.at ?? now,
          description: plugin.detail,
          version: plugin.version,
          docsUrl: OFFICIAL_URL[env],
          platformName,
        }),
      );
    }
  };

  servers('codex', 'codex', codexMcp, 'codex mcp list --json', 'Codex');
  plugins('codex', 'codex', codexPlugins, 'codex plugin list', 'Codex');
  servers('gemini', 'gemini', geminiMcp, 'gemini mcp list', 'Gemini CLI');
  servers('antigravity', 'agy', agyMcp, 'agy mcp list', 'Antigravity');
  plugins('antigravity', 'agy', agyPlugins, 'agy plugin list --json', 'Antigravity');

  // Skill folders. Gemini's own list upgrades "discovered" to enabled or disabled.
  const geminiByPath = new Map((geminiSkills.reading.data ?? []).map((skill) => [skill.location.toLowerCase(), skill]));
  for (const dir of SKILL_DIRS) {
    for (const skill of await scanSkills(join(homeDir, ...dir.parts))) {
      const envs = dir.envs.map((env) => {
        const listed = env === 'gemini' ? geminiByPath.get(skill.path.toLowerCase()) : undefined;
        return listed
          ? place(env, listed.enabled ? 'enabled' : 'disabled', staleNote('gemini skills list', geminiSkills.reading.stale))
          : place(env, 'discovered', dir.evidence);
      });
      const first = dir.envs[0] as 'codex' | 'gemini' | 'antigravity';
      add(
        first,
        makeTool({
          id: `skill:${dir.key}:${skill.name}`,
          kind: 'skill',
          name: skill.name,
          status: envs.some((e) => e.status === 'enabled') ? 'enabled' : 'discovered',
          source: dir.key,
          envs,
          evidence: dir.evidence,
          checkedAt: now,
          description: skill.description,
          location: skill.path,
          docsUrl: OFFICIAL_URL[first],
          platformName: dir.envs.length > 1 ? 'Codex وGemini CLI' : first === 'codex' ? 'Codex' : first === 'gemini' ? 'Gemini CLI' : 'Antigravity',
        }),
      );
      for (const env of dir.envs.slice(1)) count[env as 'codex' | 'gemini' | 'antigravity']++;
    }
  }

  const version = (run: { ok: boolean; stdout: string } | null) => (run?.ok ? run.stdout.trim().split(/\r?\n/)[0] : undefined);
  const codexLoggedIn = codexLogin?.ok ? /logged in/i.test(codexLogin.stdout + codexLogin.stderr) : null;
  const listState = (ok: boolean): PlatformCapability['state'] => (ok ? 'verified' : 'unverified');
  const fresh = (...probes: Array<Probe<unknown>>) => probes.every((p) => p.reading.data !== null && !p.reading.stale);
  const SYNC = 'يُعاد الجرد عند كل تشغيل وعند التحديث اليدوي والمزامنة الدورية.';

  const platforms: PlatformInfo[] = [
    {
      env: 'codex',
      detected: hasCodex,
      version: version(codexVersion),
      officialUrl: OFFICIAL_URL.codex,
      capabilities: [
        capability('inventory', 'الجرد', listState(fresh(codexMcp, codexPlugins)), 'الموصلات والإضافات المثبّتة من CLI، والمهارات من مجلداتها.', 'codex mcp list --json، codex plugin list، ~/.agents/skills'),
        capability('install', 'التثبيت', 'verified', 'المهارات تُنسخ إلى ~/.agents/skills. الإضافات والموصلات تتطلب إكمالًا بأمر codex plugin add أو codex mcp add.', SKILL_TARGET.codex?.evidence ?? ''),
        capability('sync', 'المزامنة', listState(hasCodex), SYNC, 'إعادة تشغيل أوامر الجرد'),
        capability('login', 'تسجيل الدخول', codexLoggedIn ? 'verified' : codexLoggedIn === false ? 'needs-completion' : 'unverified', codexLoggedIn ? 'Codex مسجّل الدخول.' : 'نفّذ codex login لإكمال الدخول في المتصفح.', 'codex login status'),
      ],
    },
    {
      env: 'gemini',
      detected: hasGemini,
      version: version(geminiVersion),
      officialUrl: OFFICIAL_URL.gemini,
      capabilities: [
        capability('inventory', 'الجرد', listState(fresh(geminiMcp, geminiSkills)), 'الموصلات مع فحص اتصالها، والمهارات مع حالة تفعيلها.', 'gemini mcp list، gemini skills list'),
        capability('install', 'التثبيت', 'verified', 'المهارات تُنسخ إلى ~/.gemini/skills. الامتدادات تتطلب إكمالًا بأمر gemini extensions install لأنه يطلب موافقة في الطرفية.', SKILL_TARGET.gemini?.evidence ?? ''),
        capability('sync', 'المزامنة', listState(hasGemini), SYNC, 'إعادة تشغيل أوامر الجرد'),
        capability('login', 'تسجيل الدخول', 'unverified', 'لا يوفر Gemini CLI أمرًا لقراءة حالة الدخول. شغّل gemini لإكمال الدخول عند الحاجة.', 'gemini --help'),
      ],
    },
    {
      env: 'antigravity',
      detected: hasAgy,
      version: version(agyVersion),
      officialUrl: OFFICIAL_URL.antigravity,
      capabilities: [
        capability('inventory', 'الجرد', listState(fresh(agyMcp, agyPlugins)), 'الموصلات والإضافات من CLI، والمهارات من مجلداتها.', 'agy mcp list، agy plugin list --json، ~/.gemini/config/skills'),
        capability('install', 'التثبيت', 'verified', 'المهارات تُنسخ إلى ~/.gemini/config/skills. إضافات Claude تتطلب إكمالًا بأمر agy plugin import claude.', SKILL_TARGET.antigravity?.evidence ?? ''),
        capability('sync', 'المزامنة', listState(hasAgy), SYNC, 'إعادة تشغيل أوامر الجرد'),
        capability('login', 'تسجيل الدخول', 'unverified', 'لا يوفر agy أمرًا لقراءة حالة الدخول. افتح Antigravity لإكمال الدخول عند الحاجة.', 'agy --help'),
      ],
    },
    {
      env: 'chatgpt',
      detected: false,
      officialUrl: OFFICIAL_URL.chatgpt,
      capabilities: [
        capability('inventory', 'الجرد', 'unverified', 'تطبيقات ChatGPT وموصلاته محفوظة في الحساب، ولا توجد واجهة محلية موثقة لقراءتها من هذا الجهاز.', 'لا يوجد مصدر محلي'),
        capability('install', 'التثبيت', 'needs-completion', 'أضِف التطبيقات والموصلات من إعدادات ChatGPT في المتصفح.', 'المسار الرسمي في chatgpt.com'),
        capability('sync', 'المزامنة', 'unverified', 'لا يوجد ما يُقرأ محليًا لمزامنته.', 'لا يوجد مصدر محلي'),
        capability('login', 'تسجيل الدخول', 'needs-completion', 'سجّل الدخول في chatgpt.com من متصفح الجهاز.', 'المسار الرسمي في chatgpt.com'),
      ],
    },
  ];

  const sources: SourceHealth[] = [
    sourceFor('codex', 'Codex', [codexMcp, codexPlugins], hasCodex, count.codex, 'codex mcp list --json، codex plugin list', now),
    sourceFor('gemini', 'Gemini CLI', [geminiMcp, geminiSkills], hasGemini, count.gemini, 'gemini mcp list، gemini skills list', now),
    sourceFor('antigravity', 'Antigravity', [agyMcp, agyPlugins], hasAgy, count.antigravity, 'agy mcp list، agy plugin list --json', now),
  ];

  return { tools, sources, platforms };
}
