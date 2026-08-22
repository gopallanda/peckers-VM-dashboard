'use strict';

/**
 * daily/sync.js
 * -------------
 * Entry point for `npm run sync:daily`.
 *
 * Pulls "Net Sales by Channel" for each store for each of the last few business
 * days (see daily/config.js) and loads it into vm_daily_net_sales_raw, so the
 * Cash-Flow API can serve one net-sales number per store per day to Sauce
 * Management.
 *
 * Purely additive: it imports extract.js, load.js and src/config.js READ-ONLY
 * and changes nothing about the weekly sync. Running this cannot affect any
 * vm_* table the weekly orchestrator owns.
 *
 * ---------------------------------------------------------------------------
 * WHY week_start / week_end HOLD A SINGLE DAY
 * ---------------------------------------------------------------------------
 * This looks like a naming compromise. It is deliberate, and it is the whole
 * point of the design.
 *
 * loadStore() in src/load.js is idempotent per (store, week_start): it deletes
 * that exact key and re-inserts, inside one transaction, scoped only to the
 * dates in the current run. By setting week_start = week_end = the business
 * date, a "week" becomes a day and we inherit that idempotency for free:
 *
 *   - re-running a date replaces exactly that date, never a neighbour;
 *   - a late delivery-platform correction self-heals on the next night's run;
 *   - there is ZERO new write code, so no second insert path to keep correct;
 *   - and no existing table is touched.
 *
 * The alternative — a bespoke daily writer with its own upsert — would
 * duplicate delete-then-insert logic that already exists and is already proven.
 *
 * So: in vm_daily_net_sales_raw, `week_start` is a DAY. Do not "fix" it. The
 * same explanation is repeated at the top of sql/daily_net_sales.sql, which is
 * where the next reader is most likely to trip over it.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY
 * ---------------------------------------------------------------------------
 * A QueryProcessorError means Metabase aborted the query and streamed a PARTIAL
 * result. extract.js already refuses to fall back to a DOM scrape in that case;
 * here we let it propagate through withRetry and then simply SKIP loading that
 * (store, date). Skipping is safe precisely because the delete is scoped to the
 * dates we did capture: an undercount is never written, and yesterday's good
 * figure is left standing rather than being replaced by a bad one.
 *
 * Anything that failed makes the process exit non-zero, which is what turns the
 * workflow red and fires the email alert.
 */

const { Pool } = require('pg');

const { RUNTIME } = require('../config');
const { withSession, extractReportForStoreWeek } = require('../extract');
const { loadStore, closePool } = require('../load');
const { DAILY_REPORT, STORES, getBusinessDates, DAILY_LOOKBACK_DAYS } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry an async fn with exponential backoff. Same contract and same backoff
 * curve as index.js's withRetry — reimplemented rather than imported because
 * index.js is the weekly orchestrator: requiring it would execute its main()
 * on import and kick off a full weekly sync.
 */
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

