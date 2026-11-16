import { findAlternatives } from '../shared/alternatives';
import {
  CAPABILITY_LABEL,
  COPY_LABEL,
  DESTINATION_LABEL,
  ENVS,
  ISSUE_LABEL,
  KIND_LABEL,
  PLAN_KIND_LABEL,
  SCOPE_LABEL,
  STAGE_LABEL,
  STATUS_LABEL,
  STATUS_MEANING,
  STATUS_ORDER,
  STATUS_TONE,
  TAB_LABEL,
  categoryLabel,
  envLabel,
  sourceLabel,
  type Tone,
} from '../shared/labels';
import { EMPTY_FILTERS, matchesQuery, searchGroups, sortTools, statusCounts, statusIn, tabCounts, type Filters, type Sort, type SortKey, type TabKind } from '../shared/query';
import type {
  ActionResult,
  BackupResult,
  ClaudeAddsApi,
  Diagnosis,
  DiagnoseTarget,
  EnvId,
  FixResult,
  InstallPlan,
  JobProgress,
  PlanDestination,
  PlanItem,
  PlanPick,
  PlanResult,
  Snapshot,
  SourceHealth,
  Tool,
  ToolStatus,
  UpdateState,
} from '../shared/types';
import { Dropdown } from './dropdown';

declare global {
  interface Window {
    claudeAdds: ClaudeAddsApi;
  }
}

const api = window.claudeAdds;
const PANEL_MIN_WIDTH = 1180;
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

interface DiagEntry {
  diagnosis?: Diagnosis;
  result?: FixResult;
  busy: boolean;
  confirming: boolean;
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
  /** The user's choice for the details panel. Narrow windows always use the pop-up. */
  panelOpen: boolean;
  /** Stage of each background install, by `${itemId}|${env}`. */
  progress: Map<string, JobProgress>;
  /** Tool actions in flight, by tool id. */
  busy: Map<string, 'verify' | 'auth'>;
  /** Result of the last action on a tool, by tool id. */
  outcomes: Map<string, FixResult>;
  diag: { targets: DiagnoseTarget[]; entries: Map<string, DiagEntry> } | null;
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
  panelOpen: stored('detailsPanel') !== 'hidden',
  progress: new Map(),
  busy: new Map(),
  outcomes: new Map(),
  diag: null,
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

/** Label chip without the status dot, for kind, scope and platform. */
function chip(label: string): HTMLElement {
  return h('span', { class: 'badge plain', 'data-tone': 'neutral' }, label);
}

function statusBadge(status: ToolStatus): HTMLElement {
  return badge(STATUS_LABEL[status], STATUS_TONE[status]);
}

/** Collapsed section for long or secondary material. */
function fold(title: string, key: string, ...body: Child[]): HTMLElement {
  return h('details', { class: 'fold', 'data-fold': key }, h('summary', {}, title), h('div', { class: 'fold-body' }, ...body));
}

function evidenceList(items: string[]): HTMLElement {
  return h('ul', { class: 'evidence' }, ...items.filter(Boolean).map((item) => h('li', {}, mixed(item))));
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
  tabs: byId('tabs'),
  summary: byId('summary'),
  tableWrap: byId('table-wrap'),
  platforms: byId('platforms'),
  details: byId('details'),
  panelToggle: byId<HTMLButtonElement>('panel-toggle'),
  toolModal: byId<HTMLDialogElement>('tool-modal'),
  toolModalBody: byId('tool-modal-body'),
  appVersion: byId('app-version'),
  toast: byId('toast'),
  theme: byId<HTMLButtonElement>('theme-toggle'),
  clear: byId<HTMLButtonElement>('clear-filters'),
  plan: byId<HTMLDialogElement>('plan'),
  planBody: byId('plan-body'),
  planActions: byId('plan-actions'),
  diag: byId<HTMLDialogElement>('diag'),
  diagBody: byId('diag-body'),
  diagActions: byId('diag-actions'),
};

const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
  state.filters = { ...state.filters, [key]: value };
  renderList();
};
const dropdowns = {
  status: new Dropdown(byId('f-status'), 'status', 'الحالة', (value) => setFilter('status', value as Filters['status'])),
  category: new Dropdown(byId('f-category'), 'category', 'الفئة', (value) => setFilter('category', value)),
  source: new Dropdown(byId('f-source'), 'source', 'المصدر', (value) => setFilter('source', value)),
  scope: new Dropdown(byId('f-scope'), 'scope', 'النطاق', (value) => setFilter('scope', value as Filters['scope'])),
};

function tools(): Tool[] {
  return state.snapshot?.tools ?? [];
}

function findTool(id: string | null): Tool | undefined {
  return id ? tools().find((tool) => tool.id === id) : undefined;
}

const usePanel = () => state.panelOpen && window.innerWidth >= PANEL_MIN_WIDTH;

// ---------- Actions ----------

function showView(view: View): void {
  state.view = view;
  state.selectedId = null;
  if (view !== 'platforms') state.filters = { ...EMPTY_FILTERS, view, env: state.filters.env, kind: state.filters.kind, query: state.filters.query };
  render();
}

function setEnv(env: EnvId | 'all'): void {
  state.filters = { ...state.filters, env, status: 'all', category: 'all', source: 'all', scope: 'all' };
  if (state.view === 'platforms') state.view = 'mine';
  render();
}

function setTab(kind: TabKind): void {
  state.filters = { ...state.filters, kind, status: 'all', category: 'all', source: 'all', scope: 'all' };
  state.selectedId = null;
  render();
}

function focusRow(id: string | null): void {
  if (id) document.querySelector<HTMLButtonElement>(`[data-tool="${CSS.escape(id)}"]`)?.focus();
}

function selectTool(id: string | null, fromKeyboard = false): void {
  const tool = findTool(id);
  if (tool && state.view === 'platforms') {
    state.view = tool.mine ? 'mine' : 'catalog';
    state.filters = { ...EMPTY_FILTERS, view: state.view, kind: tool.kind === 'command' ? 'plugin' : tool.kind };
  }
  // A command opens inside its plugin's tab.
  if (tool && tool.kind !== 'command' && tool.kind !== state.filters.kind && state.view !== 'platforms') state.filters = { ...state.filters, kind: tool.kind };
  const previous = state.selectedId;
  state.selectedId = id;
  render();
  if (!id) {
    focusRow(previous);
    return;
  }
  if (usePanel()) {
    if (fromKeyboard) el.details.querySelector<HTMLElement>('[data-primary], [data-close]')?.focus();
  } else {
    if (!el.toolModal.open) el.toolModal.showModal();
    el.toolModalBody.querySelector<HTMLElement>('[data-close]')?.focus();
  }
}

