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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = join(root, 'test-results');
const electronPath = process.env.CLAUDE_ADDS_EXE || require('electron');
const appArgs = process.env.CLAUDE_ADDS_EXE ? [] : [root];
const only = process.env.CLAUDE_ADDS_E2E_ONLY ? process.env.CLAUDE_ADDS_E2E_ONLY.split(',') : null;
const wants = (name) => !only || only.includes(name);

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

// The app follows the system theme on first run, so tests set it explicitly.
async function setTheme(page, theme) {
  if ((await page.getAttribute('html', 'data-theme')) !== theme) await page.locator('#theme-toggle').click();
}

async function sourceStates(page) {
  await page.locator('[data-nav="platforms"]').click();
  return page.locator('[data-source-row]').evaluateAll((list) => Object.fromEntries(list.map((r) => [r.dataset.sourceRow, r.dataset.sourceState])));
}

function makeFixtureRepo(dir) {
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'fixture-market', plugins: [{ name: 'demo-plugin', description: 'Demo plugin for tests.', source: './demo-plugin' }] }));
  write('demo-plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }));
  write('skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: Formats release notes from a changelog.\n---\n\nSteps.\n');
  write('skills/demo-skill/reference.md', 'Reference text.\n');
  write('skills/broken/SKILL.md', 'no frontmatter here\n');
  write('gemini-extension.json', JSON.stringify({ name: 'demo-extension', version: '1.0.0', description: 'Demo extension.' }));
  write('.mcp.json', JSON.stringify({ mcpServers: { 'demo-server': { command: 'node', args: ['server.js'], env: { API_KEY: 'do-not-show-this' } } } }));
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
    const navBox = await page.locator('nav.side').boundingBox();
    const mainBox = await page.locator('main.main').boundingBox();
    check(T, 'navigation sits on the right of the content', navBox.x > mainBox.x);
    check(T, 'home screen is "my tools"', (await page.locator('[data-nav="mine"]').getAttribute('aria-current')) === 'page' && (await page.locator('#list-title').innerText()).includes('أدواتي'));
    const envButtons = await page.locator('#envbar button').evaluateAll((list) => list.map((b) => b.dataset.env));
    check(T, 'quick bar lists all environments in order', envButtons.join() === 'all,claude,claude-code,chatgpt,codex,gemini,antigravity', envButtons.join());
    check(T, 'home lists only tools that exist here', (await rowCount(page)) > 0 && (await rows(page).evaluateAll((list) => list.every((r) => r.dataset.mine === 'true'))));
    await page.screenshot({ path: join(shots, '01-my-tools-light.png') });

    // Counts: a status chip opens exactly that many rows.
    const chipButton = page.locator('.sum-status[data-count-kind="connector"][data-count-status="needs-auth"]');
    const expected = Number(await chipButton.locator('.n').innerText());
    await chipButton.click();
    const seen = await rows(page).evaluateAll((list) => [...new Set(list.map((r) => `${r.dataset.kind}/${r.dataset.status}`))]);
    check(T, 'status count opens the matching filtered list', (await rowCount(page)) === expected && seen.join() === 'connector/needs-auth', `${expected} rows`);

    // Details: function, placements, copy.
    await rows(page).first().locator('.name-btn').click();
    check(T, 'details show function, example and status per environment', (await page.locator('#details').innerText()).includes('وظيفتها') && (await page.locator('#details').innerText()).includes('مثال عملي') && (await page.locator('#details [data-placement]').count()) >= 1);
    await page.locator('#details [data-copy="auth"]').click();
    check(T, 'copying the connector auth command puts /mcp on the clipboard', (await clip(app)) === '/mcp');
    check(T, 'details panel sits on the left side', (await page.locator('#details').boundingBox()).x < 10);
    await page.screenshot({ path: join(shots, '02-details-light.png') });
    await page.keyboard.press('Escape');
    check(T, 'Escape closes the details panel', await page.locator('#details').isHidden());
    await page.locator('#clear-filters').click();

    // Commands are their own kind.
    await page.selectOption('#f-kind', 'command');
    const commandKinds = await rows(page).evaluateAll((list) => [...new Set(list.map((r) => r.dataset.kind))]);
    check(T, 'commands are listed apart from skills', commandKinds.join() === 'command', `${await rowCount(page)} commands`);
    await page.locator('#clear-filters').click();

    // Unified search: my tools first, then the catalog.
    await page.fill('#search', 'slack');
    const order =await page.locator('#table-wrap tbody tr').evaluateAll((list) => list.map((r) => r.dataset.group ?? r.dataset.mine).filter(Boolean));
    const firstCatalog = order.indexOf('catalog');
    check(T, 'search shows my tools first, then catalog results', order[0] === 'mine' && firstCatalog > 0 && order.slice(firstCatalog + 1).every((v) => v === 'false') && order.slice(1, firstCatalog).every((v) => v === 'true'), order.slice(0, 6).join(' '));
    await page.screenshot({ path: join(shots, '03-search-groups.png') });
    await page.fill('#search', 'القانون');
    check(T, 'Arabic search finds the legal plugin', (await page.locator('#table-wrap tbody .name-btn bdi').allInnerTexts()).includes('legal'));
    await page.fill('#search', 'zzzz-no-such-tool');
    check(T, 'empty state appears with a way out', await page.locator('[data-state="empty"] button').isVisible());
    await page.locator('[data-state="empty"] button').click();

    // Alternatives: the same skill installed in another platform's folder.
    await page.fill('#search', 'antislop');
    const antislop = page.locator('[data-tool="skill:user-skills:antislop"]');
    if (await antislop.count()) {
      await antislop.click();
      check(T, 'details suggest an alternative from my own tools', (await page.locator('#details [data-alternative]').count()) >= 1, (await page.locator('#details [data-alternative]').first().innerText()).replace(/\s+/g, ' ').slice(0, 70));
      await page.keyboard.press('Escape');
    } else {
      check(T, 'details suggest an alternative from my own tools', false, 'antislop skill not found on this machine');
    }
    await page.fill('#search', '');

    // Environments.
    for (const env of ['claude', 'claude-code', 'codex', 'gemini', 'antigravity']) {
      const count = Number(await page.locator(`#envbar [data-env="${env}"] .count`).innerText());
      await page.locator(`#envbar [data-env="${env}"]`).click();
      check(T, `${env}: quick bar opens its own tools`, count > 0 && (await rowCount(page)) === count, `${count} tools`);
    }
    await page.locator('#envbar [data-env="codex"]').click();
    await rows(page).first().locator('.name-btn').click();
    check(T, 'a Codex tool shows its Codex placement and evidence', (await page.locator('#details [data-placement="codex"]').count()) === 1);
    await page.screenshot({ path: join(shots, '04-codex-tools.png') });
    await page.keyboard.press('Escape');
    await page.locator('#envbar [data-env="chatgpt"]').click();
    check(T, 'ChatGPT shows an honest "cannot verify" state with the official path', (await page.locator('[data-state="no-inventory"]').innerText()).includes('تعذّر التحقق') && (await page.locator('[data-state="no-inventory"] [data-official="chatgpt"]').isVisible()));
    await page.locator('#envbar [data-env="all"]').click();

    // Catalog and the install plan (opened, not run, on the real configuration).
    await page.locator('[data-nav="catalog"]').click();
    check(T, 'catalog is a separate list of tools not installed here', (await rowCount(page)) > 50 && (await rows(page).evaluateAll((list) => list.every((r) => r.dataset.mine === 'false'))));
    await page.selectOption('#f-kind', 'plugin');
    await rows(page).first().locator('.name-btn').click();
    await page.locator('#details [data-install]').click();
    await page.waitForSelector('#plan .plan-item');
    const destinations = await page.locator('#plan .dest').evaluateAll((list) => Object.fromEntries(list.map((d) => [d.dataset.dest, d.dataset.destState])));
    check(T, 'install plan lists every destination with its compatibility', Object.keys(destinations).length === 6 && destinations['claude-code'] === 'ready' && destinations.chatgpt === 'unsupported' && destinations.claude === 'needs-completion', JSON.stringify(destinations));
    check(T, 'plan shows the exact command before anything runs', /^claude plugin install \S+ --scope user$/.test(await page.locator('#plan .dest[data-dest="claude-code"] code').innerText()));
    await page.screenshot({ path: join(shots, '05-install-plan.png') });
    await page.locator('#plan [data-plan-close]').click();
    check(T, 'closing the plan installs nothing', await page.locator('#plan').isHidden());
    await page.keyboard.press('Escape');

    // Platforms and sources.
    const states = await sourceStates(page);
    check(T, 'every source was read successfully', Object.values(states).every((s) => s === 'ok') && Object.keys(states).length === 9, JSON.stringify(states));
    const caps = await page.locator('.platform[data-platform]').evaluateAll((list) => Object.fromEntries(list.map((p) => [p.dataset.platform, Object.fromEntries([...p.querySelectorAll('[data-cap]')].map((c) => [c.dataset.cap, c.dataset.capState]))])));
    check(T, 'six platforms report their capabilities', Object.keys(caps).length === 6);
    check(T, 'Claude Code, Codex, Gemini and Antigravity inventories are verified', ['claude-code', 'codex', 'gemini', 'antigravity'].every((env) => caps[env]?.inventory === 'verified'), JSON.stringify(Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.inventory]))));
    check(T, 'ChatGPT and the Claude account are marked as needing completion, not faked', caps.chatgpt?.inventory === 'unverified' && caps.chatgpt?.install === 'needs-completion' && caps.claude?.install === 'needs-completion');
    await page.screenshot({ path: join(shots, '06-platforms.png'), fullPage: false });

    // Keyboard, sorting, theme, narrow window, refresh.
    await page.locator('[data-nav="mine"]').click();
    await page.locator('[data-sort="name"]').click();
    const desc = await page.locator('#table-wrap tbody .name-btn bdi.token').allInnerTexts();
    check(T, 'name column sorts descending on second click', desc[0].toLowerCase() >= desc[desc.length - 1].toLowerCase());
    await rows(page).first().locator('.name-btn').focus();
    await page.keyboard.press('Enter');
    check(T, 'Enter on a focused row opens details and moves focus into it', await page.evaluate(() => document.activeElement?.hasAttribute('data-close') ?? false));
    await setTheme(page, 'dark');
    check(T, 'dark theme applies', (await page.getAttribute('html', 'data-theme')) === 'dark');
    await page.screenshot({ path: join(shots, '07-details-dark.png') });
    await setTheme(page, 'light');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await page.waitForTimeout(300);
    check(T, 'no horizontal page overflow at minimum width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(shots, '08-narrow.png') });
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 860));

    const before = await page.getAttribute('#checked-at', 'data-checked');
    await page.locator('#refresh').click();
    check(T, 'manual refresh reports progress', (await page.locator('#refresh').innerText()) === 'جارٍ التحديث');
    await page.waitForFunction((prev) => document.querySelector('#checked-at')?.getAttribute('data-checked') !== prev && !document.querySelector('#refresh')?.disabled, before, { timeout: 240000 });
    check(T, 'refresh updates the last-checked time', (await page.getAttribute('#checked-at', 'data-checked')) > before);
    check(T, 'no console errors', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 2. Refresh failures keep the last good result ----------
  if (wants('real')) {
    const T = 'REAL';
    const { app, page, errors } = await launch(profile, { CLAUDE_ADDS_CATALOG_URL: 'https://127.0.0.1:9/marketplace.json', CLAUDE_ADDS_CLAUDE_BIN: join(profile, 'no-such-claude.exe') });
    check(T, 'failed refresh is announced with the date of the data shown', (await page.locator('#banner [data-stale]').innerText()).includes('آخر نتيجة ناجحة'));
    const states = await sourceStates(page);
    check(T, 'missing CLI and unreachable catalog are reported, not hidden', states.cli === 'failed' && states.plugins === 'degraded' && states.connectors === 'degraded' && states.catalog === 'degraded', JSON.stringify(states));
    check(T, 'each stale source shows its reason and data date', (await page.locator('[data-source-row="plugins"]').innerText()).includes('تاريخ البيانات المعروضة') && (await page.locator('[data-source-row="plugins"]').innerText()).includes('آخر نتيجة ناجحة'));
    check(T, 'official setup path is offered for the missing CLI', await page.locator('[data-source-row="cli"] [data-setup]').isVisible());
    await page.locator('[data-nav="mine"]').click();
    check(T, 'last good inventory stays visible', (await rowCount(page)) > 50);
    await page.locator('#envbar [data-env="claude-code"]').click();
    await page.selectOption('#f-kind', 'plugin');
    await rows(page).first().locator('.name-btn').click();
    check(T, 'a tool from stale data says so in its status note', (await page.locator('#details [data-status-note]').innerText()).includes('آخر قراءة ناجحة'));
    await page.locator('[data-nav="catalog"]').click();
    await page.selectOption('#f-kind', 'plugin');
    await rows(page).first().locator('.name-btn').click();
    check(T, 'direct install is not offered from stale data', (await page.locator('#details [data-install]').count()) === 0);
    await page.screenshot({ path: join(shots, '09-stale-sources.png') });
    check(T, 'no console errors', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 3. Nothing cached, no CLI, no catalog ----------
  if (wants('real')) {
    const T = 'REAL';
    const { app, page } = await launch(emptyProfile, { CLAUDE_ADDS_CATALOG_URL: 'https://127.0.0.1:9/marketplace.json', CLAUDE_ADDS_CLAUDE_BIN: join(emptyProfile, 'no-such-claude.exe') });
    const states = await sourceStates(page);
    check(T, 'with no cache the catalog is reported as failed', states.catalog === 'failed' && states.cli === 'failed');
    await page.locator('[data-nav="mine"]').click();
    await page.locator('#envbar [data-env="claude-code"]').click();
    const statuses = await rows(page).evaluateAll((list) => [...new Set(list.map((r) => r.dataset.status))]);
    check(T, 'nothing is claimed as connected or enabled-by-CLI without the CLI', statuses.length > 0 && !statuses.includes('connected') && !statuses.includes('needs-auth'), statuses.join());
    check(T, 'file-only plugins read as installed or enabled by settings, connectors as configured', statuses.every((s) => ['installed', 'enabled', 'disabled', 'discovered', 'configured', 'not-configured', 'unverified'].includes(s)), statuses.join());
    await app.close();
  }

  // ---------- 4. Git link to several destinations, simulated ----------
  if (wants('sim')) {
    const T = 'SIM';
    const home = join(sandbox, 'sim-home');
    const repo = join(sandbox, 'fixture-repo');
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    makeFixtureRepo(repo);
    // A file where Gemini's skills folder should be makes that one destination fail.
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'skills'), 'blocker');
    const fakeState = join(sandbox, 'fake-claude-state.json');
    const backups = join(sandbox, 'backups');
    mkdirSync(backups, { recursive: true });
    // Stand-in for the GitHub release list: one official release and one newer development build.
    const releaseList = JSON.stringify([
      { tag_name: 'v99.0.0', prerelease: false, draft: false, html_url: 'https://github.com/sufyanaser/Claude-Adds/releases/tag/v99.0.0', assets: [] },
      { tag_name: 'v99.1.0-dev.3', prerelease: true, draft: false, html_url: 'https://github.com/sufyanaser/Claude-Adds/releases/tag/v99.1.0-dev.3', assets: [] },
    ]);
    const server = createServer((_request, response) => response.end(releaseList));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const { app, page, errors } = await launch(join(sandbox, 'sim-profile'), {
      CLAUDE_ADDS_PICK_DIR: backups,
      CLAUDE_ADDS_UPDATE_API: `http://127.0.0.1:${server.address().port}/releases`,
      CLAUDE_ADDS_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CLAUDE_ADDS_ALLOW_LOCAL_GIT: '1',
      CLAUDE_ADDS_CLAUDE_BIN: join(root, 'tests', 'e2e', 'fixtures', 'fake-claude.cmd'),
      FAKE_CLAUDE_STATE: fakeState,
    });

    await page.locator('#add-tool').click();
    await page.fill('#plan-url', 'http://example.test/repo');
    await page.locator('[data-plan-inspect]').click();
    check(T, 'a non-https link is refused before anything is downloaded', (await page.locator('[data-plan-error]').innerText()).includes('https'));

    await page.fill('#plan-url', repo);
    await page.locator('[data-plan-inspect]').click();
    await page.waitForSelector('#plan .plan-item', { timeout: 120000 });
    const items = await page.locator('#plan .plan-item').evaluateAll((list) => list.map((i) => i.dataset.item));
    check(T, 'repository contents are discovered by type', ['plugin:demo-plugin', 'extension:demo-extension', 'connector:demo-server', 'skill:skills/demo-skill', 'skill:skills/broken'].every((id) => items.includes(id)), items.join(' '));
    check(T, 'secrets inside the repository config are never shown', !(await page.locator('#plan').innerText()).includes('do-not-show-this'));

    const skill = page.locator('#plan .plan-item[data-item="skill:skills/demo-skill"]');
    const skillDests = await skill.locator('.dest').evaluateAll((list) => Object.fromEntries(list.map((d) => [d.dataset.dest, d.dataset.destState])));
    check(T, 'one skill offers every compatible destination in one plan', skillDests['claude-code'] === 'ready' && skillDests.codex === 'ready' && skillDests.gemini === 'ready' && skillDests.antigravity === 'ready' && skillDests.claude === 'needs-completion' && skillDests.chatgpt === 'unsupported', JSON.stringify(skillDests));
    check(T, 'each destination states its compatibility evidence', (await skill.locator('.dest[data-dest="codex"]').innerText()).includes('.agents/skills'));
    const broken = await page.locator('#plan .plan-item[data-item="skill:skills/broken"] .dest').evaluateAll((list) => list.every((d) => d.dataset.destState === 'unsupported'));
    check(T, 'a skill without valid metadata is not offered anywhere', broken);
    check(T, 'the Gemini extension and MCP server are shown as needing completion, with the command', (await page.locator('#plan .plan-item[data-item="extension:demo-extension"] .dest[data-dest="gemini"]').getAttribute('data-dest-state')) === 'needs-completion' && (await page.locator('#plan .plan-item[data-item="connector:demo-server"] .dest[data-dest="codex"] code').innerText()).startsWith('codex mcp add'));
    check(T, 'nothing is ticked by default in a multi-item plan', (await page.locator('#plan [data-plan-run]').isDisabled()));
    await page.screenshot({ path: join(shots, '10-git-plan.png') });

    for (const env of ['claude-code', 'codex', 'gemini', 'antigravity']) await skill.locator(`.dest[data-dest="${env}"] input`).check();
    await page.locator('#plan .plan-item[data-item="plugin:demo-plugin"] .dest[data-dest="claude-code"] input').check();
    check(T, 'the run button counts the chosen destinations', (await page.locator('#plan [data-plan-run]').innerText()).includes('(5)'));
    await page.locator('#plan [data-plan-run]').click();
    await page.waitForSelector('#plan .plan-result[data-result-env="gemini"]', { timeout: 120000 });
    const outcome = await skill.locator('.plan-result').evaluateAll((list) => Object.fromEntries(list.map((r) => [r.dataset.resultEnv, r.dataset.result])));
    check(T, 'each destination reports its own result', outcome['claude-code'] === 'verified' && outcome.codex === 'verified' && outcome.antigravity === 'verified' && outcome.gemini === 'failed', JSON.stringify(outcome));
    check(T, 'the skill was copied to each documented folder', existsSync(join(home, '.claude', 'skills', 'demo-skill', 'SKILL.md')) && existsSync(join(home, '.agents', 'skills', 'demo-skill', 'reference.md')) && existsSync(join(home, '.gemini', 'config', 'skills', 'demo-skill', 'SKILL.md')));
    check(T, 'the plugin install went through the CLI stand-in', readFileSync(fakeState, 'utf8').includes('demo-plugin') && (await page.locator('#plan .plan-item[data-item="plugin:demo-plugin"] .plan-result').getAttribute('data-result')) === 'verified');
    await page.screenshot({ path: join(shots, '11-git-results.png') });

    rmSync(join(home, '.gemini', 'skills'));
    await skill.locator('[data-retry]').click();
    await page.waitForSelector('#plan .plan-item[data-item="skill:skills/demo-skill"] .plan-result[data-result-env="gemini"][data-result="verified"]', { timeout: 60000 });
    check(T, 'the failed destination is retried on its own and succeeds', existsSync(join(home, '.gemini', 'skills', 'demo-skill', 'SKILL.md')));
    await page.locator('#plan [data-plan-close]').click();
    await idle(page);

    await page.fill('#search', 'demo');
    const mineIds = await rows(page).evaluateAll((list) => list.filter((r) => r.dataset.mine === 'true').map((r) => r.querySelector('.name-btn').dataset.tool));
    check(T, 'installed tools appear in "my tools" after the re-inventory', ['skill:user-skills:demo-skill', 'skill:agents-skills:demo-skill', 'skill:gemini-skills:demo-skill', 'skill:antigravity-skills:demo-skill', 'plugin:demo-plugin'].every((id) => mineIds.includes(id)), mineIds.join(' '));
    await page.locator('[data-tool="skill:agents-skills:demo-skill"]').click();
    const placements = await page.locator('#details [data-placement]').evaluateAll((list) => list.map((p) => `${p.dataset.placement}=${p.dataset.placementStatus}`));
    check(T, 'a skill in the shared folder is shown for both Codex and Gemini as discovered', placements.join() === 'codex=discovered,gemini=discovered', placements.join());
    check(T, 'same-named copies in other folders are offered as alternatives, each with its own identity', (await page.locator('#details [data-alternative]').count()) >= 1);

    // Backup to a chosen export path.
    await page.fill('#search', '');
    await page.locator('[data-nav="platforms"]').click();
    check(T, 'backup cannot run before an export path is chosen', await page.locator('[data-backup-run]').isDisabled());
    await page.locator('[data-backup-choose]').click();
    await page.waitForFunction(() => !document.querySelector('[data-backup-run]')?.disabled);
    check(T, 'the chosen export path is shown', (await page.locator('[data-backup-dir]').innerText()).includes('backups'));
    await page.locator('[data-backup-run]').click();
    await page.waitForSelector('[data-backup-result]', { timeout: 60000 });
    const folders = readdirSync(backups);
    const backupRoot = join(backups, folders[0] ?? '');
    check(T, 'a dated backup folder is written to the export path', (await page.locator('[data-backup-result]').getAttribute('data-backup-result')) === 'ok' && folders.length === 1 && /^Claude-Adds-backup-\d{4}-\d{2}-\d{2}_/.test(folders[0]));
    const manifest = existsSync(join(backupRoot, 'manifest.json')) ? readFileSync(join(backupRoot, 'manifest.json'), 'utf8') : '';
    check(T, 'the backup holds the inventory and copies of owned skills', manifest.includes('skill:user-skills:demo-skill') && manifest.includes('plugin:demo-plugin') && existsSync(join(backupRoot, 'skills', 'user-skills', 'demo-skill', 'SKILL.md')) && existsSync(join(backupRoot, 'skills', 'agents-skills', 'demo-skill', 'reference.md')) && existsSync(join(backupRoot, 'README.txt')));
    check(T, 'the backup contains no credential values', !manifest.includes('do-not-show-this'));
    await page.screenshot({ path: join(shots, '14-backup.png') });

    // Update check against the stand-in release list.
    check(T, 'the app shows its version and starts on the stable channel', (await page.locator('#update-channel').inputValue()) === 'stable' && /\d+\.\d+\.\d+/.test(await page.locator('[data-card="update"] .platform-head').innerText()));
    await page.locator('[data-update-check]').click();
    await page.waitForSelector('[data-card="update"][data-update-status="available"]', { timeout: 30000 });
    check(T, 'the stable channel offers the official release, not the development build', (await page.locator('[data-update-text]').innerText()).includes('99.0.0') && !(await page.locator('[data-update-text]').innerText()).includes('dev'));
    await page.selectOption('#update-channel', 'dev');
    await page.waitForFunction(() => document.querySelector('[data-update-text]')?.textContent?.includes('99.1.0-dev.3'), null, { timeout: 30000 });
    check(T, 'the development channel follows the newest build', (await page.locator('#update-channel').inputValue()) === 'dev');
    await page.screenshot({ path: join(shots, '15-update.png') });
    server.close();
    check(T, 'no console errors', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 5. Full journey with the real Claude CLI, isolated ----------
  if (wants('isolated')) {
    const T = 'REAL-ISOLATED';
    const home = join(sandbox, 'iso-home');
    const config = join(home, '.claude');
    mkdirSync(home, { recursive: true });
    const realRegistry = join(process.env.USERPROFILE ?? '', '.claude', 'plugins', 'installed_plugins.json');
    const realBefore = existsSync(realRegistry) ? readFileSync(realRegistry, 'utf8') : '';

    const { app, page, errors } = await launch(join(sandbox, 'iso-profile'), { CLAUDE_ADDS_HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_ADDS_CLAUDE_BIN: undefined });
    await page.locator('#envbar [data-env="claude-code"]').click();
    check(T, 'isolated Claude Code starts with no plugins', (await rows(page).evaluateAll((list) => list.filter((r) => r.dataset.kind === 'plugin').length)) === 0);
    await page.locator('#envbar [data-env="all"]').click();

    // Search by task, read what the tool does, then install it.
    await page.fill('#search', 'المهام');
    await page.locator('[data-tool="plugin:productivity"]').click();
    const details = await page.locator('#details').innerText();
    check(T, 'searching by task finds the tool in the catalog and explains it', details.includes('إدارة المهام') && details.includes('من الكتالوج'));
    await page.locator('#details [data-install]').click();
    await page.waitForSelector('#plan .plan-item');
    const command = await page.locator('#plan .dest[data-dest="claude-code"] code').innerText();
    check(T, 'the plan uses the documented marketplace install for a fresh configuration', command === 'claude plugin install productivity --marketplace anthropics/knowledge-work-plugins --scope user', command);
    await page.locator('#plan [data-plan-run]').click();
    await page.waitForSelector('#plan .plan-result', { timeout: 300000 });
    const result = await page.locator('#plan .plan-result').getAttribute('data-result');
    check(T, 'the real Claude CLI installed the plugin and the fresh inventory confirmed it', result === 'verified', (await page.locator('#plan .plan-result').innerText()).replace(/\s+/g, ' ').slice(0, 120));
    await page.screenshot({ path: join(shots, '12-real-install-result.png') });
    await page.locator('#plan [data-plan-close]').click();
    await idle(page);

    await page.fill('#search', '');
    await page.locator('[data-nav="mine"]').click();
    await page.locator('#envbar [data-env="claude-code"]').click();
    const row = page.locator('#table-wrap tbody tr:has([data-tool="plugin:productivity"])');
    check(T, 'the plugin now appears in "my tools" as enabled', (await row.getAttribute('data-status')) === 'enabled' && (await row.getAttribute('data-mine')) === 'true');
    await page.locator('[data-tool="plugin:productivity"]').click();
    const placement = page.locator('#details [data-placement="claude-code"]');
    check(T, 'its status comes from the CLI in user scope', (await placement.getAttribute('data-placement-status')) === 'enabled' && (await placement.innerText()).includes('المستخدم') && (await placement.innerText()).includes('claude plugin list'));
    check(T, 'its skills arrive with it', (await page.locator('#details [data-related]').count()) > 3);
    await page.screenshot({ path: join(shots, '13-real-install-my-tools.png') });

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
