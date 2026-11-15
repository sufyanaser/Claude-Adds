import type { CommandKind, ToolKind, ToolScope, ToolStatus } from './types';

export const KIND_LABEL: Record<ToolKind, string> = {
  plugin: 'إضافة',
  skill: 'مهارة',
  connector: 'موصل',
};

export const KIND_PLURAL: Record<ToolKind, string> = {
  plugin: 'الإضافات',
  skill: 'المهارات',
  connector: 'الموصلات',
};

export const STATUS_LABEL: Record<ToolStatus, string> = {
  available: 'متاحة في الكتالوج',
  enabled: 'مثبّتة ومفعّلة',
  disabled: 'مثبّتة ومعطّلة',
  configured: 'مُعدّ',
  connected: 'متصل مؤكد',
  'needs-auth': 'يتطلب مصادقة',
  'not-configured': 'غير مُعدّ',
  unverified: 'تعذّر التحقق',
};

export type Tone = 'ok' | 'warn' | 'info' | 'neutral' | 'danger';

export const STATUS_TONE: Record<ToolStatus, Tone> = {
  available: 'neutral',
  enabled: 'ok',
  disabled: 'warn',
  configured: 'info',
  connected: 'ok',
  'needs-auth': 'warn',
  'not-configured': 'neutral',
  unverified: 'danger',
};

/** Display order of statuses, most actionable first. */
export const STATUS_ORDER: ToolStatus[] = [
  'enabled',
  'connected',
  'needs-auth',
  'disabled',
  'configured',
  'not-configured',
  'available',
  'unverified',
];

export const SCOPE_LABEL: Record<ToolScope, string> = {
  user: 'المستخدم',
  project: 'المشروع',
  local: 'محلي لمشروع واحد',
  managed: 'مُدار من المؤسسة',
  account: 'حساب Claude',
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
  'user-skills': 'مهارات المستخدم',
  'user-config': 'إعداد MCP المحلي',
  project: 'ملفات المشروع',
};

export function sourceLabel(key: string): string {
  return SOURCE_LABEL[key] ?? key;
}

export const COPY_LABEL: Record<CommandKind, string> = {
  usage: 'نسخ أمر الاستخدام',
  install: 'نسخ أمر التثبيت',
  auth: 'نسخ أمر المصادقة',
  prereq: 'نسخ أمر إضافة الكتالوج',
};