function togglePanel(): void {
  state.panelOpen = !state.panelOpen;
  store('detailsPanel', state.panelOpen ? 'shown' : 'hidden');
  if (el.toolModal.open) el.toolModal.close();
  render();
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

/** Takes the inventory the main process already has, after an action that refreshed it there. */
async function adoptLatest(): Promise<void> {
  const latest = await api.last();
  if (latest) state.snapshot = latest;
  render();
}

async function runVerify(tool: Tool): Promise<void> {
  state.busy.set(tool.id, 'verify');
  renderDetails();
  state.outcomes.set(tool.id, await api.verifyTool(tool.id));
  state.busy.delete(tool.id);
  await adoptLatest();
}

async function runAuth(tool: Tool): Promise<void> {
  state.busy.set(tool.id, 'auth');
  renderDetails();
  state.outcomes.set(tool.id, await api.authConnector(tool.id));
  state.busy.delete(tool.id);
  await adoptLatest();
}

// ---------- Diagnosis ----------

const targetKey = (target: DiagnoseTarget) => `${target.kind}:${target.id}`;

async function openDiag(targets: DiagnoseTarget[]): Promise<void> {
  state.diag = { targets, entries: new Map(targets.map((target) => [targetKey(target), { busy: true, confirming: false }])) };
  renderDiag();
  if (!el.diag.open) el.diag.showModal();
  await Promise.all(
    targets.map(async (target) => {
      const diagnosis = await api.diagnose(target);
      const entry = state.diag?.entries.get(targetKey(target));
      if (entry) {
        entry.diagnosis = diagnosis;
        entry.busy = false;
      }
      renderDiag();
    }),
  );
}

async function runFix(target: DiagnoseTarget): Promise<void> {
  const entry = state.diag?.entries.get(targetKey(target));
  const fix = entry?.diagnosis?.fix;
  if (!entry || !fix) return;
  // A fix that changes something is shown with its scope first, then confirmed.
  if (fix.needsConfirm && !entry.confirming) {
    entry.confirming = true;
    renderDiag();
    return;
  }
  entry.confirming = false;
  entry.busy = true;
  renderDiag();
  entry.result = await api.applyFix(target, fix.id);
  entry.busy = false;
  await adoptLatest();
  // Diagnose again so the entry shows the state after the fix.
  entry.diagnosis = await api.diagnose(target);
  renderDiag();
}

function renderDiag(): void {
  const diag = state.diag;
  if (!diag) return;
  setChildren(
    el.diagBody,
    ...diag.targets.map((target) => {
      const entry = diag.entries.get(targetKey(target));
      const d = entry?.diagnosis;
      if (!entry || !d) return h('p', { role: 'status', 'data-diag-state': 'loading' }, 'جارٍ فحص السبب.');
      const healthy = d.issue === 'none';
      const url = d.officialUrl;
      return h(
        'div',
        { class: 'diag-item', 'data-diag': targetKey(target), 'data-diag-issue': d.issue },
        h('div', { class: 'cap-head' }, h('strong', {}, mixed(d.title)), badge(ISSUE_LABEL[d.issue], healthy ? 'ok' : d.issue === 'cli-not-in-path' || d.issue === 'auth' ? 'warn' : 'danger')),
        h('p', {}, mixed(d.cause)),
        d.evidence.length > 0 ? fold('الأدلة', 'evidence', evidenceList(d.evidence)) : null,
        d.fix && entry.confirming ? h('p', { class: 'warn', 'data-diag-confirm': true }, mixed(d.fix.detail)) : null,
        d.fix && !entry.confirming && !healthy ? h('p', { class: 'muted' }, mixed(d.fix.detail)) : null,
        entry.result
          ? h(
              'div',
              { class: entry.result.ok ? 'ok-box' : 'warn', role: 'status', 'data-diag-result': entry.result.ok ? 'ok' : 'failed' },
              mixed(entry.result.message),
              entry.result.evidence.length > 0 ? fold('دليل النتيجة', 'result-evidence', evidenceList(entry.result.evidence)) : null,
            )
          : null,
        h(
          'div',
          { class: 'actions' },
          d.fix
            ? button(entry.busy ? 'جارٍ التنفيذ' : entry.confirming ? `تأكيد: ${d.fix.label}` : d.fix.label, { class: 'btn primary', 'data-diag-fix': d.fix.id, disabled: entry.busy }, () => void runFix(target))
            : null,
          entry.confirming
            ? button('إلغاء', { class: 'btn' }, () => {
                entry.confirming = false;
                renderDiag();
              })
            : null,
          url ? button('فتح المسار الرسمي', { class: 'btn' }, () => void api.open(url)) : null,
        ),
      );
    }),
  );
  setChildren(el.diagActions, button('إغلاق', { class: 'btn', 'data-diag-close': true }, () => el.diag.close()));
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
  for (const pick of picks) state.plan.results.delete(pickKey(pick.itemId, pick.env));
  renderPlan();
  renderDetails();
  // The install runs in the main process and keeps going if this dialog or the details panel is closed.
  const results = await api.runPlan(plan.id, picks);
  for (const result of results) {
    const key = pickKey(result.itemId, result.env);
    state.progress.delete(key);
    state.plan.results.set(key, result);
    if (result.ok) {
      state.plan.picks.delete(key);
      const destination = plan.items.find((item) => item.id === result.itemId)?.destinations.find((d) => d.env === result.env);
      if (destination) destination.state = 'exists';
    }
    // The tool's own panel shows the outcome too, also when the plan dialog was closed meanwhile.
    state.outcomes.set(result.itemId, { ok: result.ok && result.verified, message: `${envLabel(result.env)}: ${result.message}`, evidence: [] });
  }
  state.plan.running = false;
  renderPlan();
  renderDetails();
  // Re-inventory so the installed tool shows up in "my tools".
  if (results.some((result) => result.ok)) void load();
}

function progressNode(progress: JobProgress): HTMLElement {
  const fill = h('span', { class: 'progress-fill' });
  // Set through the style object: the page's content policy blocks inline style attributes.
  fill.style.setProperty('--done', `${Math.round(((progress.index - 1) / progress.total) * 100)}%`);
  return h(
    'div',
    { class: 'progress', role: 'status', 'data-progress': progress.stage, 'data-progress-env': progress.env },
    h('span', {}, `${progress.index} من ${progress.total}: ${STAGE_LABEL[progress.stage]}`),
    h('span', { class: 'progress-bar', 'aria-hidden': 'true' }, fill),
  );
}

function destinationRow(item: PlanItem, destination: PlanDestination): HTMLElement {
  const id = pickKey(item.id, destination.env);
  const result = state.plan.results.get(id);
  const progress = state.progress.get(id);
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
        h('span', { class: 'muted' }, 'إكمال الإعداد:'),
        detail && /^[a-z]+ /.test(detail) ? button('نسخ الأمر', { class: 'btn' }, () => void copyCommand(detail)) : null,
        url ? button('فتح المسار الرسمي', { class: 'btn', 'data-official': destination.env }, () => void api.open(url)) : null,
      ),
    );
  }
  if (progress) extras.push(progressNode(progress));
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
  const close = button(running ? 'إخفاء، والتثبيت يستمر في الخلفية' : 'إغلاق', { class: 'btn', 'data-plan-close': true }, () => el.plan.close());
  if (step !== 'plan' || !plan) {
    setChildren(el.planActions, close);
    return;
  }
  const chosen: PlanPick[] = plan.items.flatMap((item) => item.destinations.filter((d) => picks.has(pickKey(item.id, d.env))).map((d) => ({ itemId: item.id, env: d.env })));
  setChildren(
    el.planActions,
    button(running ? 'جارٍ التثبيت في الخلفية' : `تثبيت مباشر في الوجهات المحددة (${chosen.length})`, { class: 'btn primary', 'data-plan-run': true, disabled: running || chosen.length === 0 }, () => void runPicks(chosen)),
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

// ---------- Rendering: chrome ----------

const NAV: Array<{ key: View; label: string }> = [
  { key: 'mine', label: 'أدواتي' },
  { key: 'catalog', label: 'الكتالوج' },
  { key: 'platforms', label: 'المنصات والمصادر' },
];

const isTab = (tool: Tool) => tool.kind !== 'command';

/** Platforms whose inventory could not be read. A zero there means "unknown", not "none". */
function inventoryUnknown(env: EnvId | 'all'): boolean {
  if (env === 'all' || state.view === 'catalog') return false;
  const capability = state.snapshot?.platforms.find((platform) => platform.env === env)?.capabilities.find((item) => item.key === 'inventory');
  return capability !== undefined && capability.state !== 'verified' && !tools().some((tool) => tool.mine && tool.envs.some((placement) => placement.env === env));
}

function renderNav(): void {
  const counts: Partial<Record<View, number>> = {
    mine: tools().filter((tool) => tool.mine && isTab(tool)).length,
    catalog: tools().filter((tool) => !tool.mine && isTab(tool)).length,
  };
  el.nav.replaceChildren(
    ...NAV.map((item) => {
      const count = state.snapshot ? counts[item.key] : undefined;
      return h(
        'li',
        {},
        button([h('span', {}, item.label), count !== undefined ? h('span', { class: 'count' }, String(count)) : null], { 'aria-current': state.view === item.key ? 'page' : undefined, 'data-nav': item.key }, () => showView(item.key)),
      );
    }),
  );
}

function renderEnvBar(): void {
  const mine = state.view !== 'catalog';
  const pool = tools().filter((tool) => tool.mine === mine && isTab(tool));
  const entries: Array<{ id: EnvId | 'all'; label: string; count: number }> = [
    { id: 'all', label: 'الكل', count: pool.length },
    ...ENVS.map((env) => ({ id: env.id, label: env.label, count: pool.filter((tool) => tool.envs.some((p) => p.env === env.id)).length })),
  ];
  el.envbar.replaceChildren(
    ...entries.map((entry) => {
      const unknown = inventoryUnknown(entry.id);
      return button(
        [h('bdi', { dir: 'auto' }, entry.label), state.snapshot ? h('span', { class: 'count', title: unknown ? 'تعذّر التحقق من جرد هذه المنصة' : undefined }, unknown ? 'تعذّر التحقق' : String(entry.count)) : null],
        { 'data-env': entry.id, 'aria-pressed': state.filters.env === entry.id ? 'true' : 'false', 'data-env-unknown': unknown ? 'true' : undefined },
        () => setEnv(entry.id),
      );
    }),
  );
}

const SOURCE_STATE: Record<SourceHealth['state'], { label: string; tone: Tone }> = {
  ok: { label: 'سليم', tone: 'ok' },
  degraded: { label: 'جزئي', tone: 'warn' },
  failed: { label: 'متعذّر', tone: 'danger' },
};

const unhealthySources = () => (state.snapshot?.sources ?? []).filter((source) => source.state !== 'ok');

function renderBanner(): void {
  const notices: HTMLElement[] = [];
  if (state.error) {
    notices.push(h('div', { class: 'notice', 'data-tone': 'danger', role: 'alert' }, h('strong', {}, 'تعذّر تحميل البيانات:'), ltr(state.error), button('إعادة المحاولة', { class: 'btn' }, () => void load())));
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
  }
  const unhealthy = unhealthySources();
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
        button('تشخيص المشاكل', { class: 'btn', 'data-diagnose-all': true }, () => void openDiag(unhealthy.map((source) => ({ kind: 'source', id: source.id })))),
      ),
    );
  }
  el.banner.replaceChildren(...notices);
}

