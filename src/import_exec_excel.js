'use strict';

/**
 * import_exec_excel.js
 * --------------------
 * Backfills the three Executive-dashboard base tables from Excel exports by
 * REUSING this project's own loader (`loadStore()` in src/load.js). No schema
 * changes, no parallel insert path.
 *
 *   vm_net_sales_by_channel  <- net_sales_by_channel_{hitchin,stevenage}_10w.xlsx
 *   vm_orders_by_channel     <- no_of_orders_fullfillment_date_{...}_10w.xlsx
 *   vm_customer_metrics      <- new_return_customers_{...}_10w.xlsx
 *
 * Per file: parse rows, resolve each row's Monday from the week column
 * (week_commencing / order_window), STRIP that week column out of the data
 * (it maps to the week_start metadata, not a data column), group by week, and
 * call loadStore(table, store, weeksData). loadStore does delete-then-insert
 * per (store, week_start), so re-running is idempotent.
 *
 * Safety rails:
 *   - Only the 10 target Mondays (2026-03-16 .. 2026-05-18) are allowed.
 *   - Anything >= 2026-05-25 is refused (never touch existing weeks).
 *   - Every sanitised data header must already exist on the target table;
 *     otherwise abort (do NOT let ensureTable add a stray column).
 *
 * Usage:
 *   node src/import_exec_excel.js --dry-run   # parse + validate, no writes
 *   node src/import_exec_excel.js             # real load
 */

const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const { RUNTIME, parseISO, addDays, fmtISO, mondayOf } = require('./config');
const { loadStore, closePool, sanitizeColumn } = require('./load');

// --- config ----------------------------------------------------------------
const IMPORT_DIR = path.join(__dirname, '..', 'import');

const ALLOWED_MONDAYS = [
  '2026-03-16', '2026-03-23', '2026-03-30', '2026-04-06', '2026-04-13',
  '2026-04-20', '2026-04-27', '2026-05-04', '2026-05-11', '2026-05-18',
];
const ALLOWED_SET = new Set(ALLOWED_MONDAYS);
const CUTOFF_ISO = '2026-05-25'; // refuse this Monday and anything after

const FILES = [
  { file: 'net_sales_by_channel_hitchin_10w.xlsx',            table: 'vm_net_sales_by_channel', store: 'Peckers Hitchin',   weekCol: 'week_commencing' },
  { file: 'net_sales_by_channel_stevenage_10w.xlsx',          table: 'vm_net_sales_by_channel', store: 'Peckers Stevenage', weekCol: 'week_commencing' },
  { file: 'no_of_orders_fullfillment_date_hitchin_10w.xlsx',  table: 'vm_orders_by_channel',    store: 'Peckers Hitchin',   weekCol: 'week_commencing' },
  { file: 'no_of_orders_fullfillment_date_stevenage_10w.xlsx',table: 'vm_orders_by_channel',    store: 'Peckers Stevenage', weekCol: 'week_commencing' },
  { file: 'new_return_customers_hitchin_10w.xlsx',            table: 'vm_customer_metrics',     store: 'Peckers Hitchin',   weekCol: 'order_window' },
  { file: 'new_return_customers_stevenage_10w.xlsx',          table: 'vm_customer_metrics',     store: 'Peckers Stevenage', weekCol: 'order_window' },
];

// --- helpers ---------------------------------------------------------------
function readSheet(file) {
  const wb = XLSX.readFile(path.join(IMPORT_DIR, file));
  const ws = wb.Sheets[wb.SheetNames[0]];
  // raw:false keeps every value as its formatted string (TEXT; no numeric cast).
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
  // Header order preserved first-seen across rows.
  const headers = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  return { rows, headers };
}

/** Resolve the Monday ISO from a week-column value and validate it hard. */
function resolveMonday(rawVal, weekCol, ctx) {
  if (rawVal == null || String(rawVal).trim() === '') {
    throw new Error(`${ctx}: empty ${weekCol} value`);
  }
  // week_commencing is already YYYY-MM-DD; order_window is an ISO timestamp.
  const iso = String(rawVal).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`${ctx}: cannot parse Monday from ${weekCol}="${rawVal}"`);
  }
  // Must be a real Monday.
  const asMonday = fmtISO(mondayOf(parseISO(iso)));
  if (asMonday !== iso) {
    throw new Error(`${ctx}: ${weekCol}="${iso}" is not a Monday (Monday would be ${asMonday})`);
  }
  // Never touch existing weeks.
  if (iso >= CUTOFF_ISO) {
    throw new Error(`${ctx}: refusing week ${iso} (>= ${CUTOFF_ISO}, must not modify existing weeks)`);
  }
  // Must be one of the 10 target Mondays.
  if (!ALLOWED_SET.has(iso)) {
    throw new Error(`${ctx}: week ${iso} is not one of the 10 target Mondays`);
  }
  return iso;
}

