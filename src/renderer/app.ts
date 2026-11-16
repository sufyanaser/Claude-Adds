import { findAlternatives } from '../shared/alternatives';
import {
  CAPABILITY_LABEL,
  COPY_LABEL,
  DESTINATION_LABEL,
  ENVS,
  KINDS,
  KIND_LABEL,
  KIND_PLURAL,
  PLAN_KIND_LABEL,
  SCOPE_LABEL,
  STATUS_LABEL,
  STATUS_MEANING,
  STATUS_ORDER,
  STATUS_TONE,
  categoryLabel,
  envLabel,
  sourceLabel,
  type Tone,
} from '../shared/labels';
import { EMPTY_FILTERS, searchGroups, sortTools, statusIn, summarize, type Filters, type Sort, type SortKey } from '../shared/query';
import type {
  ActionResult,
  BackupResult,
  ClaudeAddsApi,
  UpdateState,
  EnvId,
  InstallPlan,
  PlanDestination,
  PlanItem,
  PlanPick,
  PlanResult,
  Snapshot,
  SourceHealth,
  Tool,
  ToolKind,
  ToolStatus,
} from '../shared/types';

declare global {
  interface Window {
    claudeAdds: ClaudeAddsApi;
  }
}

const api = window.claudeAdds;
const MAX_RELATED = 60;
type View = 'mine' | 'catalog' | 'platforms';

interface PlanState {
  step: 'input' | 'loading' | 'plan';
  url: string;
  error: string | null;
  plan: InstallPlan | null;
  picks: Set<string>;
  results: Map<string, PlanResult>;
  running: boolean;
}

interface State {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  view: View;
  filters: Filters;
  sort: Sort;
  selectedId: string | null;
  /** Outcome of the last sign-in action, shown until dismissed. */
  result: ActionResult | null;
  /** Minutes between automatic refreshes. 0 turns it off. */
  syncMinutes: number;
  plan: PlanState;
  update: UpdateState | null;
  backupDir: string | null;
  backup: BackupResult | null;
  backingUp: boolean;
}

const SYNC_OPTIONS: Array<[number, string]> = [
  [0, 'متوقفة'],
  [5, 'كل 5 دقائق'],
  [15, 'كل 15 دقيقة'],
  [60, 'كل ساعة'],
];

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
}

function storedSync(): number {
  const value = Number(stored('syncMinutes') ?? '15');
  return SYNC_OPTIONS.some(([minutes]) => minutes === value) ? value : 15;
}

const emptyPlan = (): PlanState => ({ step: 'input', url: '', error: null, plan: null, picks: new Set(), results: new Map(), running: false });

