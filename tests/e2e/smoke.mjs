// Drives the real Electron window through the main user journeys and the two
// degraded states. Run with `npm run test:e2e` (builds first).
import { existsSync, readFileSync } from 'node:fs';
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

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const openApps = [];

async function launch(userData, extraEnv = {}) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: appArgs,
    env: { ...process.env, CLAUDE_ADDS_USER_DATA: userData, ...extraEnv },
  });
  openApps.push(app);
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.waitForSelector('#checked-at[data-checked]:not([data-checked=""])', { timeout: 180000 });
  return { app, page, errors };
}

const rowCount = (page) => page.locator('#table-wrap tbody tr').count();

// The app follows the system theme on first run, so tests set it explicitly.
async function setTheme(page, theme) {
  if ((await page.getAttribute('html', 'data-theme')) !== theme) await page.locator('#theme-toggle').click();
}

async function main() {
  await mkdir(shots, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'claude-adds-e2e-'));
  const emptyProfile = await mkdtemp(join(tmpdir(), 'claude-adds-e2e-empty-'));

  // ---------- 1. Normal run ----------
  {
    const { app, page, errors } = await launch(profile);
    await setTheme(page, 'light');
    check('window opens with RTL Arabic document', (await page.getAttribute('html', 'dir')) === 'rtl' && (await page.getAttribute('html', 'lang')) === 'ar');
    check('window title', (await page.title()) === 'Claude Adds');

    const navBox = await page.locator('nav.side').boundingBox();
    const mainBox = await page.locator('main.main').boundingBox();
    check('navigation sits on the right of the content', navBox.x > mainBox.x, `nav x=${Math.round(navBox.x)}, main x=${Math.round(mainBox.x)}`);
    check('navigation has the four sections', (await page.locator('#nav button').count()) === 4);

    const sourceStates = await page.locator('[data-source-row]').evaluateAll((rows) => rows.map((r) => `${r.dataset.sourceRow}=${r.dataset.sourceState}`));
    check('all six sources healthy, including the linked account', sourceStates.length === 6 && sourceStates.every((s) => s.endsWith('=ok')), sourceStates.join(' '));
    await page.screenshot({ path: join(shots, '01-overview-light.png') });

    // Status count -> filtered list.
    const countButton = page.locator('[data-count-kind="connector"][data-count-status="needs-auth"]');
    const expected = Number(await countButton.locator('.n').innerText());
    await countButton.click();
    const statuses = await page.locator('#table-wrap tbody tr').evaluateAll((rows) => [...new Set(rows.map((r) => `${r.dataset.kind}/${r.dataset.status}`))]);
    check('status count opens the matching filtered list', (await rowCount(page)) === expected && statuses.join() === 'connector/needs-auth', `${expected} rows, ${statuses.join()}`);
    check('status filter reflects the chosen status', (await page.locator('#f-status').inputValue()) === 'needs-auth');

    // Details + copying the auth command.
    await page.locator('#table-wrap tbody tr .name-btn').first().click();
    check('details panel opens for the selected tool', await page.locator('#details').isVisible());
    const detailsBox = await page.locator('#details').boundingBox();
    check('details panel sits on the left side', detailsBox.x < (await page.locator('main.main').boundingBox()).x + 5, `details x=${Math.round(detailsBox.x)}`);
    await page.locator('#details [data-copy="auth"]').click();
    check('copying the auth command puts /mcp on the clipboard', (await app.evaluate(({ clipboard }) => clipboard.readText())) === '/mcp');
    check('copy confirmation is announced', (await page.locator('#toast').innerText()).includes('تم نسخ'));
    await page.keyboard.press('Escape');
    check('Escape closes the details panel', await page.locator('#details').isHidden());

    // English search.
    await page.locator('[data-nav="plugin"]').click();
    const pluginTotal = await rowCount(page);
    await page.fill('#search', 'figma');
    const english = await rowCount(page);
    check('English search narrows the plugin list', english > 0 && english < pluginTotal, `${english} of ${pluginTotal}`);

    // Arabic search for a curated title, then install command.
    await page.fill('#search', 'القانون');
    const arabicNames = await page.locator('#table-wrap tbody .name-btn bdi').allInnerTexts();
    check('Arabic search finds the legal plugin', arabicNames.includes('legal'), arabicNames.join(', '));

    await page.fill('#search', '');
    await page.selectOption('#f-status', 'available');
    const available = await page.locator('#table-wrap tbody tr').evaluateAll((rows) => rows.every((r) => r.dataset.status === 'available') && rows.length);
    check('status filter keeps only catalog-available plugins', available > 0, `${available} rows`);
    await page.locator('#table-wrap tbody tr .name-btn').first().click();
    const installText = await page.locator('#details .command:has([data-copy="install"]) code').innerText();
    await page.locator('#details [data-copy="install"]').click();
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    check('copied install command matches the documented form', clip === installText && /^claude plugin install \S+@knowledge-work-plugins --scope user$/.test(clip), clip);
    check('command says where it runs', (await page.locator('#details .command .where').first().innerText()).includes('PowerShell'));
    check('details show evidence source and check time', (await page.locator('#details .facts').innerText()).includes('marketplace.json') && (await page.locator('#details [data-checked]').innerText()).length > 0);
    check('command text is rendered left to right', (await page.locator('#details .command code').first().evaluate((n) => getComputedStyle(n).direction)) === 'ltr');
    await page.screenshot({ path: join(shots, '02-list-details-light.png') });

    // Sorting.
    await page.locator('[data-sort="name"]').click();
    const desc = await page.locator('#table-wrap tbody .name-btn bdi.token').allInnerTexts();
    check('name column sorts descending on second click', desc.length > 1 && desc[0].toLowerCase() >= desc[desc.length - 1].toLowerCase(), `${desc[0]} .. ${desc[desc.length - 1]}`);

    // Empty state.
    await page.fill('#search', 'zzzz-no-such-tool');
    check('empty state appears with a way out', await page.locator('[data-state="empty"] button').isVisible());
    await page.locator('[data-state="empty"] button').click();
    check('clearing restores the list', (await rowCount(page)) === pluginTotal);

    // Skills show parent state; related tools navigate.
    await page.locator('[data-nav="skill"]').click();
    await page.fill('#search', 'code-review');
    await page.locator('#table-wrap tbody tr .name-btn').first().click();
    check('skill details show the parent plugin state', (await page.locator('#details [data-status-note]').innerText()).includes('حالة الإضافة الأم'));
    await page.locator('#details [data-copy="usage"]').click();
    check('copied usage command is a slash command', /^\/[\w-]+(:[\w-]+)?$/.test(await app.evaluate(({ clipboard }) => clipboard.readText())));
    await page.locator('#details .related button').first().click();
    check('related tool opens from the details panel', (await page.locator('#details .related button').count()) > 1);

    // Keyboard only: focus a row with Tab-reachable button and open with Enter.
    await page.fill('#search', '');
    await page.locator('[data-nav="connector"]').click();
    await page.locator('#table-wrap tbody tr .name-btn').first().focus();
    await page.keyboard.press('Enter');
    check('Enter on a focused row opens details and moves focus into it', await page.evaluate(() => document.activeElement?.hasAttribute('data-close') ?? false));
    await page.keyboard.press('Escape');

    // Theme toggle, then force dark for the screenshots.
    const themeBefore = await page.getAttribute('html', 'data-theme');
    await page.locator('#theme-toggle').click();
    const themeAfter = await page.getAttribute('html', 'data-theme');
    check('theme toggle switches between light and dark', themeBefore !== themeAfter && ['light', 'dark'].includes(themeAfter), `${themeBefore} -> ${themeAfter}`);
    await setTheme(page, 'dark');
    check('dark theme applies', (await page.getAttribute('html', 'data-theme')) === 'dark');
    await page.locator('[data-nav="plugin"]').click();
    await page.locator('#table-wrap tbody tr .name-btn').first().click();
    await page.screenshot({ path: join(shots, '03-list-details-dark.png') });
    await page.locator('[data-nav="overview"]').click();
    await page.screenshot({ path: join(shots, '04-overview-dark.png') });
    await setTheme(page, 'light');

    // Narrow window: no horizontal overflow, details overlays.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 640));
    await page.locator('[data-nav="skill"]').click();
    await page.locator('#table-wrap tbody tr .name-btn').first().click();
    await page.waitForTimeout(300);
    check('no horizontal page overflow at minimum width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(shots, '05-narrow-details.png') });
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 840));

    // Refresh.
    const before = await page.getAttribute('#checked-at', 'data-checked');
    await page.locator('#refresh').click();
    check('refresh button reports progress', (await page.locator('#refresh').innerText()) === 'جارٍ التحديث' && (await page.locator('#refresh').isDisabled()));
    await page.waitForFunction((prev) => document.querySelector('#checked-at')?.getAttribute('data-checked') !== prev && !document.querySelector('#refresh')?.disabled, before, { timeout: 180000 });
    check('refresh updates the last-checked time', (await page.getAttribute('#checked-at', 'data-checked')) > before);

    check('no console errors in the normal run', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 2. Catalog unreachable, cached copy available ----------
  {
    const { app, page, errors } = await launch(profile, { CLAUDE_ADDS_CATALOG_URL: 'https://127.0.0.1:9/marketplace.json' });
    const row = page.locator('[data-source-row="catalog"]');
    check('catalog failure is reported as partial, not hidden', (await row.getAttribute('data-source-state')) === 'degraded');
    check('cached catalog date is shown', (await row.innerText()).includes('تاريخ البيانات') && (await page.locator('#banner').innerText()).includes('تاريخ نسخة الكتالوج المعروضة'));
    await page.locator('[data-nav="plugin"]').click();
    await page.selectOption('#f-status', 'available');
    check('last good catalog stays visible', (await rowCount(page)) > 50, `${await rowCount(page)} rows`);
    await page.locator('[data-nav="overview"]').click();
    await page.screenshot({ path: join(shots, '06-catalog-cached.png') });
    check('no console errors with cached catalog', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 3. Catalog unreachable, no cache ----------
  {
    const { app, page } = await launch(emptyProfile, { CLAUDE_ADDS_CATALOG_URL: 'https://127.0.0.1:9/marketplace.json' });
    check('catalog with no cache is reported as failed', (await page.locator('[data-source-row="catalog"]').getAttribute('data-source-state')) === 'failed');
    await page.locator('[data-nav="plugin"]').click();
    const kept = await rowCount(page);
    check('locally installed plugins still listed without any catalog', kept > 0, `${kept} rows`);
    await app.close();
  }

  // ---------- 4. Claude CLI missing ----------
  {
    const { app, page, errors } = await launch(profile, { CLAUDE_ADDS_CLAUDE_BIN: join(profile, 'no-such-claude.exe') });
    check('missing CLI is reported as failed', (await page.locator('[data-source-row="cli"]').getAttribute('data-source-state')) === 'failed');
    check('official setup path is offered', await page.locator('[data-source-row="cli"] [data-setup]').isVisible());
    check('connectors fall back to configuration files', (await page.locator('[data-source-row="connectors"]').getAttribute('data-source-state')) === 'degraded');
    await page.screenshot({ path: join(shots, '07-cli-missing-overview.png') });

    await page.locator('[data-nav="connector"]').click();
    const connectorStates = await page.locator('#table-wrap tbody tr').evaluateAll((rows) => [...new Set(rows.map((r) => r.dataset.status))]);
    check('no connector is claimed as connected without the CLI', connectorStates.length > 0 && !connectorStates.includes('connected') && !connectorStates.includes('needs-auth'), connectorStates.join());

    await page.locator('[data-nav="plugin"]').click();
    const pluginStates = await page.locator('#table-wrap tbody tr').evaluateAll((rows) => [...new Set(rows.map((r) => r.dataset.status))]);
    check('uninstalled-looking plugins are unverified, not available, without the CLI', pluginStates.includes('unverified') && !pluginStates.includes('available'), pluginStates.join());
    await page.selectOption('#f-status', 'unverified');
    await page.locator('#table-wrap tbody tr .name-btn').first().click();
    check('reason for the unverified state is shown', (await page.locator('#details [data-status-note]').innerText()).includes('Claude CLI'));
    await page.screenshot({ path: join(shots, '08-cli-missing-details.png') });

    await page.fill('#search', 'sales');
    check('search still works without the CLI', (await rowCount(page)) > 0);
    check('no console errors without the CLI', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  // ---------- 5. Direct install and account link, against a stand-in CLI ----------
  {
    const fakeState = join(profile, 'fake-claude-state.json');
    const { app, page, errors } = await launch(profile, {
      CLAUDE_ADDS_CLAUDE_BIN: join(root, 'tests', 'e2e', 'fixtures', 'fake-claude.cmd'),
      FAKE_CLAUDE_STATE: fakeState,
    });
    const accountRow = page.locator('[data-source-row="account"]');
    check('linked account is shown from the CLI sign-in', (await accountRow.getAttribute('data-source-state')) === 'ok' && (await accountRow.innerText()).includes('tester@example.test'));
    check('automatic sync defaults to 15 minutes', (await page.locator('#sync').inputValue()) === '15');
    await page.selectOption('#sync', '5');
    check('automatic sync interval can be changed', (await page.evaluate(() => localStorage.getItem('syncMinutes'))) === '5');

    await page.locator('[data-nav="plugin"]').click();
    await page.fill('#search', 'legal');
    await page.locator('[data-tool="plugin:legal"]').click();
    await page.locator('#details [data-install]').click();
    check('install asks for confirmation and shows the exact command', (await page.locator('#confirm').isVisible()) && (await page.locator('#confirm code').innerText()) === 'claude plugin install legal@knowledge-work-plugins --scope user');
    check('Anthropic-hosted plugin carries no third-party warning', (await page.locator('#confirm [data-third-party]').count()) === 0);
    await page.locator('#confirm-no').click();
    check('cancel installs nothing', !existsSync(fakeState) && (await page.locator('#confirm').isHidden()));

    await page.locator('#details [data-install]').click();
    await page.locator('#confirm-yes').click();
    await page.waitForSelector('[data-result="ok"]', { timeout: 120000 });
    await page.waitForFunction(() => !document.querySelector('#refresh')?.disabled, null, { timeout: 120000 });
    check('confirmed install runs through the CLI', readFileSync(fakeState, 'utf8').includes('legal@knowledge-work-plugins'));
    check('installed plugin shows as enabled after the automatic refresh', (await page.locator('#table-wrap tbody tr:has([data-tool="plugin:legal"])').getAttribute('data-status')) === 'enabled');
    check('installed plugin no longer offers install', (await page.locator('#details [data-install]').count()) === 0);
    await page.screenshot({ path: join(shots, '09-install-done.png') });

    await page.fill('#search', 'figma');
    await page.locator('[data-tool="plugin:figma"]').click();
    await page.locator('#details [data-install]').click();
    check('third-party plugin shows a source warning before install', await page.locator('#confirm [data-third-party]').isVisible());
    await page.screenshot({ path: join(shots, '10-install-confirm.png') });
    await page.keyboard.press('Escape');
    check('Escape closes the confirmation without installing', (await page.locator('#confirm').isHidden()) && !readFileSync(fakeState, 'utf8').includes('figma'));

    await page.fill('#search', 'zapier');
    await page.locator('[data-tool="plugin:zapier"]').click();
    await page.locator('#details [data-install]').click();
    await page.locator('#confirm-yes').click();
    await page.waitForSelector('[data-result="failed"]', { timeout: 120000 });
    check('a refused install is reported with the CLI reason', (await page.locator('[data-result="failed"]').innerText()).includes('confirmed in a terminal'));
    check('no console errors in the install run', errors.length === 0, errors.join(' | '));
    await app.close();
  }

  await rm(profile, { recursive: true, force: true });
  await rm(emptyProfile, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // A failed step must not leave an app window open behind it.
  .finally(() => Promise.all(openApps.map((app) => app.close().catch(() => {}))));
