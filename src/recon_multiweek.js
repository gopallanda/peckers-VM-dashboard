'use strict';

/**
 * recon_multiweek.js — validates the multi-week aggregation the Executive page
 * performs, at the data level. Read-only.
 *
 *  - Latest N completed weeks (mirrors getWeeks(): vm_v_available_weeks desc).
 *  - Σ net_sales over N weeks == sum of the N individual weekly net_sales.
 *  - Period AOV = Σsales / Σorders, and shows it differs from the mean of the
 *    weekly AOVs (proves we aggregate from totals, not by averaging).
 *  - YoY mapping: each Monday − 364d, and how many match vm_yoy_both_stores.
 */

const { Pool } = require('pg');
const { RUNTIME } = require('./config');

const num = (v) => { const x = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(x) ? x : 0; };
const minus364 = (iso) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 364); return d.toISOString().slice(0, 10); };

async function main() {
  const pool = new Pool({ connectionString: RUNTIME.dbUrl, ssl: { rejectUnauthorized: false }, max: 2 });

  const wk = await pool.query(`SELECT week_start::text AS w FROM vm_v_available_weeks ORDER BY week_start DESC`);
  const allWeeks = wk.rows.map((r) => r.w);
  console.log(`available completed weeks (newest first): ${allWeeks.join(', ')}\n`);

  for (const N of [4, 12]) {
    const period = allWeeks.slice(0, N);
    console.log(`========== ${N}-WEEK (both stores) ==========`);
    console.log(`period: ${period[period.length - 1]} → ${period[0]}  (${period.length} of ${N} weeks)`);

    // Per-week net sales (both stores) from the exec view.
    const ns = await pool.query(
      `SELECT week_start::text AS w, sum(net_sales::numeric) AS net, sum(number_of_orders::numeric) AS ord
       FROM vm_v_exec_dashboard_with_wow WHERE week_start = ANY($1) GROUP BY week_start ORDER BY week_start`,
      [period]
    );
    let sumNet = 0, weeklyAovs = [];
    for (const r of ns.rows) {
      const net = num(r.net), ord = num(r.ord);
      sumNet += net;
      weeklyAovs.push(ord > 0 ? net / ord : 0);
    }

    // Orders from the raw channel table (what the page actually sums for AOV).
    const ordRes = await pool.query(
      `SELECT sum(number_of_orders::numeric) AS ord FROM vm_orders_by_channel WHERE week_start = ANY($1)`,
      [period]
    );
    const sumOrders = num(ordRes.rows[0].ord);
    const periodAov = sumOrders > 0 ? sumNet / sumOrders : 0;
    const meanWeeklyAov = weeklyAovs.reduce((a, b) => a + b, 0) / (weeklyAovs.length || 1);

    // Independent re-sum of the individual weekly nets, to prove additivity.
    const reSum = ns.rows.reduce((a, r) => a + num(r.net), 0);

    console.log(`  Σ net_sales (period)          £${sumNet.toFixed(2)}`);
    console.log(`  Σ of individual weekly nets   £${reSum.toFixed(2)}  ${Math.abs(reSum - sumNet) < 0.005 ? 'MATCH ✓' : 'MISMATCH ✗'}`);
    console.log(`  Σ orders (channel table)      ${sumOrders}`);
    console.log(`  Period AOV = Σsales/Σorders   £${periodAov.toFixed(4)}`);
    console.log(`  Mean of weekly AOVs           £${meanWeeklyAov.toFixed(4)}  ${Math.abs(meanWeeklyAov - periodAov) > 0.0001 ? '(differs — good, not averaged)' : '(equal)'}`);

    // YoY mapping + match count.
    const yoyWeeks = period.map(minus364);
    const yoyRes = await pool.query(
      `SELECT count(*)::int AS m FROM vm_yoy_both_stores WHERE week_commencing = ANY($1)`,
      [yoyWeeks]
    );
    console.log(`  YoY weeks (−364d): ${yoyWeeks[yoyWeeks.length - 1]} → ${yoyWeeks[0]}`);
    console.log(`  prior-year matched: ${yoyRes.rows[0].m} of ${period.length}\n`);
  }

  await pool.end();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
