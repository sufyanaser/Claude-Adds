import type { CapabilityState, CommandKind, DestinationState, EnvId, IssueCode, JobStage, PlanItemKind, ToolKind, ToolScope, ToolStatus } from './types';

export const KIND_LABEL: Record<ToolKind, string> = {
  plugin: 'إضافة',
  skill: 'مهارة',
  command: 'أمر',
  connector: 'موصل',
};

export const KIND_PLURAL: Record<ToolKind, string> = {
  plugin: 'الإضافات',
  skill: 'المهارات',
  command: 'الأوامر',
  connector: 'الموصلات',
};

export const KINDS: ToolKind[] = ['plugin', 'skill', 'command', 'connector'];

/** The three fixed tabs of "my tools" and the catalog. */
export const TAB_KINDS = ['plugin', 'skill', 'connector'] as const;

export const TAB_LABEL: Record<(typeof TAB_KINDS)[number], string> = {
  plugin: 'Plugins',
  skill: 'Skills',
  connector: 'MCP',
};

export const ISSUE_LABEL: Record<IssueCode, string> = {
  none: 'لا مشكلة مثبتة',
  'cli-missing': 'الأداة غير مثبّتة',
  'cli-not-in-path': 'الأداة خارج PATH',
  'command-failed': 'فشل أمر الجرد',
  timeout: 'انتهت مهلة الأمر',
  auth: 'يتطلب تسجيل الدخول',
  'plugin-disabled': 'الإضافة معطّلة',
  'skill-scope': 'مجلد المهارة غير موثّق',
  catalog: 'تعذّر تحديث الكتالوج',
  'no-source': 'لا يوجد مصدر جرد مدعوم',
};

export const STAGE_LABEL: Record<JobStage, string> = {
  check: 'التحقق',
  install: 'جاري التثبيت',
  auth: 'بانتظار المصادقة',
  enable: 'جاري التفعيل',
  verify: 'التحقق النهائي',
};

export const ENVS: Array<{ id: EnvId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'antigravity', label: 'Antigravity' },
];

export function envLabel(id: EnvId | 'catalog'): string {
  return id === 'catalog' ? 'الكتالوج' : (ENVS.find((env) => env.id === id)?.label ?? id);
}

export const STATUS_LABEL: Record<ToolStatus, string> = {
  available: 'متاحة في الكتالوج',
  discovered: 'مكتشفة',
  installed: 'مثبّتة',
  enabled: 'مفعّلة',
  disabled: 'معطّلة',
  configured: 'مُعدّ',
  connected: 'متصل مؤكد',
  'needs-auth': 'يتطلب مصادقة',
  'not-configured': 'غير مُعدّ',
  unverified: 'تعذّر التحقق',
};

/** What each status proves, shown beside it in the details panel. */
export const STATUS_MEANING: Record<ToolStatus, string> = {
  available: 'موجودة في الكتالوج وغير مثبّتة هنا.',
  discovered: 'وُجد ملفها أو مدخلها في الإعداد، ولا دليل على حالة تحميلها.',
  installed: 'مسجّلة كمثبّتة، وحالة تفعيلها غير مؤكدة.',
  enabled: 'المنصة نفسها تقرّر أنها مفعّلة.',
  disabled: 'مثبّتة والمنصة تقرّر أنها معطّلة.',
  configured: 'موجود في الإعداد ولم يُفحص اتصاله.',
  connected: 'نجح فحص اتصال حي.',
  'needs-auth': 'المنصة تطلب تسجيل دخول لهذا الموصل.',
  'not-configured': 'عنصر نائب بلا عنوان خادم.',
  unverified: 'لم يتوفر دليل كافٍ على حالتها.',
};

export type Tone = 'ok' | 'warn' | 'info' | 'neutral' | 'danger';

