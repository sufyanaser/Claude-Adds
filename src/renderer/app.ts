import {
  COPY_LABEL,
  KIND_LABEL,
  KIND_PLURAL,
  SCOPE_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_TONE,
  categoryLabel,
  sourceLabel,
  type Tone,
} from '../shared/labels';
import { EMPTY_FILTERS, applyFilters, countByStatus, sortTools, type Filters, type Sort, type SortKey } from '../shared/query';
import type { ActionResult, ClaudeAddsApi, Snapshot, SourceHealth, Tool, ToolKind, ToolScope, ToolStatus } from '../shared/types';

declare global {
  interface Window {
    claudeAdds: ClaudeAddsApi;
  }
}

const api = window.claudeAdds;
const KINDS: ToolKind[] = ['plugin', 'skill', 'connector'];
const MAX_RELATED = 60;

interface State {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  view: 'overview' | 'list';
  filters: Filters;
  sort: Sort;
  selectedId: string | null;
  /** Tool id whose install is running. */
  installing: string | null;
  /** Outcome of the last install or sign-in action, shown until dismissed. */
  result: ActionResult | null;
  /** Minutes between automatic refreshes. 0 turns it off. */
  syncMinutes: number;
}

const SYNC_OPTIONS: Array<[number, string]> = [
  [0, 'متوقفة'],
  [5, 'كل 5 دقائق'],
  [15, 'كل 15 دقيقة'],
  [60, 'كل ساعة'],
];

function storedSync(): number {
  try {
    const value = Number(localStorage.getItem('syncMinutes') ?? '15');
    return SYNC_OPTIONS.some(([minutes]) => minutes === value) ? value : 15;
  } catch {
    return 15;
  }
}

const state: State = {
  snapshot: null,
  loading: true,
  error: null,
  view: 'overview',
  filters: { ...EMPTY_FILTERS },
  sort: { key: 'name', dir: 'asc' },
  selectedId: null,
  installing: null,
  result: null,
  syncMinutes: storedSync(),
};

// ---------- DOM helpers ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function setChildren(parent: HTMLElement, ...children: Child[]): void {
  parent.replaceChildren(...children.filter((child): child is Node | string => Boolean(child)));
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

/** Left-to-right technical text that stays intact inside Arabic sentences. */
function ltr(text: string, chip = false): HTMLElement {
  return h('bdi', { class: chip ? 'ltr token' : 'ltr', dir: 'ltr' }, text);
}

/**
 * Arabic sentence with embedded commands, paths or product names. Each Latin
 * run is isolated left to right so `/sales:call-prep` or `~/.claude.json`
 * keeps its order, while the Arabic around it stays right to left.
 */
function mixed(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of text.split(/([!-~][ -~]*[!-~]|[!-~])/)) {
    if (!/[A-Za-z]/.test(part)) {
      fragment.append(part);
      continue;
    }
    // Punctuation and brackets at the edges belong to the Arabic sentence, not
    // to the Latin run. Without this, "Claude CLI (" would drag the bracket
    // into the left-to-right run and mirror it on the wrong side.
    const lead = /^[^A-Za-z0-9(/~."'\\-]+/.exec(part)?.[0] ?? '';
    const tail = /[^A-Za-z0-9)/"'\\*+]+$/.exec(part.slice(lead.length))?.[0] ?? '';
    const body = part.slice(lead.length, part.length - tail.length);
    fragment.append(lead, h('bdi', { class: 'lat', dir: 'ltr' }, body), tail);
  }
  return fragment;
}

function badge(label: string, tone: Tone): HTMLElement {
  return h('span', { class: 'badge', 'data-tone': tone }, label);
}

/** Label chip without the status dot, for kind and scope. */
function chip(label: string): HTMLElement {
  return h('span', { class: 'badge plain', 'data-tone': 'neutral' }, label);
}

function statusBadge(status: ToolStatus): HTMLElement {
  return badge(STATUS_LABEL[status], STATUS_TONE[status]);
}

const timeFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date);
}

