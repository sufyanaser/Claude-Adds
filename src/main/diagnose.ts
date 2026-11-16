import { existsSync, lstatSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SCOPE_LABEL, STATUS_LABEL, envLabel } from '../shared/labels';
import type { Diagnosis, DiagnoseTarget, EnvId, FixId, FixResult, Snapshot, Tool } from '../shared/types';
import { DEFAULT_CATALOG_URL } from './discovery/catalog';
import { detectCli, onPath, runCli, runTool } from './discovery/cli';
import { parseFrontmatter } from './discovery/contents';
import { addToPath, findOutsidePath } from './discovery/paths';
import { OFFICIAL_URL, SKILL_TARGET } from './discovery/platforms';
import { redactCommand } from './discovery/redact';

export interface DiagnoseContext {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  snapshot(): Snapshot | null;
  reload(): Promise<Snapshot>;
  login(): Promise<FixResult>;
  openExternal(url: string): Promise<void>;
}

/** Command each inventory source depends on. */
const SOURCE_BIN: Record<string, { bin: string; env: EnvId }> = {
  cli: { bin: 'claude', env: 'claude-code' },
  account: { bin: 'claude', env: 'claude-code' },
  plugins: { bin: 'claude', env: 'claude-code' },
  connectors: { bin: 'claude', env: 'claude-code' },
  codex: { bin: 'codex', env: 'codex' },
  gemini: { bin: 'gemini', env: 'gemini' },
  antigravity: { bin: 'agy', env: 'antigravity' },
};

const LEGACY_SKILL_SOURCES: Record<string, EnvId> = { 'codex-skills': 'codex', 'antigravity-legacy-skills': 'antigravity' };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const SAFE_SERVER = /^[A-Za-z0-9][A-Za-z0-9 ._:@-]*$/;
const RETRY = { id: 'retry' as const, label: 'إعادة الجرد الآن', detail: 'يعيد قراءة المصادر دون تغيير أي إعداد.', needsConfirm: false };

function sourceOf(ctx: DiagnoseContext, id: string) {
  return ctx.snapshot()?.sources.find((source) => source.id === id);
}

function toolOf(ctx: DiagnoseContext, id: string): Tool | undefined {
  return ctx.snapshot()?.tools.find((tool) => tool.id === id);
}

function enableId(tool: Tool): string | null {
  const command = tool.commands.find((item) => item.text.startsWith('claude plugin enable '));
  const id = command?.text.slice('claude plugin enable '.length).trim();
  return id && SAFE_ID.test(id) ? id : null;
}

