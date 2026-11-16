import { existsSync, lstatSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { ENVS, envLabel } from '../../shared/labels';
import type { EnvId, InstallPlan, JobProgress, JobStage, PlanDestination, PlanItem, PlanPick, PlanResult, Tool } from '../../shared/types';
import { detectCli, runCli, runGit } from '../discovery/cli';
import { parseFrontmatter, readServerDefs } from '../discovery/contents';
import { claudePaths } from '../discovery/discover';
import { OFFICIAL_URL, SKILL_TARGET } from '../discovery/platforms';
import { parsePluginList } from '../discovery/plugins';
import { redactCommand } from '../discovery/redact';

export interface PlanContext {
  homeDir: string;
  userDataDir: string;
  env: NodeJS.ProcessEnv;
}

type Exec =
  | { type: 'copy-skill'; from: string; to: string }
  | { type: 'claude-plugin'; args: string[]; name: string };

interface StoredPlan {
  plan: InstallPlan;
  exec: Map<string, Exec>;
}

const plans = new Map<string, StoredPlan>();
let counter = 0;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SKILLS = 60;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', 'dist', 'build']);
const key = (itemId: string, env: EnvId) => `${itemId}|${env}`;

// ---------- Source ----------

/**
 * Only https Git URLs without embedded credentials are accepted. A local
 * folder is accepted only when tests switch it on.
 */
export function validateGitUrl(raw: string, allowLocal: boolean): { ok: true; url: string } | { ok: false; message: string } {
  const text = raw.trim();
  if (!text) return { ok: false, message: 'أدخل رابط المستودع.' };
  if (allowLocal && existsSync(text)) return { ok: true, url: text };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: 'الرابط غير صالح. استخدم رابط https لمستودع Git.' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'يُقبل رابط https فقط.' };
  if (url.username || url.password) return { ok: false, message: 'أزل اسم المستخدم أو الرمز من الرابط. التطبيق لا يتعامل مع بيانات الاعتماد.' };
  if (text.length > 300 || /\s/.test(text)) return { ok: false, message: 'الرابط غير صالح.' };
  return { ok: true, url: `${url.origin}${url.pathname}` };
}

// ---------- Scan (repository files are read as data, never run) ----------

interface Found {
  marketplace: { name: string; plugins: Array<{ name: string; description: string }> } | null;
  rootPlugin: { name: string; description: string } | null;
  codexMarketplace: boolean;
  extension: { name: string; description: string } | null;
  servers: string[];
  skills: Array<{ dir: string; name: string; description: string; valid: boolean }>;
  skillsTruncated: boolean;
}

async function json(path: string): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 400) : '');

async function findSkills(root: string, dir: string, depth: number, out: Found['skills']): Promise<void> {
  if (depth > 5 || out.length > MAX_SKILLS) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md') && dir !== root) {
    let meta: { name?: string; description?: string } = {};
    try {
      meta = parseFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8'));
    } catch {
      // Unreadable SKILL.md: listed as invalid below.
    }
    const name = basename(dir);
    out.push({ dir, name, description: meta.description ?? '', valid: Boolean(meta.name && meta.description) && SAFE_NAME.test(name) });
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name)) await findSkills(root, join(dir, entry.name), depth + 1, out);
  }
}

export async function scanRepo(root: string): Promise<Found> {
  const market = await json(join(root, '.claude-plugin', 'marketplace.json'));
  const plugin = await json(join(root, '.claude-plugin', 'plugin.json'));
  const extension = await json(join(root, 'gemini-extension.json'));
  const mcp = await json(join(root, '.mcp.json'));
  const skills: Found['skills'] = [];
  await findSkills(root, root, 0, skills);

  const marketPlugins = Array.isArray(market?.plugins)
    ? (market.plugins as Array<Record<string, unknown>>)
        .filter((p) => typeof p?.name === 'string' && SAFE_NAME.test(p.name as string))
        .map((p) => ({ name: p.name as string, description: text(p.description) }))
    : [];

  return {
    marketplace: market && marketPlugins.length > 0 ? { name: text(market.name), plugins: marketPlugins } : null,
    rootPlugin: plugin && typeof plugin.name === 'string' ? { name: plugin.name, description: text(plugin.description) } : null,
    codexMarketplace: existsSync(join(root, '.agents', 'plugins', 'marketplace.json')),
    extension: extension && typeof extension.name === 'string' ? { name: extension.name, description: text(extension.description) } : null,
    servers: mcp ? readServerDefs(mcp).map((server) => server.name) : [],
    skills: skills.slice(0, MAX_SKILLS),
    skillsTruncated: skills.length > MAX_SKILLS,
  };
}

