import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { STATUS_LABEL } from '../../shared/labels';
import type { AccountInfo, CommandHint, InstallPlan, Snapshot, SourceHealth, Tool, ToolScope, ToolStatus } from '../../shared/types';
import { parseAuthStatus } from './account';
import { connectorNotes, curatedTitle, pluginCategory, pluginNotes, skillNotes } from './arabic';
import { CATALOG_MARKETPLACE, CATALOG_REPO, DEFAULT_CATALOG_URL, loadCatalog, type CatalogEntry } from './catalog';
import { detectCli, runCli } from './cli';
import {
  readPluginContents,
  readServerDefs,
  readServerFile,
  scanSkills,
  type PluginContents,
  type ServerDef,
  type SkillFile,
} from './contents';
import { parseMcpList, type McpEntry } from './mcp';
import { parsePluginList, pluginStatus, readInstalledFromFiles, type InstalledPlugin } from './plugins';

export interface DiscoverOptions {
  homeDir: string;
  userDataDir: string;
  projectDir: string | null;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const WHERE_SHELL = 'يُنفَّذ في PowerShell أو أي طرفية، خارج محادثة Claude.';
const WHERE_SESSION = 'يُكتب داخل محادثة Claude Code أو Cowork، في مربع الرسالة.';
const DOCS = {
  setup: 'https://code.claude.com/docs/en/setup',
  plugins: 'https://code.claude.com/docs/en/discover-plugins',
  mcp: 'https://code.claude.com/docs/en/mcp',
  skills: 'https://code.claude.com/docs/en/skills',
  catalog: `https://github.com/${CATALOG_REPO}`,
};

interface PluginRecord {
  tool: Tool;
  installed?: InstalledPlugin;
  root?: string;
  contents?: PluginContents;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function pickInstall(installs: InstalledPlugin[]): InstalledPlugin | undefined {
  return installs.find((p) => p.enabled === true) ?? installs[0];
}

const SAFE_PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Install arguments for a catalog plugin. When the catalog is not registered
 * locally yet, `--marketplace` lets the CLI add it under its own checks.
 */
function installPlan(entry: CatalogEntry, marketplaceKnown: boolean): InstallPlan | undefined {
  if (!SAFE_PLUGIN_NAME.test(entry.name)) return undefined;
  return {
    args: marketplaceKnown
      ? ['plugin', 'install', `${entry.name}@${CATALOG_MARKETPLACE}`, '--scope', 'user']
      : ['plugin', 'install', entry.name, '--marketplace', CATALOG_REPO, '--scope', 'user'],
    plugin: entry.name,
    thirdParty: entry.localPath === undefined,
    origin: entry.origin,
  };
}

function pluginCommands(installed: InstalledPlugin | undefined, status: ToolStatus, plan: InstallPlan | undefined): CommandHint[] {
  if (installed && status === 'enabled') {
    return [{ kind: 'usage', label: 'عرض مكوّنات الإضافة', text: `claude plugin details ${installed.id}`, where: WHERE_SHELL }];
  }
  if (installed && status === 'disabled') {
    return [{ kind: 'usage', label: 'تفعيل الإضافة', text: `claude plugin enable ${installed.id}`, where: WHERE_SHELL }];
  }
  if (installed || !plan) return [];
  return [{ kind: 'install', label: 'تثبيت الإضافة', text: `claude ${plan.args.join(' ')}`, where: WHERE_SHELL }];
}

function childStatus(parent: ToolStatus): ToolStatus {
  return parent === 'enabled' || parent === 'disabled' || parent === 'available' ? parent : 'unverified';
}

/** Servers the user configured directly, with the scope each file implies. */
async function readUserServers(homeDir: string, projectDir: string | null) {
  const found: Array<ServerDef & { scope: ToolScope; source: string; evidence: string }> = [];
  const config = (await readJson(join(homeDir, '.claude.json'))) as {
    mcpServers?: unknown;
    projects?: Record<string, unknown>;
  } | null;
  if (config) {
    for (const def of readServerDefs({ mcpServers: config.mcpServers })) {
      found.push({ ...def, scope: 'user', source: 'user-config', evidence: '~/.claude.json (mcpServers)' });
    }
    if (projectDir) {
      const project = config.projects?.[projectDir.replace(/\\/g, '/')];
      for (const def of readServerDefs(project)) {
        found.push({ ...def, scope: 'local', source: 'user-config', evidence: '~/.claude.json (إعداد المشروع المحلي)' });
      }
    }
  }
  if (projectDir) {
    for (const def of await readServerFile(join(projectDir, '.mcp.json'))) {
      found.push({ ...def, scope: 'project', source: 'project', evidence: '.mcp.json في مجلد المشروع' });
    }
  }
  return found;
}

export async function discover(options: DiscoverOptions): Promise<Snapshot> {
  const { homeDir, env } = options;
  const now = new Date().toISOString();
  const claudeDir = join(homeDir, '.claude');
  const projectDir = options.projectDir && existsSync(options.projectDir) ? options.projectDir : null;
  const cwd = projectDir ?? homeDir;

  const cli = await detectCli(cwd, env);
  const [authRun, pluginRun, mcpRun, catalog, marketplaces, userServers] = await Promise.all([
    cli.available ? runCli(cli, ['auth', 'status', '--json'], cwd, 30000) : null,
    cli.available ? runCli(cli, ['plugin', 'list', '--json'], cwd, 45000) : null,
    cli.available ? runCli(cli, ['mcp', 'list'], cwd, 120000) : null,
    loadCatalog({
      url: env.CLAUDE_ADDS_CATALOG_URL || DEFAULT_CATALOG_URL,
      cacheFile: join(options.userDataDir, 'catalog-cache.json'),
      now,
      fetchImpl: options.fetchImpl,
    }),
    readJson(join(claudeDir, 'plugins', 'known_marketplaces.json')) as Promise<Record<string, { installLocation?: string }> | null>,
    readUserServers(homeDir, projectDir),
  ]);

  // ---- Installed plugins: CLI first, registry files as fallback.
  let installed: InstalledPlugin[] = [];
  let pluginsFromCli = false;
  let pluginError = '';
  if (pluginRun?.ok) {
    try {
      installed = parsePluginList(pluginRun.stdout);
      pluginsFromCli = true;
    } catch {
      pluginError = 'خرج الأمر بصيغة غير متوقعة';
    }
  } else if (pluginRun) {
    pluginError = pluginRun.error ?? '';
  }
  let pluginsFromFiles = false;
  if (!pluginsFromCli) {
    try {
      installed = await readInstalledFromFiles(claudeDir);
      pluginsFromFiles = true;
    } catch {
      installed = [];
    }
  }
  const pluginEvidence = pluginsFromCli ? 'claude plugin list --json' : 'installed_plugins.json و settings.json';
  const catalogEvidence = catalog.fromCache ? 'marketplace.json (نسخة محفوظة)' : 'marketplace.json (المستودع الرسمي)';

  // ---- Plugins.
  const records = new Map<string, PluginRecord>();
  const cloneRoot = marketplaces?.[CATALOG_MARKETPLACE]?.installLocation;
  const marketplaceKnown = Boolean(cloneRoot);

  const makePlugin = (name: string, entry: CatalogEntry | undefined, install: InstalledPlugin | undefined): PluginRecord => {
    const category = pluginCategory(name, entry?.category ?? '');
    const displayName = entry?.displayName ?? name;
    const status = pluginStatus(install, pluginsFromCli);
    let statusNote: string | undefined;
    if (!install && !pluginsFromCli) {
      statusNote = 'لم يُفحص التثبيت كاملًا لأن Claude CLI غير متاح. قد تكون مثبّتة عبر مزامنة الحساب.';
    } else if (install && install.enabled === null) {
      statusNote = 'مثبّتة حسب ملفات التثبيت، وحالة التفعيل لهذا النطاق تتطلب Claude CLI.';
    }
    let root = install?.installPath;
    if (!root && entry?.localPath && cloneRoot) root = join(cloneRoot, entry.localPath);
    if (root && !existsSync(root)) root = undefined;
    // Direct install is offered only when the CLI confirmed the plugin is absent.
    const plan = entry && !install && pluginsFromCli ? installPlan(entry, marketplaceKnown) : undefined;

    const tool: Tool = {
      id: `plugin:${name}`,
      kind: 'plugin',
      name,
      title: curatedTitle(name) ?? displayName,
      category,
      status,
      statusNote,
      scope: install ? install.scope : 'catalog',
      source: install ? install.marketplace || 'unknown' : CATALOG_MARKETPLACE,
      inCatalog: Boolean(entry),
      evidence: { source: install ? pluginEvidence : `${pluginEvidence} مع ${catalogEvidence}`, checkedAt: now },
      description: entry?.description ?? '',
      ar: pluginNotes(name, displayName, category),
      related: [],
      commands: pluginCommands(install, status, plan ?? (entry && !install ? installPlan(entry, marketplaceKnown) : undefined)),
      docsUrl: entry?.docsUrl ?? DOCS.plugins,
      version: install?.version,
      location: install?.installPath,
      install: plan,
    };
    return { tool, installed: install, root };
  };

  for (const entry of catalog.entries) {
    const install = pickInstall(installed.filter((p) => p.name === entry.name));
    records.set(entry.name, makePlugin(entry.name, entry, install));
  }
  for (const install of installed) {
    if (!records.has(install.name)) records.set(install.name, makePlugin(install.name, undefined, install));
  }

  await Promise.all(
    [...records.values()].map(async (record) => {
      if (!record.root) return;
      record.contents = await readPluginContents(record.root);
      if (!record.tool.description) {
        const manifest = (await readJson(join(record.root, '.claude-plugin', 'plugin.json'))) as { description?: unknown } | null;
        if (typeof manifest?.description === 'string') record.tool.description = manifest.description;
      }
    }),
  );

  const tools = new Map<string, Tool>();
  for (const record of records.values()) tools.set(record.tool.id, record.tool);

  // ---- Skills.
  let skillCount = 0;
  const addSkill = (skill: SkillFile, record: PluginRecord | null, standalone: { scope: ToolScope; source: string } | null, isCommand: boolean) => {
    const owner = record ? record.tool.name : (standalone?.source ?? 'user');
    const id = `skill:${owner}:${skill.name}`;
    if (tools.has(id)) return;
    const usage = record ? `/${record.tool.name}:${skill.name}` : `/${skill.name}`;
    const status = record ? childStatus(record.tool.status) : 'enabled';
    const commands: CommandHint[] = [{ kind: 'usage', label: 'استدعاء مباشر', text: usage, where: WHERE_SESSION }];
    if (record) commands.push(...record.tool.commands.filter((c) => c.kind !== 'usage'));
    tools.set(id, {
      id,
      kind: 'skill',
      isCommand: isCommand || undefined,
      name: skill.name,
      title: skill.name,
      category: record ? record.tool.category : 'personal',
      status,
      statusNote: record
        ? `حالة الإضافة الأم ${record.tool.name}: ${STATUS_LABEL[record.tool.status]}.`
        : 'ملف المهارة موجود في مجلد المهارات، ويُحمَّل مع كل جلسة.',
      scope: record ? record.tool.scope : (standalone?.scope ?? 'unknown'),
      source: record ? record.tool.source : (standalone?.source ?? 'unknown'),
      inCatalog: record ? record.tool.inCatalog : false,
      evidence: {
        source: record ? `ملف المهارة في مجلد الإضافة، وحالة الإضافة من ${record.tool.evidence.source}` : 'فحص مجلد المهارات على القرص',
        checkedAt: now,
      },
      description: skill.description,
      ar: skillNotes(skill.name, record ? record.tool.title : null, usage, isCommand),
      parentId: record?.tool.id,
      related: [],
      commands,
      docsUrl: record ? record.tool.docsUrl : DOCS.skills,
      location: skill.path,
      install: record?.tool.install,
    });
    skillCount++;
  };

  for (const record of records.values()) {
    for (const skill of record.contents?.skills ?? []) addSkill(skill, record, null, false);
    for (const command of record.contents?.commands ?? []) addSkill(command, record, null, true);
  }
  for (const skill of await scanSkills(join(claudeDir, 'skills'))) {
    addSkill(skill, null, { scope: 'user', source: 'user-skills' }, false);
  }
  try {
    const syncedRoot = join(claudeDir, 'skills', 'synced');
    for (const bucket of await readdir(syncedRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory() || bucket.name.startsWith('.')) continue;
      for (const skill of await scanSkills(join(syncedRoot, bucket.name))) {
        addSkill(skill, null, { scope: 'account', source: 'synced' }, false);
      }
    }
  } catch {
    // No synced skills on this machine.
  }
  if (projectDir) {
    for (const skill of await scanSkills(join(projectDir, '.claude', 'skills'))) {
      addSkill(skill, null, { scope: 'project', source: 'project' }, false);
    }
  }

  // ---- Connectors.
  let mcpEntries: McpEntry[] = [];
  const mcpChecked = Boolean(mcpRun?.ok);
  if (mcpRun?.ok) mcpEntries = parseMcpList(mcpRun.stdout);
  const mcpReason = !cli.available ? 'Claude CLI غير متاح' : mcpRun && !mcpRun.ok ? `فشل الأمر claude mcp list (${mcpRun.error})` : '';
  let connectorCount = 0;

  const addConnector = (input: {
    id: string;
    server: string;
    record: PluginRecord | null;
    status: ToolStatus;
    statusNote?: string;
    scope: ToolScope;
    source: string;
    evidence: string;
    endpoint: string;
    rawName?: string;
  }) => {
    if (tools.has(input.id)) return;
    const commands: CommandHint[] = [];
    if (input.status === 'needs-auth') {
      commands.push({
        kind: 'auth',
        label: 'بدء المصادقة',
        text: '/mcp',
        where: `${WHERE_SESSION} ثم اختر هذا الموصل وأكمل تسجيل الدخول في المتصفح.`,
      });
    }
    if (input.rawName) {
      commands.push({ kind: 'usage', label: 'فحص حالة الموصل', text: `claude mcp get "${input.rawName}"`, where: WHERE_SHELL });
    }
    if (input.record && input.status === 'available') {
      commands.push(...input.record.tool.commands.filter((c) => c.kind !== 'usage'));
    }
    tools.set(input.id, {
      id: input.id,
      kind: 'connector',
      name: input.server,
      title: input.server,
      category: input.record ? input.record.tool.category : 'other',
      status: input.status,
      statusNote: input.statusNote,
      scope: input.scope,
      source: input.source,
      inCatalog: input.record ? input.record.tool.inCatalog : false,
      evidence: { source: input.evidence, checkedAt: now },
      description: '',
      ar: connectorNotes(input.server, input.record ? input.record.tool.title : null, input.status),
      parentId: input.record?.tool.id,
      related: [],
      commands,
      docsUrl: DOCS.mcp,
      location: input.endpoint || undefined,
      install: input.status === 'available' ? input.record?.tool.install : undefined,
    });
    connectorCount++;
  };

  for (const entry of mcpEntries) {
    const record = entry.plugin ? (records.get(entry.plugin) ?? null) : null;
    const configured = entry.origin === 'user' ? userServers.find((s) => s.name === entry.server) : undefined;
    const detail = entry.detail.replace(/\s+—\s+/g, ': ');
    addConnector({
      id: `connector:${entry.rawName}`,
      server: entry.server,
      record,
      status: entry.status,
      statusNote: entry.status === 'unverified' ? `رد Claude CLI: ${detail}` : undefined,
      scope: entry.origin === 'claude.ai' ? 'account' : record ? record.tool.scope : (configured?.scope ?? 'unknown'),
      source: entry.origin === 'claude.ai' ? 'claude.ai' : record ? record.tool.source : (configured?.source ?? 'user-config'),
      evidence: 'claude mcp list (فحص اتصال مباشر)',
      endpoint: entry.endpoint,
      rawName: entry.rawName,
    });
  }

  for (const record of records.values()) {
    for (const server of record.contents?.servers ?? []) {
      const id = `connector:plugin:${record.tool.name}:${server.name}`;
      if (!record.installed) {
        addConnector({
          id,
          server: server.name,
          record,
          status: 'available',
          scope: 'catalog',
          source: record.tool.source,
          evidence: `ملف .mcp.json للإضافة في نسخة الكتالوج المحلية`,
          endpoint: server.endpoint,
        });
      } else if (!mcpChecked) {
        addConnector({
          id,
          server: server.name,
          record,
          status: server.transport === 'none' ? 'not-configured' : 'configured',
          statusNote: `لم يُفحص الاتصال: ${mcpReason}.`,
          scope: record.tool.scope,
          source: record.tool.source,
          evidence: 'ملف .mcp.json داخل مجلد الإضافة المثبّتة',
          endpoint: server.endpoint,
        });
      }
    }
  }
  if (!mcpChecked) {
    for (const server of userServers) {
      addConnector({
        id: `connector:${server.name}`,
        server: server.name,
        record: null,
        status: 'configured',
        statusNote: `لم يُفحص الاتصال: ${mcpReason}.`,
        scope: server.scope,
        source: server.source,
        evidence: server.evidence,
        endpoint: server.endpoint,
      });
    }
  }

  // ---- Related tools: parent on the child, children on the parent.
  for (const tool of tools.values()) {
    if (!tool.parentId) continue;
    tool.related.push(tool.parentId);
    tools.get(tool.parentId)?.related.push(tool.id);
  }

  // ---- Account linked to the CLI on this computer.
  const account: AccountInfo = authRun?.ok ? parseAuthStatus(authRun.stdout) : { loggedIn: null };
  const accountSource: SourceHealth = {
    id: 'account',
    label: 'حساب Claude',
    state: account.loggedIn ? 'ok' : account.loggedIn === false ? 'degraded' : 'failed',
    message: account.loggedIn
      ? `مرتبط بالحساب ${account.email ?? 'المسجّل على هذا الجهاز'}${account.organization ? `، ${account.organization}` : ''}. تُقرأ إضافات الحساب وموصلاته عبر Claude CLI.`
      : account.loggedIn === false
        ? 'Claude CLI غير مسجّل الدخول، فلا تظهر إضافات الحساب وموصلاته. سجّل الدخول بالحساب نفسه ثم حدّث البيانات.'
        : cli.available
          ? 'تعذّرت قراءة حالة تسجيل الدخول من Claude CLI.'
          : 'قراءة حالة الحساب تتطلب Claude CLI.',
    evidence: 'claude auth status --json',
    checkedAt: now,
    setupUrl: account.loggedIn ? undefined : DOCS.setup,
  };

  // ---- Source health.
  const sources: SourceHealth[] = [
    {
      id: 'cli',
      label: 'Claude CLI',
      state: cli.available ? 'ok' : 'failed',
      message: cli.available ? `متاح، الإصدار ${cli.version ?? 'غير معلوم'}.` : `${cli.reason ?? 'غير متاح.'} ثبّته من المسار الرسمي ثم حدّث البيانات.`,
      evidence: 'claude --version',
      checkedAt: now,
      setupUrl: cli.available ? undefined : DOCS.setup,
    },
    accountSource,
    {
      id: 'plugins',
      label: 'الإضافات المثبّتة',
      state: pluginsFromCli ? 'ok' : pluginsFromFiles ? 'degraded' : 'failed',
      message: pluginsFromCli
        ? `${installed.length} إضافة مثبّتة.`
        : pluginsFromFiles
          ? `قُرئت ${installed.length} إضافة من ملفات التثبيت فقط${pluginError ? ` (${pluginError})` : ''}. الإضافات المزامَنة من الحساب وحالة التفعيل خارج نطاق المستخدم تتطلب Claude CLI.`
          : 'تعذّرت قراءة الإضافات المثبّتة من CLI ومن ملفات التثبيت.',
      evidence: pluginEvidence,
      checkedAt: now,
      setupUrl: pluginsFromCli ? undefined : DOCS.plugins,
    },
    {
      id: 'skills',
      label: 'المهارات',
      state: 'ok',
      message: `${skillCount} مهارة من مجلدات الإضافات ومجلدات المهارات.`,
      evidence: 'فحص ملفات SKILL.md على القرص',
      checkedAt: now,
    },
    {
      id: 'connectors',
      label: 'الموصلات',
      state: mcpChecked ? 'ok' : 'degraded',
      message: mcpChecked
        ? `${connectorCount} موصل، وفُحص اتصال المُعدّ منها.`
        : `${mcpReason}. تُعرض الموصلات الموجودة في ملفات الإعداد دون حالة اتصال، وموصلات حساب Claude غير ظاهرة.`,
      evidence: mcpChecked ? 'claude mcp list' : 'ملفات .mcp.json و ~/.claude.json',
      checkedAt: now,
      setupUrl: mcpChecked ? undefined : DOCS.mcp,
    },
    {
      id: 'catalog',
      label: 'كتالوج Anthropic',
      state: catalog.fetchedAt === null ? 'failed' : catalog.fromCache ? 'degraded' : 'ok',
      message:
        catalog.fetchedAt === null
          ? `تعذّر تحميل الكتالوج ولا توجد نسخة محفوظة (${catalog.error ?? ''}). تُعرض الأدوات المحلية فقط.`
          : catalog.fromCache
            ? `تعذّر التحديث (${catalog.error ?? ''}). تُعرض آخر نسخة ناجحة.`
            : `${catalog.entries.length} إضافة في الكتالوج.`,
      evidence: 'marketplace.json في المستودع الرسمي',
      checkedAt: now,
      dataDate: catalog.fetchedAt ?? undefined,
      setupUrl: catalog.fetchedAt === null || catalog.fromCache ? DOCS.catalog : undefined,
    },
  ];

  return { generatedAt: now, cliVersion: cli.version, projectDir, account, tools: [...tools.values()], sources };
}