const el = {
  app: byId('app'),
  nav: byId('nav'),
  search: byId<HTMLInputElement>('search'),
  refresh: byId<HTMLButtonElement>('refresh'),
  checkedAt: byId('checked-at'),
  banner: byId('banner'),
  overview: byId('overview'),
  list: byId('list'),
  listTitle: byId('list-title'),
  resultCount: byId('result-count'),
  tableWrap: byId('table-wrap'),
  details: byId('details'),
  toast: byId('toast'),
  theme: byId<HTMLButtonElement>('theme-toggle'),
  clear: byId<HTMLButtonElement>('clear-filters'),
  fStatus: byId<HTMLSelectElement>('f-status'),
  fCategory: byId<HTMLSelectElement>('f-category'),
  fSource: byId<HTMLSelectElement>('f-source'),
  fScope: byId<HTMLSelectElement>('f-scope'),
  confirm: byId<HTMLDialogElement>('confirm'),
  confirmBody: byId('confirm-body'),
  confirmYes: byId<HTMLButtonElement>('confirm-yes'),
  confirmNo: byId<HTMLButtonElement>('confirm-no'),
};

function tools(): Tool[] {
  return state.snapshot?.tools ?? [];
}

function findTool(id: string | null): Tool | undefined {
  return id ? tools().find((tool) => tool.id === id) : undefined;
}

// ---------- Actions ----------

function showList(kind: ToolKind | 'all', status: ToolStatus | 'all' = 'all'): void {
  state.view = 'list';
  state.filters = { ...EMPTY_FILTERS, query: state.filters.query, kind, status };
  render();
}

function showOverview(): void {
  state.view = 'overview';
  state.selectedId = null;
  state.filters = { ...EMPTY_FILTERS };
  el.search.value = '';
  render();
}

function selectTool(id: string | null, focusPanel = false): void {
  const previous = state.selectedId;
  state.selectedId = id;
  if (id && state.view !== 'list') state.view = 'list';
  render();
  if (id && focusPanel) {
    el.details.querySelector<HTMLButtonElement>('[data-close]')?.focus();
  } else if (!id && previous) {
    document.querySelector<HTMLButtonElement>(`[data-tool="${CSS.escape(previous)}"]`)?.focus();
  }
}

let toastTimer: number | undefined;

function toast(message: string): void {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.remove('show'), 2200);
}

async function copyCommand(text: string): Promise<void> {
  const ok = await api.copy(text);
  toast(ok ? 'تم نسخ الأمر إلى الحافظة' : 'تعذّر النسخ إلى الحافظة');
}

let pendingInstall: Tool | null = null;

/** Shows exactly what will run and where the files come from before anything changes. */
function askInstall(tool: Tool): void {
  const plan = tool.install;
  if (!plan) return;
  pendingInstall = tool;
  setChildren(
    el.confirmBody,
    h('p', {}, mixed(`سيُنفَّذ هذا الأمر عبر Claude CLI على هذا الجهاز، ويغيّر إعدادات Claude في نطاق المستخدم:`)),
    h('code', { class: 'ltr', dir: 'ltr' }, `claude ${plan.args.join(' ')}`),
    tool.kind !== 'plugin' ? h('p', {}, mixed(`هذه الأداة جزء من الإضافة ${plan.plugin}، وستُثبَّت الإضافة كاملة.`)) : null,
    h('p', {}, 'مصدر الملفات: ', ltr(plan.origin)),
    plan.thirdParty
      ? h('p', { class: 'warn', 'data-third-party': true }, mixed('هذه الإضافة يستضيفها طرف خارجي خارج مستودع Anthropic. ثبّتها فقط إن كنت تثق بمصدرها.'))
      : null,
  );
  el.confirm.showModal();
  el.confirmNo.focus();
}

