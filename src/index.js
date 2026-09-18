'use strict';

/**
 * index.js
 * --------
 * Orchestrator for `npm run sync`.
 *
 * Loops every whitelisted report x every store, captures each Mon–Sun week in
 * the window (retrying with exponential backoff), then full-refreshes that
 * store's table in Supabase. Prints a run summary and exits non-zero if
 * anything failed.
 */

const { REPORTS, STORES, RUNTIME, getWeeks } = require('./config');
const { withSession, extractReportForStoreWeek } = require('./extract');
const { loadStore, closePool, refreshSnapshots } = require('./load');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry an async fn up to maxRetries with exponential backoff. */
async function withRetry(label, fn, maxRetries = RUNTIME.maxRetries) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(30000, 1000 * 2 ** (attempt - 1));
      console.warn(`[retry] ${label} attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) await sleep(backoff);
    }
  }
  throw lastErr;
}

async function main() {
  const weeks = getWeeks();
  console.log('==========================================================');
  console.log(' VM Hub -> Supabase sync');
  console.log(`  Reports : ${REPORTS.map((r) => r.chart).join(' | ')}`);
  console.log(`  Stores  : ${STORES.join(' | ')}`);
  console.log(`  Weeks   : ${weeks.map((w) => `${w.startISO}..${w.endISO}`).join(', ')}`);
  console.log(`  Headless: ${RUNTIME.headless}`);
  console.log('==========================================================\n');

  const summary = []; // { report, store, weeks, rows, status, error? }
  let anyFailed = false;

  await withSession(async (page) => {
    for (const report of REPORTS) {
      for (const store of STORES) {
        const label = `${report.chart} @ ${store}`;
        const weeksData = [];
        let storeFailed = false;

        for (const week of weeks) {
          const wLabel = `${label} [${week.startISO}..${week.endISO}]`;
          try {
            const captured = await withRetry(wLabel, () =>
              extractReportForStoreWeek(page, { report, store, week })
            );
            weeksData.push({ ...captured, week });
            console.log(`[ok]  ${wLabel} -> ${captured.rows.length} rows`);
          } catch (err) {
            storeFailed = true;
            anyFailed = true;
            console.error(`[FAIL] ${wLabel}: ${err.message}`);
            summary.push({
              report: report.chart,
              store,
              week: `${week.startISO}..${week.endISO}`,
              rows: 0,
              status: 'extract-failed',
              error: err.message,
            });
          }
        }

        if (weeksData.length === 0) {
          console.error(`[FAIL] ${label}: no weeks captured, skipping load.`);
          continue;
        }

        // Load whatever weeks we did capture (full-refresh per store).
        try {
          const { deleted, inserted } = await loadStore(report.table, store, weeksData);
          const totalRows = weeksData.reduce((n, w) => n + w.rows.length, 0);
          console.log(
            `[load] ${report.table} <- ${store}: deleted ${deleted}, inserted ${inserted}`
          );
          summary.push({
            report: report.chart,
            store,
            week: weeks.map((w) => w.startISO).join(','),
            rows: totalRows,
            status: storeFailed ? 'partial' : 'ok',
          });
        } catch (err) {
          anyFailed = true;
          console.error(`[FAIL] load ${report.table} <- ${store}: ${err.message}`);
          summary.push({
            report: report.chart,
            store,
            week: '-',
            rows: 0,
            status: 'load-failed',
            error: err.message,
          });
        }
      }
    }
  });

  // ---- Snapshot refresh (once, after ALL loads have committed) -----------
  // A snapshot of partial data is worse than a stale one, so skip on any
  // failure. A refresh error never touches the committed load; it only makes
  // the run exit non-zero so it isn't silent.
  let refreshFailed = false;
  if (anyFailed) {
    console.warn('[refresh] skipped vm_refresh_all_snapshots(): one or more report/store loads failed.');
  } else {
    const t0 = Date.now();
    try {
      await refreshSnapshots();
      console.log(`[refresh] vm_refresh_all_snapshots() ok in ${Date.now() - t0}ms`);
    } catch (err) {
      if (err.code === '42883') {
        // undefined_function — code deployed before the SQL; don't fail the sync.
        console.warn(
          '[refresh] WARNING: vm_refresh_all_snapshots() does not exist — run the ' +
            'snapshot-refresh SQL in the Supabase SQL Editor. Snapshots NOT refreshed.'
        );
      } else {
        refreshFailed = true;
        console.error(
          `[FAIL] refresh vm_refresh_all_snapshots() after ${Date.now() - t0}ms: ${err.message}`
        );
        summary.push({
          report: 'vm_refresh_all_snapshots()',
          store: 'all',
          week: '-',
          rows: 0,
          status: 'refresh-failed',
          error: err.message,
        });
      }
    }
  }

  await closePool();

  // ---- Run summary -------------------------------------------------------
  console.log('\n===================== RUN SUMMARY ========================');
  for (const s of summary) {
    const tag = s.status.toUpperCase().padEnd(14);
    console.log(`${tag} ${s.report} @ ${s.store}  rows=${s.rows}${s.error ? `  (${s.error})` : ''}`);
  }
  console.log('==========================================================');

  if (anyFailed) {
    console.error('\nOne or more report/store loads failed. Exiting non-zero.');
    process.exit(1);
  }
  if (refreshFailed) {
    console.error('\nAll data loaded, but the snapshot refresh failed. Exiting non-zero.');
    process.exit(1);
  }
  console.log('\nAll reports synced successfully.');
}

main().catch(async (err) => {
  console.error('[sync] Fatal:', err.message);
  await closePool().catch(() => {});
  process.exit(1);
});