// ---------- Destinations ----------

const unsupported = (env: EnvId, evidence: string): PlanDestination => ({ env, state: 'unsupported', evidence, action: 'لا إجراء', scope: '' });

const manual = (env: EnvId, evidence: string, action: string, detail?: string): PlanDestination => ({
  env,
  state: 'needs-completion',
  evidence,
  action,
  scope: env === 'claude' || env === 'chatgpt' ? 'الحساب' : 'المستخدم',
  detail,
  officialUrl: OFFICIAL_URL[env],
});

function ordered(destinations: PlanDestination[]): PlanDestination[] {
  return ENVS.map((env) => destinations.find((d) => d.env === env.id)).filter((d): d is PlanDestination => Boolean(d));
}

function skillDestinations(stored: StoredPlan, itemId: string, skill: Found['skills'][number], ctx: PlanContext): PlanDestination[] {
  if (!skill.valid) {
    return ENVS.map((env) => unsupported(env.id, 'ملف SKILL.md بلا name أو description، أو اسم المجلد غير صالح، فلا يثبت أنه مهارة بصيغة Agent Skills.'));
  }
  const { claudeDir } = claudePaths(ctx.homeDir, ctx.env);
  const copy = (env: EnvId, to: string, display: string, evidence: string): PlanDestination => {
    if (existsSync(to)) return { env, state: 'exists', evidence, action: 'لا إجراء، مجلد بالاسم نفسه موجود ولن يُستبدل', scope: 'المستخدم', detail: display };
    stored.exec.set(key(itemId, env), { type: 'copy-skill', from: skill.dir, to });
    return { env, state: 'ready', evidence, action: 'نسخ مجلد المهارة', scope: 'المستخدم', detail: display };
  };
  const list: PlanDestination[] = [
    copy('claude-code', join(claudeDir, 'skills', skill.name), `~/.claude/skills/${skill.name}`, 'مهارة بصيغة Agent Skills، وClaude Code يقرأ المهارات الشخصية من ~/.claude/skills'),
    manual('claude', 'مهارات حساب Claude تُرفع من الإعدادات، ولا توجد آلية محلية للكتابة في الحساب.', 'رفع المهارة من إعدادات Claude في المتصفح'),
    unsupported('chatgpt', 'لم يثبت من هذا الجهاز توافق Agent Skills مع ChatGPT ولا آلية لتثبيتها فيه.'),
  ];
  for (const env of ['codex', 'gemini', 'antigravity'] as const) {
    const target = SKILL_TARGET[env];
    if (target) list.push(copy(env, join(ctx.homeDir, ...target.parts, skill.name), `${target.display}/${skill.name}`, target.evidence));
  }
  return ordered(list);
}

