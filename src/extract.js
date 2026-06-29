'use strict';

/**
 * extract.js
 * ----------
 * Playwright extraction against the VM Hub MP1 reporting page.
 *
 * Everything important lives inside a single cross-origin Metabase iframe. A
 * headless browser CAN reach into it via frame locators, type into its inputs,
 * wait for the query network call, and capture the data — which the live
 * interactive tooling could not do because keystrokes don't cross the iframe
 * boundary there.
 *
 * Public API:
 *   withSession(fn)                       -> sets up browser+context+guard
 *   extractReportForStoreWeek(page, opts) -> returns { columns, rows }
 *
 * Many selectors inside the iframe (react-select widgets, date inputs, the CSV
 * export button) cannot be guaranteed without the live DOM. They are best-effort
 * and marked TODO(confirm-on-first-run). Run once with HEADLESS=0 DEBUG_SHOTS=1
 * to confirm/adjust them.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { parse: parseCsv } = require('csv-parse/sync');
const { RUNTIME, NAV } = require('./config');

const REPORTING_URL = RUNTIME.hubUrl.replace(/\/+$/, '') + RUNTIME.reportingPath;

// ---------------------------------------------------------------------------
// Navigation guard — hard block on any document navigation to the VM Hub host
// that is NOT the reporting page (and is not an auth flow). Cross-origin
// resources (the Metabase iframe, fonts, APIs on other hosts) are untouched.
// ---------------------------------------------------------------------------
function isAllowedNav(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return true; // not a real URL, let Playwright deal with it
  }
  const hubHost = new URL(RUNTIME.hubUrl).host;
  if (u.host !== hubHost) return true; // other hosts (e.g. Metabase) are fine

  const p = u.pathname.toLowerCase();
  if (NAV.allowedPathPrefixes.some((prefix) => p.startsWith(prefix))) return true;
  if (NAV.authPathHints.some((hint) => p.includes(hint))) return true;
  if (p === '/' || p === '') return true; // root often redirects into auth
  return false;
}

async function installNavGuard(context) {
  await context.route('**/*', (route) => {
    const req = route.request();
    // Only police TOP-LEVEL (main-frame) document navigations — that's what
    // could wander the browser into another live-ordering module. Sub-frame
    // (iframe) document loads must be allowed, because the embedded report
    // itself loads from a VM Hub path; blocking those leaves the pane empty.
    if (req.resourceType() === 'document' && req.isNavigationRequest()) {
      const frame = req.frame();
      const isMainFrame = frame ? frame.parentFrame() === null : true;
      if (isMainFrame && !isAllowedNav(req.url())) {
        console.warn(`[guard] BLOCKED top-level navigation to disallowed VM Hub page: ${req.url()}`);
        return route.abort();
      }
    }
    return route.continue();
  });
}

