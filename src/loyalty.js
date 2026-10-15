'use strict';

/**
 * loyalty.js
 * ----------
 * Orchestrator for `npm run sync:loyalty` — the LOYALTY reports only
 * (LOYALTY_REPORTS in config.js). No core reports, no snapshot refresh.
 *
 * WHY a separate step and not part of index.js:
 *   index.js skips vm_refresh_all_snapshots() if ANY report fails. These are
 *   customer-level charts on heavy Metabase queries (one took 131s and 504'd
 *   once in discovery); one of them failing must never block the core refresh.
 *   The weekly workflow runs this AFTER `npm run sync`, even when the core step
 *   failed, and its failures exit non-zero on their own. index.js is untouched.
 *
 * Modes
 *   (default)          last complete Mon–Sun week for the weekly reports, plus
 *                      every snapshot report stamped with that same week.
 *   LOYALTY_FROM=Mon   backfill: one window per week from that Monday up to the
 *   [LOYALTY_TO=Mon]   last complete week (or LOYALTY_TO). Weekly reports ONLY —
 *                      snapshots are never backfilled (past weeks would get
 *                      today's balances). Ignores START_DATE / END_DATE.
 *   SKIP_LOYALTY=1     do nothing, exit 0 (kill switch for the weekly workflow).
 *   LOYALTY_ONLY=t1,t2 restrict to these tables (testing / splitting a backfill).
 *   --dry-run          extract + validate + strip + print counts; no writes to
 *                      Supabase, no files, no progress entries.
 *   --no-resume        in backfill mode, redo units already logged as done.
 *
 * Personal data (mandatory, see LOYALTY_PII_DEFAULT): load.js turns EVERY CSV
 * header into a TEXT column, so personal-data columns are removed from
 * `columns` and every row BEFORE anything touches disk or Supabase. The raw CSV
 * is never written (captureViaCsv persist:false); downloads/ only ever gets the
 * stripped copy. No DEBUG_SHOTS screenshots are taken in this step — the
 * workflow uploads debug/ on failure and a screenshot of Users or Discounts
 * Info would show names and emails.
 *
 * Fail-closed checks per unit (any one fails the unit, nothing is loaded):
 *   - the Chart select must show the exact chart name;
 *   - dates and the single store must read back exactly as requested;
 *   - headers must equal the Phase 0 list (a new header might be personal data);
 *   - the id column must be present;
 *   - no value left after stripping may look like an email;
 *   - a CSV `store` column must only contain the store that was filtered.
 *
 * Resumable: each (report, store, week) is its own extract + loadStore()
 * transaction, logged to downloads/loyalty_progress.jsonl. In backfill mode a
 * re-run skips units already logged ok (or no-data, see below).
 *
 * NO-DATA: a report flagged invalidQueryMeansNoData (Loyalty per channel) whose
 * Metabase query is rejected as "invalid-query" — it does that for every
 * store-week with zero redemptions — is logged as no-data: not a failure, not
 * retried, nothing loaded. loadStore() is delete-then-insert per
 * (store, week_start), so redoing a unit is always safe, and it never touches a
 * week_start outside the windows of this run.
 *
 * Known VM Hub quirk handled here (and NOT in core setDate(), on purpose): typing
 * a start date that is after the current end date leaves the start calendar
 * open over the end input and the end click times out. Backfills walk forward
 * week by week, so the end date is set first whenever the window moves forward.
 */