const state: State = {
  snapshot: null,
  loading: true,
  error: null,
  view: 'mine',
  filters: { ...EMPTY_FILTERS },
  sort: { key: 'name', dir: 'asc' },
  selectedId: null,
  result: null,
  syncMinutes: storedSync(),
  plan: emptyPlan(),
  update: null,
  backupDir: null,
  backup: null,
  backingUp: false,
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

function button(content: Child | Child[], attrs: Record<string, string | boolean | undefined>, onClick: () => void): HTMLButtonElement {
  const node = h('button', { type: 'button', ...attrs }, ...(Array.isArray(content) ? content : [content]));
  node.addEventListener('click', onClick);
  return node;
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
    const lead = /^[^A-Za-z0-9(/~."'\\$-]+/.exec(part)?.[0] ?? '';
    const tail = /[^A-Za-z0-9)/"'\\*+]+$/.exec(part.slice(lead.length))?.[0] ?? '';
    const body = part.slice(lead.length, part.length - tail.length);
    fragment.append(lead, h('bdi', { class: 'lat', dir: 'ltr' }, body), tail);
  }
  return fragment;
}

function badge(label: string, tone: Tone): HTMLElement {
  return h('span', { class: 'badge', 'data-tone': tone }, label);
}

/** Label chip without the status dot, for kind, scope and environment. */
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
  envbar: byId('envbar'),
  search: byId<HTMLInputElement>('search'),
  refresh: byId<HTMLButtonElement>('refresh'),
  addTool: byId<HTMLButtonElement>('add-tool'),
  checkedAt: byId('checked-at'),
  banner: byId('banner'),
  list: byId('list'),
  listTitle: byId('list-title'),
  resultCount: byId('result-count'),
  summary: byId('summary'),
  tableWrap: byId('table-wrap'),
  platforms: byId('platforms'),
  details: byId('details'),
  toast: byId('toast'),
  theme: byId<HTMLButtonElement>('theme-toggle'),
  clear: byId<HTMLButtonElement>('clear-filters'),
  fKind: byId<HTMLSelectElement>('f-kind'),
  fStatus: byId<HTMLSelectElement>('f-status'),
  fCategory: byId<HTMLSelectElement>('f-category'),
  fSource: byId<HTMLSelectElement>('f-source'),
  fScope: byId<HTMLSelectElement>('f-scope'),
  plan: byId<HTMLDialogElement>('plan'),
  planBody: byId('plan-body'),
  planActions: byId('plan-actions'),
};

function tools(): Tool[] {
  return state.snapshot?.tools ?? [];
}

function findTool(id: string | null): Tool | undefined {
  return id ? tools().find((tool) => tool.id === id) : undefined;
}

// ---------- Actions ----------

function showView(view: View): void {
  state.view = view;
  state.selectedId = null;
  if (view !== 'platforms') state.filters = { ...EMPTY_FILTERS, view, env: state.filters.env, query: state.filters.query };
  render();
}

function setEnv(env: EnvId | 'all'): void {
  state.filters = { ...state.filters, env, status: 'all', category: 'all', source: 'all', scope: 'all' };
  if (state.view === 'platforms') state.view = 'mine';
  state.selectedId = null;
  render();
}

function selectTool(id: string | null, focusPanel = false): void {
  const previous = state.selectedId;
  state.selectedId = id;
  const tool = findTool(id);
  if (tool && state.view === 'platforms') {
    state.view = tool.mine ? 'mine' : 'catalog';
    state.filters = { ...EMPTY_FILTERS, view: state.view };
  }
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

let pendingLoads = 0;

async function load(): Promise<void> {
  // Several refreshes can overlap (an install finishing during a refresh).
  // The view stays "loading" until the last one returns.
  pendingLoads++;
  state.loading = true;
  state.error = null;
  render();
  try {
    state.snapshot = await api.load();
    if (state.selectedId && !findTool(state.selectedId)) state.selectedId = null;
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  }
  pendingLoads--;
  state.loading = pendingLoads > 0;
  render();
}

// ---------- Install plan ----------

const pickKey = (itemId: string, env: EnvId) => `${itemId}|${env}`;

function openGitPlan(): void {
  state.plan = emptyPlan();
  renderPlan();
  el.plan.showModal();
  el.plan.querySelector<HTMLInputElement>('#plan-url')?.focus();
}

async function inspectUrl(): Promise<void> {
  state.plan.step = 'loading';
  state.plan.error = null;
  renderPlan();
  const response = await api.planFromGit(state.plan.url);
  if (response.ok) acceptPlan(response.plan);
  else {
    state.plan.step = 'input';
    state.plan.error = response.message;
  }
  renderPlan();
}

async function openToolPlan(tool: Tool): Promise<void> {
  state.plan = { ...emptyPlan(), step: 'loading' };
  renderPlan();
  el.plan.showModal();
  const response = await api.planFromTool(tool.id);
  if (response.ok) acceptPlan(response.plan);
  else {
    state.plan.step = 'input';
    state.plan.error = response.message;
  }
  renderPlan();
}

function acceptPlan(plan: InstallPlan): void {
  state.plan.plan = plan;
  state.plan.step = 'plan';
  state.plan.picks = new Set();
  state.plan.results = new Map();
  // A single-item plan with one ready destination starts ticked; larger plans start empty.
  const ready = plan.items.flatMap((item) => item.destinations.filter((d) => d.state === 'ready').map((d) => pickKey(item.id, d.env)));
  if (ready.length === 1 && ready[0]) state.plan.picks.add(ready[0]);
}

async function runPicks(picks: PlanPick[]): Promise<void> {
  const plan = state.plan.plan;
  if (!plan || picks.length === 0) return;
  state.plan.running = true;
  renderPlan();
  const results = await api.runPlan(plan.id, picks);
  for (const result of results) {
    state.plan.results.set(pickKey(result.itemId, result.env), result);
    if (result.ok) {
      state.plan.picks.delete(pickKey(result.itemId, result.env));
      const destination = plan.items.find((item) => item.id === result.itemId)?.destinations.find((d) => d.env === result.env);
      if (destination) destination.state = 'exists';
    }
  }
  state.plan.running = false;
  renderPlan();
  // Re-inventory so the installed tool shows up in "my tools".
  if (results.some((result) => result.ok)) void load();
}

function destinationRow(item: PlanItem, destination: PlanDestination): HTMLElement {
  const id = pickKey(item.id, destination.env);
  const result = state.plan.results.get(id);
  const info = DESTINATION_LABEL[destination.state];
  const box = h('input', { type: 'checkbox', 'data-pick': id, 'aria-label': `${item.name}: ${envLabel(destination.env)}`, disabled: destination.state !== 'ready' || state.plan.running });
  box.checked = state.plan.picks.has(id);
  box.addEventListener('change', () => {
    if (box.checked) state.plan.picks.add(id);
    else state.plan.picks.delete(id);
    renderPlanActions();
  });

  const extras: Child[] = [];
  if (destination.detail) extras.push(h('code', { class: 'ltr', dir: 'ltr' }, destination.detail));
  if (destination.state === 'needs-completion') {
    const detail = destination.detail;
    const url = destination.officialUrl;
    extras.push(
      h(
        'div',
        { class: 'actions' },
        detail && /^[a-z]+ /.test(detail) ? button('نسخ الأمر', { class: 'btn' }, () => void copyCommand(detail)) : null,
        url ? button('فتح المسار الرسمي', { class: 'btn', 'data-official': destination.env }, () => void api.open(url)) : null,
      ),
    );
  }
  if (result) {
    extras.push(
      h(
        'div',
        { class: 'plan-result', 'data-result': result.ok ? (result.verified ? 'verified' : 'unverified') : 'failed', 'data-result-env': destination.env },
        badge(result.ok ? (result.verified ? 'تم وتحقق' : 'تم دون تحقق') : 'فشل', result.ok ? (result.verified ? 'ok' : 'warn') : 'danger'),
        h('span', {}, mixed(result.message)),
        !result.ok ? button('إعادة المحاولة لهذه الوجهة', { class: 'btn', 'data-retry': id, disabled: state.plan.running }, () => void runPicks([{ itemId: item.id, env: destination.env }])) : null,
      ),
    );
  }

  return h(
    'li',
    { class: 'dest', 'data-dest': destination.env, 'data-dest-state': destination.state },
    h('label', { class: 'dest-head' }, box, h('strong', {}, envLabel(destination.env)), badge(info.label, info.tone)),
    h('div', { class: 'dest-body' }, h('div', {}, destination.action, destination.scope ? ` · النطاق: ${destination.scope}` : ''), h('div', { class: 'muted' }, 'دليل التوافق: ', mixed(destination.evidence)), ...extras),
  );
}

function renderPlanActions(): void {
  const { plan, running, picks, step } = state.plan;
  const close = button('إغلاق', { class: 'btn', 'data-plan-close': true }, () => el.plan.close());
  if (step !== 'plan' || !plan) {
    setChildren(el.planActions, close);
    return;
  }
  const chosen: PlanPick[] = plan.items.flatMap((item) => item.destinations.filter((d) => picks.has(pickKey(item.id, d.env))).map((d) => ({ itemId: item.id, env: d.env })));
  setChildren(
    el.planActions,
    button(running ? 'جارٍ التثبيت' : `تثبيت الوجهات المحددة (${chosen.length})`, { class: 'btn primary', 'data-plan-run': true, disabled: running || chosen.length === 0 }, () => void runPicks(chosen)),
    close,
  );
}

function renderPlan(): void {
  const { step, plan, error } = state.plan;
  if (step === 'loading') {
    setChildren(el.planBody, h('p', { role: 'status', 'data-plan-state': 'loading' }, 'جارٍ تنزيل المصدر وفحص محتواه.'));
  } else if (step === 'input' || !plan) {
    const input = h('input', { id: 'plan-url', type: 'url', dir: 'ltr', placeholder: 'https://github.com/owner/repo', autocomplete: 'off', spellcheck: 'false' });
    input.value = state.plan.url;
    input.addEventListener('input', () => {
      state.plan.url = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void inspectUrl();
    });
    setChildren(
      el.planBody,
      h('p', {}, mixed('الصق رابط https لمستودع Git. يُنزَّل إلى مجلد مؤقت وتُقرأ ملفاته كبيانات، ولا يُشغَّل أي شيء منه. لا يتغير شيء قبل أن تختار الوجهات وتؤكد.')),
      h('label', { class: 'field' }, 'رابط المستودع', input),
      error ? h('p', { class: 'warn', role: 'alert', 'data-plan-error': true }, mixed(error)) : null,
      button('فحص الرابط', { class: 'btn primary', 'data-plan-inspect': true }, () => void inspectUrl()),
    );
  } else {
    setChildren(
      el.planBody,
      h('p', {}, 'المصدر: ', ltr(plan.source)),
      plan.thirdParty ? h('p', { class: 'warn', 'data-third-party': true }, mixed('هذا المصدر يستضيفه طرف خارجي خارج مستودعات Anthropic. ثبّت منه فقط إن كنت تثق به.')) : null,
      plan.note ? h('p', { class: 'muted' }, plan.note) : null,
      h(
        'ul',
        { class: 'plan-items' },
        ...plan.items.map((item) =>
          h(
            'li',
            { class: 'plan-item', 'data-item': item.id },
            h('div', { class: 'plan-item-head' }, chip(PLAN_KIND_LABEL[item.kind]), h('strong', {}, ltr(item.name)), h('span', { class: 'muted' }, ltr(item.path))),
            item.description ? h('p', { class: 'original', lang: 'en', dir: 'auto' }, item.description) : null,
            h('ul', { class: 'dests' }, ...item.destinations.map((destination) => destinationRow(item, destination))),
          ),
        ),
      ),
    );
  }
  renderPlanActions();
}

// ---------- Rendering ----------

const NAV: Array<{ key: View; label: string }> = [
  { key: 'mine', label: 'أدواتي' },
  { key: 'catalog', label: 'الكتالوج' },
  { key: 'platforms', label: 'المنصات والمصادر' },
];

function renderNav(): void {
  const counts: Partial<Record<View, number>> = {
    mine: tools().filter((tool) => tool.mine).length,
    catalog: tools().filter((tool) => !tool.mine).length,
  };
  el.nav.replaceChildren(
    ...NAV.map((item) => {
      const count = state.snapshot ? counts[item.key] : undefined;
      return h(
        'li',
        {},
        button(
          [h('span', {}, item.label), count !== undefined ? h('span', { class: 'count' }, String(count)) : null],
          { 'aria-current': state.view === item.key ? 'page' : undefined, 'data-nav': item.key },
          () => showView(item.key),
        ),
      );
    }),
  );
}

function renderEnvBar(): void {
  const mine = tools().filter((tool) => tool.mine);
  const entries: Array<{ id: EnvId | 'all'; label: string; count: number }> = [
    { id: 'all', label: 'الكل', count: mine.length },
    ...ENVS.map((env) => ({ id: env.id, label: env.label, count: mine.filter((tool) => tool.envs.some((p) => p.env === env.id)).length })),
  ];
  el.envbar.replaceChildren(
    ...entries.map((entry) =>
      button(
        [h('bdi', { dir: 'auto' }, entry.label), state.snapshot ? h('span', { class: 'count' }, String(entry.count)) : null],
        { 'data-env': entry.id, 'aria-pressed': state.filters.env === entry.id ? 'true' : 'false' },
        () => setEnv(entry.id),
      ),
    ),
  );
}

const SOURCE_STATE: Record<SourceHealth['state'], { label: string; tone: Tone }> = {
  ok: { label: 'سليم', tone: 'ok' },
  degraded: { label: 'جزئي', tone: 'warn' },
  failed: { label: 'متعذّر', tone: 'danger' },
};

function renderBanner(): void {
  const notices: HTMLElement[] = [];
  if (state.error) {
    notices.push(
      h('div', { class: 'notice', 'data-tone': 'danger', role: 'alert' }, h('strong', {}, 'تعذّر تحميل البيانات:'), ltr(state.error), button('إعادة المحاولة', { class: 'btn' }, () => void load())),
    );
  }
  if (state.result) {
    notices.push(
      h(
        'div',
        { class: 'notice', 'data-tone': state.result.ok ? 'ok' : 'danger', role: 'status' },
        h('span', {}, mixed(state.result.message)),
        button('إخفاء', { class: 'btn' }, () => {
          state.result = null;
          renderBanner();
        }),
      ),
    );
  }
  const update = state.update;
  if (update?.status === 'ready' && update.latest) {
    notices.push(
      h(
        'div',
        { class: 'notice', 'data-tone': 'ok', 'data-update-notice': 'ready', role: 'status' },
        h('span', {}, mixed(`الإصدار ${update.latest} نُزّل وجاهز. يُثبَّت عند إغلاق التطبيق.`)),
        button('إعادة التشغيل والتحديث الآن', { class: 'btn', 'data-update-install': true }, () => void api.updateInstall()),
      ),
    );
  } else if (update?.status === 'available' && update.latest && update.mode === 'manual') {
    const url = update.url;
    notices.push(
      h(
        'div',
        { class: 'notice', 'data-tone': 'ok', 'data-update-notice': 'available', role: 'status' },
        h('span', {}, mixed(`يتوفر الإصدار ${update.latest}. هذه النسخة لا تحدّث نفسها.`)),
        url ? button('فتح صفحة الإصدار', { class: 'btn' }, () => void api.open(url)) : null,
      ),
    );
  }
  const unhealthy = (state.snapshot?.sources ?? []).filter((source) => source.state !== 'ok');
  if (unhealthy.length > 0) {
    const failed = unhealthy.some((source) => source.state === 'failed');
    const names = unhealthy.map((source) => `${source.label}: ${SOURCE_STATE[source.state].label}`).join('، ');
    const stale = unhealthy.filter((source) => source.dataDate).map((source) => `${source.label} بتاريخ ${formatTime(source.dataDate ?? '')}`);
    notices.push(
      h(
        'div',
        { class: 'notice', 'data-tone': failed ? 'danger' : 'warn', 'data-sources-notice': true, role: 'status' },
        h('strong', {}, 'بيانات غير مكتملة:'),
        h('span', {}, mixed(`${names}.`)),
        stale.length > 0 ? h('span', { 'data-stale': true }, mixed(`آخر نتيجة ناجحة معروضة: ${stale.join('، ')}.`)) : null,
        state.view !== 'platforms' ? button('السبب ومسار الإعداد', { class: 'btn', 'data-sources-link': true }, () => showView('platforms')) : null,
      ),
    );
  }
  el.banner.replaceChildren(...notices);
}

function loadingBox(): HTMLElement {
  return h('div', { class: 'state-box', role: 'status', 'data-state': 'loading' }, 'جارٍ جرد الأدوات في كل المنصات وتحميل الكتالوج. قد يستغرق فحص الموصلات نحو نصف دقيقة.');
}

function fillSelect(select: HTMLSelectElement, allLabel: string, options: Array<[string, string]>, value: string): void {
  select.replaceChildren(h('option', { value: 'all' }, allLabel), ...options.map(([key, label]) => h('option', { value: key }, label)));
  select.value = options.some(([key]) => key === value) ? value : 'all';
}

function pool(): Tool[] {
  const mine = state.filters.view === 'mine';
  return tools().filter((tool) => tool.mine === mine && (state.filters.env === 'all' || tool.envs.some((p) => p.env === state.filters.env)));
}

function renderFilters(): void {
  const base = pool();
  const ofKind = base.filter((tool) => state.filters.kind === 'all' || tool.kind === state.filters.kind);
  const present = <T extends string>(list: Tool[], pick: (tool: Tool) => T) => [...new Set(list.map(pick))];
  const byLabel = (a: [string, string], b: [string, string]) => a[1].localeCompare(b[1], 'ar');

  const kinds = present(base, (tool) => tool.kind);
  fillSelect(el.fKind, 'كل الأنواع', KINDS.filter((kind) => kinds.includes(kind)).map((kind) => [kind, KIND_PLURAL[kind]]), state.filters.kind);
  const statuses = present(ofKind, (tool) => statusIn(tool, state.filters.env));
  fillSelect(el.fStatus, 'كل الحالات', STATUS_ORDER.filter((status) => statuses.includes(status)).map((status) => [status, STATUS_LABEL[status]]), state.filters.status);
  fillSelect(el.fCategory, 'كل الفئات', present(ofKind, (tool) => tool.category).map((key): [string, string] => [key, categoryLabel(key)]).sort(byLabel), state.filters.category);
  fillSelect(el.fSource, 'كل المصادر', present(ofKind, (tool) => tool.source).map((key): [string, string] => [key, sourceLabel(key)]).sort(byLabel), state.filters.source);
  fillSelect(el.fScope, 'كل النطاقات', present(ofKind, (tool) => tool.scope).map((key): [string, string] => [key, SCOPE_LABEL[key]]).sort(byLabel), state.filters.scope);
}

function renderSummary(): void {
  const groups = summarize(pool(), state.filters.env).filter((group) => group.total > 0);
  el.summary.replaceChildren(
    ...groups.map((group) =>
      h(
        'div',
        { class: 'sum-group' },
        button(
          [`${KIND_PLURAL[group.kind]} `, h('b', {}, String(group.total))],
          { class: 'sum-kind', 'data-count-kind': group.kind, 'aria-pressed': state.filters.kind === group.kind && state.filters.status === 'all' ? 'true' : 'false' },
          () => {
            state.filters = { ...state.filters, kind: group.kind, status: 'all' };
            render();
          },
        ),
        ...group.statuses.map(({ status, count }) =>
          button(
            [statusBadge(status), h('span', { class: 'n' }, String(count))],
            {
              class: 'sum-status',
              'data-count-kind': group.kind,
              'data-count-status': status,
              'aria-label': `${KIND_PLURAL[group.kind]}، ${STATUS_LABEL[status]}: ${count}`,
              'aria-pressed': state.filters.kind === group.kind && state.filters.status === status ? 'true' : 'false',
            },
            () => {
              state.filters = { ...state.filters, kind: group.kind, status };
              render();
            },
          ),
        ),
      ),
    ),
  );
}

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'الاسم' },
  { key: 'type', label: 'النوع والفئة' },
  { key: 'status', label: 'الحالة' },
  { key: 'scope', label: 'البيئة والنطاق' },
];