async function runInstall(tool: Tool): Promise<void> {
  state.installing = tool.id;
  state.result = null;
  render();
  let result: ActionResult;
  try {
    result = await api.install(tool.id);
  } catch (cause) {
    result = { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  state.installing = null;
  state.result = result;
  if (result.ok) await load();
  else render();
}

async function runLogin(): Promise<void> {
  state.result = await api.login();
  render();
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    state.snapshot = await api.load();
    if (state.selectedId && !findTool(state.selectedId)) state.selectedId = null;
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  }
  state.loading = false;
  render();
}

// ---------- Rendering ----------

function renderNav(): void {
  const items: Array<{ key: 'overview' | ToolKind; label: string; count?: number }> = [
    { key: 'overview', label: 'نظرة عامة' },
    ...KINDS.map((kind) => ({
      key: kind,
      label: KIND_PLURAL[kind],
      count: tools().filter((tool) => tool.kind === kind).length,
    })),
  ];
  el.nav.replaceChildren(
    ...items.map((item) => {
      const current = item.key === 'overview' ? state.view === 'overview' : state.view === 'list' && state.filters.kind === item.key;
      const button = h(
        'button',
        { type: 'button', 'aria-current': current ? 'page' : undefined, 'data-nav': item.key },
        h('span', {}, item.label),
        item.count !== undefined && state.snapshot ? h('span', { class: 'count' }, String(item.count)) : null,
      );
      button.addEventListener('click', () => (item.key === 'overview' ? showOverview() : showList(item.key)));
      return h('li', {}, button);
    }),
  );
}

/** One compact line for every source that is not healthy. Details live in the overview. */
function sourcesNotice(sources: SourceHealth[]): HTMLElement {
  const failed = sources.some((source) => source.state === 'failed');
  const names = sources.map((source) => `${source.label}: ${SOURCE_STATE[source.state].label}`).join('، ');
  const cached = sources.find((source) => source.id === 'catalog' && source.state === 'degraded' && source.dataDate);
  const notice = h(
    'div',
    { class: 'notice', 'data-tone': failed ? 'danger' : 'warn', role: 'status' },
    h('strong', {}, 'بيانات غير مكتملة:'),
    h('span', {}, mixed(`${names}.`)),
    cached?.dataDate ? h('span', {}, `تاريخ نسخة الكتالوج المعروضة: ${formatTime(cached.dataDate)}.`) : null,
  );
  if (state.view !== 'overview') {
    const more = h('button', { type: 'button', class: 'btn', 'data-sources-link': true }, 'السبب ومسار الإعداد');
    more.addEventListener('click', showOverview);
    notice.append(more);
  }
  return notice;
}

function renderBanner(): void {
  const notices: HTMLElement[] = [];
  if (state.error) {
    const retry = h('button', { type: 'button', class: 'btn' }, 'إعادة المحاولة');
    retry.addEventListener('click', () => void load());
    notices.push(
      h('div', { class: 'notice', 'data-tone': 'danger', role: 'alert' }, h('strong', {}, 'تعذّر تحميل البيانات:'), ltr(state.error), retry),
    );
  }
  if (state.result) {
    const dismiss = h('button', { type: 'button', class: 'btn' }, 'إخفاء');
    dismiss.addEventListener('click', () => {
      state.result = null;
      renderBanner();
    });
    notices.push(
      h(
        'div',
        { class: 'notice', 'data-tone': state.result.ok ? 'ok' : 'danger', 'data-result': state.result.ok ? 'ok' : 'failed', role: 'status' },
        h('span', {}, mixed(state.result.message)),
        dismiss,
      ),
    );
  }
  const unhealthy = (state.snapshot?.sources ?? []).filter((source) => source.state !== 'ok');
  if (unhealthy.length > 0) notices.push(sourcesNotice(unhealthy));
  el.banner.replaceChildren(...notices);
}

function loadingBox(): HTMLElement {
  return h('div', { class: 'state-box', role: 'status', 'data-state': 'loading' }, 'جارٍ فحص الأدوات المحلية وتحميل الكتالوج. قد يستغرق فحص الموصلات نحو نصف دقيقة.');
}

const SOURCE_STATE: Record<SourceHealth['state'], { label: string; tone: Tone }> = {
  ok: { label: 'سليم', tone: 'ok' },
  degraded: { label: 'جزئي', tone: 'warn' },
  failed: { label: 'متعذّر', tone: 'danger' },
};

function renderOverview(): void {
  el.overview.hidden = state.view !== 'overview';
  if (state.view !== 'overview') return;
  const snapshot = state.snapshot;
  if (!snapshot) {
    el.overview.replaceChildren(state.loading ? loadingBox() : h('div', { class: 'state-box' }, 'لا توجد بيانات معروضة بعد.'));
    return;
  }

  const cards = KINDS.map((kind) => {
    const total = snapshot.tools.filter((tool) => tool.kind === kind).length;
    const head = h(
      'button',
      { type: 'button', class: 'summary-head', 'data-count-kind': kind },
      h('span', {}, KIND_PLURAL[kind]),
      h('span', { class: 'total' }, String(total)),
    );
    head.addEventListener('click', () => showList(kind));
    const rows = countByStatus(snapshot.tools, kind).map(({ status, count }) => {
      const button = h(
        'button',
        { type: 'button', 'data-count-kind': kind, 'data-count-status': status, 'aria-label': `${KIND_PLURAL[kind]}، ${STATUS_LABEL[status]}: ${count}` },
        statusBadge(status),
        h('span', { class: 'n' }, String(count)),
      );
      button.addEventListener('click', () => showList(kind, status));
      return h('li', {}, button);
    });
    return h('div', { class: 'summary' }, head, h('ul', {}, ...rows));
  });

  const sources = snapshot.sources.map((source) => {
    const stateInfo = SOURCE_STATE[source.state];
    let setup: HTMLElement | null = null;
    if (source.setupUrl) {
      const url = source.setupUrl;
      setup = h('button', { type: 'button', class: 'btn', 'data-setup': true }, 'فتح مسار الإعداد الرسمي');
      setup.addEventListener('click', () => void api.open(url));
    }
    let login: HTMLElement | null = null;
    if (source.id === 'account' && source.state !== 'ok' && snapshot.cliVersion) {
      login = h('button', { type: 'button', class: 'btn primary', 'data-login': true }, 'تسجيل الدخول عبر Claude CLI');
      login.addEventListener('click', () => void runLogin());
    }
    return h(
      'li',
      { 'data-source-row': source.id, 'data-source-state': source.state },
      h('strong', {}, mixed(source.label)),
      badge(stateInfo.label, stateInfo.tone),
      h(
        'div',
        {},
        h('div', {}, mixed(source.message)),
        h(
          'div',
          { class: 'meta' },
          'المصدر: ',
          mixed(source.evidence),
          ` · آخر تحقق: ${formatTime(source.checkedAt)}`,
          source.dataDate && source.dataDate !== source.checkedAt ? ` · تاريخ البيانات: ${formatTime(source.dataDate)}` : '',
        ),
        login || setup ? h('div', { class: 'settings-row' }, login, setup) : null,
      ),
    );
  });

  const choose = h('button', { type: 'button', class: 'btn' }, 'اختيار مجلد مشروع');
  choose.addEventListener('click', async () => {
    if (await api.chooseProject()) void load();
  });
  const projectRow = h('div', { class: 'project-row' }, choose);
  if (snapshot.projectDir) {
    const clear = h('button', { type: 'button', class: 'btn quiet' }, 'إلغاء تحديد المشروع');
    clear.addEventListener('click', async () => {
      await api.clearProject();
      void load();
    });
    projectRow.prepend(h('span', {}, 'المشروع المحدد: ', ltr(snapshot.projectDir, true)));
    projectRow.append(clear);
  } else {
    projectRow.prepend(h('span', { class: 'muted' }, 'لم يُحدَّد مجلد مشروع، فتُعرض أدوات نطاق المستخدم والحساب فقط.'));
  }

  const sync = h('select', { id: 'sync', 'aria-label': 'المزامنة التلقائية' }, ...SYNC_OPTIONS.map(([minutes, label]) => h('option', { value: String(minutes) }, label)));
  sync.value = String(state.syncMinutes);
  sync.addEventListener('change', () => {
    state.syncMinutes = Number(sync.value);
    try {
      localStorage.setItem('syncMinutes', sync.value);
    } catch {
      // Storage unavailable: the choice lasts for this window only.
    }
  });
  const syncRow = h(
    'div',
    { class: 'settings-row' },
    h('label', { for: 'sync' }, 'المزامنة التلقائية'),
    sync,
    h('span', { class: 'muted' }, 'تُحدَّث البيانات أيضًا عند كل تشغيل للتطبيق.'),
  );

  el.overview.replaceChildren(
    h('h1', { class: 'overview-title' }, 'نظرة عامة'),
    h('p', { class: 'muted' }, 'اضغط أي عدد للانتقال إلى القائمة المفلترة بتلك الحالة.'),
    h('div', { class: 'overview-grid' }, ...cards),
    h('h2', { class: 'section-title' }, 'مصادر البيانات وآخر تحقق'),
    h('ul', { class: 'sources' }, ...sources),
    syncRow,
    projectRow,
  );
}

function fillSelect(select: HTMLSelectElement, allLabel: string, options: Array<[string, string]>, value: string): void {
  select.replaceChildren(
    h('option', { value: 'all' }, allLabel),
    ...options.map(([key, label]) => h('option', { value: key }, label)),
  );
  select.value = options.some(([key]) => key === value) ? value : 'all';
}

function renderFilters(): void {
  const pool = tools().filter((tool) => state.filters.kind === 'all' || tool.kind === state.filters.kind);
  const present = <T extends string>(pick: (tool: Tool) => T) => [...new Set(pool.map(pick))];
  const byLabel = (a: [string, string], b: [string, string]) => a[1].localeCompare(b[1], 'ar');

  const statuses = present((tool) => tool.status);
  fillSelect(
    el.fStatus,
    'كل الحالات',
    STATUS_ORDER.filter((status) => statuses.includes(status)).map((status) => [status, STATUS_LABEL[status]]),
    state.filters.status,
  );
  fillSelect(
    el.fCategory,
    'كل الفئات',
    present((tool) => tool.category).map((key): [string, string] => [key, categoryLabel(key)]).sort(byLabel),
    state.filters.category,
  );
  fillSelect(
    el.fSource,
    'كل المصادر',
    present((tool) => tool.source).map((key): [string, string] => [key, sourceLabel(key)]).sort(byLabel),
    state.filters.source,
  );
  fillSelect(
    el.fScope,
    'كل النطاقات',
    present((tool) => tool.scope).map((key): [string, string] => [key, SCOPE_LABEL[key]]).sort(byLabel),
    state.filters.scope,
  );
}

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'الاسم' },
  { key: 'type', label: 'النوع والفئة' },
  { key: 'status', label: 'الحالة' },
  { key: 'scope', label: 'النطاق والمصدر' },
];

