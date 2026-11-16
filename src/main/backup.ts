import { existsSync, lstatSync } from 'node:fs';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { KIND_LABEL, envLabel, sourceLabel } from '../shared/labels';
import type { BackupResult, Snapshot, Tool } from '../shared/types';

/** Skill folders the user owns. Account-synced and plugin-bundled skills are reinstalled, not copied. */
const COPYABLE_SOURCES = new Set(['user-skills', 'project', 'agents-skills', 'codex-skills', 'gemini-skills', 'antigravity-skills', 'antigravity-legacy-skills']);

/** Files that commonly hold credentials are left out of the copy. */
const SENSITIVE = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|credentials.*|secrets?(\..*)?|\.npmrc|\.netrc|id_(rsa|ed25519).*)$/i;

function stamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`;
}

async function countFiles(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1;
  }
  return total;
}

function manifestEntry(tool: Tool) {
  return {
    id: tool.id,
    kind: tool.kind,
    name: tool.name,
    source: tool.source,
    version: tool.version,
    status: tool.status,
    environments: tool.envs.map((placement) => ({ environment: placement.env, scope: placement.scope, status: placement.status })),
    // Already redacted when the inventory was built.
    location: tool.location,
    commands: tool.commands.map((command) => command.text),
  };
}

/**
 * Writes a dated backup folder: the inventory of the user's tools, the commands
 * to bring them back, and copies of the skill folders the user owns.
 * No tokens, keys or other credentials are read or written.
 */
export async function createBackup(destination: string, snapshot: Snapshot, appVersion: string, now = new Date()): Promise<BackupResult> {
  if (!destination || !existsSync(destination)) return { ok: false, message: 'مسار التصدير غير موجود. اختر مجلدًا آخر.' };
  const mine = snapshot.tools.filter((tool) => tool.mine);
  const root = join(destination, `Claude-Adds-backup-${stamp(now)}`);
  if (existsSync(root)) return { ok: false, message: 'توجد نسخة احتياطية بالاسم نفسه. أعد المحاولة بعد ثانية.' };

  try {
    await mkdir(join(root, 'skills'), { recursive: true });

    let skills = 0;
    const copied: Array<{ id: string; from: string; to: string }> = [];
    for (const tool of mine) {
      if (tool.kind !== 'skill' || !COPYABLE_SOURCES.has(tool.source) || !tool.location) continue;
      const from = dirname(tool.location);
      const safeName = basename(from).replace(/[^A-Za-z0-9._-]/g, '_');
      const to = join(root, 'skills', tool.source, safeName);
      if (!existsSync(from) || existsSync(to)) continue;
      await cp(from, to, {
        recursive: true,
        errorOnExist: true,
        filter: (source) => !lstatSync(source).isSymbolicLink() && !SENSITIVE.test(basename(source)) && basename(source) !== '.git',
      });
      copied.push({ id: tool.id, from, to: join('skills', tool.source, safeName) });
      skills++;
    }

    const manifest = {
      format: 'claude-adds-backup/1',
      createdAt: now.toISOString(),
      appVersion,
      inventoryCheckedAt: snapshot.generatedAt,
      counts: Object.fromEntries(['plugin', 'skill', 'command', 'connector'].map((kind) => [kind, mine.filter((tool) => tool.kind === kind).length])),
      copiedSkills: copied,
      tools: mine.map(manifestEntry),
    };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const lines = [
      'نسخة احتياطية من Claude Adds',
      `التاريخ: ${now.toLocaleString('ar-u-nu-latn')}`,
      `إصدار التطبيق: ${appVersion}`,
      '',
      'المحتوى',
      '- manifest.json: جرد أدواتك في كل بيئة مع حالتها ومصدرها وأوامرها.',
      '- skills/: نسخ من مجلدات المهارات التي تملكها، مرتبة حسب مصدرها.',
      '',
      'ما ليس في النسخة',
      '- لا مفاتيح ولا رموز ولا بيانات اعتماد. ملفات مثل .env والمفاتيح الخاصة تُستثنى من النسخ.',
      '- إضافات المنصات وموصلاتها لا تُنسخ ملفاتها، فهي تُعاد بتثبيتها من مصدرها.',
      '- مصادقة الموصلات تُعاد يدويًا بعد الاستعادة.',
      '',
      'الاستعادة',
      ...copied.map((item) => `- انسخ ${item.to} إلى ${item.from}`),
      '- الإضافات: نفّذ أوامر التثبيت المذكورة لكل إضافة في manifest.json.',
      '',
      'الأدوات المشمولة في الجرد',
      ...mine.map((tool) => `- ${KIND_LABEL[tool.kind]} ${tool.name} (${sourceLabel(tool.source)}): ${[...new Set(tool.envs.map((placement) => envLabel(placement.env)))].join('، ')}`),
    ];
    await writeFile(join(root, 'README.txt'), lines.join('\r\n'), 'utf8');

    const files = await countFiles(root);
    return { ok: true, path: root, tools: mine.length, skills, files, message: `حُفظت النسخة الاحتياطية: ${mine.length} أداة في الجرد و${skills} مجلد مهارة.` };
  } catch (cause) {
    return { ok: false, message: `تعذّر إنشاء النسخة الاحتياطية: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
