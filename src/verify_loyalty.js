'use strict';

/**
 * verify_loyalty.js — read-only checks on the LOYALTY tables (`npm run verify:loyalty`).
 *
 *  1. Per table: distinct week_start with row counts per store.
 *  2. Weekly tables: every (table, store, week) between the first and last
 *     loaded week that has ZERO rows. Some can be genuine (a store with no
 *     discounted orders that week), but each is worth a look — a silent gap is
 *     exactly how the old Stevenage undercount hid.
 *  3. information_schema.columns: no column of any loyalty table may match the
 *     personal-data rules (LOYALTY_PII_DEFAULT + per-report dropColumns). Any hit
 *     means stripping failed somewhere and the column must be dropped by hand.
 *  4. Row/column counts of three core tables, so a run can be compared with a
 *     before snapshot and shown to have left them alone.
 *
 * Exits non-zero if a personal-data column exists.
 */

const { Pool } = require('pg');
const { RUNTIME, STORES, LOYALTY_REPORTS, LOYALTY_PII_DEFAULT, LOYALTY_ALL_STORES } = require('./config');

const CORE_TABLES = ['vm_net_sales_by_channel', 'vm_detailed_sales_info', 'vm_net_sales_per_product'];

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const pool = new Pool({ connectionString: RUNTIME.dbUrl, ssl: { rejectUnauthorized: false }, max: 2 });
  let piiFound = false;

  const existing = new Set(
    (
      await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)
    ).rows.map((r) => r.table_name)
  );

  for (const report of LOYALTY_REPORTS) {
    const t = report.table;
    console.log(`\n===== ${t}  (${report.kind}, ${report.perStore ? 'per store' : 'estate-wide'}) =====`);
    if (!existing.has(t)) {
      console.log('   (table does not exist yet)');
      continue;
    }

    const res = await pool.query(
      `SELECT week_start::text AS week_start, store, count(*)::int AS n
         FROM ${t} GROUP BY week_start, store ORDER BY week_start, store`
    );
    const have = new Map(res.rows.map((r) => [`${r.store}|${r.week_start}`, r.n]));
    const weeks = [...new Set(res.rows.map((r) => r.week_start))];
    for (const w of weeks) {
      const per = res.rows.filter((r) => r.week_start === w).map((r) => `${r.store}=${r.n}`);
      console.log(`  ${w}  ${per.join('  ')}`);
    }
    console.log(`   -> ${weeks.length} distinct week_start`);

    if (report.kind === 'weekly' && weeks.length) {
      const stores = report.perStore ? STORES : [LOYALTY_ALL_STORES];
      const zero = [];
      for (let w = weeks[0]; w <= weeks[weeks.length - 1]; w = addDaysISO(w, 7)) {
        for (const s of stores) if (!have.has(`${s}|${w}`)) zero.push(`${s} ${w}`);
      }
      console.log(`   zero-row (store, week): ${zero.length ? zero.join(', ') : 'none'}`);
    }

    const cols = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [t]
      )
    ).rows.map((r) => r.column_name);
    const rules = [...LOYALTY_PII_DEFAULT, ...(report.dropColumns || [])];
    const hits = cols.filter((c) => rules.some((rx) => rx.test(c)));
    console.log(`   columns: ${cols.join(', ')}`);
    console.log(`   personal-data columns present: ${hits.length ? hits.join(', ') : 'NONE'}`);
    if (hits.length) piiFound = true;
  }

  console.log('\n===== core tables (compare with a before snapshot) =====');
  for (const t of CORE_TABLES) {
    const r = await pool.query(`SELECT count(*)::int AS n, max(ingested_at) AS last FROM ${t}`);
    const c = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [t]
    );
    console.log(`  ${t.padEnd(28)} rows=${r.rows[0].n} cols=${c.rows[0].n} last_ingested=${r.rows[0].last?.toISOString()}`);
  }

  await pool.end();
  if (piiFound) {
    console.error('\nPersonal-data column(s) found in a loyalty table. Exiting non-zero.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[verify-loyalty] Failed:', err.message);
  process.exit(1);
});
