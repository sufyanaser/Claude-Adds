import { categoryLabel } from '../../shared/labels';
import type { ArabicNotes, ToolStatus } from '../../shared/types';

interface Curated {
  title: string;
  category: string;
  summary: string;
  when: string;
  example: string;
}

/** Hand-written notes for the plugins Anthropic hosts in the catalog repo. */
const CURATED: Record<string, Curated> = {
  productivity: {
    title: 'الإنتاجية',
    category: 'productivity',
    summary: 'إدارة المهام وتخطيط اليوم مع ذاكرة لسياق عملك، بالربط مع التقويم والبريد والمحادثات.',
    when: 'عند بدء يوم العمل، أو حين تريد قائمة مهام محدّثة من مصادرك المتصلة.',
    example: 'اكتب /productivity:start ثم اطلب: «رتّب مهام اليوم حسب الأولوية».',
  },
  'enterprise-search': {
    title: 'البحث المؤسسي',
    category: 'search',
    summary: 'بحث واحد عبر البريد والمحادثات والمستندات والويكي دون التنقل بين التطبيقات.',
    when: 'حين تبحث عن قرار أو ملف ولا تعرف في أي أداة يوجد.',
    example: 'اكتب /enterprise-search:search ثم: «ما آخر ما قيل عن ميزانية الربع القادم؟».',
  },
  'cowork-plugin-management': {
    title: 'إدارة إضافات Cowork',
    category: 'development',
    summary: 'إنشاء إضافة جديدة أو تخصيص إضافة قائمة لتناسب أدوات مؤسستك وسير عملها.',
    when: 'حين تريد إضافة خاصة بفريقك أو تعديل موصلات إضافة موجودة.',
    example: 'اكتب /cowork-plugin-management:create-cowork-plugin وصف الإضافة التي تريدها.',
  },
  sales: {
    title: 'المبيعات',
    category: 'sales',
    summary: 'بحث عن العملاء المحتملين، تحضير للمكالمات، مراجعة مسار الصفقات، وصياغة رسائل التواصل.',
    when: 'قبل مكالمة مع عميل، أو عند مراجعة الصفقات الأسبوعية.',
    example: 'اكتب /sales:call-prep ثم اسم الشركة وموعد المكالمة.',
  },
  finance: {
    title: 'المالية',
    category: 'finance',
    summary: 'قيود اليومية، التسويات، القوائم المالية، تحليل الانحرافات ودعم التدقيق.',
    when: 'في إقفال الشهر، أو عند تحضير تسوية أو تحليل انحراف.',
    example: 'اكتب /finance:reconciliation ثم أرفق كشف الحساب ودفتر الأستاذ.',
  },
  data: {
    title: 'البيانات',
    category: 'data',
    summary: 'كتابة استعلامات SQL، استكشاف البيانات، التحليل الإحصائي وبناء لوحات ورسوم.',
    when: 'حين تحتاج إجابة من جدول بيانات أو مستودع بيانات.',
    example: 'اكتب /data:write-query ثم: «مبيعات كل منطقة في آخر 90 يومًا».',
  },
  legal: {
    title: 'القانون',
    category: 'legal',
    summary: 'مراجعة العقود، فرز اتفاقيات عدم الإفصاح، فحوص الامتثال وتقييم المخاطر.',
    when: 'عند استلام عقد أو اتفاقية تحتاج قراءة أولى سريعة.',
    example: 'اكتب /legal:review-contract ثم أرفق العقد.',
  },
  marketing: {
    title: 'التسويق',
    category: 'marketing',
    summary: 'صياغة المحتوى، تخطيط الحملات، مراجعة الهوية، وتقارير الأداء.',
    when: 'عند التخطيط لحملة أو كتابة محتوى لقناة محددة.',
    example: 'اكتب /marketing:campaign-plan ثم الهدف والجمهور والميزانية.',
  },
  'customer-support': {
    title: 'دعم العملاء',
    category: 'support',
    summary: 'فرز التذاكر، صياغة الردود، تصعيد الحالات، وكتابة مقالات قاعدة المعرفة.',
    when: 'عند وصول تذكرة تحتاج ردًا أو تصعيدًا.',
    example: 'اكتب /customer-support:draft-response ثم الصق رسالة العميل.',
  },
  'product-management': {
    title: 'إدارة المنتج',
    category: 'product',
    summary: 'كتابة المواصفات، تخطيط خارطة الطريق، تلخيص أبحاث المستخدمين وتحديثات أصحاب المصلحة.',
    when: 'حين تحوّل فكرة إلى مواصفة أو تحضّر تحديثًا دوريًا.',
    example: 'اكتب /product-management:write-spec ثم وصف المشكلة.',
  },
  'bio-research': {
    title: 'أبحاث علوم الحياة',
    category: 'research',
    summary: 'بحث في الأدبيات والتجارب السريرية وقواعد البيانات الحيوية، مع تحليل بيانات المختبر.',
    when: 'عند مراجعة أدبيات، أو تحليل بيانات تسلسل الخلية الواحدة.',
    example: 'اكتب /bio-research:start ثم سؤالك البحثي.',
  },
  engineering: {
    title: 'الهندسة',
    category: 'engineering',
    summary: 'مراجعة الكود، قرارات المعمارية، الاستجابة للحوادث، الاجتماعات اليومية والتوثيق التقني.',
    when: 'قبل دمج تغيير، أو عند حادث، أو عند توثيق قرار معماري.',
    example: 'اكتب /engineering:code-review ثم رابط طلب الدمج.',
  },
  'human-resources': {
    title: 'الموارد البشرية',
    category: 'hr',
    summary: 'عروض التوظيف، التحضير للمقابلات، تهيئة الموظفين، وتحليل التعويضات.',
    when: 'عند فتح وظيفة أو تحضير مقابلة أو صياغة عرض.',
    example: 'اكتب /human-resources:interview-prep ثم المسمى الوظيفي.',
  },
  design: {
    title: 'التصميم',
    category: 'design',
    summary: 'نقد التصميم، مراجعة إمكانية الوصول، نصوص الواجهة، وتسليم التصميم للمطورين.',
    when: 'حين تريد رأيًا ثانيًا في شاشة أو تحضّر ملف تسليم.',
    example: 'اكتب /design:design-critique ثم أرفق لقطة الشاشة.',
  },
  operations: {
    title: 'العمليات',
    category: 'operations',
    summary: 'توثيق الإجراءات، تقييم المخاطر، مراجعة الموردين، وتقارير الحالة.',
    when: 'عند كتابة إجراء تشغيلي أو طلب تغيير.',
    example: 'اكتب /operations:runbook ثم اسم الإجراء وخطواته الحالية.',
  },
  'small-business': {
    title: 'الأعمال الصغيرة',
    category: 'business',
    summary: 'متابعة الفواتير والتدفق النقدي، الرواتب، العملاء المحتملين والتسويق لمنشأة صغيرة.',
    when: 'في المراجعة الأسبوعية للمنشأة أو عند ملاحقة فواتير متأخرة.',
    example: 'اكتب /small-business:monday-brief للحصول على ملخص بداية الأسبوع.',
  },
  'brand-voice': {
    title: 'صوت العلامة',
    category: 'marketing',
    summary: 'استخراج إرشادات صوت العلامة من موادك ثم تطبيقها على أي محتوى جديد.',
    when: 'حين تريد محتوى متسقًا مع أسلوب علامتك.',
    example: 'اكتب /brand-voice:generate-guidelines ثم أرفق نماذج من محتواك.',
  },
  'pdf-viewer': {
    title: 'عارض PDF',
    category: 'documents',
    summary: 'فتح ملفات PDF داخل المحادثة مع التعليق وتعبئة النماذج والتوقيع.',
    when: 'حين تريد قراءة ملف PDF أو تعبئة نموذج مع Claude.',
    example: 'اكتب /pdf-viewer:open ثم مسار الملف.',
  },
};