function renderRow(tool: Tool): HTMLElement {
  const parent = findTool(tool.parentId ?? null);
  const nameButton = h(
    'button',
    { type: 'button', class: 'name-btn', 'data-tool': tool.id },
    tool.title !== tool.name ? h('span', {}, tool.title, ' ') : null,
    ltr(tool.name, true),
    parent ? h('span', { class: 'sub' }, 'ضمن إضافة ', ltr(parent.name)) : null,
  );
  nameButton.addEventListener('click', (event) => {
    event.stopPropagation();
    selectTool(tool.id, event.detail === 0);
  });
  const row = h(
    'tr',
    { 'aria-selected': tool.id === state.selectedId ? 'true' : 'false', 'data-kind': tool.kind, 'data-status': tool.status },
    h('td', {}, nameButton),
    h('td', {}, tool.isCommand ? 'أمر' : KIND_LABEL[tool.kind], h('span', { class: 'sub' }, categoryLabel(tool.category))),
    h('td', {}, statusBadge(tool.status)),
    h('td', {}, SCOPE_LABEL[tool.scope], h('span', { class: 'sub' }, sourceLabel(tool.source))),
  );
  row.addEventListener('click', () => selectTool(tool.id));
  return row;
}

function renderList(): void {
  el.list.hidden = state.view !== 'list';
  if (state.view !== 'list') return;

  el.listTitle.textContent = state.filters.kind === 'all' ? 'كل الأدوات' : KIND_PLURAL[state.filters.kind];
  renderFilters();

  if (!state.snapshot) {
    el.resultCount.textContent = '';
    el.tableWrap.replaceChildren(state.loading ? loadingBox() : h('div', { class: 'state-box' }, 'لا توجد بيانات معروضة بعد.'));
    return;
  }

  const rows = sortTools(applyFilters(tools(), state.filters), state.sort);
  el.resultCount.textContent = `${rows.length} نتيجة`;

  if (rows.length === 0) {
    const clear = h('button', { type: 'button', class: 'btn' }, 'مسح البحث والمرشحات');
    clear.addEventListener('click', clearFilters);
    el.tableWrap.replaceChildren(
      h('div', { class: 'state-box', 'data-state': 'empty' }, 'لا توجد أدوات تطابق البحث والمرشحات الحالية.', clear),
    );
    return;
  }

  const head = h(
    'tr',
    {},
    ...COLUMNS.map((column) => {
      const active = state.sort.key === column.key;
      const button = h(
        'button',
        { type: 'button', 'data-sort': column.key },
        column.label,
        active ? h('span', { class: 'dir' }, state.sort.dir === 'asc' ? 'تصاعدي' : 'تنازلي') : null,
      );
      button.addEventListener('click', () => {
        state.sort = { key: column.key, dir: active && state.sort.dir === 'asc' ? 'desc' : 'asc' };
        renderList();
      });
      return h('th', { scope: 'col', 'aria-sort': active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' }, button);
    }),
  );
  const scrollTop = el.tableWrap.scrollTop;
  el.tableWrap.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, ...rows.map(renderRow))));
  el.tableWrap.scrollTop = scrollTop;
}