const UPDATE_STATUS: Record<UpdateState['status'], (update: UpdateState) => string> = {
  idle: () => 'لم يُفحص بعد في هذه الجلسة.',
  checking: () => 'جاري التحقق',
  none: () => 'أنت على أحدث إصدار',
  available: (update) => `تحديث متاح: ${update.latest ?? ''}`,
  downloading: (update) => `جاري تنزيل ${update.latest ?? ''}`,
  ready: (update) => `تحديث متاح: ${update.latest ?? ''}، نُزّل وجاهز للتثبيت`,
  error: (update) => `تعذّر التحقق: ${update.message ?? 'سبب غير معلوم'}`,
};

/** Version of the running build, its channel, and the app-update check. Tool data has its own refresh button. */
function renderAppVersion(): void {
  const update = state.update;
  if (!update) {
    el.appVersion.replaceChildren();
    return;
  }
  const url = update.url;
  const busy = update.status === 'checking' || update.status === 'downloading';
  setChildren(
    el.appVersion,
    h('div', { class: 'version-line', 'data-app-version': update.current, 'data-app-channel': update.channel }, 'الإصدار ', ltr(update.current), h('span', { class: 'muted' }, ` · ${update.channel === 'dev' ? 'تطويرية' : 'مستقرة'}`)),
    h('div', { class: 'muted version-status', role: 'status', 'data-app-update': update.status }, mixed(UPDATE_STATUS[update.status](update))),
    button(busy ? 'جاري التحقق' : 'التحقق من تحديث التطبيق', { class: 'btn quiet', 'data-app-update-check': true, disabled: busy }, () => void api.updateCheck()),
    update.status === 'ready' ? button('إعادة التشغيل والتحديث الآن', { class: 'btn primary', 'data-update-install': true }, () => void api.updateInstall()) : null,
    update.status === 'available' && update.mode === 'manual' && url ? button('تنزيل الإصدار الجديد', { class: 'btn', 'data-update-download': true }, () => void api.open(url)) : null,
  );
}