async function fetchTableColumns(pool, table) {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

/**
 * Parse + validate one file into { store, table, columns, weeksData, stats }.
 * Throws on any column / store / week mismatch.
 */
function buildFilePlan(spec) {
  const ctxFile = spec.file;
  const { rows, headers } = readSheet(spec.file);
  if (!rows.length) throw new Error(`${ctxFile}: no rows`);
  if (!headers.includes(spec.weekCol)) {
    throw new Error(`${ctxFile}: expected week column "${spec.weekCol}" not found; headers=${JSON.stringify(headers)}`);
  }

  // Data headers = everything except the week column (which maps to week_start).
  const dataColumns = headers.filter((h) => h !== spec.weekCol);
  if (!dataColumns.length) throw new Error(`${ctxFile}: no data columns after stripping ${spec.weekCol}`);

  // Group rows by resolved Monday, stripping the week column from each row.
  const byWeek = new Map();
  for (let i = 0; i < rows.length; i++) {
    const ctx = `${ctxFile} row ${i + 2}`;
    const iso = resolveMonday(rows[i][spec.weekCol], spec.weekCol, ctx);
    const dataRow = {};
    for (const h of dataColumns) dataRow[h] = rows[i][h];
    if (!byWeek.has(iso)) byWeek.set(iso, []);
    byWeek.get(iso).push(dataRow);
  }

  const weeksData = [];
  for (const iso of [...byWeek.keys()].sort()) {
    weeksData.push({
      columns: dataColumns,
      rows: byWeek.get(iso),
      sourceFile: spec.file,
      week: { startISO: iso, endISO: fmtISO(addDays(parseISO(iso), 6)) },
    });
  }

  return {
    spec,
    dataColumns,
    weeksData,
    stats: {
      rows: rows.length,
      stores: [spec.store],
      weeks: [...byWeek.keys()].sort(),
      perWeekCounts: [...byWeek.entries()].sort().map(([w, r]) => `${w}:${r.length}`),
    },
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`\n===== import_exec_excel  (${dryRun ? 'DRY-RUN' : 'LOAD'}) =====\n`);

  const pool = new Pool({ connectionString: RUNTIME.dbUrl, ssl: { rejectUnauthorized: false }, max: 2 });
  const tableColsCache = {};
  const getCols = async (t) => (tableColsCache[t] ||= await fetchTableColumns(pool, t));

  // ---- Parse + validate every file first (fail fast, before any write) ----
  const plans = [];
  let anyMismatch = false;
  for (const spec of FILES) {
    let plan;
    try {
      plan = buildFilePlan(spec);
    } catch (err) {
      anyMismatch = true;
      console.error(`[ABORT] ${spec.file}: ${err.message}`);
      continue;
    }

    // Column validation against the live table.
    const existing = await getCols(spec.table);
    const mismatches = [];
    for (const h of plan.dataColumns) {
      const safe = sanitizeColumn(h, 0);
      if (!existing.includes(safe)) mismatches.push(`${h} -> ${safe}`);
    }

    console.log(`--- ${spec.file}  ->  ${spec.table} / ${spec.store} ---`);
    console.log(`    rows: ${plan.stats.rows}`);
    console.log(`    distinct stores: ${JSON.stringify(plan.stats.stores)}`);
    console.log(`    distinct resolved weeks (${plan.stats.weeks.length}): ${JSON.stringify(plan.stats.weeks)}`);
    console.log(`    rows/week: ${plan.stats.perWeekCounts.join(', ')}`);
    console.log(`    data columns: ${JSON.stringify(plan.dataColumns)}`);
    if (mismatches.length) {
      anyMismatch = true;
      console.error(`    !! COLUMN MISMATCH (not on ${spec.table}): ${JSON.stringify(mismatches)}`);
    } else {
      console.log(`    OK: all data columns already exist on ${spec.table}`);
    }
    console.log('');

    plans.push(plan);
  }

  if (anyMismatch) {
    console.error('\nOne or more files failed validation (column/store/week mismatch). Aborting — no writes.');
    await pool.end();
    await closePool();
    process.exit(1);
  }

  if (dryRun) {
    console.log('DRY-RUN complete: parsed + validated, no writes performed.');
    await pool.end();
    await closePool();
    return;
  }

  // ---- Real load via the existing loader -----------------------------------
  await pool.end(); // introspection pool no longer needed; loadStore has its own
  let totalDeleted = 0;
  let totalInserted = 0;
  for (const plan of plans) {
    const { spec, weeksData } = plan;
    const { deleted, inserted } = await loadStore(spec.table, spec.store, weeksData);
    totalDeleted += deleted;
    totalInserted += inserted;
    console.log(`[load] ${spec.table} <- ${spec.store}: deleted ${deleted}, inserted ${inserted} (${weeksData.length} weeks)`);
  }
  console.log(`\nDONE. total deleted ${totalDeleted}, total inserted ${totalInserted}.`);
  await closePool();
}

main().catch(async (err) => {
  console.error('[import_exec_excel] Fatal:', err.message);
  await closePool().catch(() => {});
  process.exit(1);
});