function renderRow(tool: Tool): HTMLElement {
  const parent = findTool(tool.parentId ?? null);
  const status = statusIn(tool, state.filters.env);
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
  const envs = [...new Set(tool.envs.map((placement) => envLabel(placement.env)))].join('، ');
  const row = h(
    'tr',
    { 'aria-selected': tool.id === state.selectedId ? 'true' : 'false', 'data-kind': tool.kind, 'data-status': status, 'data-mine': tool.mine ? 'true' : 'false' },
    h('td', {}, nameButton),
    h('td', {}, KIND_LABEL[tool.kind], h('span', { class: 'sub' }, categoryLabel(tool.category))),
    h('td', {}, statusBadge(status)),
    h('td', {}, h('bdi', { dir: 'auto' }, envs || 'غير معلوم'), h('span', { class: 'sub' }, `${SCOPE_LABEL[tool.scope]} · ${sourceLabel(tool.source)}`)),
  );
  row.addEventListener('click', () => selectTool(tool.id));
  return row;
}

function groupRow(label: string, count: number, group: string): HTMLElement {
  return h('tr', { class: 'group', 'data-group': group }, h('th', { colspan: '4', scope: 'colgroup' }, `${label} (${count})`));
}

function emptyBox(): HTMLElement {
  const platform = state.snapshot?.platforms.find((p) => p.env === state.filters.env);
  const inventory = platform?.capabilities.find((c) => c.key === 'inventory');
  if (platform && inventory && inventory.state !== 'verified' && !state.filters.query.trim()) {
    return h(
      'div',
      { class: 'state-box', 'data-state': 'no-inventory' },
      h('strong', {}, mixed(`${envLabel(platform.env)}: ${CAPABILITY_LABEL[inventory.state].label}`)),
      h('span', {}, mixed(inventory.detail)),
      h(
        'div',
        { class: 'actions' },
        button('فتح المسار الرسمي', { class: 'btn', 'data-official': platform.env }, () => void api.open(platform.officialUrl)),
        button('قدرات هذه المنصة', { class: 'btn' }, () => showView('platforms')),
      ),
    );
  }
  return h('div', { class: 'state-box', 'data-state': 'empty' }, 'لا توجد أدوات تطابق البحث والمرشحات الحالية.', button('مسح البحث والمرشحات', { class: 'btn' }, clearFilters));
}