function loadingBox(): HTMLElement {
  return h('div', { class: 'state-box', role: 'status', 'data-state': 'loading' }, 'جارٍ جرد الأدوات في كل المنصات وتحميل الكتالوج. قد يستغرق فحص الموصلات نحو نصف دقيقة.');
}

// ---------- Rendering: list ----------

function pool(): Tool[] {
  const mine = state.filters.view === 'mine';
  return tools().filter((tool) => tool.mine === mine && tool.kind === state.filters.kind && (state.filters.env === 'all' || tool.envs.some((p) => p.env === state.filters.env)));
}

function renderFilters(): void {
  const base = pool();
  const present = <T extends string>(pick: (tool: Tool) => T) => [...new Set(base.map(pick))];
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, 'ar');
  const statuses = present((tool) => statusIn(tool, state.filters.env));
  dropdowns.status.setOptions([{ value: 'all', label: 'كل الحالات' }, ...STATUS_ORDER.filter((status) => statuses.includes(status)).map((status) => ({ value: status, label: STATUS_LABEL[status] }))], state.filters.status);
  dropdowns.category.setOptions([{ value: 'all', label: 'كل الفئات' }, ...present((tool) => tool.category).map((key) => ({ value: key, label: categoryLabel(key) })).sort(byLabel)], state.filters.category);
  dropdowns.source.setOptions([{ value: 'all', label: 'كل المصادر' }, ...present((tool) => tool.source).map((key) => ({ value: key, label: sourceLabel(key) })).sort(byLabel)], state.filters.source);
  dropdowns.scope.setOptions([{ value: 'all', label: 'كل النطاقات' }, ...present((tool) => tool.scope).map((key) => ({ value: key, label: SCOPE_LABEL[key] })).sort(byLabel)], state.filters.scope);
}

function renderTabs(): void {
  const unknown = inventoryUnknown(state.filters.env);
  el.tabs.replaceChildren(
    ...tabCounts(tools(), state.filters).map((tab) => {
      const text = unknown ? 'تعذّر التحقق' : tab.shown === tab.total ? String(tab.total) : `${tab.shown} من ${tab.total}`;
      return button(
        [h('bdi', { dir: 'ltr' }, TAB_LABEL[tab.kind]), state.snapshot ? h('span', { class: 'count' }, text) : null],
        { role: 'tab', 'data-tab': tab.kind, 'aria-selected': tab.kind === state.filters.kind ? 'true' : 'false', 'data-tab-total': String(tab.total), 'data-tab-shown': String(tab.shown), 'data-tab-unknown': unknown ? 'true' : undefined },
        () => setTab(tab.kind),
      );
    }),
  );
}

function renderSummary(): void {
  el.summary.replaceChildren(
    ...statusCounts(tools(), state.filters).map(({ status, count }) =>
      button(
        [statusBadge(status), h('span', { class: 'n' }, String(count))],
        { class: 'sum-status', 'data-count-status': status, 'aria-label': `${STATUS_LABEL[status]}: ${count}`, 'aria-pressed': state.filters.status === status ? 'true' : 'false' },
        () => setFilter('status', state.filters.status === status ? 'all' : status),
      ),
    ),
  );
}

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'الاسم' },
  { key: 'type', label: 'الفئة' },
  { key: 'status', label: 'الحالة' },
  { key: 'scope', label: 'المنصة والنطاق' },
];

function renderRow(tool: Tool): HTMLElement {
  const parent = findTool(tool.parentId ?? null);
  const status = statusIn(tool, state.filters.env);
  const query = state.filters.query.trim();
  // A plugin can match through one of its commands. Say which, so the match is not a mystery.
  const commands = query && tool.kind === 'plugin' ? tool.related.map((id) => findTool(id)).filter((item): item is Tool => item?.kind === 'command' && matchesQuery(item, query)) : [];
  const nameButton = h(
    'button',
    { type: 'button', class: 'name-btn', 'data-tool': tool.id },
    tool.title !== tool.name ? h('span', {}, tool.title, ' ') : null,
    ltr(tool.name, true),
    parent ? h('span', { class: 'sub' }, 'ضمن إضافة ', ltr(parent.name)) : null,
    commands.length > 0 ? h('span', { class: 'sub', 'data-command-match': true }, 'يطابق الأمر: ', ...commands.slice(0, 2).flatMap((command) => [ltr(`/${tool.name}:${command.name}`), ' '])) : null,
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
    h('td', {}, categoryLabel(tool.category)),
    h('td', {}, statusBadge(status)),
    h('td', {}, h('bdi', { dir: 'auto' }, envs || 'غير معلوم'), h('span', { class: 'sub' }, `${SCOPE_LABEL[tool.scope]} · ${sourceLabel(tool.source)}`)),
  );
  row.addEventListener('click', () => selectTool(tool.id));
  return row;
}

function groupRow(label: string, count: number, group: string): HTMLElement {
  return h('tr', { class: 'group', 'data-group': group }, h('th', { colspan: '4', scope: 'colgroup' }, `${label} (${count})`));
}

/**
 * Explains an empty list instead of showing a bare zero. The cases differ:
 * unreadable inventory, a failed catalog source, a platform the catalog does
 * not cover, a search with no match, or filters that hide everything.
 */
