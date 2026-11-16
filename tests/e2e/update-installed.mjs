// Real update test for an installed Windows build.
//
// Install an older build with its setup.exe, make sure a newer release exists
// on GitHub for its channel, then run:
//
//   CLAUDE_ADDS_INSTALLED_EXE="<install dir>\Claude Adds.exe" node tests/e2e/update-installed.mjs
//
// The app checks GitHub, downloads the installer, verifies it, installs it and
// restarts. The script then reads the version of the restarted app.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const exe = process.env.CLAUDE_ADDS_INSTALLED_EXE;
if (!exe) {
  console.error('Set CLAUDE_ADDS_INSTALLED_EXE to the installed "Claude Adds.exe".');
  process.exit(2);
}

const results = [];
function check(name, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  [REAL-UPDATE] ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A throwaway profile and home keep the test away from the real settings and
// make the inventory quick. The update itself talks to the real GitHub.
async function open(profile, home) {
  const app = await electron.launch({
    executablePath: exe,
    args: [],
    env: { ...process.env, CLAUDE_ADDS_USER_DATA: profile, CLAUDE_ADDS_HOME: home, CLAUDE_ADDS_NO_UPDATE_CHECK: '1', CLAUDE_ADDS_CLAUDE_BIN: join(home, 'none.exe') },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#checked-at[data-checked]:not([data-checked=""])', { timeout: 180000 });
  await page.locator('[data-nav="platforms"]').click();
  await page.waitForSelector('[data-card="update"]');
  const version = (await page.locator('[data-card="update"] .platform-head bdi').innerText()).trim();
  return { app, page, version };
}

function stopInstalledApp() {
  const dir = dirname(exe).replace(/'/g, "''");
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process 'Claude Adds' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${dir}\\*' } | Stop-Process -Force`], { stdio: 'ignore' });
  } catch {
    // Nothing to stop, or the process already exited.
  }
}

const profile = await mkdtemp(join(tmpdir(), 'claude-adds-upd-profile-'));
const home = await mkdtemp(join(tmpdir(), 'claude-adds-upd-home-'));

try {
  const first = await open(profile, home);
  const card = first.page.locator('[data-card="update"]');
  check('the installed build can update itself', (await card.getAttribute('data-update-mode')) === 'installer', `version ${first.version}`);
  // CLAUDE_ADDS_UPDATE_TEST_CHANNEL=stable|dev tests a specific channel instead of the build's default.
  const wanted = process.env.CLAUDE_ADDS_UPDATE_TEST_CHANNEL;
  if (wanted && wanted !== (await first.page.locator('#update-channel').inputValue())) {
    await first.page.selectOption('#update-channel', wanted);
    await sleep(1500);
  }
  console.log(`      channel: ${await first.page.locator('#update-channel').inputValue()}`);

  await first.page.locator('[data-update-check]').click();
  await first.page.waitForSelector('[data-card="update"][data-update-status="ready"], [data-card="update"][data-update-status="none"], [data-card="update"][data-update-status="error"]', { timeout: 600000 });
  const status = await card.getAttribute('data-update-status');
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  check('a newer release was found, downloaded and verified', status === 'ready' && text.includes('SHA-256'), `${status}: ${text.slice(0, 160)}`);
  check('the ready update is announced in the banner', (await first.page.locator('[data-update-notice="ready"]').count()) === 1);
  if (status !== 'ready') throw new Error('update did not become ready');

  const closed = first.app.waitForEvent('close', { timeout: 60000 });
  await first.page.locator('[data-card="update"] [data-update-install]').click();
  await closed;
  check('the app closed to let the installer run', true);

  // The installer replaces the files and restarts the app on its own.
  await sleep(60000);
  stopInstalledApp();
  await sleep(3000);

  const second = await open(profile, home);
  check('the restarted app runs the newer version', second.version !== first.version, `${first.version} -> ${second.version}`);
  await second.page.locator('[data-update-check]').click();
  await second.page.waitForSelector('[data-card="update"][data-update-status="none"], [data-card="update"][data-update-status="available"], [data-card="update"][data-update-status="ready"], [data-card="update"][data-update-status="error"]', { timeout: 120000 });
  check('after updating, the channel reports no newer build', (await second.page.locator('[data-card="update"]').getAttribute('data-update-status')) === 'none');
  await second.app.close();
} catch (error) {
  console.error(error);
  results.push(false);
} finally {
  stopInstalledApp();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