// ---------------------------------------------------------------------------
// Session bootstrap
// ---------------------------------------------------------------------------
async function withSession(fn) {
  if (!fs.existsSync(RUNTIME.authFile)) {
    throw new Error(
      `Missing ${RUNTIME.authFile}. Run "npm run auth" once to log in and save the session.`
    );
  }
  fs.mkdirSync(RUNTIME.downloadsDir, { recursive: true });
  if (RUNTIME.debugShots) fs.mkdirSync(RUNTIME.debugDir, { recursive: true });

  const browser = await chromium.launch({ headless: RUNTIME.headless });
  const context = await browser.newContext({
    storageState: RUNTIME.authFile,
    acceptDownloads: true,
  });
  await installNavGuard(context);
  // VM Hub + the cross-origin embed can be slow to settle; be generous.
  context.setDefaultNavigationTimeout(90000);
  context.setDefaultTimeout(30000);

  const page = await context.newPage();
  try {
    await openReporting(page);
    return await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function openReporting(page) {
  // 'commit' resolves as soon as the navigation response is received, rather
  // than waiting for all subresources — VM Hub can be slow to fully settle.
  await page.goto(REPORTING_URL, { waitUntil: 'commit' });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await assertLoggedIn(page);
  await page.waitForLoadState('networkidle').catch(() => {});

  // Decide where we are by URL only. The reporting route may load its Metabase
  // iframe a few seconds later, so iframe-presence is NOT a reliable "are we
  // there" signal — we wait for it separately below.
  if (!onReportingUrl(page)) {
    console.log('[extract] Not on /mp1-reporting yet. Routing via the sidebar link…');
    await gotoReportingViaNav(page);
  }

  if (!onReportingUrl(page)) {
    throw new Error(
      'Could not reach /mp1-reporting. The "MP1 reporting" sidebar link was not ' +
        'found/clickable — run with HEADLESS=0 DEBUG_SHOTS=1 and confirm the nav ' +
        'link selector in gotoReportingViaNav(). TODO(confirm-on-first-run).'
    );
  }

  console.log(`[extract] URL: ${page.url()}`);
  await waitForReportIframe(page);
  console.log('[extract] Report iframe ready.');
}

/** True when the current URL is the reporting route (iframe not required). */
function onReportingUrl(page) {
  return page.url().toLowerCase().includes('mp1-reporting');
}

/**
 * Wait for the Metabase report iframe to be injected. It can appear a few
 * seconds after the route loads, so we give it a generous window and report a
 * clear diagnostic if it never shows.
 */
async function waitForReportIframe(page) {
  try {
    await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 60000 });
  } catch {
    const n = await page.locator('iframe').count().catch(() => 0);
    throw new Error(
      `No report iframe appeared on ${page.url()} (iframe count=${n}). Run with ` +
        'HEADLESS=0 DEBUG_SHOTS=1 and confirm the report renders inside an <iframe>. ' +
        'TODO(confirm-on-first-run).'
    );
  }
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * Route to the reporting page by clicking the "MP1 reporting" sidebar item
 * (client-side route — no document navigation, so the nav guard is untouched).
 * The MUI sidebar drawer is often collapsed, so the link is present but hidden;
 * we click it forcibly / via JS rather than waiting for visibility. The other
 * sidebar modules are never clicked.
 * TODO(confirm-on-first-run): confirm the sidebar link selector.
 */
async function gotoReportingViaNav(page) {
  const link = page
    .locator('a[href="/mp1-reporting"], a[href*="mp1-reporting"]')
    .first();
  await link.waitFor({ state: 'attached', timeout: 15000 });
  // Hidden (collapsed drawer) -> force click, then fall back to a DOM click.
  await link.click({ force: true, timeout: 5000 }).catch(async () => {
    await link.evaluate((el) => el.click()).catch(() => {});
  });
  await page.waitForURL('**/mp1-reporting**', { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * If a run lands on a login page, fail loudly telling the user to re-auth.
 * TODO(confirm-on-first-run): tighten the login detection for this VM Hub build.
 */
async function assertLoggedIn(page) {
  const url = page.url().toLowerCase();
  const onAuthUrl = NAV.authPathHints.some((h) => url.includes(h));
  const passwordVisible = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (onAuthUrl || passwordVisible) {
    throw new Error(
      'Landed on a VM Hub login page — the saved session has expired. ' +
        'Re-run "npm run auth" to refresh auth.json.'
    );
  }
}

// ---------------------------------------------------------------------------
// Iframe helpers — confirmed against the live DOM (see debug/frame_1.html).
//
//   main page
//     └─ iframe[title="Feature Iframe"]   (vmos2.vmos.io report embed)  ← FILTERS
//          └─ iframe#question-data        (Metabase question)           ← RESULTS
// ---------------------------------------------------------------------------
const REPORT_IFRAME = 'iframe[title="Feature Iframe"]';

// Stable filter-bar hooks discovered in the DOM.
const SEL = {
  chart: '[data-test="null-Chart"]',
  interval: '[data-test="null-Interval"]', // not present in current build; optional
  stores: '[data-test="null-Stores"]',
  channels: '[data-test="null-Channels"]',
  startDate: '#rdp-form-control-startDate',
  endDate: '#rdp-form-control-endDate',
  update: 'button:has-text("Update")',
  // react-select option elements carry an emotion class ending in "-option".
  option: '[class*="-option"]',
};

/** FrameLocator for the report embed (filter bar lives here). */
function reportFrame(page) {
  return page.frameLocator(REPORT_IFRAME);
}

/** FrameLocator for the nested Metabase question (results + export live here). */
function resultFrame(page) {
  return page.frameLocator(REPORT_IFRAME).frameLocator('#question-data');
}

async function shot(page, name) {
  if (!RUNTIME.debugShots) return;
  const file = path.join(RUNTIME.debugDir, `${Date.now()}_${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log(`[debug] screenshot -> ${file}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a react-select widget by clicking its control box; retry until the
 *  option menu actually appears (reopening a select with a value can be flaky). */
async function openReactSelect(frame, rootSel) {
  const control = frame.locator(`${rootSel} [class*="-control"]`).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await control.click().catch(() => {});
    try {
      await frame.locator(SEL.option).first().waitFor({ state: 'visible', timeout: 6000 });
      return;
    } catch {
      await sleep(500); // and retry the open click
    }
  }
  throw new Error(`Could not open select ${rootSel} — option menu never appeared.`);
}

/**
 * Click the open react-select option whose text EXACTLY equals `label`. The
 * Chart select is NOT searchable (readonly dummy input), so we open the menu
 * and click the exact option. Matching is EXACT (anchored, case-insensitive) so
 * we never grab a similarly-named variant like "… (on fulfilment date)".
 */
async function clickOptionByText(page, frame, label, { timeout = 15000 } = {}) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactRx = new RegExp(`^\\s*${escaped}\\s*$`, 'i');

  // 1) Exact-match locator (lets Playwright wait/scroll/click).
  const opt = frame.locator(SEL.option).filter({ hasText: exactRx }).first();
  try {
    await opt.waitFor({ state: 'visible', timeout });
    await opt.scrollIntoViewIfNeeded().catch(() => {});
    await opt.click();
    return label;
  } catch {
    /* fall through to the text-scan fallback */
  }

  // 2) Fallback: scan all option texts for an exact (normalised) match.
  const options = frame.locator(SEL.option);
  const texts = (await options.allInnerTexts().catch(() => [])).map((t) => t.trim());
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const idx = texts.findIndex((t) => norm(t) === norm(label));
  if (idx < 0) {
    throw new Error(
      `Option "${label}" not found among ${texts.length} options: ${texts.slice(0, 8).join(' | ')}…`
    );
  }
  await options.nth(idx).scrollIntoViewIfNeeded().catch(() => {});
  await options.nth(idx).click();
  return texts[idx];
}

// ---------------------------------------------------------------------------
// Filter setters
// ---------------------------------------------------------------------------
async function selectChart(page, frame, chartName) {
  // If the chart is ALREADY the target (common when looping stores for the same
  // report), don't reopen — react-select hides/marks the selected option, so a
  // re-pick would "not find" it. Just keep what's there.
  const current = (
    await frame.locator(`${SEL.chart} [class*="singleValue"]`).innerText().catch(() => '')
  ).trim();
  if (current === chartName) {
    console.log(`[extract] Chart already "${chartName}" — keeping.`);
    return;
  }

  await openReactSelect(frame, SEL.chart);
  await clickOptionByText(page, frame, chartName);
  await page.waitForTimeout(300);

  const shown = (await frame.locator(`${SEL.chart} [class*="singleValue"]`).innerText().catch(() => '')) || '';
  if (shown.trim() !== chartName) {
    console.warn(`[extract] Chart shows "${shown.trim()}" (wanted "${chartName}").`);
  }
}

/**
 * Interval (Daily/Weekly/Whole period) is not present in the current build's
 * filter bar; it may appear for some charts. Best-effort: set Weekly if present.
 */
async function selectInterval(page, frame) {
  if (!(await frame.locator(SEL.interval).count().catch(() => 0))) {
    console.log('[extract] No Interval control in this report — skipping (report defaults apply).');
    return false;
  }
  await openReactSelect(frame, SEL.interval);
  const weekly = frame.locator(SEL.option).filter({ hasText: 'Weekly' }).first();
  await weekly.click({ timeout: 5000 }).catch(async () => {
    await page.keyboard.type('Weekly');
    await page.keyboard.press('Enter');
  });
  return true;
}

async function setDate(page, frame, which /* 'start' | 'end' */, ddmmyyyy) {
  const sel = which === 'start' ? SEL.startDate : SEL.endDate;
  const groupId = which === 'start' ? '#rdp-input-group-startDate' : '#rdp-input-group-endDate';
  const dayNum = parseInt(ddmmyyyy.slice(0, 2), 10); // DD/MM/YYYY -> day
  const input = frame.locator(sel);

  // Press Escape to dismiss any open calendar popover before interaction.
  // This avoids the "intercepts pointer events" timeout entirely.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);

  // Click the input to open the date picker.
  await input.click();
  await page.waitForTimeout(200);

  // Select all existing text and type the new date.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(ddmmyyyy, { delay: 40 });
  await page.waitForTimeout(300);

  // Typing moves the calendar to that month with the day highlighted. Clicking
  // the day confirms the value AND closes the popover (which otherwise overlays
  // the next field). Fall back to Escape if the cell isn't clickable.
  const dayCell = frame.locator(`${groupId} .rdp-popover td[data-day="${dayNum}"]`).first();
  await dayCell.click({ timeout: 2500 }).catch(async () => {
    await page.keyboard.press('Escape').catch(() => {});
  });
  await page.waitForTimeout(150);

  const got = await input.inputValue().catch(() => '');
  if (got !== ddmmyyyy) {
    console.warn(`[extract] ${which} date is "${got}" (wanted ${ddmmyyyy}).`);
  }
}

/**
 * Set the Stores multi-select to exactly ONE store: open, click "Deselect all",
 * click the single target store option, close. Verifies via the hidden
 * <input name="stores"> values the widget keeps in sync.
 */
async function selectSingleStore(page, frame, storeName) {
  await openReactSelect(frame, SEL.stores);
  await page.waitForTimeout(400);

  // Deselect everything first (default is "All stores"). The exact link text
  // is confirmed from the menu dump; try a few variants defensively.
  for (const label of ['Deselect all', 'Deselect All', 'Clear all', 'Clear', 'Remove all']) {
    const link = frame.getByText(label, { exact: true }).first();
    if (await link.count().catch(() => 0)) {
      await link.click().catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(250);

  // Click the single target store option (exact text).
  await clickOptionByText(page, frame, storeName, { timeout: 8000 }).catch(async () => {
    await frame.getByText(storeName, { exact: true }).first().click().catch(() => {});
  });
  await frame.locator('body').press('Escape').catch(() => {});

  const vals = await frame
    .locator(`${SEL.stores} input[name="stores"]`)
    .evaluateAll((els) => els.map((e) => e.value))
    .catch(() => []);
  console.log(`[extract] Stores selected: ${JSON.stringify(vals)}`);
  if (!(vals.length === 1 && vals[0] === storeName)) {
    console.warn(`[extract] Expected only "${storeName}" selected but got ${JSON.stringify(vals)}.`);
  }
}

async function clickUpdate(page, frame) {
  // The button is `disabled` until a chart is chosen; wait for it to enable.
  const update = frame.locator(SEL.update).first();
  await update.waitFor({ state: 'visible', timeout: 15000 });
  for (let i = 0; i < 30; i++) {
    const dis = await update.getAttribute('disabled').catch(() => null);
    const cls = (await update.getAttribute('class').catch(() => '')) || '';
    if (dis === null && !cls.includes('disabled')) break;
    await page.waitForTimeout(500);
  }
  await update.click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

// The results live in a nested Metabase embed iframe whose URL carries a
// self-authorizing JWT token, e.g.
//   https://<metabase-host>/embed/question/<JWT>#bordered=true&titled=true
const EMBED_RE = /\/embed\/question\/([^/?#]+)/;

/** Find the live Metabase embed Frame (by URL) among all frames. */
function findEmbedFrame(page) {
  return page.frames().find((f) => EMBED_RE.test(f.url())) || null;
}

/** Current embed URL, or '' if none. Each query mints a fresh token, so this
 *  string changes after every Update — we use that to detect the new result. */
function currentEmbedUrl(page) {
  const f = findEmbedFrame(page);
  return f ? f.url() : '';
}

/**
 * Wait for the Metabase embed to reload with a FRESH token (different from
 * `prevUrl`) and render its table. Waiting for the URL to change is what stops
 * us from fetching the PREVIOUS report's stale data. Returns the Frame.
 */
async function waitForResults(page, prevUrl = '', timeoutMs = 210000) {
  const deadline = Date.now() + timeoutMs;
  let embed = null;
  let urlChanged = false;
  while (Date.now() < deadline) {
    embed = findEmbedFrame(page);
    if (embed && embed.url() !== prevUrl) {
      if (!urlChanged) {
        console.log(`[extract] Embed URL changed (new token) — waiting for table to render.`);
        urlChanged = true;
      }
      const hasTable = await embed
        .locator('table, [class*="TableInteractive"]')
        .first()
        .count()
        .catch(() => 0);
      if (hasTable) {
        await embed
          .locator('table, [class*="TableInteractive"]')
          .first()
          .waitFor({ state: 'visible', timeout: 30000 })
          .catch(() => {});
        console.log(`[extract] Table visible after ~${Math.round((timeoutMs - (deadline - Date.now())) / 1000)}s.`);
        return embed;
      }
    }
    await page.waitForTimeout(2000);
  }
  // Chart may render as a visualization (not a table) — CSV path can still succeed.
  console.warn(`[extract] Table not detected in ${timeoutMs / 1000}s (chart may render as graph). URL changed=${urlChanged}. Proceeding to CSV capture.`);
  return embed;
}

/**
 * Apply all filters for one (report, store, week) and run the query. Returns the
 * Metabase embed Frame. Shared by the extractor and the inspector.
 */
async function applyFilters(page, { report, store, week }) {
  const frame = reportFrame(page);
  await assertLoggedIn(page);

  await selectChart(page, frame, report.chart);
  await selectInterval(page, frame); // Weekly if the control exists (URL also defaults to Weekly)
  await setDate(page, frame, 'start', week.startUK);
  await setDate(page, frame, 'end', week.endUK);
  await selectSingleStore(page, frame, store);
  // Channels: intentionally left as "All channels".

  // Remember the current embed token, then wait for it to CHANGE after Update so
  // we never capture the previous report/store's data.
  const prevUrl = currentEmbedUrl(page);
  await clickUpdate(page, frame);
  return waitForResults(page, prevUrl);
}

// ---------------------------------------------------------------------------
// Data capture.
//
// PREFERRED: fetch the full result set straight from Metabase's signed-embed
// CSV endpoint — /api/embed/card/<token>/query/csv — using the token from the
// embed iframe URL. All filters (dates/store/channels/weekly) are locked inside
// the token, so the endpoint returns exactly the filtered data with no clicking
// and no row-virtualisation limits.
//
// FALLBACK: scrape the rendered Metabase table (visible rows only).
// ---------------------------------------------------------------------------
async function captureViaCsv(page, tag) {
  const embed = findEmbedFrame(page);
  if (!embed) {
    console.warn('[extract] No Metabase embed frame found — cannot fetch CSV.');
    return null;
  }
  const u = new URL(embed.url());
  const token = (u.pathname.match(EMBED_RE) || [])[1];
  if (!token) return null;

  const csvUrl = `${u.origin}/api/embed/card/${token}/query/csv`;
  console.log(`[extract] Fetching CSV for tag=${tag} …`);
  const resp = await page.request.get(csvUrl, { timeout: 120000 }).catch((e) => {
    console.warn(`[extract] CSV request error (${tag}): ${e.message}`);
    return null;
  });
  if (!resp || !resp.ok()) {
    console.warn(`[extract] CSV endpoint returned ${resp ? resp.status() : 'no response'} for ${tag}.`);
    return null;
  }

  const raw = await resp.text();
  if (/^\s*</.test(raw)) {
    console.warn('[extract] CSV endpoint returned HTML (not CSV) — falling back to table scrape.');
    return null;
  }
  const filePath = path.join(RUNTIME.downloadsDir, `${tag}_${Date.now()}.csv`);
  fs.mkdirSync(RUNTIME.downloadsDir, { recursive: true });
  fs.writeFileSync(filePath, raw, 'utf8');
  return { ...parseCsvString(raw), sourceFile: path.basename(filePath) };
}

async function captureViaTable(page) {
  // Fallback: read the rendered Metabase TableInteractive. NOTE: Metabase
  // virtualises rows, so this may only see what's scrolled into view — the CSV
  // endpoint above is strongly preferred.
  const embed = findEmbedFrame(page);
  if (!embed) return { columns: [], rows: [], sourceFile: '(no-embed-frame)' };

  const headerCells = embed.locator('th.TableInteractive-headerCellData, thead th');
  await headerCells.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  const columns = (await headerCells.allInnerTexts().catch(() => [])).map((c) => c.trim());

  const rowEls = embed.locator('tbody tr');
  const n = await rowEls.count().catch(() => 0);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const cells = await rowEls.nth(i).locator('td').allInnerTexts().catch(() => []);
    if (!cells.length) continue;
    const obj = {};
    columns.forEach((c, idx) => {
      obj[c || `col_${idx}`] = (cells[idx] || '').trim();
    });
    rows.push(obj);
  }
  return { columns, rows, sourceFile: '(rendered-table)' };
}

function parseCsvString(raw) {
  const records = parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  const columns = records.length ? Object.keys(records[0]) : [];
  return { columns, rows: records };
}

// ---------------------------------------------------------------------------
// Top-level: extract one report for one store and one week window.
// ---------------------------------------------------------------------------
/**
 * @param {import('playwright').Page} page
 * @param {object} opts { report, store, week }  (see config.js shapes)
 * @returns {{ columns:string[], rows:object[], sourceFile:string }}
 */
async function extractReportForStoreWeek(page, opts) {
  const { report, store, week } = opts;
  const tag = `${report.table}_${store}_${week.startISO}`.replace(/[^a-z0-9_]+/gi, '_');

  await applyFilters(page, opts);

  // Confirm which chart the embed actually queried (the report frame URL carries
  // ?chart=<name>) — a cheap guard against picking the wrong report.
  const rfUrl = (page.frames().find((f) => /\/dashboard\/reporting/.test(f.url())) || {}).url
    ? page.frames().find((f) => /\/dashboard\/reporting/.test(f.url())).url()
    : '';
  const activeChart = rfUrl ? new URL(rfUrl).searchParams.get('chart') : null;
  if (activeChart && activeChart !== report.chart) {
    console.warn(`[extract] Active chart "${activeChart}" != requested "${report.chart}".`);
  } else if (activeChart) {
    console.log(`[extract] Active chart confirmed: ${activeChart}`);
  }
  await shot(page, `${tag}_filters`);

  let captured = await captureViaCsv(page, tag).catch((e) => {
    console.warn(`[extract] CSV export failed (${e.message}); will try table fallback.`);
    return null;
  });
  if (!captured || !captured.rows.length) {
    console.warn(`[extract] CSV returned ${captured ? 0 : 'null'} rows for ${tag} — falling back to DOM table scrape.`);
    captured = await captureViaTable(page);
    console.log(`[extract] DOM table fallback returned ${captured.rows.length} rows for ${tag}.`);
  } else {
    console.log(`[extract] CSV captured ${captured.rows.length} rows for ${tag}.`);
  }
  await shot(page, `${tag}_result`);

  return captured;
}

module.exports = {
  withSession,
  extractReportForStoreWeek,
  // exported for the inspector and for unit testing
  applyFilters,
  reportFrame,
  resultFrame,
  isAllowedNav,
  parseCsvString,
};