function emptyBox(): HTMLElement {
  const { env, view, query, kind } = state.filters;
  const others = tabCounts(tools(), state.filters).filter((tab) => tab.kind !== kind && tab.shown > 0);
  const otherTabs = others.map((tab) => button(`${TAB_LABEL[tab.kind]} (${tab.shown})`, { class: 'btn', 'data-other-tab': tab.kind }, () => setTab(tab.kind)));
  const allPlatforms = env !== 'all' ? button('عرض كل المنصات', { class: 'btn primary', 'data-show-all-platforms': true }, () => setEnv('all')) : null;
  const catalogSource = state.snapshot?.sources.find((source) => source.id === 'catalog');
  const platformSource = state.snapshot?.sources.find((source) => source.env === env && source.state !== 'ok');
  const diagnose = (id: string) => button('تشخيص وإصلاح', { class: 'btn primary', 'data-diagnose': id }, () => void openDiag([{ kind: 'source', id }]));

  if (query.trim()) {
    return h(
      'div',
      { class: 'state-box', 'data-state': 'no-results' },
      h('strong', {}, mixed(`لا نتائج للبحث «${query.trim()}» في ${TAB_LABEL[kind]}.`)),
      otherTabs.length > 0 ? h('span', {}, 'توجد نتائج في تبويب آخر:') : null,
      h('div', { class: 'actions' }, ...otherTabs, button('مسح البحث', { class: 'btn' }, clearFilters), allPlatforms),
    );
  }
  if (view === 'catalog' && catalogSource && catalogSource.state === 'failed') {
    return h('div', { class: 'state-box', 'data-state': 'source-failed' }, h('strong', {}, 'تعذّر تحميل الكتالوج، فلا يُعرف ما فيه.'), h('span', {}, mixed(catalogSource.message)), h('div', { class: 'actions' }, diagnose('catalog')));
  }
  if (env !== 'all' && inventoryUnknown(env)) {
    const platform = state.snapshot?.platforms.find((item) => item.env === env);
    const inventory = platform?.capabilities.find((item) => item.key === 'inventory');
    return h(
      'div',
      { class: 'state-box', 'data-state': 'no-inventory' },
      h('strong', {}, mixed(`${envLabel(env)}: تعذّر التحقق`)),
      inventory ? h('span', {}, mixed(inventory.detail)) : null,
      h(
        'div',
        { class: 'actions' },
        platformSource ? diagnose(platformSource.id) : null,
        platform ? button('فتح المسار الرسمي', { class: 'btn', 'data-official': platform.env }, () => void api.open(platform.officialUrl)) : null,
        allPlatforms,
      ),
    );
  }
  const filtered = state.filters.status !== 'all' || state.filters.category !== 'all' || state.filters.source !== 'all' || state.filters.scope !== 'all';
  if (filtered) {
    return h('div', { class: 'state-box', 'data-state': 'filtered-out' }, 'المرشحات الحالية تخفي كل العناصر.', h('div', { class: 'actions' }, button('مسح المرشحات', { class: 'btn primary' }, clearFilters)));
  }
  if (env !== 'all') {
    return h(
      'div',
      { class: 'state-box', 'data-state': 'no-platform-items' },
      h('strong', {}, mixed(view === 'catalog' ? `لا يحتوي الكتالوج عناصر ${TAB_LABEL[kind]} لمنصة ${envLabel(env)}.` : `لا توجد عندك عناصر ${TAB_LABEL[kind]} في ${envLabel(env)}.`)),
      view === 'catalog' && catalogSource?.state === 'degraded' ? h('span', {}, mixed(`${catalogSource.message} قد يكون الكتالوج المعروض قديمًا.`)) : null,
      otherTabs.length > 0 ? h('span', {}, 'توجد عناصر في تبويب آخر:') : null,
      h('div', { class: 'actions' }, allPlatforms, ...otherTabs, view === 'catalog' && catalogSource?.state === 'degraded' ? diagnose('catalog') : null),
    );
  }
  return h('div', { class: 'state-box', 'data-state': 'empty' }, mixed(`لا توجد عناصر ${TAB_LABEL[kind]} هنا.`), h('div', { class: 'actions' }, ...otherTabs));
}

function renderList(): void {
  const listing = state.view !== 'platforms';
  el.list.hidden = !listing;
  if (!listing) return;

  const scope = state.filters.env === 'all' ? '' : `، ${envLabel(state.filters.env)}`;
  setChildren(el.listTitle, mixed(`${state.view === 'mine' ? 'أدواتي' : 'الكتالوج'}${scope}`));
  renderTabs();
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
  const tab = tabCounts(tools(), state.filters).find((item) => item.kind === state.filters.kind);
  el.resultCount.textContent = inventoryUnknown(state.filters.env)
    ? 'تعذّر التحقق'
    : tab && tab.shown !== tab.total
      ? `${tab.shown} نتيجة بعد التصفية من ${tab.total}`
      : `${tab?.total ?? total} في هذا التبويب`;

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
        button([column.label, active ? h('span', { class: 'dir' }, state.sort.dir === 'asc' ? 'تصاعدي' : 'تنازلي') : null], { 'data-sort': column.key }, () => {
          state.sort = { key: column.key, dir: active && state.sort.dir === 'asc' ? 'desc' : 'asc' };
          renderList();
        }),
      );
    }),
  );

  // With a query on the home screen, the user's own tools come first, then the catalog.
  const grouped = state.view === 'mine' && state.filters.query.trim() !== '';
  const body: HTMLElement[] = [];
  if (grouped) {
    body.push(groupRow('أدواتي', mine.length, 'mine'));
    if (mine.length === 0) body.push(h('tr', { class: 'group-empty' }, h('td', { colspan: '4' }, 'لا شيء من أدواتك يطابق البحث في هذا التبويب.')));
  }
  body.push(...mine.map(renderRow));
  if (grouped && catalog.length > 0) body.push(groupRow('من الكتالوج، غير مثبّتة عندك', catalog.length, 'catalog'));
  body.push(...catalog.map(renderRow));

  const scrollTop = el.tableWrap.scrollTop;
  el.tableWrap.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, ...body)));
  el.tableWrap.scrollTop = scrollTop;
}

// ---------- Rendering: details ----------

function section(title: string, ...body: Child[]): HTMLElement {
  return h('section', {}, h('h3', {}, title), ...body);
}

function toolList(items: Tool[], attr: string, sub?: (tool: Tool) => string): HTMLElement {
  return h(
    'div',
    { class: 'related' },
    ...items.slice(0, 60).map((item) =>
      button([h('span', {}, ltr(item.kind === 'command' && item.parentId ? `/${findTool(item.parentId)?.name ?? ''}:${item.name}` : item.name), sub ? h('span', { class: 'sub' }, mixed(sub(item))) : null), statusBadge(item.status)], { [attr]: item.id }, () =>
        selectTool(item.id, true),
      ),
    ),
    items.length > 60 ? h('p', { class: 'muted' }, `و${items.length - 60} أخرى.`) : null,
  );
}