function section(title: string, ...body: Child[]): HTMLElement {
  return h('section', {}, h('h3', {}, title), ...body);
}

function relatedList(tool: Tool): HTMLElement | null {
  const related = tool.related.map((id) => findTool(id)).filter((item): item is Tool => Boolean(item));
  if (related.length === 0) return null;
  const order: Record<ToolKind, number> = { plugin: 0, skill: 1, connector: 2 };
  related.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  const shown = related.slice(0, MAX_RELATED);
  const list = h(
    'div',
    { class: 'related' },
    ...shown.map((item) => {
      const button = h(
        'button',
        { type: 'button', 'data-related': item.id },
        h('span', {}, `${item.isCommand ? 'أمر' : KIND_LABEL[item.kind]} `, ltr(item.name)),
        statusBadge(item.status),
      );
      button.addEventListener('click', () => selectTool(item.id, true));
      return button;
    }),
  );
  return section(
    `الأدوات المرتبطة (${related.length})`,
    list,
    related.length > shown.length ? h('p', { class: 'muted' }, `و${related.length - shown.length} أدوات أخرى، ابحث باسم الإضافة لعرضها كلها.`) : null,
  );
}

function renderDetails(): void {
  const tool = state.view === 'list' ? findTool(state.selectedId) : undefined;
  el.details.hidden = !tool;
  el.app.classList.toggle('with-details', Boolean(tool));
  if (!tool) {
    el.details.replaceChildren();
    return;
  }

  const close = h('button', { type: 'button', class: 'btn quiet', 'data-close': true }, 'إغلاق');
  close.addEventListener('click', () => selectTool(null));

  const commands = tool.commands.map((command, index) => {
    const copy = h(
      'button',
      { type: 'button', class: index === 0 ? 'btn primary' : 'btn', 'data-copy': command.kind },
      COPY_LABEL[command.kind],
    );
    copy.addEventListener('click', () => void copyCommand(command.text));
    let direct: HTMLButtonElement | null = null;
    if (command.kind === 'install' && tool.install && state.snapshot?.cliVersion) {
      const busy = state.installing !== null;
      direct = h('button', { type: 'button', class: 'btn', 'data-install': true, disabled: busy }, state.installing === tool.id ? 'جارٍ التثبيت' : 'تثبيت مباشر');
      direct.addEventListener('click', () => askInstall(tool));
    }
    return h(
      'div',
      { class: 'command' },
      h('strong', {}, command.label),
      h('code', { class: 'ltr', dir: 'ltr' }, command.text),
      h('span', { class: 'where' }, mixed(command.where)),
      h('div', { class: 'actions' }, copy, direct),
    );
  });

  let docs: HTMLElement | null = null;
  if (tool.docsUrl) {
    const url = tool.docsUrl;
    docs = h('button', { type: 'button', class: 'btn', 'data-docs': true }, 'فتح التوثيق');
    docs.addEventListener('click', () => void api.open(url));
  }

  setChildren(
    el.details,
    h(
      'div',
      { class: 'details-head' },
      h('div', {}, h('h2', {}, tool.title), tool.title !== tool.name ? ltr(tool.name, true) : null),
      close,
    ),
    h(
      'div',
      { class: 'chips' },
      chip(tool.isCommand ? 'أمر' : KIND_LABEL[tool.kind]),
      statusBadge(tool.status),
      chip(SCOPE_LABEL[tool.scope]),
    ),
    tool.statusNote ? h('p', { class: 'muted', 'data-status-note': true }, mixed(tool.statusNote)) : null,
    section('الوصف', h('p', {}, mixed(tool.ar.summary))),
    tool.ar.when ? section('متى تُستخدم', h('p', {}, mixed(tool.ar.when))) : null,
    section('مثال عملي', h('p', {}, mixed(tool.ar.example))),
    tool.description
      ? section(
          tool.ar.generic ? 'الوصف الأصلي من المصدر (الصياغة العربية أعلاه عامة)' : 'الوصف الأصلي من المصدر',
          h('p', { class: 'original', lang: 'en', dir: 'ltr' }, tool.description),
        )
      : null,
    commands.length > 0 ? section('الأوامر', ...commands) : null,
    docs,
    relatedList(tool),
    section(
      'المصدر والتحقق',
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'المصدر'),
        h('dd', {}, sourceLabel(tool.source), tool.inCatalog && tool.source !== 'knowledge-work-plugins' ? '، وموجودة في كتالوج Anthropic' : ''),
        h('dt', {}, 'النطاق'),
        h('dd', {}, SCOPE_LABEL[tool.scope]),
        h('dt', {}, 'دليل الحالة'),
        h('dd', {}, mixed(tool.evidence.source)),
        h('dt', {}, 'آخر تحقق'),
        h('dd', { 'data-checked': true }, formatTime(tool.evidence.checkedAt)),
        tool.version ? h('dt', {}, 'الإصدار') : null,
        tool.version ? h('dd', {}, ltr(tool.version)) : null,
        tool.location ? h('dt', {}, tool.kind === 'connector' ? 'العنوان' : 'المسار') : null,
        tool.location ? h('dd', {}, ltr(tool.location)) : null,
      ),
    ),
  );
}

