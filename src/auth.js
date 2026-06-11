'use strict';

/**
 * auth.js
 * -------
 * One-time, HEADED login. Run with `npm run auth`.
 *
 * Opens a real browser window so YOU complete the VM Hub login (and any MFA)
 * by hand, then saves the authenticated session to `auth.json` via Playwright
 * storageState. The scheduled `npm run sync` reuses that file headlessly.
 *
 * The password is never auto-typed in unattended runs. If VM_HUB_PASSWORD is
 * set we pre-fill the email/password to save you typing, but you still click
 * through MFA / "Sign in" yourself.
 */

const { chromium } = require('playwright');
const { RUNTIME } = require('./config');

const REPORTING_URL = RUNTIME.hubUrl.replace(/\/+$/, '') + RUNTIME.reportingPath;

async function main() {
  console.log('[auth] Launching a headed browser for interactive login…');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  // Go straight to the reporting page; if not logged in VM Hub will bounce us
  // to its login screen.
  await page.goto(REPORTING_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Best-effort convenience pre-fill. These selectors may need a one-time tweak
  // for this exact VM Hub build.
  // TODO(confirm-on-first-run): adjust the login email/password selectors here.
  if (RUNTIME.email) {
    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[autocomplete="username"]')
      .first();
    await emailInput.fill(RUNTIME.email, { timeout: 4000 }).catch(() => {});
  }
  if (RUNTIME.password) {
    const pwInput = page
      .locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]')
      .first();
    await pwInput.fill(RUNTIME.password, { timeout: 4000 }).catch(() => {});
  }

  console.log('\n========================================================');
  console.log(' Complete the login (and MFA) in the opened browser.');
  console.log(' When you can SEE the MP1 reporting page with the report');
  console.log(' iframe loaded, come back here and press ENTER to save.');
  console.log('========================================================\n');

  await waitForEnter();

  await context.storageState({ path: RUNTIME.authFile });
  console.log(`[auth] Saved session to ${RUNTIME.authFile}.`);
  console.log('[auth] You can now run: npm run sync');

  await browser.close();
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

main().catch((err) => {
  console.error('[auth] Failed:', err);
  process.exit(1);
});