/** A plugin shows its commands, skills and connectors; a child shows the plugin it belongs to. */
function relations(tool: Tool): Child[] {
  const related = tool.related.map((id) => findTool(id)).filter((item): item is Tool => Boolean(item));
  if (related.length === 0) return [];
  const of = (kind: Tool['kind']) => related.filter((item) => item.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
  const parents = of('plugin');
  const blocks: Child[] = [];
  if (tool.kind !== 'plugin' && parents.length > 0) blocks.push(section('الإضافة التي تتبعها', toolList(parents, 'data-related')));
  if (tool.kind === 'plugin') {
    const commands = of('command');
    const skills = of('skill');
    const connectors = of('connector');
    if (commands.length > 0) blocks.push(section(`أوامرها (${commands.length})`, h('div', { 'data-commands': true }, toolList(commands, 'data-related', (item) => item.description.slice(0, 90)))));
    if (skills.length > 0) blocks.push(section(`مهاراتها (${skills.length})`, toolList(skills, 'data-related')));
    if (connectors.length > 0) blocks.push(section(`موصلاتها (${connectors.length})`, toolList(connectors, 'data-related')));
  }
  return blocks;
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
        button([h('span', {}, `${KIND_LABEL[other.kind]} `, ltr(other.name), h('span', { class: 'sub' }, mixed(reason))), statusBadge(other.status)], { 'data-alternative': other.id }, () => selectTool(other.id, true)),
      ),
    ),
  );
}

function placements(tool: Tool): HTMLElement {
  return section(
    'الحالة حسب المنصة والنطاق',
    h(
      'ul',
      { class: 'placements' },
      ...tool.envs.map((placement) =>
        h(
          'li',
          { 'data-placement': placement.env, 'data-placement-status': placement.status },
          h('div', { class: 'placement-head' }, h('strong', {}, h('bdi', { dir: 'auto' }, envLabel(placement.env))), chip(SCOPE_LABEL[placement.scope]), statusBadge(placement.status)),
          h('div', { class: 'muted' }, STATUS_MEANING[placement.status]),
        ),
      ),
    ),
  );
}

const LEGACY_SOURCES = new Set(['codex-skills', 'antigravity-legacy-skills']);

/** Stage of this tool's install, if one is running in the background. */
function toolProgress(tool: Tool): JobProgress | undefined {
  const itemId = tool.install ? `plugin:${tool.install.plugin}` : tool.id;
  return [...state.progress.values()].find((progress) => progress.itemId === itemId);
}

/**
 * The one action that fits the tool's state, plus its progress and outcome.
 * It stays visible at the top of the details while the rest scrolls.
 */
function actionZone(tool: Tool): HTMLElement {
  const busy = state.busy.get(tool.id);
  const progress = toolProgress(tool);
  const outcome = state.outcomes.get(tool.id) ?? (tool.install ? state.outcomes.get(`plugin:${tool.install.plugin}`) : undefined);
  const firstCommand = tool.commands[0];
  const docsUrl = tool.docsUrl;

  let primary: HTMLElement;
  if (progress) {
    primary = progressNode(progress);
  } else if (busy === 'auth') {
    primary = h('div', { class: 'progress', role: 'status', 'data-progress': 'auth' }, h('span', {}, STAGE_LABEL.auth), h('span', { class: 'progress-bar', 'aria-hidden': 'true' }, h('span', { class: 'progress-fill indeterminate' })));
  } else if (tool.install) {
    primary = button('تثبيت مباشر', { class: 'btn primary', 'data-primary': 'install', 'data-install': true }, () => void openToolPlan(tool));
  } else if (tool.status === 'needs-auth') {
    primary = button('متابعة المصادقة', { class: 'btn primary', 'data-primary': 'auth' }, () => void runAuth(tool));
  } else if (tool.status === 'disabled' || tool.status === 'unverified' || LEGACY_SOURCES.has(tool.source)) {
    primary = button('إصلاح تلقائي', { class: 'btn primary', 'data-primary': 'fix' }, () => void openDiag([{ kind: 'tool', id: tool.id }]));
  } else if (!tool.mine) {
    primary = h('span', { class: 'muted', 'data-primary': 'manual' }, 'إكمال الإعداد: لا يتوفر تثبيت مباشر لهذه الأداة الآن. استخدم الأمر أو التوثيق.');
  } else {
    const strong = tool.status === 'enabled' || tool.status === 'connected';
    primary = button(busy === 'verify' ? 'جاري التحقق' : 'تحقّق من الجاهزية', { class: strong ? 'btn' : 'btn primary', 'data-primary': 'verify', disabled: busy === 'verify' }, () => void runVerify(tool));
  }

  return h(
    'div',
    { class: 'action-zone', 'data-action-zone': true },
    h(
      'div',
      { class: 'actions' },
      primary,
      firstCommand ? button('نسخ الأمر', { class: 'btn', 'data-copy-main': true }, () => void copyCommand(firstCommand.text)) : null,
      docsUrl ? button('فتح التوثيق', { class: 'btn', 'data-docs': true }, () => void api.open(docsUrl)) : null,
    ),
    outcome
      ? h(
          'div',
          { class: outcome.ok ? 'ok-box' : 'warn', role: 'status', 'data-outcome': outcome.ok ? 'ok' : 'failed' },
          mixed(outcome.message),
          outcome.evidence.length > 0 ? fold('الأدلة', 'outcome-evidence', evidenceList(outcome.evidence)) : null,
        )
      : null,
  );
}

function detailsNodes(tool: Tool, onClose: () => void): Child[] {
  const commands = tool.commands.map((command) =>
    h(
      'div',
      { class: 'command' },
      h('strong', {}, command.label),
      h('code', { class: 'ltr', dir: 'ltr' }, command.text),
      h('span', { class: 'where' }, mixed(command.where)),
      h('div', { class: 'actions' }, button(COPY_LABEL[command.kind], { class: 'btn', 'data-copy': command.kind }, () => void copyCommand(command.text))),
    ),
  );
  return [
    h(
      'div',
      { class: 'details-top' },
      h(
        'div',
        { class: 'details-head' },
        h('div', {}, h('h2', {}, tool.title), tool.title !== tool.name ? ltr(tool.name, true) : null),
        button('إغلاق', { class: 'btn quiet', 'data-close': true }, onClose),
      ),
      h('div', { class: 'chips' }, chip(KIND_LABEL[tool.kind]), statusBadge(statusIn(tool, state.filters.env)), chip(tool.mine ? 'من أدواتي' : 'من الكتالوج')),
      h('p', { class: 'summary-text', 'data-function': true }, mixed(tool.ar.summary)),
      actionZone(tool),
    ),
    tool.statusNote ? h('p', { class: 'muted', 'data-status-note': true }, mixed(tool.statusNote)) : null,
    tool.ar.when ? section('متى تُستخدم', h('p', {}, mixed(tool.ar.when))) : null,
    section('مثال عملي', h('p', { 'data-example': true }, mixed(tool.ar.example))),
    placements(tool),
    alternativesList(tool),
    ...relations(tool),
    tool.description ? fold(tool.ar.generic ? 'الوصف الأصلي من المصدر (الصياغة العربية أعلاه عامة)' : 'الوصف الأصلي من المصدر', 'original', h('p', { class: 'original', lang: 'en', dir: 'ltr' }, tool.description)) : null,
    commands.length > 0 ? fold(`الأوامر (${commands.length})`, 'commands', ...commands) : null,
    fold(
      'المصدر والأدلة',
      'evidence',
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'المصدر'),
        h('dd', {}, mixed(sourceLabel(tool.source)), tool.inCatalog && tool.source !== 'knowledge-work-plugins' ? '، وموجودة في كتالوج Anthropic' : ''),
        h('dt', {}, 'المعرّف'),
        h('dd', {}, ltr(tool.id)),
        h('dt', {}, 'آخر تحقق'),
        h('dd', { 'data-checked': true }, formatTime(tool.evidence.checkedAt)),
        tool.version ? h('dt', {}, 'الإصدار') : null,
        tool.version ? h('dd', {}, ltr(tool.version)) : null,
        tool.location ? h('dt', {}, tool.kind === 'connector' ? 'العنوان' : 'المسار') : null,
        tool.location ? h('dd', {}, ltr(tool.location)) : null,
      ),
      h('h3', {}, 'دليل كل منصة'),
      evidenceList(tool.envs.map((placement) => `${envLabel(placement.env)}: ${placement.evidence}`)),
      tool.copies && tool.copies.length > 0 ? h('h3', {}, 'نسخ مطابقة دُمجت في هذا السجل') : null,
      tool.copies && tool.copies.length > 0 ? evidenceList(tool.copies.map((copy) => `${sourceLabel(copy.source)}: ${copy.location}`)) : null,
    ),
  ];
}

