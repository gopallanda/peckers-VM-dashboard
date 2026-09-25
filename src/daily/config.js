'use strict';

/**
 * daily/config.js
 * ---------------
 * Configuration for the DAILY net-sales sync (`npm run sync:daily`).
 *
 * This is a separate, purely additive feature. It deliberately does NOT touch
 * src/config.js — in particular it does NOT add an entry to REPORTS, because
 * REPORTS drives the weekly orchestrator and every chart in it is pulled for
 * every store for every week. The daily chart is pulled on a different cadence
 * with a different window, so it lives here instead.
 *
 * What it does reuse from src/config.js: STORES (imported, never re-declared —
 * one canonical store list) and the UTC-safe date formatters.
 *
 * ---------------------------------------------------------------------------
 * WHY "YESTERDAY" IS COMPUTED IN Europe/London
 * ---------------------------------------------------------------------------
 * A business date is a local trading-day concept: what the stores call
 * "Thursday's takings" is Thursday in London, not Thursday in UTC. The cron
 * fires at 00:30 GMT; under BST that is 01:30 local, so a UTC-based
 * "yesterday" would still be correct there — but at other clock times, and
 * across the two DST switchovers, UTC and London disagree about which calendar
 * day it is and the sync would pull the wrong day.
 *
 * The weekly code in src/config.js does its Mon–Sun maths in UTC on purpose:
 * it needs a deterministic week boundary that never shifts, and it always runs
 * on complete weeks that are days in the past. That is a different problem.
 * Do not copy the UTC approach down here, and do not "unify" the two.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATES COME BACK NEWEST-FIRST
 * ---------------------------------------------------------------------------
 * This is load-bearing, not cosmetic. The VM Hub filter bar is a date-RANGE
 * picker and extract.js's applyFilters() always sets the START field before the
 * END field. If a new start lands AFTER the end still sitting on the form, the
 * range is momentarily inverted: the start field's calendar popover then
 * refuses to close and permanently overlays #rdp-form-control-endDate, so every
 * later click in that browser session times out ("<span>August 2026</span> ...
 * intercepts pointer events"). Retries do not help — they re-enter from the
 * same wedged DOM.
 *
 * Walking the dates DOWNWARDS means each new start is always earlier than the
 * end already on the form, so the range is never inverted. The reporting page's
 * own default end date is today, so the first hop into yesterday is safe too.
 *
 * This was reproduced and then fixed by ordering alone during the Phase 0
 * reconciliation: ascending died on day 2 of 7, descending completed 7/7 with
 * zero retries. Fixing it here rather than in extract.js is what keeps the
 * weekly sync untouched.
 *
 * ---------------------------------------------------------------------------
 * WHY WE RE-PULL THREE DAYS, NOT ONE
 * ---------------------------------------------------------------------------
 * Delivery-platform figures can still settle after midnight, so D-1 read at
 * 00:30 is not always final. Because the load is idempotent per (store, date),
 * re-pulling D-1/D-2/D-3 every night lets a late correction overwrite itself,
 * and silently repairs any single day the cron missed. This is self-healing,
 * NOT a historical backfill — the window is fixed and always adjacent to today.
 */

require('dotenv').config();

const { STORES, fmtISO, fmtUK, parseISO, addDays } = require('../config');

