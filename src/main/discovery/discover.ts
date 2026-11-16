import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { STATUS_LABEL } from '../../shared/labels';
import type {
  AccountInfo,
  CatalogInstall,
  CommandHint,
  EnvPlacement,
  IssueCode,
  PlatformInfo,
  Snapshot,
  SourceHealth,
  Tool,
  ToolScope,
  ToolStatus,
} from '../../shared/types';
import { parseAuthStatus } from './account';
import { connectorNotes, curatedTitle, pluginCategory, pluginNotes, skillNotes } from './arabic';
import { CATALOG_MARKETPLACE, CATALOG_REPO, DEFAULT_CATALOG_URL, loadCatalog, type CatalogEntry } from './catalog';
import { detectCli, runCli } from './cli';
import { readPluginContents, readServerDefs, readServerFile, scanSkills, type PluginContents, type ServerDef, type SkillFile } from './contents';
import { LastGood, staleNote } from './lastgood';
import { parseMcpList, type McpEntry } from './mcp';
import { mergeIdentical } from './merge';
import { OFFICIAL_URL, discoverPlatforms } from './platforms';
import { parsePluginList, pluginStatus, readInstalledFromFiles, type InstalledPlugin } from './plugins';

export interface DiscoverOptions {
  homeDir: string;
  userDataDir: string;
  projectDir: string | null;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** Claude Code keeps its files in ~/.claude unless CLAUDE_CONFIG_DIR says otherwise. */
export function claudePaths(homeDir: string, env: NodeJS.ProcessEnv): { claudeDir: string; userConfig: string } {
  const override = env.CLAUDE_CONFIG_DIR;
  return override
    ? { claudeDir: override, userConfig: join(override, '.claude.json') }
    : { claudeDir: join(homeDir, '.claude'), userConfig: join(homeDir, '.claude.json') };
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
const SYNC_EVIDENCE = 'مصدرها مزامنة حساب Claude على هذا الجهاز';

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
function catalogInstall(entry: CatalogEntry, marketplaceKnown: boolean): CatalogInstall | undefined {
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

function pluginCommands(installed: InstalledPlugin | undefined, status: ToolStatus, plan: CatalogInstall | undefined): CommandHint[] {
  if (installed && status === 'enabled') {
    return [{ kind: 'usage', label: 'عرض مكوّنات الإضافة', text: `claude plugin details ${installed.id}`, where: WHERE_SHELL }];
  }
  if (installed && status === 'disabled') {
    return [{ kind: 'usage', label: 'تفعيل الإضافة', text: `claude plugin enable ${installed.id}`, where: WHERE_SHELL }];
  }
  if (installed || !plan) return [];
  return [{ kind: 'install', label: 'تثبيت الإضافة', text: `claude ${plan.args.join(' ')}`, where: WHERE_SHELL }];
}

/** Servers the user configured directly, with the scope each file implies. */
async function readUserServers(userConfig: string, projectDir: string | null) {
  const found: Array<ServerDef & { scope: ToolScope; source: string; evidence: string }> = [];
  const config = (await readJson(userConfig)) as { mcpServers?: unknown; projects?: Record<string, unknown> } | null;
  if (config) {
    for (const def of readServerDefs({ mcpServers: config.mcpServers })) {
      found.push({ ...def, scope: 'user', source: 'user-config', evidence: '~/.claude.json (mcpServers)' });
    }
    if (projectDir) {
      for (const def of readServerDefs(config.projects?.[projectDir.replace(/\\/g, '/')])) {
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
  const { claudeDir, userConfig } = claudePaths(homeDir, env);
  const projectDir = options.projectDir && existsSync(options.projectDir) ? options.projectDir : null;
  const cwd = projectDir ?? homeDir;
  const lastGood = new LastGood(join(options.userDataDir, 'last-good.json'));
  await lastGood.load();

  const cli = await detectCli(cwd, env);
  const [authRun, pluginRun, mcpRun, catalog, marketplaces, userServers, others] = await Promise.all([
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
    readUserServers(userConfig, projectDir),
    discoverPlatforms({ homeDir, cwd, now, lastGood, skipClis: Boolean(env.CLAUDE_ADDS_HOME) }),
  ]);

  // ---- Installed plugins: CLI, then the last good CLI result, then registry files.
  let freshPlugins: InstalledPlugin[] | null = null;
  let pluginError = cli.available ? '' : (cli.reason ?? 'Claude CLI غير متاح');
  if (pluginRun?.ok) {
    try {
      freshPlugins = parsePluginList(pluginRun.stdout);
    } catch {
      pluginError = 'خرج الأمر claude plugin list بصيغة غير متوقعة';
    }
  } else if (pluginRun) {
    pluginError = `فشل الأمر claude plugin list (${pluginRun.error})`;
  }
  const pluginReading = lastGood.use('claude.plugins', freshPlugins, now);
  let installed: InstalledPlugin[] = pluginReading.data ?? [];
  const hasFullList = pluginReading.data !== null;
  let pluginsFromFiles = false;
  if (!hasFullList) {
    try {
      installed = await readInstalledFromFiles(claudeDir);
      pluginsFromFiles = true;
    } catch {
      installed = [];
    }
  }
  const pluginEvidence = hasFullList ? staleNote('claude plugin list --json', pluginReading.stale) : 'installed_plugins.json و settings.json';
  const pluginCheckedAt = pluginReading.at ?? now;
  const catalogEvidence = catalog.fromCache ? 'marketplace.json (نسخة محفوظة)' : 'marketplace.json (المستودع الرسمي)';
  // Installing needs a live CLI and a fresh list, not a remembered one.
  const canInstall = cli.available && hasFullList && !pluginReading.stale;

  // ---- Plugins.
  const records = new Map<string, PluginRecord>();
  const cloneRoot = marketplaces?.[CATALOG_MARKETPLACE]?.installLocation;
  const marketplaceKnown = Boolean(cloneRoot);

  const makePlugin = (name: string, entry: CatalogEntry | undefined, install: InstalledPlugin | undefined): PluginRecord => {
    const category = pluginCategory(name, entry?.category ?? '');
    const displayName = entry?.displayName ?? name;
    const status = pluginStatus(install, hasFullList);
    let statusNote: string | undefined;
    if (!install && !hasFullList) {
      statusNote = 'لم يُفحص التثبيت كاملًا لأن Claude CLI غير متاح ولا توجد نتيجة سابقة. قد تكون مثبّتة عبر مزامنة الحساب.';
    } else if (install && install.enabled === null) {
      statusNote = 'مسجّلة في ملفات التثبيت، وحالة التفعيل لهذا النطاق تتطلب Claude CLI.';
    } else if (pluginReading.stale) {
      statusNote = `تعذّر التحديث الآن (${pluginError}). الحالة من آخر قراءة ناجحة.`;
    }
    let root = install?.installPath;
    if (!root && entry?.localPath && cloneRoot) root = join(cloneRoot, entry.localPath);
    if (root && !existsSync(root)) root = undefined;
    const plan = entry && !install ? catalogInstall(entry, marketplaceKnown) : undefined;

    const envs: EnvPlacement[] = install
      ? [{ env: 'claude-code', scope: install.scope, status, evidence: pluginEvidence }]
      : [{ env: 'claude-code', scope: 'catalog', status, evidence: `${pluginEvidence} مع ${catalogEvidence}` }];
    if (install?.scope === 'account') envs.unshift({ env: 'claude', scope: 'account', status: 'installed', evidence: SYNC_EVIDENCE });
    // The catalog serves Claude (Cowork) as well as Claude Code, so a catalog entry is listed for both.
    if (!install && entry) envs.unshift({ env: 'claude', scope: 'catalog', status, evidence: `${catalogEvidence}، والكتالوج موجّه إلى Claude وClaude Code` });

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
      mine: Boolean(install),
      envs,
      evidence: { source: envs[envs.length - 1]?.evidence ?? pluginEvidence, checkedAt: pluginCheckedAt },
      description: entry?.description ?? '',
      ar: pluginNotes(name, displayName, category),
      related: [],
      commands: pluginCommands(install, status, plan),
      docsUrl: entry?.docsUrl ?? DOCS.plugins,
      version: install?.version,
      location: install?.installPath,
      install: canInstall ? plan : undefined,
    };
    return { tool, installed: install, root };
  };

  for (const entry of catalog.entries) {
    records.set(entry.name, makePlugin(entry.name, entry, pickInstall(installed.filter((p) => p.name === entry.name))));
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

  // ---- Skills and commands. Their identity keeps the owner, so equal names never merge.
  let skillCount = 0;
  const addSkill = (
    skill: SkillFile,
    record: PluginRecord | null,
    standalone: { scope: ToolScope; source: string; envs: EnvPlacement[]; evidence: string } | null,
    isCommand: boolean,
  ) => {
    const owner = record ? record.tool.name : (standalone?.source ?? 'user');
    const id = `${isCommand ? 'command' : 'skill'}:${owner}:${skill.name}`;
    if (tools.has(id)) return;
    const usage = record ? `/${record.tool.name}:${skill.name}` : `/${skill.name}`;
    const commands: CommandHint[] = [{ kind: 'usage', label: 'استدعاء مباشر', text: usage, where: WHERE_SESSION }];
    if (record) commands.push(...record.tool.commands.filter((c) => c.kind !== 'usage'));
    tools.set(id, {
      id,
      kind: isCommand ? 'command' : 'skill',
      name: skill.name,
      title: skill.name,
      category: record ? record.tool.category : 'personal',
      status: record ? record.tool.status : 'discovered',
      statusNote: record ? `تتبع حالة الإضافة الأم ${record.tool.name}: ${STATUS_LABEL[record.tool.status]}.` : undefined,
      scope: record ? record.tool.scope : (standalone?.scope ?? 'unknown'),
      source: record ? record.tool.source : (standalone?.source ?? 'unknown'),
      inCatalog: record ? record.tool.inCatalog : false,
      mine: record ? record.tool.mine : true,
      envs: record ? record.tool.envs.map((placement) => ({ ...placement })) : (standalone?.envs ?? []),
      evidence: {
        source: record ? `ملفها داخل مجلد الإضافة، وحالتها من ${record.tool.evidence.source}` : (standalone?.evidence ?? ''),
        checkedAt: record ? record.tool.evidence.checkedAt : now,
      },
      description: skill.description,
      ar: skillNotes(skill.name, record ? record.tool.title : null, usage, isCommand),
      parentId: record?.tool.id,
      related: [],
      commands,
      docsUrl: record ? record.tool.docsUrl : DOCS.skills,
      location: skill.path,
      install: record?.tool.install,
      fingerprint: record ? undefined : skill.hash,
    });
    skillCount++;
  };

  for (const record of records.values()) {
    for (const skill of record.contents?.skills ?? []) addSkill(skill, record, null, false);
    for (const command of record.contents?.commands ?? []) addSkill(command, record, null, true);
  }
  const userEvidence = 'ملف SKILL.md في مجلد مهارات Claude Code الشخصية';
  for (const skill of await scanSkills(join(claudeDir, 'skills'))) {
    addSkill(skill, null, { scope: 'user', source: 'user-skills', evidence: userEvidence, envs: [{ env: 'claude-code', scope: 'user', status: 'discovered', evidence: userEvidence }] }, false);
  }
  let syncedFound = false;
  try {
    const syncedRoot = join(claudeDir, 'skills', 'synced');
    for (const bucket of await readdir(syncedRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory() || bucket.name.startsWith('.')) continue;
      for (const skill of await scanSkills(join(syncedRoot, bucket.name))) {
        syncedFound = true;
        addSkill(
          skill,
          null,
          {
            scope: 'account',
            source: 'synced',
            evidence: SYNC_EVIDENCE,
            envs: [
              { env: 'claude', scope: 'account', status: 'discovered', evidence: SYNC_EVIDENCE },
              { env: 'claude-code', scope: 'account', status: 'discovered', evidence: 'ملف SKILL.md في مجلد المهارات المزامَنة' },
            ],
          },
          false,
        );
      }
    }
  } catch {
    // No synced skills on this machine.
  }
  if (projectDir) {
    const projectEvidence = 'ملف SKILL.md في مجلد .claude/skills داخل المشروع';
    for (const skill of await scanSkills(join(projectDir, '.claude', 'skills'))) {
      addSkill(skill, null, { scope: 'project', source: 'project', evidence: projectEvidence, envs: [{ env: 'claude-code', scope: 'project', status: 'discovered', evidence: projectEvidence }] }, false);
    }
  }

  // ---- Connectors.
  const freshMcp: McpEntry[] | null = mcpRun?.ok ? parseMcpList(mcpRun.stdout) : null;
  const mcpError = !cli.available ? (cli.reason ?? 'Claude CLI غير متاح') : mcpRun && !mcpRun.ok ? `فشل الأمر claude mcp list (${mcpRun.error})` : '';
  const mcpReading = lastGood.use('claude.mcp', freshMcp, now);
  const mcpChecked = mcpReading.data !== null;
  const mcpEvidence = staleNote('claude mcp list (فحص اتصال مباشر)', mcpReading.stale);
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
    checkedAt: string;
    endpoint: string;
    rawName?: string;
    mine: boolean;
    alsoClaude: boolean;
  }) => {
    if (tools.has(input.id)) return;
    const commands: CommandHint[] = [];
    if (input.status === 'needs-auth') {
      commands.push({ kind: 'auth', label: 'بدء مصادقة الموصل', text: '/mcp', where: `${WHERE_SESSION} ثم اختر هذا الموصل وأكمل تسجيل الدخول في المتصفح.` });
    }
    if (input.rawName) {
      commands.push({ kind: 'usage', label: 'فحص حالة الموصل', text: `claude mcp get "${input.rawName}"`, where: WHERE_SHELL });
    }
    if (input.record && input.status === 'available') commands.push(...input.record.tool.commands.filter((c) => c.kind !== 'usage'));
    const envs: EnvPlacement[] = [{ env: 'claude-code', scope: input.scope, status: input.status, evidence: input.evidence }];
    if (input.alsoClaude) envs.unshift({ env: 'claude', scope: 'account', status: 'configured', evidence: 'موصل مرتبط بحساب Claude، ولم يُفحص اتصاله داخل تطبيق Claude' });
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
      mine: input.mine,
      envs,
      evidence: { source: input.evidence, checkedAt: input.checkedAt },
      description: '',
      ar: connectorNotes(input.server, input.record ? input.record.tool.title : null, input.status),
      parentId: input.record?.tool.id,
      related: [],
      commands,
      docsUrl: DOCS.mcp,
      location: input.endpoint || undefined,
      install: input.status === 'available' ? input.record?.tool.install : undefined,
      fingerprint: !input.record && input.endpoint ? input.endpoint.toLowerCase() : undefined,
    });
    connectorCount++;
  };

  for (const entry of mcpReading.data ?? []) {
    const record = entry.plugin ? (records.get(entry.plugin) ?? null) : null;
    const configured = entry.origin === 'user' ? userServers.find((s) => s.name === entry.server) : undefined;
    const detail = entry.detail.replace(/\s+—\s+/g, ': ');
    const scope: ToolScope = entry.origin === 'claude.ai' ? 'account' : record ? record.tool.scope : (configured?.scope ?? 'unknown');
    addConnector({
      id: `connector:${entry.rawName}`,
      server: entry.server,
      record,
      status: entry.status,
      statusNote: entry.status === 'unverified' ? `رد Claude CLI: ${detail}` : mcpReading.stale ? `تعذّر التحديث الآن (${mcpError}). الحالة من آخر قراءة ناجحة.` : undefined,
      scope,
      source: entry.origin === 'claude.ai' ? 'claude.ai' : record ? record.tool.source : (configured?.source ?? 'user-config'),
      evidence: mcpEvidence,
      checkedAt: mcpReading.at ?? now,
      endpoint: entry.endpoint,
      rawName: entry.rawName,
      mine: true,
      alsoClaude: scope === 'account',
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
          status: record.tool.status === 'unverified' ? 'unverified' : 'available',
          scope: 'catalog',
          source: record.tool.source,
          evidence: 'ملف .mcp.json للإضافة في نسخة الكتالوج المحلية',
          checkedAt: now,
          endpoint: server.endpoint,
          mine: false,
          alsoClaude: false,
        });
      } else if (!mcpChecked) {
        addConnector({
          id,
          server: server.name,
          record,
          status: server.transport === 'none' ? 'not-configured' : 'configured',
          statusNote: `لم يُفحص الاتصال: ${mcpError}.`,
          scope: record.tool.scope,
          source: record.tool.source,
          evidence: 'ملف .mcp.json داخل مجلد الإضافة المثبّتة',
          checkedAt: now,
          endpoint: server.endpoint,
          mine: true,
          alsoClaude: false,
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
        statusNote: `لم يُفحص الاتصال: ${mcpError}.`,
        scope: server.scope,
        source: server.source,
        evidence: server.evidence,
        checkedAt: now,
        endpoint: server.endpoint,
        mine: true,
        alsoClaude: false,
      });
    }
  }

  for (const tool of others.tools) tools.set(tool.id, tool);

  // ---- Related tools: parent on the child, children on the parent.
  for (const tool of tools.values()) {
    if (!tool.parentId) continue;
    tool.related.push(tool.parentId);
    const parent = tools.get(tool.parentId);
    if (!parent) continue;
    parent.related.push(tool.id);
    // A plugin is found by the names and descriptions of its commands.
    if (tool.kind === 'command') parent.keywords = `${parent.keywords ?? ''} ${tool.name} ${tool.description}`.trim();
  }

  // ---- One record per tool when copies in several platforms are provably identical.
  const allTools = mergeIdentical([...tools.values()]);

  // ---- Account linked to the CLI on this computer.
  const account: AccountInfo = authRun?.ok ? parseAuthStatus(authRun.stdout) : { loggedIn: null };

  const cliIssue: IssueCode = cli.available ? (authRun?.timedOut ? 'timeout' : 'command-failed') : 'cli-missing';
  const sources: SourceHealth[] = [
    {
      id: 'cli',
      env: 'claude-code',
      label: 'Claude CLI',
      state: cli.available ? 'ok' : 'failed',
      message: cli.available ? `متاح، الإصدار ${cli.version ?? 'غير معلوم'}.` : `${cli.reason ?? 'غير متاح.'} ثبّته من المسار الرسمي ثم حدّث البيانات.`,
      evidence: 'claude --version',
      checkedAt: now,
      setupUrl: cli.available ? undefined : DOCS.setup,
      issue: cli.available ? 'none' : 'cli-missing',
    },
    {
      id: 'account',
      env: 'claude',
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
      issue: account.loggedIn ? 'none' : account.loggedIn === false ? 'auth' : cliIssue,
    },
    {
      id: 'plugins',
      env: 'claude-code',
      label: 'إضافات Claude Code',
      state: hasFullList && !pluginReading.stale ? 'ok' : hasFullList || pluginsFromFiles ? 'degraded' : 'failed',
      message:
        hasFullList && !pluginReading.stale
          ? `${installed.length} إضافة مثبّتة.`
          : hasFullList
            ? `تعذّر التحديث (${pluginError}). تُعرض آخر نتيجة ناجحة مع ${installed.length} إضافة.`
            : pluginsFromFiles
              ? `${pluginError}. قُرئت ${installed.length} إضافة من ملفات التثبيت فقط، والإضافات المزامَنة من الحساب وحالة التفعيل خارج نطاق المستخدم غير ظاهرة.`
              : 'تعذّرت قراءة الإضافات المثبّتة من CLI ومن ملفات التثبيت.',
      evidence: pluginEvidence,
      checkedAt: now,
      dataDate: pluginReading.stale ? (pluginReading.at ?? undefined) : undefined,
      setupUrl: hasFullList && !pluginReading.stale ? undefined : DOCS.plugins,
      issue: hasFullList && !pluginReading.stale ? 'none' : !cli.available ? 'cli-missing' : pluginRun?.timedOut ? 'timeout' : 'command-failed',
    },
    {
      id: 'skills',
      env: 'claude-code',
      label: 'مهارات Claude وأوامره',
      state: 'ok',
      message: `${skillCount} مهارة وأمر من مجلدات الإضافات ومجلدات المهارات.`,
      evidence: 'فحص ملفات SKILL.md على القرص',
      checkedAt: now,
    },
    {
      id: 'connectors',
      env: 'claude-code',
      label: 'موصلات Claude',
      state: mcpChecked && !mcpReading.stale ? 'ok' : 'degraded',
      message:
        mcpChecked && !mcpReading.stale
          ? `${connectorCount} موصل، وفُحص اتصال المُعدّ منها.`
          : mcpChecked
            ? `تعذّر التحديث (${mcpError}). تُعرض آخر نتيجة ناجحة لفحص الاتصال.`
            : `${mcpError}. تُعرض الموصلات الموجودة في ملفات الإعداد دون حالة اتصال، وموصلات حساب Claude غير ظاهرة.`,
      evidence: mcpChecked ? mcpEvidence : 'ملفات .mcp.json و ~/.claude.json',
      checkedAt: now,
      dataDate: mcpReading.stale ? (mcpReading.at ?? undefined) : undefined,
      setupUrl: mcpChecked && !mcpReading.stale ? undefined : DOCS.mcp,
      issue: mcpChecked && !mcpReading.stale ? 'none' : !cli.available ? 'cli-missing' : mcpRun?.timedOut ? 'timeout' : 'command-failed',
    },
    {
      id: 'catalog',
      env: 'catalog',
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
      dataDate: catalog.fromCache ? (catalog.fetchedAt ?? undefined) : undefined,
      setupUrl: catalog.fetchedAt === null || catalog.fromCache ? DOCS.catalog : undefined,
      issue: catalog.fetchedAt === null || catalog.fromCache ? 'catalog' : 'none',
    },
    ...others.sources,
  ];

  const SYNC = 'يُعاد الجرد عند كل تشغيل وعند التحديث اليدوي والمزامنة الدورية.';
  const freshClaude = hasFullList && !pluginReading.stale && mcpChecked && !mcpReading.stale;
  const loginState = account.loggedIn ? 'verified' : account.loggedIn === false ? 'needs-completion' : 'unverified';
  const claudePlatforms: PlatformInfo[] = [
    {
      env: 'claude',
      detected: syncedFound || installed.some((p) => p.scope === 'account'),
      officialUrl: OFFICIAL_URL.claude,
      capabilities: [
        { key: 'inventory', label: 'الجرد', state: freshClaude && account.loggedIn ? 'verified' : 'unverified', detail: 'إضافات الحساب ومهاراته المزامَنة إلى هذا الجهاز، وموصلات claude.ai كما يسردها Claude CLI.', evidence: 'مجلدات المزامنة، claude plugin list --json، claude mcp list' },
        { key: 'install', label: 'التثبيت', state: 'needs-completion', detail: 'لا توجد آلية محلية للكتابة في الحساب. أضِف الإضافات والمهارات والموصلات من إعدادات Claude في المتصفح.', evidence: 'المسار الرسمي في claude.ai' },
        { key: 'sync', label: 'المزامنة', state: syncedFound ? 'verified' : 'unverified', detail: 'تطبيق Claude يزامن عناصر الحساب إلى الجهاز، والتطبيق يقرأ نتيجتها فقط.', evidence: SYNC_EVIDENCE },
        { key: 'login', label: 'تسجيل الدخول', state: loginState, detail: account.loggedIn ? 'الحساب نفسه مسجّل في Claude CLI.' : 'سجّل الدخول عبر claude auth login.', evidence: 'claude auth status --json' },
      ],
    },
    {
      env: 'claude-code',
      detected: cli.available,
      version: cli.version ?? undefined,
      officialUrl: OFFICIAL_URL['claude-code'],
      capabilities: [
        { key: 'inventory', label: 'الجرد', state: freshClaude ? 'verified' : 'unverified', detail: 'الإضافات مع نطاقها وتفعيلها، الموصلات مع فحص اتصال حي، والمهارات من ملفاتها.', evidence: 'claude plugin list --json، claude mcp list' },
        { key: 'install', label: 'التثبيت', state: cli.available ? 'verified' : 'needs-completion', detail: 'الإضافات بأمر claude plugin install، والمهارات بنسخها إلى مجلد المهارات الشخصية.', evidence: 'claude plugin install --help، وثائق المهارات' },
        { key: 'sync', label: 'المزامنة', state: cli.available ? 'verified' : 'unverified', detail: SYNC, evidence: 'إعادة تشغيل أوامر الجرد' },
        { key: 'login', label: 'تسجيل الدخول', state: loginState, detail: account.loggedIn ? 'مسجّل الدخول.' : 'نفّذ claude auth login لإكمال الدخول في المتصفح.', evidence: 'claude auth status --json' },
      ],
    },
  ];

  await lastGood.save();

  return {
    generatedAt: now,
    cliVersion: cli.version,
    projectDir,
    account,
    tools: allTools,
    sources,
    platforms: [...claudePlatforms, ...others.platforms],
  };
}