function renderChrome(): void {
  el.refresh.disabled = state.loading;
  el.refresh.textContent = state.loading ? 'جارٍ التحديث' : 'تحديث البيانات';
  el.checkedAt.textContent = state.snapshot ? `آخر تحقق: ${formatTime(state.snapshot.generatedAt)}` : '';
  el.checkedAt.dataset.checked = state.snapshot?.generatedAt ?? '';
}

function render(): void {
  renderChrome();
  renderNav();
  renderBanner();
  renderOverview();
  renderList();
  renderDetails();
}

// ---------- Events ----------

function clearFilters(): void {
  state.filters = { ...EMPTY_FILTERS, kind: state.filters.kind };
  el.search.value = '';
  render();
}

el.search.addEventListener('input', () => {
  state.filters.query = el.search.value;
  if (state.view === 'overview' && el.search.value.trim()) {
    showList('all');
    return;
  }
  renderList();
  renderDetails();
});

el.fStatus.addEventListener('change', () => {
  state.filters.status = el.fStatus.value as ToolStatus | 'all';
  renderList();
});
el.fCategory.addEventListener('change', () => {
  state.filters.category = el.fCategory.value;
  renderList();
});
el.fSource.addEventListener('change', () => {
  state.filters.source = el.fSource.value;
  renderList();
});
el.fScope.addEventListener('change', () => {
  state.filters.scope = el.fScope.value as ToolScope | 'all';
  renderList();
});
el.clear.addEventListener('click', clearFilters);
el.refresh.addEventListener('click', () => void load());

