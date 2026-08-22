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
// The one chart this sync pulls.
// `chart` must match the VM Hub "Chart" dropdown CHARACTER-FOR-CHARACTER.
//
// Reconciled against the weekly data before being adopted (Peckers Hitchin,
// week 2026-08-10..2026-08-16): the sum of 7 single-day pulls was 11560.96
// against 11560.96 already stored by the weekly sync — a 0.00 difference. So
// this chart really is business-date based at day granularity, and a one-day
// window is a legitimate slice of the same net-sales number the Executive
// Dashboard reports (ex-VAT, after discounts and refunds).
// ---------------------------------------------------------------------------
const DAILY_REPORT = {
  chart: 'Gross Sales',
  table: 'vm_daily_net_sales_raw',
};

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
  DAILY_REPORT,
  DAILY_LOOKBACK_DAYS,
  STORES, // re-exported from src/config.js — the single canonical store list
  getBusinessDates,
  // exported for the sync's logging and for ad-hoc checks
  londonToday,
};