async function diagnoseSource(id: string, ctx: DiagnoseContext): Promise<Diagnosis> {
  const source = sourceOf(ctx, id);
  if (!source) return { title: id, issue: 'no-source', cause: 'لا يوجد مصدر جرد بهذا المعرّف في آخر قراءة.', evidence: [] };
  if (source.state === 'ok') return { title: source.label, issue: 'none', cause: 'هذا المصدر سليم في آخر جرد.', evidence: [source.evidence] };

  if (id === 'catalog') {
    const url = ctx.env.CLAUDE_ADDS_CATALOG_URL || DEFAULT_CATALOG_URL;
    let reason: string;
    try {
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15000) });
      reason = response.ok ? '' : `HTTP ${response.status}`;
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      title: source.label,
      issue: 'catalog',
      cause: reason ? `تعذّر الوصول إلى ملف الكتالوج الآن: ${reason}. تبقى آخر نسخة ناجحة معروضة.` : 'ملف الكتالوج يستجيب الآن، والتعذّر السابق كان مؤقتًا.',
      evidence: [redactCommand(url), source.dataDate ? `تاريخ النسخة المعروضة: ${source.dataDate}` : 'لا توجد نسخة محفوظة'],
      fix: { ...RETRY, label: 'إعادة تحميل الكتالوج' },
      officialUrl: source.setupUrl,
    };
  }

  const target = SOURCE_BIN[id];
  if (!target) return { title: source.label, issue: 'no-source', cause: source.message, evidence: [source.evidence], fix: RETRY };
  const { bin, env } = target;

  // An explicit CLI path was configured: it is the only place that counts.
  if (bin === 'claude' && ctx.env.CLAUDE_ADDS_CLAUDE_BIN) {
    const cli = await detectCli(ctx.homeDir, ctx.env);
    if (!cli.available) {
      return { title: source.label, issue: 'cli-missing', cause: cli.reason ?? 'Claude CLI غير متاح في المسار المحدد.', evidence: ['المسار محدد عبر CLAUDE_ADDS_CLAUDE_BIN'], fix: RETRY, officialUrl: OFFICIAL_URL[env] };
    }
  } else if (!(await onPath(bin, ctx.homeDir))) {
    const dir = findOutsidePath(bin, ctx.homeDir, process.platform, ctx.env);
    if (dir) {
      return {
        title: source.label,
        issue: 'cli-not-in-path',
        cause: `الأمر ${bin} مثبّت لكنه خارج PATH الذي ورثه التطبيق عند تشغيله.`,
        evidence: [`وُجد في: ${dir}`, 'هذا المجلد غير موجود في PATH الحالي للتطبيق'],
        fix: { id: 'path', label: 'استخدام هذا المسار وإعادة الجرد', detail: 'يُضاف المجلد إلى PATH داخل التطبيق فقط حتى إغلاقه. لا تُعدَّل ملفات الصدفة ولا إعدادات النظام.', needsConfirm: false },
      };
    }
    return {
      title: source.label,
      issue: 'cli-missing',
      cause: `لم يُعثر على الأمر ${bin} في PATH ولا في مجلدات التثبيت المعروفة.`,
      evidence: ['فُحص PATH الحالي ومجلدات التثبيت الشائعة لهذا النظام'],
      fix: RETRY,
      officialUrl: OFFICIAL_URL[env],
    };
  }

  const version = await runTool(bin, ['--version'], ctx.homeDir, 20000);
  if (!version.ok) {
    return {
      title: source.label,
      issue: version.timedOut ? 'timeout' : 'command-failed',
      cause: version.timedOut ? `الأمر ${bin} موجود لكنه لم يرد خلال المهلة.` : `الأمر ${bin} موجود لكنه فشل عند التشغيل (${version.error ?? ''}).`,
      evidence: [`${bin} --version`, redactCommand((version.stderr || version.stdout).trim().split(/\r?\n/).slice(-2).join(' ')).slice(0, 200)],
      fix: RETRY,
      officialUrl: OFFICIAL_URL[env],
    };
  }

  const line = version.stdout.trim().split(/\r?\n/)[0] ?? '';
  if (id === 'account' && ctx.snapshot()?.account.loggedIn === false) {
    return {
      title: source.label,
      issue: 'auth',
      cause: 'Claude CLI يعمل لكنه غير مسجّل الدخول، فلا تُقرأ عناصر الحساب.',
      evidence: ['claude auth status --json: loggedIn=false'],
      fix: { id: 'login', label: 'بدء تسجيل الدخول', detail: 'يشغّل claude auth login في الخلفية ويفتح صفحة الدخول الرسمية في المتصفح. التطبيق لا يرى كلمة المرور ولا الرموز.', needsConfirm: false },
    };
  }
  return {
    title: source.label,
    issue: source.issue === 'timeout' ? 'timeout' : 'command-failed',
    cause: `الأمر ${bin} يعمل الآن، وآخر جرد تعذّر جزئيًا.`,
    evidence: [`${bin} --version: ${line}`, source.message],
    fix: RETRY,
  };
}

function diagnoseTool(id: string, ctx: DiagnoseContext): Diagnosis {
  const tool = toolOf(ctx, id);
  if (!tool) return { title: id, issue: 'no-source', cause: 'لم تعد هذه الأداة موجودة في آخر جرد.', evidence: [], fix: RETRY };
  const evidence = tool.envs.map((placement) => `${envLabel(placement.env)}، ${SCOPE_LABEL[placement.scope]}: ${STATUS_LABEL[placement.status]} (${placement.evidence})`);

  if (tool.kind === 'plugin' && tool.status === 'disabled') {
    const plugin = enableId(tool);
    return {
      title: tool.name,
      issue: 'plugin-disabled',
      cause: 'الإضافة مثبّتة لكن المنصة تقرّر أنها معطّلة، فلا تُحمَّل مهاراتها ولا موصلاتها.',
      evidence,
      fix: plugin
        ? { id: 'enable', label: 'تفعيل الإضافة', detail: `ينفّذ في الخلفية: claude plugin enable ${plugin}، في نطاق ${SCOPE_LABEL[tool.scope]}.`, needsConfirm: true }
        : undefined,
    };
  }
  if (tool.kind === 'connector' && tool.status === 'needs-auth') {
    return { title: tool.name, issue: 'auth', cause: 'المنصة تطلب تسجيل الدخول إلى خدمة هذا الموصل. هذه مصادقة للموصل نفسه وليست ربطًا لحساب المنصة.', evidence, officialUrl: tool.docsUrl };
  }
  const legacyEnv = LEGACY_SKILL_SOURCES[tool.source];
  const target = legacyEnv ? SKILL_TARGET[legacyEnv] : undefined;
  if (tool.kind === 'skill' && legacyEnv && target && tool.location) {
    const to = join(ctx.homeDir, ...target.parts, basename(dirname(tool.location)));
    return {
      title: tool.name,
      issue: 'skill-scope',
      cause: `المهارة في مجلد قديم لا تذكره وثائق ${envLabel(legacyEnv)} الحالية، فقد لا تُحمَّل.`,
      evidence: [...evidence, target.evidence],
      fix: existsSync(to)
        ? undefined
        : { id: 'copy-skill', label: 'نسخها إلى المجلد الموثّق', detail: `ينسخ المجلد إلى ${target.display}/${basename(to)} في نطاق المستخدم. المجلد الأصلي يبقى كما هو.`, needsConfirm: true },
    };
  }
  if (tool.status === 'unverified') {
    return { title: tool.name, issue: 'command-failed', cause: tool.statusNote ?? 'لم يتوفر دليل كافٍ على حالة هذه الأداة في آخر جرد.', evidence, fix: RETRY };
  }
  return { title: tool.name, issue: 'none', cause: 'لا توجد مشكلة مثبتة لهذه الأداة.', evidence, fix: RETRY };
}