function pluginDestinations(stored: StoredPlan, itemId: string, name: string, args: string[] | null, cliAvailable: boolean, codexMarketplace: boolean, source: string): PlanDestination[] {
  const command = args ? `claude ${args.join(' ')}` : '';
  let claudeCode: PlanDestination;
  if (!args) {
    claudeCode = manual('claude-code', 'المستودع إضافة منفردة بلا marketplace.json، وClaude Code يثبّت الإضافات عبر كتالوج يعرّفها.', 'إضافة المستودع إلى كتالوج ثم التثبيت منه');
  } else if (!cliAvailable) {
    claudeCode = manual('claude-code', 'الإضافة معرّفة في كتالوج بصيغة Claude Code، لكن Claude CLI غير متاح الآن.', 'تنفيذ الأمر يدويًا بعد تثبيت Claude CLI', command);
  } else {
    stored.exec.set(key(itemId, 'claude-code'), { type: 'claude-plugin', args, name });
    claudeCode = { env: 'claude-code', state: 'ready', evidence: 'الإضافة معرّفة في كتالوج بصيغة Claude Code (.claude-plugin/marketplace.json)', action: 'تثبيت عبر Claude CLI', scope: 'المستخدم', detail: command };
  }
  return ordered([
    claudeCode,
    manual('claude', 'إضافات الحساب تُفعَّل من إعدادات Claude، ولا توجد آلية محلية للكتابة في الحساب.', 'تفعيل الإضافة من إعدادات Claude في المتصفح'),
    unsupported('chatgpt', 'إضافات Claude ليست صيغة يقرأها ChatGPT.'),
    codexMarketplace
      ? manual('codex', 'المستودع يحتوي .agents/plugins/marketplace.json الذي يقرأه Codex.', 'إضافة الكتالوج ثم التثبيت منه', `codex plugin marketplace add ${source}`)
      : unsupported('codex', 'لا يحتوي المصدر على .agents/plugins/marketplace.json الذي يقرأه Codex.'),
    unsupported('gemini', 'Gemini CLI يثبّت الامتدادات عبر gemini-extension.json، وهذا العنصر إضافة Claude.'),
    manual('antigravity', 'يوفر agy أمرًا لاستيراد إضافات Claude بعد تثبيتها في Claude Code.', 'تثبيتها في Claude Code أولًا ثم استيرادها', 'agy plugin import claude'),
  ]);
}

async function cliAvailable(ctx: PlanContext): Promise<boolean> {
  return (await detectCli(ctx.homeDir, ctx.env)).available;
}

function newPlan(sourceKind: InstallPlan['sourceKind'], source: string, thirdParty: boolean): StoredPlan {
  const stored: StoredPlan = { plan: { id: `plan-${++counter}`, sourceKind, source, thirdParty, items: [] }, exec: new Map() };
  plans.set(stored.plan.id, stored);
  return stored;
}

// ---------- Plans ----------