function renderDetails(): void {
  const listing = state.view !== 'platforms';
  const tool = listing ? findTool(state.selectedId) : undefined;
  const panel = usePanel() && listing;

  el.details.hidden = !panel;
  el.app.classList.toggle('with-details', panel);
  el.panelToggle.hidden = !listing;
  el.panelToggle.textContent = state.panelOpen ? 'إخفاء التفاصيل' : 'إظهار التفاصيل';
  el.panelToggle.setAttribute('aria-expanded', state.panelOpen ? 'true' : 'false');
  el.panelToggle.dataset.panel = state.panelOpen ? 'shown' : 'hidden';

  if (panel) {
    if (el.toolModal.open) el.toolModal.close();
    if (tool) setChildren(el.details, ...detailsNodes(tool, () => selectTool(null)));
    else setChildren(el.details, h('div', { class: 'state-box', 'data-details-empty': true }, 'اختر أداة من الجدول لعرض وظيفتها وحالتها وإجراءاتها هنا.'));
    return;
  }
  el.details.replaceChildren();
  if (el.toolModal.open) {
    if (tool) setChildren(el.toolModalBody, ...detailsNodes(tool, () => el.toolModal.close()));
    else el.toolModal.close();
  } else if (tool) {
    setChildren(el.toolModalBody, ...detailsNodes(tool, () => el.toolModal.close()));
  }
}

// ---------- Rendering: platforms ----------

function updateCard(): HTMLElement | null {
  const update = state.update;
  if (!update) return null;
  const channel = h('select', { id: 'update-channel', 'aria-label': 'قناة التحديث' }, h('option', { value: 'stable' }, 'مستقرة: الإصدارات الرسمية فقط'), h('option', { value: 'dev' }, 'تطويرية: مع كل تحديث على المستودع'));
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
    h('p', { 'data-update-text': true }, mixed(UPDATE_STATUS[update.status](update))),
    h('p', { class: 'muted' }, update.mode === 'installer' ? 'هذه النسخة مُنصَّبة وتحدّث نفسها.' : 'هذه النسخة محمولة أو على macOS، فتُشعرك بالتحديث وتفتح صفحة تنزيله.'),
    h('div', { class: 'settings-row' }, h('label', { for: 'update-channel' }, 'القناة'), channel),
    h('label', { class: 'check' }, auto, 'تنزيل التحديث وتثبيته تلقائيًا'),
    h(
      'div',
      { class: 'actions' },
      button(busy ? 'جاري التحقق' : 'التحقق من تحديث التطبيق', { class: 'btn', 'data-update-check': true, disabled: busy }, () => void api.updateCheck()),
      update.status === 'ready' ? button('إعادة التشغيل والتحديث الآن', { class: 'btn primary', 'data-update-install': true }, () => void api.updateInstall()) : null,
      update.status === 'available' && url ? button('فتح صفحة الإصدار', { class: 'btn' }, () => void api.open(url)) : null,
    ),
    update.message || update.checkedAt ? fold('تفاصيل آخر تحقق', 'update-detail', update.message ? h('p', {}, mixed(update.message)) : null, update.checkedAt ? h('p', { class: 'muted' }, `آخر تحقق: ${formatTime(update.checkedAt)}`) : null) : null,
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
    h('p', {}, mixed('جرد أدواتك وأوامر إعادة تثبيتها ونسخ من مجلدات مهاراتك، دون مفاتيح أو رموز.')),
    h('p', { 'data-backup-dir': true }, 'مسار التصدير: ', state.backupDir ? ltr(state.backupDir, true) : h('span', { class: 'muted' }, 'لم يُحدَّد بعد')),
    result ? h('p', { class: result.ok ? 'ok-box' : 'warn', role: 'status', 'data-backup-result': result.ok ? 'ok' : 'failed' }, mixed(result.message), result.path ? h('span', { class: 'sub' }, ltr(result.path)) : null) : null,
    h(
      'div',
      { class: 'actions' },
      button(state.backingUp ? 'جارٍ إنشاء النسخة' : 'إنشاء نسخة احتياطية الآن', { class: 'btn primary', 'data-backup-run': true, disabled: !state.backupDir || state.backingUp || !state.snapshot }, () => void runBackup()),
      button('اختيار مسار التصدير', { class: 'btn', 'data-backup-choose': true }, () => void chooseBackupDir()),
      result?.ok ? button('فتح مجلد النسخة', { class: 'btn' }, () => void api.openBackup()) : null,
    ),
  );
}