function renderList(): void {
  const listing = state.view !== 'platforms';
  el.list.hidden = !listing;
  if (!listing) return;

  const scope = state.filters.env === 'all' ? '' : `، ${envLabel(state.filters.env)}`;
  setChildren(el.listTitle, mixed(`${state.view === 'mine' ? 'أدواتي' : 'الكتالوج'}${scope}`));
  renderFilters();
  renderSummary();

  if (!state.snapshot) {
    el.resultCount.textContent = '';
    el.tableWrap.replaceChildren(state.loading ? loadingBox() : h('div', { class: 'state-box' }, 'لا توجد بيانات معروضة بعد.'));
    return;
  }

  const groups = searchGroups(tools(), state.filters);
  const mine = sortTools(groups.mine, state.sort, state.filters.env);
  const catalog = sortTools(groups.catalog, state.sort, state.filters.env);
  const total = mine.length + catalog.length;
  el.resultCount.textContent = `${total} نتيجة`;

  if (total === 0) {
    el.tableWrap.replaceChildren(emptyBox());
    return;
  }

  const head = h(
    'tr',
    {},
    ...COLUMNS.map((column) => {
      const active = state.sort.key === column.key;
      return h(
        'th',
        { scope: 'col', 'aria-sort': active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
        button(
          [column.label, active ? h('span', { class: 'dir' }, state.sort.dir === 'asc' ? 'تصاعدي' : 'تنازلي') : null],
          { 'data-sort': column.key },
          () => {
            state.sort = { key: column.key, dir: active && state.sort.dir === 'asc' ? 'desc' : 'asc' };
            renderList();
          },
        ),
      );
    }),
  );

  // With a query on the home screen, the user's own tools come first, then the catalog.
  const grouped = state.view === 'mine' && state.filters.query.trim() !== '';
  const body: HTMLElement[] = [];
  if (grouped) {
    body.push(groupRow('أدواتي', mine.length, 'mine'));
    if (mine.length === 0) body.push(h('tr', { class: 'group-empty' }, h('td', { colspan: '4' }, 'لا شيء من أدواتك يطابق البحث.')));
  }
  body.push(...mine.map(renderRow));
  if (grouped && catalog.length > 0) body.push(groupRow('من الكتالوج، غير مثبّتة عندك', catalog.length, 'catalog'));
  body.push(...catalog.map(renderRow));

  const scrollTop = el.tableWrap.scrollTop;
  el.tableWrap.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, ...body)));
  el.tableWrap.scrollTop = scrollTop;
}