export function diagnose(target: DiagnoseTarget, ctx: DiagnoseContext): Promise<Diagnosis> {
  return target.kind === 'source' ? diagnoseSource(target.id, ctx) : Promise.resolve(diagnoseTool(target.id, ctx));
}

function describe(target: DiagnoseTarget, snapshot: Snapshot, original?: Tool): { ok: boolean; evidence: string[]; label: string } {
  if (target.kind === 'source') {
    const source = snapshot.sources.find((item) => item.id === target.id);
    return { ok: source?.state === 'ok', evidence: source ? [source.message, `الدليل: ${source.evidence}`] : [], label: source?.label ?? target.id };
  }
  // A fix can make two copies identical, which folds them into one record under another id.
  const tool =
    snapshot.tools.find((item) => item.id === target.id) ??
    (original ? snapshot.tools.find((item) => item.mine && item.kind === original.kind && item.name === original.name) : undefined);
  return {
    ok: Boolean(tool) && tool?.status !== 'unverified' && tool?.status !== 'disabled',
    evidence: tool ? tool.envs.map((placement) => `${envLabel(placement.env)}: ${STATUS_LABEL[placement.status]} (${placement.evidence})`) : ['الأداة غير موجودة في الجرد الجديد'],
    label: tool?.name ?? target.id,
  };
}

/** Applies one fix, then takes a fresh inventory and reports what it now shows for the same target. */
export async function applyFix(target: DiagnoseTarget, fix: FixId, ctx: DiagnoseContext): Promise<FixResult> {
  const before: string[] = [];
  if (fix === 'login') return ctx.login();

  if (fix === 'path') {
    const bin = SOURCE_BIN[target.id]?.bin;
    const dir = bin ? findOutsidePath(bin, ctx.homeDir, process.platform, ctx.env) : null;
    if (!bin || !dir) return { ok: false, message: 'لم يُعثر على مسار صالح خارج PATH لهذا الأمر.', evidence: [] };
    addToPath([dir], ctx.env);
    before.push(`أُضيف إلى PATH داخل التطبيق: ${dir}`);
  }

  if (fix === 'enable') {
    const tool = toolOf(ctx, target.id);
    const plugin = tool ? enableId(tool) : null;
    if (!plugin) return { ok: false, message: 'تعذّر تحديد معرّف الإضافة للتفعيل.', evidence: [] };
    const cli = await detectCli(ctx.homeDir, ctx.env);
    if (!cli.available) return { ok: false, message: cli.reason ?? 'Claude CLI غير متاح.', evidence: [] };
    const run = await runCli(cli, ['plugin', 'enable', plugin], ctx.homeDir, 120000);
    before.push(`claude plugin enable ${plugin}: ${run.ok ? 'نجح' : `فشل (${run.error ?? ''})`}`);
    if (!run.ok) return { ok: false, message: 'رفض Claude CLI تفعيل الإضافة.', evidence: [...before, redactCommand((run.stderr || run.stdout).trim().split(/\r?\n/).slice(-2).join(' ')).slice(0, 300)] };
  }

  if (fix === 'copy-skill') {
    const tool = toolOf(ctx, target.id);
    const env = tool ? LEGACY_SKILL_SOURCES[tool.source] : undefined;
    const destination = env ? SKILL_TARGET[env] : undefined;
    if (!tool?.location || !destination) return { ok: false, message: 'هذه المهارة ليست في مجلد قديم معروف.', evidence: [] };
    const from = dirname(tool.location);
    const to = join(ctx.homeDir, ...destination.parts, basename(from));
    if (existsSync(to)) return { ok: false, message: 'مجلد بالاسم نفسه موجود في الوجهة، ولم يُستبدل.', evidence: [to] };
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, filter: (source) => !lstatSync(source).isSymbolicLink() && basename(source) !== '.git' });
    before.push(`نُسخت إلى: ${to}`);
  }

  const original = target.kind === 'tool' ? toolOf(ctx, target.id) : undefined;
  const snapshot = await ctx.reload();
  const after = describe(target, snapshot, original);
  return {
    ok: after.ok,
    message: after.ok ? `${after.label}: الحالة سليمة بعد الإجراء.` : `${after.label}: ما زالت المشكلة قائمة بعد الإجراء.`,
    evidence: [...before, ...after.evidence],
  };
}