// ---------------------------------------------------------------------------
// Run ledger (vm_daily_sync_runs)
//
// Its only job is to let a consumer tell "the stores sold nothing" apart from
// "the sync never ran". A missing row in the raw table is ambiguous; a run row
// is not. /api/sauce/health reads the latest one.
//
// This uses its own short-lived pool rather than load.js's, because load.js
// keeps its pool private (it exports only loadStore/closePool) and reaching
// into it would mean editing that file.
// ---------------------------------------------------------------------------
let ledgerPool;
function getLedgerPool() {
  if (!ledgerPool) {
    if (!RUNTIME.dbUrl) {
      throw new Error('SUPABASE_DB_URL is not set — cannot record the daily run.');
    }
    ledgerPool = new Pool({
      connectionString: RUNTIME.dbUrl,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  }
  return ledgerPool;
}

async function closeLedgerPool() {
  if (ledgerPool) {
    await ledgerPool.end();
    ledgerPool = undefined;
  }
}

async function startRun(dates, startedAt) {
  const res = await getLedgerPool().query(
    `INSERT INTO vm_daily_sync_runs (business_dates, status, rows_loaded, started_at)
     VALUES ($1, 'running', 0, $2) RETURNING id`,
    [dates, startedAt]
  );
  return res.rows[0].id;
}

async function finishRun(id, { status, rowsLoaded, error }) {
  if (id == null) return;
  await getLedgerPool().query(
    `UPDATE vm_daily_sync_runs
        SET status = $2, rows_loaded = $3, error = $4, finished_at = now()
      WHERE id = $1`,
    [id, status, rowsLoaded, error ? String(error).slice(0, 2000) : null]
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Module-scoped so the fatal handler below can still close out the ledger row
// when main() throws part-way through.
let runId = null;

async function main() {
  const dates = getBusinessDates();
  const startedAt = new Date();

  console.log('==========================================================');
  console.log(' VM Hub -> Supabase DAILY net-sales sync');
  console.log(`  Chart   : ${DAILY_REPORT.chart}`);
  console.log(`  Table   : ${DAILY_REPORT.table}`);
  console.log(`  Stores  : ${STORES.join(' | ')}`);
  console.log(`  Dates   : ${dates.map((d) => d.businessDate).join(', ')}  (newest first)`);
  console.log(`  Lookback: ${DAILY_LOOKBACK_DAYS} day(s) ending yesterday (Europe/London)`);
  console.log(`  Headless: ${RUNTIME.headless}`);
  console.log('==========================================================\n');

  const summary = []; // { store, date, rows, status, error? }
  let anyFailed = false;

  try {
    runId = await startRun(
      dates.map((d) => d.businessDate),
      startedAt
    );
    console.log(`[ledger] run #${runId} started.`);
  } catch (err) {
    // A ledger failure must not be silent — it is the thing the health check
    // relies on — but it also must not stop us from loading real sales data.
    console.error(`[ledger] Could not open a run row: ${err.message}`);
  }

  // store -> array of captured days, in the shape loadStore() expects.
  const captureByStore = new Map(STORES.map((s) => [s, []]));

  await withSession(async (page) => {
    // Dates OUTSIDE, stores INSIDE, and dates strictly newest-first.
    //
    // Newest-first is required: see the long note in daily/config.js — walking
    // dates upwards inverts the VM Hub date-range picker and wedges the session.
    //
    // Dates outside also means the date fields change once per date rather than
    // once per (store, date): both stores are pulled while the same window is
    // already on the form, which is fewer picker interactions and therefore
    // fewer chances to wedge it.
    for (const date of dates) {
      for (const store of STORES) {
        const label = `${DAILY_REPORT.chart} @ ${store} [${date.businessDate}]`;
        try {
          const captured = await withRetry(label, () =>
            extractReportForStoreWeek(page, { report: DAILY_REPORT, store, week: date })
          );
          // `week` is what loadStore() reads startISO/endISO from; both are the
          // business date, which is what makes the load idempotent per day.
          captureByStore.get(store).push({ ...captured, week: date });
          console.log(`[ok]  ${label} -> ${captured.rows.length} rows`);
        } catch (err) {
          anyFailed = true;
          console.error(`[FAIL] ${label}: ${err.message}`);
          summary.push({
            store,
            date: date.businessDate,
            rows: 0,
            status: 'extract-failed',
            error: err.message,
          });
          // Deliberately NOT loaded. Because loadStore()'s delete is scoped to
          // the dates we did capture, skipping leaves whatever was already
          // stored for this day intact instead of overwriting it with nothing.
        }
      }
    }
  });

  // ---- Load: one call per store, carrying every day captured for it --------
  let totalInserted = 0;
  for (const store of STORES) {
    const captured = captureByStore.get(store);
    if (!captured.length) {
      console.error(`[FAIL] ${store}: no dates captured, skipping load.`);
      continue;
    }
    try {
      const { deleted, inserted } = await loadStore(DAILY_REPORT.table, store, captured);
      totalInserted += inserted;
      console.log(
        `[load] ${DAILY_REPORT.table} <- ${store}: deleted ${deleted}, inserted ${inserted}`
      );
      for (const c of captured) {
        summary.push({
          store,
          date: c.week.businessDate,
          rows: c.rows.length,
          status: 'ok',
        });
      }
    } catch (err) {
      anyFailed = true;
      console.error(`[FAIL] load ${DAILY_REPORT.table} <- ${store}: ${err.message}`);
      summary.push({
        store,
        date: captured.map((c) => c.week.businessDate).join(','),
        rows: 0,
        status: 'load-failed',
        error: err.message,
      });
    }
  }

  await closePool();

  // ---- Run summary --------------------------------------------------------
  console.log('\n================== DAILY RUN SUMMARY =====================');
  for (const s of summary.sort((a, b) => a.date.localeCompare(b.date) || a.store.localeCompare(b.store))) {
    const tag = s.status.toUpperCase().padEnd(14);
    console.log(
      `${tag} ${s.date}  ${s.store}  rows=${s.rows}${s.error ? `  (${s.error})` : ''}`
    );
  }
  console.log(`${''.padEnd(14)} total rows inserted = ${totalInserted}`);
  console.log('==========================================================');

  const loadedAnything = summary.some((s) => s.status === 'ok');
  const status = !anyFailed ? 'ok' : loadedAnything ? 'partial' : 'failed';
  const errorText = summary
    .filter((s) => s.error)
    .map((s) => `${s.date} ${s.store}: ${s.error}`)
    .join(' | ');

  await finishRun(runId, { status, rowsLoaded: totalInserted, error: errorText || null });
  await closeLedgerPool();

  if (anyFailed) {
    console.error('\nOne or more (store, date) pulls failed. Exiting non-zero.');
    process.exit(1);
  }
  console.log('\nDaily net sales synced successfully.');
}

main().catch(async (err) => {
  console.error('[sync:daily] Fatal:', err.message);
  // Best-effort: mark the run failed so the health endpoint sees it (a row left
  // stuck at 'running' would read as stale, which is right but less useful than
  // the actual error), then let the non-zero exit trigger the email alert.
  await finishRun(runId, {
    status: 'failed',
    rowsLoaded: 0,
    error: err.message,
  }).catch(() => {});
  await closePool().catch(() => {});
  await closeLedgerPool().catch(() => {});
  process.exit(1);
});