function section(title: string, ...body: Child[]): HTMLElement {
  return h('section', {}, h('h3', {}, title), ...body);
}

function relatedList(tool: Tool): HTMLElement | null {
  const related = tool.related.map((id) => findTool(id)).filter((item): item is Tool => Boolean(item));
  if (related.length === 0) return null;
  const order: Record<ToolKind, number> = { plugin: 0, skill: 1, command: 2, connector: 3 };
  related.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  const shown = related.slice(0, MAX_RELATED);
  return section(
    `مكوّنات مرتبطة (${related.length})`,
    h(
      'div',
      { class: 'related' },
      ...shown.map((item) =>
        button(
          [h('span', {}, `${KIND_LABEL[item.kind]} `, ltr(item.name)), statusBadge(item.status)],
          { 'data-related': item.id },
          () => selectTool(item.id, true),
        ),
      ),
    ),
    related.length > shown.length ? h('p', { class: 'muted' }, `و${related.length - shown.length} أخرى، ابحث باسم الإضافة لعرضها كلها.`) : null,
  );
}

function alternativesList(tool: Tool): HTMLElement | null {
  const alternatives = findAlternatives(tool, tools());
  if (alternatives.length === 0) return null;
  return section(
    tool.mine ? 'أدوات أخرى عندك تغطي الحاجة نفسها' : 'عندك بديل يغطي الحاجة نفسها',
    h(
      'div',
      { class: 'related', 'data-alternatives': true },
      ...alternatives.map(({ tool: other, reason }) =>
        button(
          [h('span', {}, `${KIND_LABEL[other.kind]} `, ltr(other.name), h('span', { class: 'sub' }, mixed(reason))), statusBadge(other.status)],
          { 'data-alternative': other.id },
          () => selectTool(other.id, true),
        ),
      ),
    ),
  );
}