export const STATUS_TONE: Record<ToolStatus, Tone> = {
  available: 'neutral',
  discovered: 'info',
  installed: 'info',
  enabled: 'ok',
  disabled: 'warn',
  configured: 'info',
  connected: 'ok',
  'needs-auth': 'warn',
  'not-configured': 'neutral',
  unverified: 'danger',
};

/** Display order of statuses, strongest evidence first. */
export const STATUS_ORDER: ToolStatus[] = [
  'connected',
  'enabled',
  'installed',
  'discovered',
  'configured',
  'needs-auth',
  'disabled',
  'not-configured',
  'available',
  'unverified',
];

export const SCOPE_LABEL: Record<ToolScope, string> = {
  user: 'المستخدم',
  project: 'المشروع',
  local: 'محلي لمشروع واحد',
  managed: 'مُدار من المؤسسة',
  account: 'الحساب',
  catalog: 'الكتالوج فقط',
  unknown: 'غير معلوم',
};

export const CATEGORY_LABEL: Record<string, string> = {
  automation: 'الأتمتة',
  database: 'قواعد البيانات',
  deployment: 'النشر',
  design: 'التصميم',
  development: 'التطوير',
  finance: 'المالية',
  learning: 'التعلّم',
  monitoring: 'المراقبة',
  productivity: 'الإنتاجية',
  security: 'الأمان',
  testing: 'الاختبار',
  sales: 'المبيعات',
  legal: 'القانون',
  marketing: 'التسويق',
  support: 'دعم العملاء',
  product: 'إدارة المنتج',
  research: 'البحث العلمي',
  engineering: 'الهندسة',
  hr: 'الموارد البشرية',
  operations: 'العمليات',
  data: 'البيانات',
  search: 'البحث المؤسسي',
  business: 'الأعمال الصغيرة',
  documents: 'المستندات',
  personal: 'شخصية',
  other: 'أخرى',
};

export function categoryLabel(key: string): string {
  return CATEGORY_LABEL[key] ?? key;
}

const SOURCE_LABEL: Record<string, string> = {
  'knowledge-work-plugins': 'كتالوج Anthropic',
  synced: 'مزامنة حساب Claude',
  'claude.ai': 'موصلات claude.ai',
  'user-skills': 'مهارات Claude Code',
  'user-config': 'إعداد MCP المحلي',
  project: 'ملفات المشروع',
  'agents-skills': 'مجلد المهارات المشترك',
  'codex-skills': 'مجلد مهارات Codex القديم',
  'gemini-skills': 'مهارات Gemini',
  'antigravity-skills': 'مهارات Antigravity',
  'antigravity-legacy-skills': 'مجلد مهارات Antigravity القديم',
  codex: 'إعداد Codex',
  gemini: 'إعداد Gemini',
  antigravity: 'إعداد Antigravity',
};

export function sourceLabel(key: string): string {
  return SOURCE_LABEL[key] ?? key;
}

export const COPY_LABEL: Record<CommandKind, string> = {
  usage: 'نسخ أمر الاستخدام',
  install: 'نسخ أمر التثبيت',
  auth: 'نسخ أمر المصادقة',
};

export const CAPABILITY_LABEL: Record<CapabilityState, { label: string; tone: Tone }> = {
  verified: { label: 'متحقق', tone: 'ok' },
  'needs-completion': { label: 'يتطلب إكمالًا', tone: 'warn' },
  unverified: { label: 'تعذّر التحقق', tone: 'danger' },
};

export const DESTINATION_LABEL: Record<DestinationState, { label: string; tone: Tone }> = {
  ready: { label: 'متوافق وجاهز', tone: 'ok' },
  exists: { label: 'موجود مسبقًا', tone: 'info' },
  'needs-completion': { label: 'يتطلب إكمالًا', tone: 'warn' },
  unsupported: { label: 'غير مدعوم', tone: 'neutral' },
};

export const PLAN_KIND_LABEL: Record<PlanItemKind, string> = {
  plugin: 'إضافة',
  skill: 'مهارة',
  extension: 'امتداد Gemini',
  connector: 'موصل MCP',
};
