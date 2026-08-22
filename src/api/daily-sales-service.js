'use strict';

/**
 * daily-sales-service.js
 * -----------------------
 * Pure data logic for the daily sales feed. Reads ONLY vm_v_daily_net_sales
 * and vm_daily_sync_runs — see sql/daily_net_sales.sql and
 * docs/daily-net-sales.md for the full design.
 *
 * Serves gross_sales, not net_sales, as of 2026-08-22 — see the pivot note at
 * the top of sql/daily_net_sales.sql for why. Object/route names still say
 * "net-sales"; that is legacy naming, not a description of the metric.
 *
 * A missing day is returned as `null` (the route layer turns that into a 404),
 * never as a zero — a silent zero is indistinguishable from a genuine day of
 * no trade and would get reported as real.
 */

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const dbUrl = process.env.SUPABASE_DB_URL;
    if (!dbUrl) {
      throw new Error('SUPABASE_DB_URL not set');
    }
    pool = new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
      max: 4,
    });
  }
  return pool;
}

// business_date is formatted with to_char rather than left as a DATE, because
// node-postgres parses DATE columns into JS Date objects at UTC midnight —
// which then serialize to JSON as a full "2026-08-21T00:00:00.000Z" timestamp
// instead of the plain "2026-08-21" the API contract (docs/daily-net-sales.md
// §5) promises. Formatting in SQL sidesteps that driver behaviour entirely.

/** Latest business_date and latest overall sync timestamp, for 404 bodies. */
async function getFeedStatus() {
  const res = await getPool().query(
    `SELECT to_char(MAX(business_date), 'YYYY-MM-DD') AS latest_business_date,
            MAX(last_synced_at) AS last_synced_at
       FROM vm_v_daily_net_sales`
  );
  return res.rows[0];
}

/**
 * @param {object} opts - { store: slug, date: 'YYYY-MM-DD' }
 * @returns {Promise<object|null>} the row, or null if that (store, date) has no data
 */
async function getOne({ store, date }) {
  const res = await getPool().query(
    `SELECT store, store_slug, to_char(business_date, 'YYYY-MM-DD') AS business_date,
            gross_sales, last_synced_at
       FROM vm_v_daily_net_sales
      WHERE store_slug = $1 AND business_date = $2`,
    [store, date]
  );
  return res.rows[0] || null;
}

/**
 * @param {object} opts - { store: slug, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 * @returns {Promise<{rows: object[], missingDates: string[]}>}
 */
async function getRange({ store, from, to }) {
  const res = await getPool().query(
    `SELECT store, store_slug, to_char(business_date, 'YYYY-MM-DD') AS business_date,
            gross_sales, last_synced_at
       FROM vm_v_daily_net_sales
      WHERE store_slug = $1 AND business_date BETWEEN $2 AND $3
      ORDER BY business_date`,
    [store, from, to]
  );

  const present = new Set(res.rows.map((r) => r.business_date));
  const missingDates = [];
  for (let d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!present.has(iso)) missingDates.push(iso);
  }

  return { rows: res.rows, missingDates };
}

const STALE_THRESHOLD_HOURS = 26;

/** Latest run + latest successful run + a `stale` flag, for /sauce/health. */
async function getHealth() {
  const latestRes = await getPool().query(
    `SELECT id, business_dates, status, rows_loaded, error, started_at, finished_at
       FROM vm_daily_sync_runs
      ORDER BY started_at DESC
      LIMIT 1`
  );
  const lastOkRes = await getPool().query(
    `SELECT id, finished_at
       FROM vm_daily_sync_runs
      WHERE status = 'ok'
      ORDER BY started_at DESC
      LIMIT 1`
  );

  const latestRun = latestRes.rows[0] || null;
  const lastOk = lastOkRes.rows[0] || null;

  const hoursSinceLastSuccess = lastOk
    ? (Date.now() - new Date(lastOk.finished_at).getTime()) / 3_600_000
    : null;

  return {
    stale: hoursSinceLastSuccess === null || hoursSinceLastSuccess > STALE_THRESHOLD_HOURS,
    stale_threshold_hours: STALE_THRESHOLD_HOURS,
    hours_since_last_success: hoursSinceLastSuccess === null ? null : Number(hoursSinceLastSuccess.toFixed(2)),
    last_successful_run_at: lastOk ? lastOk.finished_at : null,
    latest_run: latestRun,
  };
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = {
  getOne,
  getRange,
  getFeedStatus,
  getHealth,
  closePool,
};