function placementsTable(tool: Tool): HTMLElement {
  return section(
    'الحالة حسب البيئة والنطاق',
    h(
      'ul',
      { class: 'placements' },
      ...tool.envs.map((placement) =>
        h(
          'li',
          { 'data-placement': placement.env, 'data-placement-status': placement.status },
          h('div', { class: 'placement-head' }, h('strong', {}, h('bdi', { dir: 'auto' }, envLabel(placement.env))), chip(SCOPE_LABEL[placement.scope]), statusBadge(placement.status)),
          h('div', { class: 'muted' }, STATUS_MEANING[placement.status], ' الدليل: ', mixed(placement.evidence)),
        ),
      ),
    ),
  );
}

function renderDetails(): void {
  const tool = state.view !== 'platforms' ? findTool(state.selectedId) : undefined;
  el.details.hidden = !tool;
  el.app.classList.toggle('with-details', Boolean(tool));
  if (!tool) {
    el.details.replaceChildren();
    return;
  }

  const commands = tool.commands.map((command, index) =>
    h(
      'div',
      { class: 'command' },
      h('strong', {}, command.label),
      h('code', { class: 'ltr', dir: 'ltr' }, command.text),
      h('span', { class: 'where' }, mixed(command.where)),
      h(
        'div',
        { class: 'actions' },
        button(COPY_LABEL[command.kind], { class: index === 0 && !tool.install ? 'btn primary' : 'btn', 'data-copy': command.kind }, () => void copyCommand(command.text)),
      ),
    ),
  );

  const docsUrl = tool.docsUrl;
  setChildren(
    el.details,
    h(
      'div',
      { class: 'details-head' },
      h('div', {}, h('h2', {}, tool.title), tool.title !== tool.name ? ltr(tool.name, true) : null),
      button('إغلاق', { class: 'btn quiet', 'data-close': true }, () => selectTool(null)),
    ),
    h('div', { class: 'chips' }, chip(KIND_LABEL[tool.kind]), statusBadge(statusIn(tool, state.filters.env)), chip(tool.mine ? 'من أدواتي' : 'من الكتالوج')),
    tool.statusNote ? h('p', { class: 'muted', 'data-status-note': true }, mixed(tool.statusNote)) : null,
    tool.install
      ? h(
          'div',
          { class: 'install-box' },
          button('تثبيت: عرض الخطة والوجهات', { class: 'btn primary', 'data-install': true }, () => void openToolPlan(tool)),
          h('span', { class: 'muted' }, 'لا يتغير شيء قبل تأكيدك.'),
        )
      : null,
    section('وظيفتها', h('p', {}, mixed(tool.ar.summary))),
    tool.ar.when ? section('متى تُستخدم', h('p', {}, mixed(tool.ar.when))) : null,
    section('مثال عملي', h('p', {}, mixed(tool.ar.example))),
    tool.description
      ? section(tool.ar.generic ? 'الوصف الأصلي من المصدر (الصياغة العربية أعلاه عامة)' : 'الوصف الأصلي من المصدر', h('p', { class: 'original', lang: 'en', dir: 'ltr' }, tool.description))
      : null,
    placementsTable(tool),
    alternativesList(tool),
    commands.length > 0 ? section('الأوامر', ...commands) : null,
    docsUrl ? button('فتح التوثيق', { class: 'btn', 'data-docs': true }, () => void api.open(docsUrl)) : null,
    relatedList(tool),
    section(
      'المصدر والتحقق',
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'المصدر'),
        h('dd', {}, mixed(sourceLabel(tool.source)), tool.inCatalog && tool.source !== 'knowledge-work-plugins' ? '، وموجودة في كتالوج Anthropic' : ''),
        h('dt', {}, 'المعرّف'),
        h('dd', {}, ltr(tool.id)),
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

const UPDATE_STATUS: Record<UpdateState['status'], (update: UpdateState) => string> = {
  idle: () => 'لم يُفحص بعد في هذه الجلسة.',
  checking: () => 'جارٍ التحقق من الإصدارات.',
  none: () => 'أنت على أحدث إصدار في هذه القناة.',
  available: (update) =>
    update.mode === 'manual'
      ? `يتوفر الإصدار ${update.latest ?? ''}. هذه النسخة محمولة أو على macOS فلا تحدّث نفسها، فنزّل الإصدار من صفحته.`
      : `يتوفر الإصدار ${update.latest ?? ''}. فعّل التحديث التلقائي أو تحقق مجددًا لتنزيله.`,
  downloading: (update) => `جارٍ تنزيل مُثبِّت الإصدار ${update.latest ?? ''}.`,
  ready: (update) => `الإصدار ${update.latest ?? ''} نُزّل وجاهز. يُثبَّت عند إغلاق التطبيق، أو الآن بزر إعادة التشغيل.`,
  error: () => 'تعذّر التحقق من التحديثات.',
};

function updateCard(): HTMLElement | null {
  const update = state.update;
  if (!update) return null;
  const channel = h(
    'select',
    { id: 'update-channel', 'aria-label': 'قناة التحديث' },
    h('option', { value: 'stable' }, 'مستقرة: الإصدارات الرسمية فقط'),
    h('option', { value: 'dev' }, 'تطويرية: مع كل تحديث على المستودع'),
  );
  channel.value = update.channel;
  channel.addEventListener('change', () => void api.updatePrefs({ channel: channel.value === 'dev' ? 'dev' : 'stable' }));
  const auto = h('input', { type: 'checkbox', id: 'update-auto' });
  auto.checked = update.auto;
  auto.addEventListener('change', () => void api.updatePrefs({ auto: auto.checked }));
  const url = update.url;
  const busy = update.status === 'checking' || update.status === 'downloading';
  return h(
    'div',
    { class: 'platform', 'data-card': 'update', 'data-update-status': update.status, 'data-update-mode': update.mode },
    h('div', { class: 'platform-head' }, h('h2', {}, 'تحديث التطبيق'), ltr(update.current, true)),
    h('div', { class: 'settings-row' }, h('label', { for: 'update-channel' }, 'القناة'), channel),
    h('label', { class: 'check' }, auto, 'تنزيل التحديث وتثبيته تلقائيًا'),
    h('p', { 'data-update-text': true }, mixed(UPDATE_STATUS[update.status](update))),
    update.message ? h('p', { class: 'muted' }, mixed(update.message)) : null,
    update.checkedAt ? h('p', { class: 'muted' }, `آخر تحقق: ${formatTime(update.checkedAt)}`) : null,
    h(
      'div',
      { class: 'actions' },
      button(busy ? 'جارٍ التحقق' : 'التحقق الآن', { class: 'btn', 'data-update-check': true, disabled: busy }, () => void api.updateCheck()),
      update.status === 'ready' ? button('إعادة التشغيل والتحديث الآن', { class: 'btn primary', 'data-update-install': true }, () => void api.updateInstall()) : null,
      update.status === 'available' && url ? button('فتح صفحة الإصدار', { class: 'btn' }, () => void api.open(url)) : null,
    ),
  );
}

async function chooseBackupDir(): Promise<void> {
  const chosen = await api.chooseBackupDir();
  if (chosen) state.backupDir = chosen;
  renderPlatforms();
}

async function runBackup(): Promise<void> {
  state.backingUp = true;
  state.backup = null;
  renderPlatforms();
  state.backup = await api.runBackup();
  state.backingUp = false;
  renderPlatforms();
}

function backupCard(): HTMLElement {
  const result = state.backup;
  return h(
    'div',
    { class: 'platform', 'data-card': 'backup' },
    h('div', { class: 'platform-head' }, h('h2', {}, 'نسخة احتياطية')),
    h('p', {}, mixed('تحفظ جرد أدواتك وأوامر إعادة تثبيتها ونسخًا من مجلدات مهاراتك في مجلد مؤرَّخ. لا تتضمن مفاتيح ولا رموزًا ولا بيانات اعتماد.')),
    h('p', { 'data-backup-dir': true }, 'مسار التصدير: ', state.backupDir ? ltr(state.backupDir, true) : h('span', { class: 'muted' }, 'لم يُحدَّد بعد')),
    result
      ? h(
          'p',
          { class: result.ok ? 'ok-box' : 'warn', role: 'status', 'data-backup-result': result.ok ? 'ok' : 'failed' },
          mixed(result.message),
          result.path ? h('span', { class: 'sub' }, ltr(result.path)) : null,
        )
      : null,
    h(
      'div',
      { class: 'actions' },
      button('اختيار مسار التصدير', { class: 'btn', 'data-backup-choose': true }, () => void chooseBackupDir()),
      button(state.backingUp ? 'جارٍ إنشاء النسخة' : 'إنشاء نسخة احتياطية الآن', { class: 'btn primary', 'data-backup-run': true, disabled: !state.backupDir || state.backingUp || !state.snapshot }, () => void runBackup()),
      result?.ok ? button('فتح مجلد النسخة', { class: 'btn' }, () => void api.openBackup()) : null,
    ),
  );
}

function renderPlatforms(): void {
  el.platforms.hidden = state.view !== 'platforms';
  if (state.view !== 'platforms') return;
  const snapshot = state.snapshot;
  if (!snapshot) {
    el.platforms.replaceChildren(state.loading ? loadingBox() : h('div', { class: 'state-box' }, 'لا توجد بيانات معروضة بعد.'));
    return;
  }

  const cards = ENVS.map((env) => {
    const platform = snapshot.platforms.find((p) => p.env === env.id);
    if (!platform) return null;
    const login = platform.capabilities.find((c) => c.key === 'login');
    return h(
      'div',
      { class: 'platform', 'data-platform': env.id },
      h(
        'div',
        { class: 'platform-head' },
        h('h2', {}, h('bdi', { dir: 'auto' }, env.label)),
        platform.version ? ltr(platform.version, true) : chip(platform.detected ? 'موجودة على الجهاز' : 'لا يوجد برنامج محلي'),
      ),
      h(
        'ul',
        { class: 'caps' },
        ...platform.capabilities.map((cap) => {
          const info = CAPABILITY_LABEL[cap.state];
          return h(
            'li',
            { 'data-cap': cap.key, 'data-cap-state': cap.state },
            h('div', { class: 'cap-head' }, h('strong', {}, cap.label), badge(info.label, info.tone)),
            h('div', {}, mixed(cap.detail)),
            h('div', { class: 'muted' }, 'الدليل: ', mixed(cap.evidence)),
          );
        }),
      ),
      h(
        'div',
        { class: 'actions' },
        button('فتح المسار الرسمي', { class: 'btn', 'data-official': env.id }, () => void api.open(platform.officialUrl)),
        env.id === 'claude-code' && login && login.state !== 'verified' && snapshot.cliVersion
          ? button('تسجيل الدخول عبر Claude CLI', { class: 'btn primary', 'data-login': true }, async () => {
              state.result = await api.login();
              render();
            })
          : null,
        button('عرض أدواتها', { class: 'btn quiet' }, () => setEnv(env.id)),
      ),
    );
  });

  const sources = snapshot.sources.map((source) => {
    const info = SOURCE_STATE[source.state];
    const url = source.setupUrl;
    return h(
      'li',
      { 'data-source-row': source.id, 'data-source-state': source.state },
      h('strong', {}, mixed(source.label)),
      badge(info.label, info.tone),
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
          source.dataDate ? ` · تاريخ البيانات المعروضة: ${formatTime(source.dataDate)}` : '',
        ),
        url ? h('div', { class: 'settings-row' }, button('فتح مسار الإعداد الرسمي', { class: 'btn', 'data-setup': true }, () => void api.open(url))) : null,
      ),
    );
  });

  const sync = h('select', { id: 'sync', 'aria-label': 'المزامنة الدورية' }, ...SYNC_OPTIONS.map(([minutes, label]) => h('option', { value: String(minutes) }, label)));
  sync.value = String(state.syncMinutes);
  sync.addEventListener('change', () => {
    state.syncMinutes = Number(sync.value);
    store('syncMinutes', sync.value);
  });

  const projectRow = h('div', { class: 'settings-row' });
  if (snapshot.projectDir) {
    projectRow.append(
      h('span', {}, 'مشروع Claude Code المحدد: ', ltr(snapshot.projectDir, true)),
      button('إلغاء تحديد المشروع', { class: 'btn quiet' }, async () => {
        await api.clearProject();
        void load();
      }),
    );
  } else {
    projectRow.append(h('span', { class: 'muted' }, 'لم يُحدَّد مجلد مشروع، فتُعرض أدوات نطاق المستخدم والحساب.'));
  }
  projectRow.append(
    button('اختيار مجلد مشروع', { class: 'btn' }, async () => {
      if (await api.chooseProject()) void load();
    }),
  );

  setChildren(
    el.platforms,
    h('h1', { class: 'overview-title' }, 'المنصات والمصادر'),
    h('p', { class: 'muted' }, 'ما ثبت لكل منصة على هذا الجهاز: الجرد، التثبيت، المزامنة، وتسجيل الدخول. تسجيل دخول المنصة ومصادقة كل موصل والتثبيت المحلي ثلاث خطوات منفصلة.'),
    h('div', { class: 'platform-grid' }, ...cards),
    h('h2', { class: 'section-title' }, 'التطبيق'),
    h('div', { class: 'platform-grid' }, updateCard(), backupCard()),
    h('h2', { class: 'section-title' }, 'مصادر البيانات وآخر تحقق'),
    h('ul', { class: 'sources' }, ...sources),
    h('div', { class: 'settings-row' }, h('label', { for: 'sync' }, 'المزامنة الدورية'), sync, h('span', { class: 'muted' }, 'تُحدَّث البيانات أيضًا عند كل تشغيل وبزر التحديث.')),
    projectRow,
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
  renderEnvBar();
  renderBanner();
  renderList();
  renderPlatforms();
  renderDetails();
}

// ---------- Events ----------

function clearFilters(): void {
  state.filters = { ...EMPTY_FILTERS, view: state.filters.view, env: state.filters.env };
  el.search.value = '';
  render();
}

el.search.addEventListener('input', () => {
  state.filters.query = el.search.value;
  if (state.view === 'platforms' && el.search.value.trim()) {
    state.view = 'mine';
    state.filters = { ...EMPTY_FILTERS, query: el.search.value };
    render();
    return;
  }
  renderList();
  renderDetails();
});

const onFilter = <K extends 'kind' | 'status' | 'category' | 'source' | 'scope'>(select: HTMLSelectElement, key: K) =>
  select.addEventListener('change', () => {
    state.filters = { ...state.filters, [key]: select.value as Filters[K] };
    if (key === 'kind') state.filters.status = 'all';
    renderList();
  });
onFilter(el.fKind, 'kind');
onFilter(el.fStatus, 'status');
onFilter(el.fCategory, 'category');
onFilter(el.fSource, 'source');
onFilter(el.fScope, 'scope');

el.clear.addEventListener('click', clearFilters);
el.refresh.addEventListener('click', () => void load());
el.addTool.addEventListener('click', openGitPlan);

document.addEventListener('keydown', (event) => {
  if (el.plan.open) return;
  if (event.key === 'Escape' && state.selectedId) {
    selectTool(null);
  } else if (event.key === '/' && document.activeElement !== el.search && !(document.activeElement instanceof HTMLSelectElement)) {
    event.preventDefault();
    el.search.focus();
  }
});

// Periodic sync: refresh once the data is older than the chosen interval.
window.setInterval(() => {
  if (state.syncMinutes === 0 || state.loading || state.plan.running || el.plan.open || !state.snapshot) return;
  const age = Date.now() - Date.parse(state.snapshot.generatedAt);
  if (age >= state.syncMinutes * 60000) void load();
}, 30000);

// ---------- Theme ----------

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  el.theme.textContent = theme === 'dark' ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن';
  store('theme', theme);
}

el.theme.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

const saved = stored('theme');
applyTheme(saved === 'dark' || saved === 'light' ? saved : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

api.onUpdate((update) => {
  state.update = update;
  renderBanner();
  renderPlatforms();
});
void api.updateState().then((update) => {
  state.update = update;
  render();
});
void api.backupDir().then((dir) => {
  state.backupDir = dir;
});

void load();
