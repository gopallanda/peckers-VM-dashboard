'use strict';

/**
 * auto-auth.js
 * -----------
 * Headless automated login for unattended (CI / GitHub Actions) runs.
 *
 * Strategy:
 *   1. If auth.json exists, try to use it — navigate to /mp1-reporting and
 *      see if we land on the dashboard (session still valid).
 *   2. If valid → save refreshed state and exit cleanly.
 *   3. If expired / missing → fill email + password, click submit, wait for
 *      the non-auth redirect, save fresh auth.json, exit.
 *
 * Run this BEFORE `npm run sync` in CI:
 *   node src/auto-auth.js && npm run sync
 *
 * Required env vars (same as sync):
 *   VM_HUB_EMAIL, VM_HUB_PASSWORD, (optionally VM_HUB_URL)
 */

const fs = require('fs');
const { chromium } = require('playwright');
const { RUNTIME, NAV } = require('./config');

const REPORTING_URL = RUNTIME.hubUrl.replace(/\/+$/, '') + RUNTIME.reportingPath;

/** True when the current page URL looks like a login/auth page. */
async function isOnLoginPage(page) {
  const url = page.url().toLowerCase();
  const onAuthUrl = NAV.authPathHints.some((h) => url.includes(h));
  const pwVisible = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  return onAuthUrl || pwVisible;
}

async function main() {
  if (!RUNTIME.email || !RUNTIME.password) {
    throw new Error(
      'VM_HUB_EMAIL and VM_HUB_PASSWORD must both be set. ' +
        'For GitHub Actions, add them as repository secrets.'
    );
  }

  // Build context options — include saved session if auth.json exists.
  const contextOptions = { acceptDownloads: false };
  if (fs.existsSync(RUNTIME.authFile)) {
    try {
      const raw = fs.readFileSync(RUNTIME.authFile, 'utf8');
      JSON.parse(raw); // validate — corrupt JSON falls through to fresh login
      contextOptions.storageState = RUNTIME.authFile;
      console.log('[auto-auth] Found auth.json — testing session validity…');
    } catch {
      console.warn('[auto-auth] auth.json is malformed — will log in fresh.');
    }
  } else {
    console.log('[auto-auth] No auth.json — will log in fresh.');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(60000);
  const page = await context.newPage();

  try {
    await page.goto(REPORTING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    if (!(await isOnLoginPage(page))) {
      console.log('[auto-auth] Session valid — saving refreshed auth.json.');
      await context.storageState({ path: RUNTIME.authFile });
      console.log('[auto-auth] Done. Session is ready for sync.');
      return;
    }

    // --- Session expired or no session — log in headlessly ---
    console.log('[auto-auth] Session invalid — logging in with credentials…');

    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[autocomplete="username"]')
      .first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(RUNTIME.email);

    const pwInput = page
      .locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]')
      .first();
    await pwInput.fill(RUNTIME.password);

    const submitBtn = page
      .locator(
        'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login"), input[type="submit"]'
      )
      .first();
    await submitBtn.click({ timeout: 10000 });

    // Poll until we leave the auth URL (max 30 s)
    const loginDeadline = Date.now() + 30000;
    while (Date.now() < loginDeadline) {
      if (!(await isOnLoginPage(page))) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForLoadState('networkidle').catch(() => {});

    if (await isOnLoginPage(page)) {
      throw new Error(
        'Login failed — still on auth page after submit. ' +
          'Verify VM_HUB_EMAIL and VM_HUB_PASSWORD are correct.'
      );
    }

    await context.storageState({ path: RUNTIME.authFile });
    console.log('[auto-auth] Login successful. Saved fresh session to auth.json.');
    console.log('[auto-auth] Ready for sync.');
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[auto-auth] FATAL:', err.message);
  process.exit(1);
});