/** Fresh inventory, then what it proves about one tool. A skill's file is also re-read and checked. */
export async function verifyTool(toolId: string, ctx: DiagnoseContext): Promise<FixResult> {
  const snapshot = await ctx.reload();
  const tool = snapshot.tools.find((item) => item.id === toolId);
  if (!tool) return { ok: false, message: 'لم تعد الأداة موجودة في الجرد الجديد.', evidence: [] };
  const evidence = tool.envs.map((placement) => `${envLabel(placement.env)}، ${SCOPE_LABEL[placement.scope]}: ${STATUS_LABEL[placement.status]} (${placement.evidence})`);
  let fileOk = true;
  if (tool.kind === 'skill' && tool.location) {
    try {
      const meta = parseFrontmatter(await readFile(tool.location, 'utf8'));
      fileOk = Boolean(meta.name && meta.description);
      evidence.push(fileOk ? 'ملف SKILL.md مقروء وفيه name و description' : 'ملف SKILL.md ينقصه name أو description، فقد لا تتعرف عليه المنصة');
    } catch {
      fileOk = false;
      evidence.push('تعذّرت قراءة ملف SKILL.md');
    }
  }
  const ok = fileOk && !['unverified', 'disabled', 'needs-auth', 'not-configured'].includes(tool.status);
  return { ok, message: ok ? `${tool.name}: ${STATUS_LABEL[tool.status]}، ولا مشكلة ظاهرة.` : `${tool.name}: ${STATUS_LABEL[tool.status]}. راجع الأدلة.`, evidence };
}

/**
 * Connector sign-in. For Claude Code the CLI's own flow runs in the background
 * and opens the browser; for other platforms the official page is opened.
 * The app never sees the credentials.
 */
export async function authConnector(toolId: string, ctx: DiagnoseContext): Promise<FixResult> {
  const tool = toolOf(ctx, toolId);
  if (!tool || tool.kind !== 'connector') return { ok: false, message: 'هذه ليست أداة موصل.', evidence: [] };
  const rawName = toolId.startsWith('connector:') ? toolId.slice('connector:'.length) : '';
  const claudeCode = tool.envs.some((placement) => placement.env === 'claude-code');

  if (!claudeCode || !SAFE_SERVER.test(rawName)) {
    const env = tool.envs[0]?.env ?? 'claude';
    await ctx.openExternal(OFFICIAL_URL[env]);
    return { ok: false, message: `فُتح المسار الرسمي لـ${envLabel(env)} في المتصفح. أكمل المصادقة هناك ثم اضغط «تحقّق من الجاهزية».`, evidence: [OFFICIAL_URL[env]] };
  }

  const cli = await detectCli(ctx.homeDir, ctx.env);
  if (!cli.available) return { ok: false, message: cli.reason ?? 'Claude CLI غير متاح.', evidence: [] };
  const run = await runCli(cli, ['mcp', 'login', `"${rawName}"`], ctx.homeDir, 300000);
  const snapshot = await ctx.reload();
  const after = snapshot.tools.find((item) => item.id === toolId);
  const connected = after?.status === 'connected';
  return {
    ok: connected,
    message: connected ? `${tool.name}: اكتملت المصادقة والموصل متصل الآن.` : run.timedOut ? `${tool.name}: انتهت مهلة انتظار المصادقة. أعد المحاولة عند الجاهزية.` : `${tool.name}: لم تكتمل المصادقة. الحالة الآن: ${after ? STATUS_LABEL[after.status] : 'غير موجود'}.`,
    evidence: [`claude mcp login "${rawName}": ${run.ok ? 'انتهى' : (run.error ?? 'فشل')}`, ...(after ? after.envs.map((placement) => `${envLabel(placement.env)}: ${STATUS_LABEL[placement.status]}`) : [])],
  };
}