const CATEGORY_WHEN: Record<string, string> = {
  automation: 'حين تريد أتمتة خطوات متكررة عبر هذه الخدمة.',
  database: 'حين تعمل على قاعدة بيانات من هذا المزوّد وتحتاج استعلامًا أو فحصًا.',
  deployment: 'عند نشر تطبيق أو متابعة عملية بناء على هذه المنصة.',
  design: 'حين يتضمن عملك ملفات أو أصول تصميم من هذه الخدمة.',
  development: 'حين تكتب كودًا يعتمد على هذه المنصة أو أدواتها.',
  finance: 'حين تحتاج بيانات أو تحليلًا ماليًا من هذا المصدر.',
  learning: 'حين تبحث عن محتوى تعليمي أو مسار تعلّم.',
  monitoring: 'عند تتبّع خطأ أو مراجعة مقاييس الأداء.',
  productivity: 'حين تريد من Claude العمل على بياناتك في هذه الخدمة.',
  security: 'عند فحص أمني أو مراجعة امتثال.',
  testing: 'عند إعداد تجربة أو اختبار.',
};

export function curatedTitle(name: string): string | undefined {
  return CURATED[name]?.title;
}

export function pluginCategory(name: string, catalogCategory: string): string {
  return CURATED[name]?.category ?? (catalogCategory || 'other');
}

