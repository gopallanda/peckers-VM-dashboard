'use strict';

/**
 * reconcile-daily-hourly.js
 * -------------------------
 * Read-only. Proves the DAILY hourly net feed against a source that was already
 * trusted before it existed.
 *
 *   node scripts/reconcile-daily-hourly.js [week_start ...]
 *
 * With no arguments it checks every Mon-Sun week fully covered by the daily
 * table.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COMPARES, AND WHY THAT IS THE RIGHT COMPARISON
 * ---------------------------------------------------------------------------
 * vm_net_sales_by_hour (the WEEKLY sync) was verified to reconcile exactly with
 * vm_v_exec_dashboard_with_wow -- summing its hour rows gives the week's net
 * sales to the penny. It was never wrong; it simply carried no date, which is
 * the entire reason the dashboards had to estimate days.
 *
 * So the week total is independently known. If the seven single-day pulls sum
 * to that same week total, the daily feed is measuring the same thing on the
 * same basis, and the only thing it has added is the date dimension.
 *
 * A per-day error that averaged out could in principle hide inside a matching
 * week total -- which is exactly the failure mode the apportionment had. That
 * is why --days also prints each day: spot-check a few against VM Hub with
 * Interval = Daily.
 *
 * ---------------------------------------------------------------------------
 * TOLERANCE IS 1p PER DAY, NOT ZERO
 * ---------------------------------------------------------------------------
 * Net values are exact multiples of 1/6 of a penny -- the arithmetic signature
 * of item-level VAT removal (whole-pence gross / 1.2 = x 5/6). Rounding a day
 * to 2dp can therefore legitimately differ from the unrounded sum. A week of
 * seven such roundings can drift a few pence. Compare at 2dp; a 4dp mismatch is
 * expected and is not a bug.
 */

require('dotenv').config();

const { Pool } = require('pg');

// Per-week tolerance in pounds. Seven daily 2dp roundings, worst case.
const WEEK_TOLERANCE = 0.05;

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const SHOW_DAYS = process.argv.includes('--days');
const weeks = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

async function main() {
  // Weeks where the daily table holds all seven days for a store, alongside the
  // weekly hourly total for the same (store, week).
  const { rows } = await pool.query(
    `
    WITH daily AS (
      SELECT store,
             -- Monday of the containing week, computed from the business date.
             (business_date - ((EXTRACT(ISODOW FROM business_date)::int - 1)))::date AS week_start,
             COUNT(*)                        AS days_present,
             SUM(net_sales)                  AS daily_sum
        FROM vm_v_daily_net_sales_by_day
       GROUP BY 1, 2
    ),
    weekly AS (
      SELECT store, week_start,
             ROUND(SUM(NULLIF(BTRIM(net_sales), '')::numeric), 2) AS weekly_sum
        FROM vm_net_sales_by_hour
       GROUP BY 1, 2
    )
    SELECT d.store, d.week_start, d.days_present,
           ROUND(d.daily_sum, 2) AS daily_sum,
           w.weekly_sum,
           ROUND(d.daily_sum - w.weekly_sum, 2) AS diff
      FROM daily d
      JOIN weekly w ON w.store = d.store AND w.week_start = d.week_start
     WHERE ($1::text[] IS NULL OR d.week_start::text = ANY($1))
     ORDER BY d.week_start DESC, d.store
    `,
    [weeks.length ? weeks : null]
  );

  if (!rows.length) {
    console.log('No overlapping (store, week) to reconcile yet.');
    console.log('The daily table needs days that the weekly hourly table also covers.');
    return 0;
  }

  let failures = 0;
  let incomplete = 0;
  console.log('\n=================== WEEK RECONCILIATION ===================');
  for (const r of rows) {
    const diff = Number(r.diff);
    const partial = Number(r.days_present) < 7;
    const bad = !partial && Math.abs(diff) > WEEK_TOLERANCE;
    if (bad) failures++;
    if (partial) incomplete++;

    // A partial week can NEVER tie to a full week total -- the daily side is
    // missing days by definition, so `diff` measures the gap, not an error.
    // Calling that a MISMATCH buries real mismatches in noise, which is exactly
    // what happened the first time this ran across a backfill that had one
    // failed month in it. Report it as INCOMPLETE and exclude it from the
    // failure count; the missing days are what need fixing, not the figures.
    const verdict = partial
      ? `INCOMPLETE (${r.days_present}/7 days)`
      : bad
        ? 'MISMATCH'
        : 'ok';
    console.log(
      `${String(r.week_start).slice(0, 10)}  ${r.store.padEnd(18)} ` +
        `days=${r.days_present}  daily=${String(r.daily_sum).padStart(10)}  ` +
        `weekly=${String(r.weekly_sum).padStart(10)}  diff=${String(diff).padStart(7)}  ${verdict}`
    );
  }
  console.log('===========================================================');

  if (SHOW_DAYS) {
    const { rows: days } = await pool.query(
      `SELECT store, to_char(business_date,'YYYY-MM-DD') AS d, to_char(business_date,'Dy') AS dow,
              net_sales, trading_hours
         FROM vm_v_daily_net_sales_by_day
        WHERE ($1::text[] IS NULL
               OR (business_date - ((EXTRACT(ISODOW FROM business_date)::int - 1)))::date::text = ANY($1))
        ORDER BY store, business_date`,
      [weeks.length ? weeks : null]
    );
    console.log('\n======================== BY DAY ===========================');
    for (const r of days) {
      console.log(
        `${r.d}  ${r.dow}  ${r.store.padEnd(18)} net=${String(r.net_sales).padStart(9)}  hours=${r.trading_hours}`
      );
    }
    console.log('===========================================================');
  }

  if (incomplete) {
    console.log(
      `\n${incomplete} week(s) INCOMPLETE -- days are missing from the daily table. ` +
        'Re-run those dates; the figures themselves are not in question.'
    );
  }
  if (failures) {
    console.error(`\n${failures} COMPLETE week(s) outside the ${WEEK_TOLERANCE} tolerance.`);
    return 1;
  }
  console.log(`\nAll ${rows.length - incomplete} complete week(s) are within tolerance.`);
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error('[reconcile] FAILED:', e.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