export async function planFromGit(rawUrl: string, ctx: PlanContext): Promise<{ ok: true; plan: InstallPlan } | { ok: false; message: string }> {
  const checked = validateGitUrl(rawUrl, ctx.env.CLAUDE_ADDS_ALLOW_LOCAL_GIT === '1');
  if (!checked.ok) return checked;

  const plansDir = join(ctx.userDataDir, 'plans');
  await rm(plansDir, { recursive: true, force: true });
  plans.clear();
  await mkdir(plansDir, { recursive: true });
  const stored = newPlan('git', checked.url, !/^https:\/\/github\.com\/anthropics\//i.test(checked.url));
  const root = join(plansDir, stored.plan.id);

  // Hooks are switched off and nothing from the repository is executed.
  const clone = await runGit(['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--no-tags', '--single-branch', '--', checked.url, root], plansDir, 180000);
  if (!clone.ok) {
    plans.delete(stored.plan.id);
    const reason = redactCommand(clone.stderr.trim().split(/\r?\n/).slice(-2).join(' ')).slice(0, 300);
    return { ok: false, message: `تعذّر تنزيل المستودع (${clone.error ?? ''}). ${reason}` };
  }

  const found = await scanRepo(root);
  const hasCli = await cliAvailable(ctx);
  const items: PlanItem[] = [];

  for (const plugin of found.marketplace?.plugins ?? []) {
    const id = `plugin:${plugin.name}`;
    const args = ['plugin', 'install', plugin.name, '--marketplace', checked.url, '--scope', 'user'];
    items.push({ id, kind: 'plugin', name: plugin.name, description: plugin.description, path: '.claude-plugin/marketplace.json', destinations: pluginDestinations(stored, id, plugin.name, args, hasCli, found.codexMarketplace, checked.url) });
  }
  if (!found.marketplace && found.rootPlugin && SAFE_NAME.test(found.rootPlugin.name)) {
    const id = `plugin:${found.rootPlugin.name}`;
    items.push({ id, kind: 'plugin', name: found.rootPlugin.name, description: found.rootPlugin.description, path: '.claude-plugin/plugin.json', destinations: pluginDestinations(stored, id, found.rootPlugin.name, null, hasCli, found.codexMarketplace, checked.url) });
  }
  if (found.extension) {
    items.push({
      id: `extension:${found.extension.name}`,
      kind: 'extension',
      name: found.extension.name,
      description: found.extension.description,
      path: 'gemini-extension.json',
      destinations: ENVS.map((env) =>
        env.id === 'gemini'
          ? manual('gemini', 'المستودع يحتوي gemini-extension.json، وهو تعريف امتداد Gemini CLI.', 'تنفيذ الأمر في الطرفية لأنه يطلب موافقة هناك', `gemini extensions install ${checked.url}`)
          : unsupported(env.id, 'امتدادات Gemini CLI صيغة خاصة به.'),
      ),
    });
  }
  for (const server of found.servers) {
    const commands: Partial<Record<EnvId, string>> = { 'claude-code': 'claude mcp add', codex: 'codex mcp add', gemini: 'gemini mcp add', antigravity: 'agy mcp add' };
    items.push({
      id: `connector:${server}`,
      kind: 'connector',
      name: server,
      description: '',
      path: '.mcp.json',
      destinations: ENVS.map((env) => {
        const command = commands[env.id];
        return command
          ? manual(env.id, 'خادم MCP معرّف في .mcp.json. إضافته قد تتطلب مفاتيح أو تسجيل دخول، فتبقى خطوة يدوية.', 'إضافة الخادم بالأمر الرسمي ثم مصادقته', `${command} ${server} ...`)
          : env.id === 'claude'
            ? manual('claude', 'موصلات الحساب تُضاف من إعدادات Claude.', 'إضافة الموصل من إعدادات Claude في المتصفح')
            : unsupported(env.id, 'لم يثبت من هذا الجهاز مسار لإضافة هذا الخادم.');
      }),
    });
  }
  for (const skill of found.skills) {
    const id = `skill:${relative(root, skill.dir).replace(/\\/g, '/')}`;
    items.push({ id, kind: 'skill', name: skill.name, description: skill.description, path: relative(root, skill.dir).replace(/\\/g, '/'), destinations: skillDestinations(stored, id, skill, ctx) });
  }

  if (items.length === 0) {
    plans.delete(stored.plan.id);
    return { ok: false, message: 'لم يُعثر في المستودع على إضافة أو مهارة أو امتداد أو خادم MCP بصيغة معروفة.' };
  }
  stored.plan.items = items;
  if (found.skillsTruncated) stored.plan.note = `عُرضت أول ${MAX_SKILLS} مهارة فقط من هذا المستودع.`;
  return { ok: true, plan: stored.plan };
}

export async function planFromTool(tool: Tool | undefined, ctx: PlanContext): Promise<{ ok: true; plan: InstallPlan } | { ok: false; message: string }> {
  const install = tool?.install;
  if (!tool || !install) return { ok: false, message: 'هذه الأداة غير قابلة للتثبيت المباشر في آخر تحديث للبيانات.' };
  const stored = newPlan('catalog', install.origin, install.thirdParty);
  const id = `plugin:${install.plugin}`;
  stored.plan.items = [
    {
      id,
      kind: 'plugin',
      name: install.plugin,
      description: tool.kind === 'plugin' ? tool.description : `${tool.name} جزء من الإضافة ${install.plugin}، وتُثبَّت الإضافة كاملة.`,
      path: 'كتالوج Anthropic',
      destinations: pluginDestinations(stored, id, install.plugin, install.args, await cliAvailable(ctx), false, install.origin),
    },
  ];
  return { ok: true, plan: stored.plan };
}

// ---------- Execution ----------

type Step = (stage: JobStage, index: number, total: number) => void;

async function copySkill(exec: Extract<Exec, { type: 'copy-skill' }>, step: Step): Promise<{ ok: boolean; verified: boolean; message: string }> {
  step('check', 1, 3);
  if (existsSync(exec.to)) return { ok: false, verified: false, message: 'مجلد بالاسم نفسه موجود في الوجهة، ولم يُستبدل.' };
  step('install', 2, 3);
  await mkdir(dirname(exec.to), { recursive: true });
  // Symbolic links are skipped so a repository cannot point outside itself.
  await cp(exec.from, exec.to, { recursive: true, errorOnExist: true, force: false, filter: (source) => !lstatSync(source).isSymbolicLink() && basename(source) !== '.git' });
  step('verify', 3, 3);
  let verified: boolean;
  try {
    verified = Boolean(parseFrontmatter(await readFile(join(exec.to, 'SKILL.md'), 'utf8')).name);
  } catch {
    verified = false;
  }
  return { ok: true, verified, message: verified ? `نُسخت المهارة إلى ${exec.to} وتأكد وجود ملفها.` : `نُسخ المجلد إلى ${exec.to} لكن تعذّر التحقق من ملف المهارة.` };
}

async function installClaudePlugin(exec: Extract<Exec, { type: 'claude-plugin' }>, ctx: PlanContext, step: Step): Promise<{ ok: boolean; verified: boolean; message: string }> {
  step('check', 1, 4);
  const cli = await detectCli(ctx.homeDir, ctx.env);
  if (!cli.available) return { ok: false, verified: false, message: cli.reason ?? 'Claude CLI غير متاح.' };
  step('install', 2, 4);
  // `-y` is never passed: a plugin that needs a marketplace command confirmed is refused and reported.
  const run = await runCli(cli, exec.args, ctx.homeDir, 300000);
  if (!run.ok) {
    const output = redactCommand((run.stderr || run.stdout).trim().split(/\r?\n/).slice(-4).join(' ')).slice(0, 400);
    return { ok: false, verified: false, message: `رفض Claude CLI التثبيت (${run.error ?? ''}). ${output}` };
  }
  const listed = async () => {
    const list = await runCli(cli, ['plugin', 'list', '--json'], ctx.homeDir, 45000);
    try {
      return list.ok ? parsePluginList(list.stdout).find((plugin) => plugin.name === exec.name) : undefined;
    } catch {
      return undefined;
    }
  };
  step('enable', 3, 4);
  let plugin = await listed();
  // Installed but switched off: turn it on, since the user asked for a working install.
  if (plugin && plugin.enabled === false && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(plugin.id)) {
    await runCli(cli, ['plugin', 'enable', plugin.id], ctx.homeDir, 120000);
    plugin = await listed();
  }
  step('verify', 4, 4);
  const verified = plugin?.enabled === true;
  return {
    ok: true,
    verified,
    message: verified ? `ثُبّتت ${exec.name} وهي مفعّلة حسب claude plugin list.` : plugin ? `ثُبّتت ${exec.name} لكنها ليست مفعّلة حسب claude plugin list.` : `انتهى أمر التثبيت لكن ${exec.name} لم تظهر في claude plugin list.`,
  };
}

/** Runs each chosen destination on its own, so one failure never hides another's result. */
export async function runPlan(planId: string, picks: PlanPick[], ctx: PlanContext, onProgress: (progress: JobProgress) => void = () => {}): Promise<PlanResult[]> {
  const stored = plans.get(planId);
  const results: PlanResult[] = [];
  for (const pick of picks) {
    const exec = stored?.exec.get(key(pick.itemId, pick.env));
    if (!stored || !exec) {
      results.push({ ...pick, ok: false, verified: false, message: `لا يوجد إجراء مباشر لهذه الوجهة (${envLabel(pick.env)}) في الخطة الحالية.` });
      continue;
    }
    try {
      const step: Step = (stage, index, total) => onProgress({ planId, itemId: pick.itemId, env: pick.env, stage, index, total });
      const outcome = exec.type === 'copy-skill' ? await copySkill(exec, step) : await installClaudePlugin(exec, ctx, step);
      results.push({ ...pick, ...outcome });
      if (outcome.ok) {
        // Installed: a retry of this destination must not run again.
        stored.exec.delete(key(pick.itemId, pick.env));
        const destination = stored.plan.items.find((item) => item.id === pick.itemId)?.destinations.find((d) => d.env === pick.env);
        if (destination) destination.state = 'exists';
      }
    } catch (cause) {
      results.push({ ...pick, ok: false, verified: false, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return results;
}

export async function clearPlans(userDataDir: string): Promise<void> {
  plans.clear();
  await rm(join(userDataDir, 'plans'), { recursive: true, force: true });
}
