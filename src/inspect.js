'use strict';

/**
 * inspect.js
 * ----------
 * One-off DOM dumper. Reuses the saved session, opens ONLY the reporting page,
 * then:
 *   1. opens the Chart menu and dumps it      -> debug/chart_frame_*.html
 *   2. opens the Stores menu and dumps it      -> debug/stores_frame_*.html
 *   3. runs the full filter cycle for the FIRST whitelisted report/store/week
 *   4. dumps every frame (the #question-data result frame is now populated)
 *
 * Run:  $env:HEADLESS=0; npm run inspect
 * Writes nothing to Supabase.
 */

const fs = require('fs');
const path = require('path');
const { withSession, applyFilters, reportFrame } = require('./extract');
const { REPORTS, STORES, RUNTIME, getWeeks } = require('./config');

function out(file) {
  return path.join(RUNTIME.debugDir, file);
}

async function dumpAllFrames(page, label) {
  const frames = page.frames();
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let html = '';
    try {
      html = await f.content();
    } catch (e) {
      html = `<<could not read frame: ${e.message}>>`;
    }
    const parent = f.parentFrame() ? 'child' : 'MAIN';
    const line = `[frame ${i}] (${parent}) url=${f.url()} name="${f.name()}" htmlBytes=${html.length}`;
    lines.push(line);
    console.log('  ' + line);
    fs.writeFileSync(out(`${label}frame_${i}.html`), html, 'utf8');
  }
  if (!label) fs.writeFileSync(out('frames.txt'), lines.join('\n'), 'utf8');
}

async function openAndDump(page, controlSel, label) {
  const frame = reportFrame(page);
  try {
    await frame.locator(`${controlSel} [class*="-control"]`).first().click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: out(`${label}menu.png`) });
    await dumpAllFrames(page, `${label}_`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  } catch (e) {
    console.warn(`[inspect] Could not open ${label} menu: ${e.message}`);
  }
}

async function main() {
  fs.mkdirSync(RUNTIME.debugDir, { recursive: true });

  await withSession(async (page) => {
    // 1 + 2: dump the open Chart and Stores menus.
    await openAndDump(page, '[data-test="null-Chart"]', 'chart');
    await openAndDump(page, '[data-test="null-Stores"]', 'stores');

    // 3: full filter cycle for the first whitelisted report.
    const report = REPORTS[0];
    const store = STORES[0];
    const week = getWeeks()[0];
    console.log(`[inspect] Applying: "${report.chart}" @ ${store} [${week.startUK}..${week.endUK}]`);
    try {
      await applyFilters(page, { report, store, week });
    } catch (e) {
      console.warn(`[inspect] applyFilters reported: ${e.message} (dumping anyway)`);
    }

    // 4: probe each frame for a results table (so we learn where it renders),
    //    then dump everything. Let this finish — do NOT Ctrl+C.
    for (let attempt = 0; attempt < 8; attempt++) {
      const rows = [];
      for (let i = 0; i < page.frames().length; i++) {
        const f = page.frames()[i];
        const info = await f
          .evaluate(() => ({
            url: location.href,
            tables: document.querySelectorAll('table').length,
            rows: document.querySelectorAll('tr').length,
            bodyLen: document.body ? document.body.innerText.length : 0,
          }))
          .catch(() => null);
        if (info) rows.push(`f${i}: tables=${info.tables} tr=${info.rows} len=${info.bodyLen} ${info.url.slice(0, 60)}`);
      }
      console.log(`[inspect] frame probe #${attempt + 1}:\n   ${rows.join('\n   ')}`);
      if (rows.some((r) => /tables=[1-9]/.test(r))) break;
      await page.waitForTimeout(4000);
    }

    await page.screenshot({ path: out('inspect_1_page.png'), fullPage: true });
    fs.writeFileSync(out('page.html'), await page.content(), 'utf8');
    await dumpAllFrames(page, '');

    console.log('\n[inspect] Done. Share these:');
    console.log('  debug/frames.txt and debug/frame_*.html (look for #question-data results)');
    console.log('  debug/chart_frame_1.html, debug/stores_frame_1.html (menu markup)');
    console.log('  debug/inspect_1_page.png');
  });
}

main().catch((err) => {
  console.error('[inspect] Failed:', err.message);
  process.exit(1);
});