const fs = require('fs');
const path = require('path');
const {
  LOYALTY_REPORTS,
  LOYALTY_PII_DEFAULT,
  LOYALTY_ALL_STORES,
  STORES,
  RUNTIME,
  getLoyaltyWeeks,
  bool,
} = require('./config');
const {
  withSession,
  reportFrame,
  SEL,
  selectChart,
  selectInterval,
  setDate,
  selectSingleStore,
  clickUpdate,
  currentEmbedUrl,
  waitForResults,
  captureViaCsv,
  InvalidQueryError,
} = require('./extract');
const { loadStore, closePool } = require('./load');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const NO_RESUME = ARGS.includes('--no-resume');
const PROGRESS_FILE = path.join(RUNTIME.downloadsDir, 'loyalty_progress.jsonl');
const EMAIL_RX = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same retry policy as index.js (kept local so index.js stays untouched). */
async function withRetry(label, fn, maxRetries = RUNTIME.maxRetries) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A header/personal-data/store mismatch won't fix itself on retry.
      if (err.noRetry) throw err;
      const backoff = Math.min(30000, 1000 * 2 ** (attempt - 1));
      console.warn(`[retry] ${label} attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) await sleep(backoff);
    }
  }
  throw lastErr;
}

function hardFail(msg) {
  const e = new Error(msg);
  e.noRetry = true;
  return e;
}

// ---------------------------------------------------------------------------
// Filters — tolerant of missing controls, but never in a way that loads the
// wrong data: a missing Stores control on a perStore report, or a missing date
// control on a weekly report, is a failure rather than a skip.
// ---------------------------------------------------------------------------
async function presentFilters(frame) {
  const has = async (sel) => (await frame.locator(sel).count().catch(() => 0)) > 0;
  return {
    stores: await has(SEL.stores),
    startDate: await has(SEL.startDate),
    endDate: await has(SEL.endDate),
    interval: await has(SEL.interval),
  };
}

function ukToNum(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? Number(m[3] + m[2] + m[1]) : NaN;
}

async function setDateChecked(page, frame, which, ddmmyyyy) {
  await setDate(page, frame, which, ddmmyyyy);
  const got = await frame.locator(which === 'start' ? SEL.startDate : SEL.endDate).inputValue().catch(() => '');
  if (got !== ddmmyyyy) throw new Error(`${which} date shows "${got}", wanted ${ddmmyyyy}.`);
}

async function setWindow(page, frame, report, week, f) {
  if (!f.startDate || !f.endDate) {
    if (report.kind === 'weekly') {
      throw hardFail(`"${report.chart}" has no ${!f.startDate ? 'start' : 'end'}-date control — cannot scope a weekly report.`);
    }
    console.log(`[loyalty] "${report.chart}": no date controls — skipping (snapshot).`);
    return;
  }
  const curEnd = await frame.locator(SEL.endDate).inputValue().catch(() => '');
  const order = ukToNum(week.startUK) > ukToNum(curEnd) ? ['end', 'start'] : ['start', 'end'];
  for (const which of order) {
    await setDateChecked(page, frame, which, which === 'start' ? week.startUK : week.endUK);
  }
}

async function setStore(page, frame, report, store, f) {
  if (!f.stores) {
    if (report.perStore) throw hardFail(`"${report.chart}" has no Stores control — cannot pull per store.`);
    console.log(`[loyalty] "${report.chart}": no Stores control — skipping (estate-wide).`);
    return;
  }
  if (!store) return; // estate-wide report: Stores filter is irrelevant, leave it.
  await selectSingleStore(page, frame, store);
  const vals = await frame
    .locator(`${SEL.stores} input[name="stores"]`)
    .evaluateAll((els) => els.map((e) => e.value))
    .catch(() => []);
  if (!(vals.length === 1 && vals[0] === store)) {
    throw new Error(`Stores filter shows ${JSON.stringify(vals)}, wanted only "${store}".`);
  }
}

// ---------------------------------------------------------------------------
// Extraction — one (report, store|null, week). Returns parsed, UNSTRIPPED rows
// in memory only (persist:false). Never screenshots.
// ---------------------------------------------------------------------------
async function extractLoyalty(page, report, store, week) {
  const frame = reportFrame(page);
  await selectChart(page, frame, report.chart);
  const shown = (await frame.locator(`${SEL.chart} [class*="singleValue"]`).innerText().catch(() => '')).trim();
  if (shown !== report.chart) throw new Error(`Chart shows "${shown}", wanted "${report.chart}".`);
  await page.waitForTimeout(1000); // let the filter bar settle for this chart

  const f = await presentFilters(frame);
  if (f.interval) await selectInterval(page, frame);
  await setWindow(page, frame, report, week, f);
  await setStore(page, frame, report, store, f);

  const prevUrl = currentEmbedUrl(page);
  await clickUpdate(page, frame);
  await waitForResults(page, prevUrl);

  const tag = `${report.table}_${store || 'all'}_${week.startISO}`.replace(/[^a-z0-9_]+/gi, '_');
  let captured;
  try {
    captured = await captureViaCsv(page, tag, {
      timeoutMs: report.csvTimeoutMs || 120000,
      retryGateway: true,
      persist: false,
      failFastErrorTypes: ['invalid-query'],
    });
  } catch (e) {
    // The query itself is rejected: re-running it returns the same error, so
    // never retry (this used to burn 9 fetches and ~3 min per unit).
    if (e instanceof InvalidQueryError) {
      e.noRetry = true;
      e.invalidQuery = true;
    }
    throw e;
  }
  // No DOM-table fallback here: Metabase virtualises rows, so it would load a
  // silent undercount — fail and retry instead.
  if (!captured) throw new Error(`No CSV for ${tag} (endpoint error or HTML response).`);
  return { ...captured, tag };
}

// ---------------------------------------------------------------------------
// Personal data + validation
// ---------------------------------------------------------------------------
function validateHeaders(report, columns) {
  const expected = new Set(report.columns);
  const unexpected = columns.filter((c) => !expected.has(c));
  const missing = report.columns.filter((c) => !columns.includes(c));
  if (unexpected.length || missing.length) {
    throw hardFail(
      `Header mismatch for "${report.chart}": new=${JSON.stringify(unexpected)} ` +
        `missing=${JSON.stringify(missing)}. Not loaded — review (new headers may be personal data) ` +
        'and update LOYALTY_REPORTS.columns.'
    );
  }
  if (report.idColumn && !columns.includes(report.idColumn)) {
    throw hardFail(`"${report.chart}" has no "${report.idColumn}" id column. Not loaded.`);
  }
}

function stripPersonalData(report, columns, rows) {
  const rules = [...LOYALTY_PII_DEFAULT, ...(report.dropColumns || [])];
  const dropped = columns.filter((c) => c !== report.idColumn && rules.some((rx) => rx.test(c)));
  const keep = columns.filter((c) => !dropped.includes(c));
  const clean = rows.map((r) => {
    const o = {};
    for (const c of keep) o[c] = r[c];
    return o;
  });
  for (const c of keep) {
    if (clean.some((r) => EMAIL_RX.test(String(r[c] ?? '')))) {
      throw hardFail(`Column "${c}" of "${report.chart}" still holds email-like values after stripping. Not loaded.`);
    }
  }
  return { columns: keep, rows: clean, dropped };
}

/** CSV `store` column (if any) must only hold the filtered store (or ~aggregates). */
function checkStoreColumn(report, rows, store) {
  if (!store || !report.columns.includes('store')) return;
  const bad = [...new Set(rows.map((r) => r.store).filter((v) => v && !String(v).startsWith('~') && v !== store))];
  if (bad.length) throw hardFail(`"${report.chart}" for ${store} returned rows for ${JSON.stringify(bad)}. Not loaded.`);
}

/** Estate-wide pull -> [{ store, rows }]: split by a store column, else 'All stores'. */
function splitEstateWide(report, rows) {
  if (!report.columns.includes('store')) return [{ store: LOYALTY_ALL_STORES, rows }];
  const groups = new Map();
  for (const r of rows) {
    const s = r.store;
    if (!STORES.includes(s)) throw hardFail(`"${report.chart}" has a row for unknown store "${s}". Not loaded.`);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(r);
  }
  return [...groups].map(([store, rs]) => ({ store, rows: rs }));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Audit copy of the STRIPPED data (the raw CSV is never written). */
function writeStrippedCsv(tag, columns, rows) {
  fs.mkdirSync(RUNTIME.downloadsDir, { recursive: true });
  const file = path.join(RUNTIME.downloadsDir, `${tag}_${Date.now()}.csv`);
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return path.basename(file);
}

// ---------------------------------------------------------------------------
// Progress log (resumability)
// ---------------------------------------------------------------------------
function unitKey(table, store, weekISO) {
  return `${table}|${store}|${weekISO}`;
}

function loadDone() {
  const done = new Set();
  if (!fs.existsSync(PROGRESS_FILE)) return done;
  for (const line of fs.readFileSync(PROGRESS_FILE, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      if (p.status === 'ok' || p.status === 'no-data') done.add(unitKey(p.table, p.store, p.week));
    } catch {
      /* ignore a torn last line after a crash */
    }
  }
  return done;
}

function logProgress(entry) {
  if (DRY_RUN) return;
  fs.mkdirSync(RUNTIME.downloadsDir, { recursive: true });
  fs.appendFileSync(PROGRESS_FILE, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (bool('SKIP_LOYALTY', false)) {
    console.log('[loyalty] SKIP_LOYALTY is set — loyalty step skipped.');
    return 0;
  }

  const from = process.env.LOYALTY_FROM || '';
  const to = process.env.LOYALTY_TO || '';
  const backfill = Boolean(from);
  const weeks = getLoyaltyWeeks(from, to);
  const only = (process.env.LOYALTY_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknownOnly = only.filter((t) => !LOYALTY_REPORTS.some((r) => r.table === t));
  if (unknownOnly.length) throw new Error(`LOYALTY_ONLY has unknown tables: ${unknownOnly.join(', ')}`);

  let reports = LOYALTY_REPORTS.filter((r) => !only.length || only.includes(r.table));
  const skippedSnapshots = backfill ? reports.filter((r) => r.kind === 'snapshot') : [];
  if (backfill) reports = reports.filter((r) => r.kind === 'weekly');
  const snapWeek = weeks[weeks.length - 1];

  const resume = backfill && !NO_RESUME && !DRY_RUN;
  const done = resume ? loadDone() : new Set();

  console.log('==========================================================');
  console.log(` VM Hub -> Supabase LOYALTY sync${DRY_RUN ? '  [DRY RUN — no writes]' : ''}`);
  console.log(`  Mode    : ${backfill ? `backfill from ${from}${to ? ` to ${to}` : ''}` : 'last complete week + snapshots'}`);
  console.log(`  Reports : ${reports.map((r) => `${r.chart} (${r.kind})`).join(' | ')}`);
  if (skippedSnapshots.length) {
    console.log(`  Skipped : ${skippedSnapshots.map((r) => r.chart).join(' | ')} (snapshots are never backfilled)`);
  }
  console.log(`  Stores  : ${STORES.join(' | ')}`);
  console.log(`  Weeks   : ${weeks.length} (${weeks[0].startISO} .. ${snapWeek.startISO})`);
  if (resume) console.log(`  Resume  : ${done.size} unit(s) already done in ${PROGRESS_FILE}`);
  if (process.env.START_DATE || process.env.END_DATE) {
    console.log('  Note    : START_DATE/END_DATE are set but ignored by the loyalty step.');
  }
  console.log('==========================================================\n');

  // Units: (report, store|null, week). Snapshots get exactly one week.
  const units = [];
  for (const report of reports) {
    const ws = report.kind === 'snapshot' ? [snapWeek] : weeks;
    const stores = report.perStore ? STORES : [null];
    for (const store of stores) for (const week of ws) units.push({ report, store, week });
  }

  const summary = [];
  const droppedLog = new Map(); // table -> Set(headers)
  let anyFailed = false;
  const t0 = Date.now();

  await withSession(async (page) => {
    for (const [i, { report, store, week }] of units.entries()) {
      const where = store || LOYALTY_ALL_STORES;
      const label = `${report.chart} @ ${where} [${week.startISO}]`;
      const progress = `(${i + 1}/${units.length})`;

      if (store && done.has(unitKey(report.table, store, week.startISO))) {
        console.log(`[skip] ${progress} ${label} — already loaded (progress log).`);
        summary.push({ table: report.table, store: where, week: week.startISO, rows: '-', status: 'skipped' });
        continue;
      }

      const u0 = Date.now();
      try {
        const captured = await withRetry(label, async () => {
          const c = await extractLoyalty(page, report, store, week);
          if (c.rows.length) validateHeaders(report, c.columns);
          checkStoreColumn(report, c.rows, store);
          return c;
        });
        const stripped = stripPersonalData(report, captured.columns, captured.rows);
        if (!droppedLog.has(report.table)) droppedLog.set(report.table, new Set());
        stripped.dropped.forEach((d) => droppedLog.get(report.table).add(d));

        const groups = store ? [{ store, rows: stripped.rows }] : splitEstateWide(report, stripped.rows);
        for (const g of groups) {
          let inserted = '-';
          let deleted = '-';
          if (!DRY_RUN) {
            const fileTag = store ? captured.tag : `${captured.tag}_${g.store}`.replace(/[^a-z0-9_]+/gi, '_');
            const sourceFile = writeStrippedCsv(fileTag, stripped.columns, g.rows);
            const res = await loadStore(report.table, g.store, [
              { columns: stripped.columns, rows: g.rows, sourceFile, week },
            ]);
            inserted = res.inserted;
            deleted = res.deleted;
          }
          const secs = Math.round((Date.now() - u0) / 1000);
          console.log(
            `[ok]  ${progress} ${report.table} @ ${g.store} [${week.startISO}] rows=${g.rows.length}` +
              ` deleted=${deleted} inserted=${inserted} dropped=${JSON.stringify(stripped.dropped)} ${secs}s`
          );
          logProgress({ table: report.table, store: g.store, week: week.startISO, rows: g.rows.length, status: 'ok', secs });
          summary.push({ table: report.table, store: g.store, week: week.startISO, rows: g.rows.length, status: DRY_RUN ? 'dry-run' : 'ok', secs });
        }
      } catch (err) {
        const secs = Math.round((Date.now() - u0) / 1000);
        if (err.invalidQuery && report.invalidQueryMeansNoData) {
          // Known VM Hub limitation, not a sync failure (see LOYALTY_REPORTS).
          console.log(`[no-data] ${progress} ${label}: VM Hub cannot compute this chart for the week (${err.message})`);
          logProgress({ table: report.table, store: where, week: week.startISO, rows: 0, status: 'no-data', error: err.message, secs });
          summary.push({ table: report.table, store: where, week: week.startISO, rows: 0, status: 'no-data', secs });
          continue;
        }
        anyFailed = true;
        console.error(`[FAIL] ${progress} ${label}: ${err.message}`);
        logProgress({ table: report.table, store: where, week: week.startISO, rows: 0, status: 'failed', error: err.message, secs });
        summary.push({ table: report.table, store: where, week: week.startISO, rows: 0, status: 'failed', error: err.message, secs });
      }
    }
  });

  await closePool();

  // ---- Run summary (separate LOYALTY heading) ------------------------------
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log('\n======================== LOYALTY ==========================');
  for (const s of summary) {
    const tag = s.status.toUpperCase().padEnd(8);
    console.log(`${tag} ${s.table} @ ${s.store} [${s.week}] rows=${s.rows}${s.secs != null ? ` ${s.secs}s` : ''}${s.error ? `  (${s.error})` : ''}`);
  }
  console.log('---------------- personal-data headers dropped -----------');
  for (const r of reports) {
    const d = droppedLog.get(r.table);
    console.log(`  ${r.table}: ${d ? (d.size ? [...d].join(', ') : '(none)') : '(not captured)'}`);
  }
  console.log(`---------------- elapsed ${mins} min ----------------------`);
  console.log('==========================================================');

  if (anyFailed) {
    console.error('\nOne or more LOYALTY units failed. Exiting non-zero.');
    return 1;
  }
  console.log(`\nLOYALTY step ${DRY_RUN ? 'dry run ' : ''}completed successfully.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('[loyalty] Fatal:', err.message);
    await closePool().catch(() => {});
    process.exit(1);
  });
