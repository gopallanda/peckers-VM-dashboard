'use strict';

/** verify_exec.js — read-only verification of the 3 exec base tables + views. */

const { Pool } = require('pg');
const { RUNTIME } = require('./config');

const TABLES = ['vm_net_sales_by_channel', 'vm_orders_by_channel', 'vm_customer_metrics'];

async function main() {
  const pool = new Pool({ connectionString: RUNTIME.dbUrl, ssl: { rejectUnauthorized: false }, max: 2 });

  for (const t of TABLES) {
    const res = await pool.query(
      `SELECT week_start::text AS week_start, store, count(*)::int AS n
       FROM ${t} GROUP BY week_start, store ORDER BY week_start, store`
    );
    console.log(`\n===== ${t} — distinct (week_start, store) counts =====`);
    let cur = null;
    for (const r of res.rows) {
      if (r.week_start !== cur) { cur = r.week_start; console.log(`  ${r.week_start}`); }
      console.log(`      ${r.store.padEnd(20)} ${r.n}`);
    }
    const wk = await pool.query(`SELECT count(DISTINCT week_start)::int AS w FROM ${t}`);
    console.log(`   -> ${wk.rows[0].w} distinct weeks`);
  }

  // vm_v_available_weeks
  try {
    const aw = await pool.query(`SELECT week_start::text AS week_start FROM vm_v_available_weeks ORDER BY week_start`);
    console.log(`\n===== vm_v_available_weeks (${aw.rows.length} rows) =====`);
    console.log('  ' + aw.rows.map((r) => r.week_start).join(', '));
  } catch (e) {
    console.log(`\n(vm_v_available_weeks not queryable: ${e.message})`);
  }

  // vm_v_exec_dashboard_with_wow for a new week
  try {
    const ew = await pool.query(
      `SELECT store, week_start::text AS week_start, net_sales, number_of_orders
       FROM vm_v_exec_dashboard_with_wow WHERE week_start = '2026-04-20' ORDER BY store`
    );
    console.log(`\n===== vm_v_exec_dashboard_with_wow @ 2026-04-20 (${ew.rows.length} rows) =====`);
    for (const r of ew.rows) console.log(`   ${r.store.padEnd(20)} net_sales=${r.net_sales} orders=${r.number_of_orders}`);
  } catch (e) {
    console.log(`\n(vm_v_exec_dashboard_with_wow not queryable: ${e.message})`);
  }

  await pool.end();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
