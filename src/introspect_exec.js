'use strict';

/**
 * introspect_exec.js — Step 1 helper (read-only).
 * Prints existing columns for the 3 Executive base tables and peeks the 6 Excel
 * source files (headers + sample row + row count). No writes.
 */

const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const { RUNTIME } = require('./config');
const { sanitizeColumn } = require('./load');

const TABLES = ['vm_net_sales_by_channel', 'vm_orders_by_channel', 'vm_customer_metrics'];

const FILES = [
  { file: 'net_sales_by_channel_hitchin_10w.xlsx', table: 'vm_net_sales_by_channel', store: 'Peckers Hitchin', weekCol: 'week_commencing' },
  { file: 'net_sales_by_channel_stevenage_10w.xlsx', table: 'vm_net_sales_by_channel', store: 'Peckers Stevenage', weekCol: 'week_commencing' },
  { file: 'no_of_orders_fullfillment_date_hitchin_10w.xlsx', table: 'vm_orders_by_channel', store: 'Peckers Hitchin', weekCol: 'week_commencing' },
  { file: 'no_of_orders_fullfillment_date_stevenage_10w.xlsx', table: 'vm_orders_by_channel', store: 'Peckers Stevenage', weekCol: 'week_commencing' },
  { file: 'new_return_customers_hitchin_10w.xlsx', table: 'vm_customer_metrics', store: 'Peckers Hitchin', weekCol: 'order_window' },
  { file: 'new_return_customers_stevenage_10w.xlsx', table: 'vm_customer_metrics', store: 'Peckers Stevenage', weekCol: 'order_window' },
];

function readSheet(file) {
  const wb = XLSX.readFile(path.join(__dirname, '..', 'import', file));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

async function main() {
  const pool = new Pool({ connectionString: RUNTIME.dbUrl, ssl: { rejectUnauthorized: false }, max: 2 });

  console.log('================ EXISTING TABLE COLUMNS ================');
  const tableCols = {};
  for (const t of TABLES) {
    const res = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [t]
    );
    tableCols[t] = res.rows.map((r) => r.column_name);
    console.log(`\n${t}:`);
    for (const r of res.rows) console.log(`   ${r.column_name}  (${r.data_type})`);
  }

  console.log('\n\n================ EXCEL FILES ================');
  for (const f of FILES) {
    const { rows, headers } = readSheet(f.file);
    console.log(`\n--- ${f.file}  ->  ${f.table} / ${f.store} ---`);
    console.log(`   rows: ${rows.length}`);
    console.log(`   headers: ${JSON.stringify(headers)}`);
    console.log(`   sample[0]: ${JSON.stringify(rows[0])}`);
    // Distinct week-column values
    const weekVals = [...new Set(rows.map((r) => r[f.weekCol]))];
    console.log(`   distinct ${f.weekCol} (${weekVals.length}): ${JSON.stringify(weekVals)}`);

    // Column match check (exclude the week column, which maps to week_start)
    const dataHeaders = headers.filter((h) => h !== f.weekCol);
    const existing = tableCols[f.table];
    const mismatches = [];
    for (const h of dataHeaders) {
      const safe = sanitizeColumn(h, 0);
      if (!existing.includes(safe)) mismatches.push(`${h} -> ${safe}`);
    }
    if (!headers.includes(f.weekCol)) {
      console.log(`   !! WEEK COLUMN "${f.weekCol}" NOT FOUND in headers`);
    }
    console.log(`   data headers (sanitized): ${JSON.stringify(dataHeaders.map((h) => `${h}=>${sanitizeColumn(h, 0)}`))}`);
    console.log(mismatches.length ? `   !! COLUMN MISMATCH (not on table): ${JSON.stringify(mismatches)}` : `   OK: all data columns already exist on ${f.table}`);
  }

  await pool.end();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