/** One line of state and one clear action per platform. The evidence opens on request. */
function platformCard(snapshot: Snapshot, env: EnvId, label: string): HTMLElement | null {
  const platform = snapshot.platforms.find((item) => item.env === env);
  if (!platform) return null;
  const broken = snapshot.sources.filter((source) => source.env === env && source.state !== 'ok');
  const inventory = platform.capabilities.find((item) => item.key === 'inventory');
  const login = platform.capabilities.find((item) => item.key === 'login');
  const state_ = broken.length > 0 ? 'needs-fix' : inventory?.state === 'verified' ? 'ok' : 'unknown';
  const headline =
    state_ === 'ok'
      ? 'تُقرأ أدواتها بنجاح.'
      : state_ === 'needs-fix'
        ? (broken[0]?.message ?? '')
        : (inventory?.detail ?? '');
  const tone: Tone = state_ === 'ok' ? 'ok' : state_ === 'needs-fix' ? 'danger' : 'warn';
  const first = broken[0];
  return h(
    'div',
    { class: 'platform', 'data-platform': env, 'data-platform-state': state_ },
    h('div', { class: 'platform-head' }, h('h2', {}, h('bdi', { dir: 'auto' }, label)), badge(state_ === 'ok' ? 'سليمة' : state_ === 'needs-fix' ? 'تحتاج إصلاحًا' : 'تعذّر التحقق', tone)),
    h('p', {}, mixed(headline)),
    h(
      'div',
      { class: 'actions' },
      first
        ? button('تشخيص وإصلاح', { class: 'btn primary', 'data-diagnose': first.id }, () => void openDiag(broken.map((source) => ({ kind: 'source', id: source.id }))))
        : state_ === 'ok'
          ? button('عرض أدواتها', { class: 'btn primary' }, () => setEnv(env))
          : button('فتح المسار الرسمي', { class: 'btn primary', 'data-official': env }, () => void api.open(platform.officialUrl)),
      env === 'claude-code' && login && login.state !== 'verified' && snapshot.cliVersion
        ? button('تسجيل الدخول', { class: 'btn', 'data-login': true }, async () => {
            state.result = await api.login();
            render();
          })
        : null,
    ),
    fold(
      'أدلة التشخيص والقدرات',
      'platform-evidence',
      platform.version ? h('p', {}, 'الإصدار: ', ltr(platform.version)) : null,
      h(
        'ul',
        { class: 'caps' },
        ...platform.capabilities.map((cap) => {
          const info = CAPABILITY_LABEL[cap.state];
          return h('li', { 'data-cap': cap.key, 'data-cap-state': cap.state }, h('div', { class: 'cap-head' }, h('strong', {}, cap.label), badge(info.label, info.tone)), h('div', {}, mixed(cap.detail)), h('div', { class: 'muted' }, 'الدليل: ', mixed(cap.evidence)));
        }),
      ),
      button('فتح المسار الرسمي', { class: 'btn', 'data-official-link': env }, () => void api.open(platform.officialUrl)),
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

  const sources = snapshot.sources.map((source) => {
    const info = SOURCE_STATE[source.state];
    return h(
      'li',
      { 'data-source-row': source.id, 'data-source-state': source.state, 'data-source-issue': source.issue ?? 'none' },
      h('strong', {}, mixed(source.label)),
      badge(info.label, info.tone),
      h(
        'div',
        {},
        h('div', {}, mixed(source.message)),
        source.state !== 'ok' ? h('div', { class: 'settings-row' }, button('تشخيص وإصلاح', { class: 'btn primary', 'data-diagnose': source.id }, () => void openDiag([{ kind: 'source', id: source.id }]))) : null,
        fold(
          'الدليل والوقت',
          'source-evidence',
          h('div', { class: 'meta' }, 'المصدر: ', mixed(source.evidence)),
          h('div', { class: 'meta' }, `آخر تحقق: ${formatTime(source.checkedAt)}`),
          source.dataDate ? h('div', { class: 'meta', 'data-data-date': true }, `تاريخ البيانات المعروضة: ${formatTime(source.dataDate)}`) : null,
        ),
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
    h('p', { class: 'muted' }, 'حالة كل منصة وإجراء واحد واضح لها. ربط حساب المنصة، ومصادقة كل موصل، والتثبيت المحلي ثلاث خطوات منفصلة.'),
    h('div', { class: 'platform-grid' }, ...ENVS.map((env) => platformCard(snapshot, env.id, env.label))),
    h('h2', { class: 'section-title' }, 'التطبيق'),
    h('div', { class: 'platform-grid' }, updateCard(), backupCard()),
    h('h2', { class: 'section-title' }, 'مصادر البيانات'),
    h('ul', { class: 'sources' }, ...sources),
    h('div', { class: 'settings-row' }, h('label', { for: 'sync' }, 'المزامنة الدورية'), sync, h('span', { class: 'muted' }, 'تُحدَّث البيانات أيضًا عند كل تشغيل وبزر «تحديث البيانات».')),
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
  renderAppVersion();
  renderBanner();
  renderList();
  renderPlatforms();
  renderDetails();
}

// ---------- Events ----------

function clearFilters(): void {
  state.filters = { ...EMPTY_FILTERS, view: state.filters.view, env: state.filters.env, kind: state.filters.kind };
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
  // The search covers all three tabs. If the open tab has no match and another has, move there.
  if (el.search.value.trim()) {
    const counts = tabCounts(tools(), state.filters);
    const here = searchGroups(tools(), state.filters);
    const best = counts.find((tab) => tab.shown > 0);
    if (here.mine.length + here.catalog.length === 0 && best && counts.find((tab) => tab.kind === state.filters.kind)?.shown === 0) {
      state.filters = { ...state.filters, kind: best.kind, status: 'all', category: 'all', source: 'all', scope: 'all' };
    }
  }
  renderList();
  renderDetails();
});

el.clear.addEventListener('click', clearFilters);
el.refresh.addEventListener('click', () => void load());
el.addTool.addEventListener('click', openGitPlan);
el.panelToggle.addEventListener('click', togglePanel);
// Closing the pop-up puts keyboard focus back on the row it was opened from.
el.toolModal.addEventListener('close', () => focusRow(state.selectedId));

document.addEventListener('keydown', (event) => {
  if (el.plan.open || el.diag.open || el.toolModal.open) return;
  if (event.key === 'Escape' && state.selectedId && usePanel()) {
    selectTool(null);
  } else if (event.key === '/' && document.activeElement !== el.search && !(document.activeElement instanceof HTMLInputElement)) {
    event.preventDefault();
    el.search.focus();
  }
});

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderDetails, 120);
});

// Periodic sync: refresh once the data is older than the chosen interval.
window.setInterval(() => {
  if (state.syncMinutes === 0 || state.loading || state.plan.running || el.plan.open || el.diag.open || !state.snapshot) return;
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
  renderAppVersion();
  renderBanner();
  renderPlatforms();
});
api.onProgress((progress) => {
  state.progress.set(pickKey(progress.itemId, progress.env), progress);
  if (el.plan.open) renderPlan();
  renderDetails();
});
api.onInventoryChanged(() => void adoptLatest());
void api.updateState().then((update) => {
  state.update = update;
  render();
});
void api.backupDir().then((dir) => {
  state.backupDir = dir;
});

void load();