// ---------------------------------------------------------------------------
// The charts this sync pulls, one single-day window at a time.
//
// `chart` must match the VM Hub "Chart" dropdown CHARACTER-FOR-CHARACTER.
//
// ---------------------------------------------------------------------------
// EVERY CHART NEEDS ITS OWN TABLE. THIS IS NOT A STYLE CHOICE.
// ---------------------------------------------------------------------------
// loadStore() in src/load.js is idempotent by deleting (store, week_start) and
// re-inserting. `week_start` here is the business date, and it carries NO chart
// dimension. Two charts sharing one table would therefore delete each other's
// rows for the same (store, date) on every run, and whichever loaded last would
// be the only one left. Do not point two entries at the same `table`.
//
// ---------------------------------------------------------------------------
// `critical` — WHAT IT CONTROLS
// ---------------------------------------------------------------------------
// Only a critical chart's outcome may move vm_daily_sync_runs.status, because
// that column is what /api/sauce/health turns into a staleness alarm for the
// Sauce Management integration. A non-critical chart failing still prints in
// the run summary, still lands in the ledger's `error` text and still exits
// non-zero (so the workflow goes red and the SMTP alert fires) — but it must
// NOT tell Sauce that its own perfectly-good feed has gone stale.
// ---------------------------------------------------------------------------
const ALL_DAILY_REPORTS = [
  // -- The Sauce Management feed. Pre-existing; unchanged. -------------------
  // Reconciled against the weekly data before being adopted (Peckers Hitchin,
  // week 2026-08-10..2026-08-16) while it was still 'Net Sales by Channel': the
  // sum of 7 single-day pulls was 11560.96 against 11560.96 already stored by
  // the weekly sync — a 0.00 difference. Repointed to 'Gross Sales' on
  // 2026-08-22; see the pivot note in sql/daily_net_sales.sql.
  {
    chart: 'Gross Sales',
    table: 'vm_daily_net_sales_raw',
    critical: true,
    feeds: 'Sauce Management daily feed -> vm_v_daily_net_sales -> /api/sauce/daily-net-sales',
  },

  // -- Daily NET sales, at hour grain. Added 2026-09-24. ---------------------
  // Fixes the two dashboards that had to SYNTHESISE a daily net figure by
  // splitting a week total across Mon–Sun using a GROSS weekday shape (the
  // Daypart net heat map and the Labour Cost weekday breakdown). See
  // peckers-cashflow/docs/DAILY_NET_SALES_GAP.md.
  //
  // Verified before adoption (scripts/probe-daily-hourly.js, Peckers Stevenage):
  //   2026-09-18  sum of 12 hour rows = 3530.5100  vs VM Hub 3530.51  (0.00)
  //   2026-09-16  sum of 11 hour rows = 2094.5717  vs VM Hub 2094.57  (0.00 @2dp)
  // So a single-day window really does return THAT DAY's hour buckets, and they
  // sum to the day's net total. One chart therefore serves both the hour grain
  // and the day grain — there is no need for a second day-total chart.
  //
  // The residual sub-penny (2094.5717) is the known sixths-of-a-penny artefact
  // of item-level VAT removal (gross / 1.2 = x5/6), not a rounding bug. Compare
  // days at 2dp, never at 4.
  {
    chart: 'Net Sales by Hour',
    table: 'vm_daily_net_sales_by_hour_raw',
    critical: false,
    feeds: 'Daypart net heat map + Labour Cost weekday breakdown (peckers-cashflow)',
  },
];

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

// How many days back from yesterday to re-pull each run (inclusive).
const DAILY_LOOKBACK_DAYS = Math.max(
  1,
  parseInt(env('DAILY_LOOKBACK_DAYS', '3'), 10) || 3
);

/**
 * Narrow the run to specific charts, via DAILY_CHARTS (comma-separated, matched
 * against `chart` exactly). Unset = every chart in ALL_DAILY_REPORTS.
 *
 * This exists for two reasons, both operational:
 *
 *  1. BACKFILL. A historical backfill wants ONE chart. Without this filter,
 *     re-running 28 weeks would also re-pull 'Gross Sales' for ~390 store-days
 *     and rewrite the table the live Sauce Management feed reads — doubling the
 *     runtime to achieve something nobody asked for.
 *
 *  2. KILL SWITCH. If a newly-added chart starts failing at 00:30, setting
 *     DAILY_CHARTS='Gross Sales' restores exactly the previous behaviour with
 *     an env change and no deploy.
 *
 * An unknown name throws rather than being ignored: a typo'd chart name that
 * silently pulled nothing would look like a clean run in the ledger.
 */