export function pluginNotes(name: string, displayName: string, category: string): ArabicNotes {
  const curated = CURATED[name];
  if (curated) {
    return { summary: curated.summary, when: curated.when, example: curated.example, generic: false };
  }
  return {
    summary:
      category === 'other'
        ? `إضافة ${displayName} من كتالوج Anthropic، بلا فئة محددة في الكتالوج.`
        : `إضافة ${displayName} ضمن فئة ${categoryLabel(category)}.`,
    when: CATEGORY_WHEN[category] ?? 'حين تطابق مهمتك الوصف الأصلي المعروض أدناه.',
    example: 'بعد التثبيت اطلب من Claude مهمة ضمن هذا المجال، وسيستخدم مهارات الإضافة وموصلاتها.',
    generic: true,
  };
}

export function skillNotes(skill: string, pluginTitle: string | null, usage: string, isCommand: boolean): ArabicNotes {
  const what = isCommand ? 'أمر' : 'مهارة';
  return {
    summary: pluginTitle ? `${what} ${skill} ضمن إضافة ${pluginTitle}.` : `${what} ${skill} مثبّتة خارج الإضافات.`,
    when: 'يستدعيها Claude تلقائيًا حين تطابق مهمتك الوصف الأصلي أدناه، ويمكنك استدعاؤها مباشرة بالأمر.',
    example: `اكتب ${usage} في مربع الرسالة ثم أضف طلبك في السطر نفسه.`,
    generic: true,
  };
}

const CONNECTOR_WHEN: Partial<Record<ToolStatus, string>> = {
  connected: 'جاهز الآن. اطلب من Claude قراءة بيانات هذه الخدمة أو تنفيذ إجراء فيها.',
  'needs-auth': 'يلزم تسجيل الدخول مرة واحدة قبل أن يستطيع Claude استخدامه.',
  'not-configured': 'عنصر نائب داخل الإضافة بلا عنوان خادم. يلزم ربط خدمة من هذه الفئة أولًا.',
  configured: 'موجود في ملفات الإعداد، ولم يُفحص اتصاله في هذا التحديث.',
  available: 'يصبح متاحًا بعد تثبيت الإضافة الأم.',
  unverified: 'تعذّر تأكيد حالته. راجع سبب التعذّر المعروض مع الحالة.',
};

export function connectorNotes(server: string, pluginTitle: string | null, status: ToolStatus): ArabicNotes {
  return {
    summary: pluginTitle
      ? `موصل MCP يربط Claude بخدمة ${server}، ويأتي مع إضافة ${pluginTitle}.`
      : `موصل MCP يربط Claude بخدمة ${server}.`,
    when: CONNECTOR_WHEN[status] ?? '',
    example: `بعد الاتصال اطلب مثلًا: «اعرض آخر ما تغيّر في ${server}».`,
    generic: true,
  };
}