el.confirmNo.addEventListener('click', () => el.confirm.close());
el.confirmYes.addEventListener('click', () => {
  const tool = pendingInstall;
  el.confirm.close();
  if (tool) void runInstall(tool);
});
el.confirm.addEventListener('close', () => {
  pendingInstall = null;
});

// Automatic sync: refresh once the data is older than the chosen interval.
window.setInterval(() => {
  if (state.syncMinutes === 0 || state.loading || state.installing || el.confirm.open || !state.snapshot) return;
  const age = Date.now() - Date.parse(state.snapshot.generatedAt);
  if (age >= state.syncMinutes * 60000) void load();
}, 30000);

document.addEventListener('keydown', (event) => {
  if (el.confirm.open) return;
  if (event.key === 'Escape' && state.selectedId) {
    selectTool(null);
  } else if (event.key === '/' && document.activeElement !== el.search && !(document.activeElement instanceof HTMLSelectElement)) {
    event.preventDefault();
    el.search.focus();
  }
});

// ---------- Theme ----------

function storedTheme(): string | null {
  try {
    return localStorage.getItem('theme');
  } catch {
    return null;
  }
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  el.theme.textContent = theme === 'dark' ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن';
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
}

el.theme.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

const saved = storedTheme();
applyTheme(saved === 'dark' || saved === 'light' ? saved : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

void load();