function selectReports() {
  const raw = env('DAILY_CHARTS');
  if (!raw) return ALL_DAILY_REPORTS;

  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const known = ALL_DAILY_REPORTS.map((r) => r.chart);
  const unknown = wanted.filter((w) => !known.includes(w));
  if (unknown.length) {
    throw new Error(
      `DAILY_CHARTS names unknown chart(s): ${unknown.join(', ')}. ` +
        `Known charts: ${known.join(' | ')}`
    );
  }
  const picked = ALL_DAILY_REPORTS.filter((r) => wanted.includes(r.chart));
  if (!picked.length) {
    throw new Error('DAILY_CHARTS is set but selected no charts.');
  }
  return picked;
}

const DAILY_REPORTS = selectReports();

/**
 * Today's calendar date in Europe/London as YYYY-MM-DD.
 *
 * en-CA formats as ISO, and passing timeZone makes the runtime do the whole
 * GMT/BST decision for us — no offset table, no DST arithmetic of our own.
 */
function londonToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Shape one business date for both consumers:
 *   - ISO  (YYYY-MM-DD) for the DB meta columns
 *   - UK   (DD/MM/YYYY) for the VM Hub date inputs
 *
 * startISO === endISO on purpose: a single-day pull is just a window where the
 * two ends are the same date. Nothing in the extraction path assumes 7 days.
 * The key names match what extract.js expects of a `week` object so the
 * existing extractReportForStoreWeek() can be reused verbatim.
 */
function businessDate(d) {
  return {
    businessDate: fmtISO(d),
    startISO: fmtISO(d),
    endISO: fmtISO(d),
    startUK: fmtUK(d),
    endUK: fmtUK(d),
  };
}

/**
 * The dates to pull this run, NEWEST FIRST (see the header — this ordering is
 * required, not stylistic).
 *
 *  - If DAILY_START_DATE and DAILY_END_DATE are BOTH set, that inclusive range
 *    is used verbatim. This is the manual re-run path for the workflow_dispatch
 *    inputs.
 *
 *    They are deliberately NOT called START_DATE/END_DATE: those already exist
 *    in .env for the weekly sync and are usually pinned to some past week. A
 *    local `npm run sync:daily` that silently inherited them would re-pull that
 *    old window into the daily table instead of yesterday.
 *
 *  - Otherwise: the last DAILY_LOOKBACK_DAYS days ending YESTERDAY, where
 *    yesterday is a Europe/London calendar day.
 *
 * @returns {Array<{businessDate,startISO,endISO,startUK,endUK}>}
 */
function getBusinessDates(now = new Date()) {
  const startEnv = env('DAILY_START_DATE');
  const endEnv = env('DAILY_END_DATE');

  const dates = [];

  if (startEnv && endEnv) {
    const s = parseISO(startEnv);
    const e = parseISO(endEnv);
    if (e < s) {
      throw new Error(
        `DAILY_END_DATE (${endEnv}) is before DAILY_START_DATE (${startEnv}).`
      );
    }
    for (let d = e; d >= s; d = addDays(d, -1)) dates.push(businessDate(d));
    return dates;
  }

  // parseISO anchors the London calendar date at UTC midnight, after which
  // addDays() is pure calendar arithmetic — so no timezone can shift it again.
  const yesterday = addDays(parseISO(londonToday(now)), -1);
  for (let i = 0; i < DAILY_LOOKBACK_DAYS; i++) {
    dates.push(businessDate(addDays(yesterday, -i)));
  }
  return dates;
}

module.exports = {
  DAILY_REPORTS,
  // Deprecated single-chart alias, kept so anything still importing the old
  // name resolves to the Sauce feed rather than to undefined. Nothing in this
  // repo reads it any more — prefer DAILY_REPORTS.
  DAILY_REPORT: ALL_DAILY_REPORTS[0],
  ALL_DAILY_REPORTS,
  DAILY_LOOKBACK_DAYS,
  STORES, // re-exported from src/config.js — the single canonical store list
  getBusinessDates,
  // exported for the sync's logging and for ad-hoc checks
  londonToday,
};
