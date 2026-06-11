'use strict';

/**
 * load.js
 * -------
 * Writes captured report data into Supabase (Postgres) via the `pg` library
 * and the connection string (SUPABASE_DB_URL). The publishable API key CANNOT
 * create tables or insert, so all writes go through this connection.
 *
 * Design:
 *  - Dynamic schema: one TEXT column per CSV column (so the loader is resilient
 *    to exact column names), plus metadata columns. Numeric casting happens in
 *    the KPI views, not here.
 *  - Idempotent: full-refresh per store each run — delete that store's rows,
 *    then insert. Re-running is safe.
 */

const { Pool } = require('pg');
const { RUNTIME } = require('./config');

const META_COLUMNS = ['store', 'week_start', 'week_end', 'source_file', 'ingested_at'];

let pool;
function getPool() {
  if (!pool) {
    if (!RUNTIME.dbUrl) {
      throw new Error('SUPABASE_DB_URL is not set — cannot write to Supabase.');
    }
    pool = new Pool({
      connectionString: RUNTIME.dbUrl,
      // Supabase requires SSL; the pooler cert is fine to accept.
      ssl: { rejectUnauthorized: false },
      max: 4,
    });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// ---------------------------------------------------------------------------
// Identifier sanitising
// ---------------------------------------------------------------------------
/** Turn an arbitrary CSV header into a safe, lower_snake Postgres identifier. */
function sanitizeColumn(name, index) {
  let s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) s = `col_${index}`;
  if (/^[0-9]/.test(s)) s = `c_${s}`; // identifiers can't start with a digit
  return s.slice(0, 63); // Postgres identifier limit
}

function quoteIdent(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

/**
 * Build the mapping from raw CSV header -> safe column name, de-duplicating
 * collisions (e.g. two headers that sanitise to the same thing).
 */
function buildColumnMap(columns) {
  const used = new Set(META_COLUMNS);
  const map = [];
  columns.forEach((raw, i) => {
    let safe = sanitizeColumn(raw, i);
    let candidate = safe;
    let k = 2;
    while (used.has(candidate)) candidate = `${safe}_${k++}`;
    used.add(candidate);
    map.push({ raw, safe: candidate });
  });
  return map;
}

// ---------------------------------------------------------------------------
// DDL: create table if missing, and add any new data columns (schema drift).
// ---------------------------------------------------------------------------
async function ensureTable(client, table, columnMap) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
       id           BIGSERIAL PRIMARY KEY,
       store        TEXT,
       week_start   DATE,
       week_end     DATE,
       source_file  TEXT,
       ingested_at  TIMESTAMPTZ DEFAULT now()
     )`
  );

  for (const { safe } of columnMap) {
    await client.query(
      `ALTER TABLE ${quoteIdent(table)} ADD COLUMN IF NOT EXISTS ${quoteIdent(safe)} TEXT`
    );
  }

  // Helpful index for the per-store full-refresh and the KPI views.
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(table + '_store_week_idx')}
       ON ${quoteIdent(table)} (store, week_start)`
  );
}

// ---------------------------------------------------------------------------
// Full-refresh per store
// ---------------------------------------------------------------------------
async function deleteStoreRows(client, table, store) {
  const res = await client.query(`DELETE FROM ${quoteIdent(table)} WHERE store = $1`, [store]);
  return res.rowCount || 0;
}

/**
 * Insert all rows for a (store, table). Each row object is keyed by the RAW CSV
 * header; we remap to safe column names and attach metadata.
 *
 * @param meta { store, weekStart (ISO), weekEnd (ISO), sourceFile }
 */
async function insertRows(client, table, columnMap, rows, meta) {
  if (!rows.length) return 0;

  const dataCols = columnMap.map((c) => c.safe);
  const allCols = ['store', 'week_start', 'week_end', 'source_file', ...dataCols];
  const colSql = allCols.map(quoteIdent).join(', ');

  // Batch inserts to keep parameter counts sane.
  const perRowVals = allCols.length;
  const maxParams = 60000;
  const batchSize = Math.max(1, Math.floor(maxParams / perRowVals));

  let inserted = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values = [];
    const tuples = batch.map((row, ri) => {
      const base = ri * perRowVals;
      const fixed = [meta.store, meta.weekStart, meta.weekEnd, meta.sourceFile];
      const dataVals = columnMap.map(({ raw }) => {
        const v = row[raw];
        return v === undefined || v === null ? null : String(v);
      });
      values.push(...fixed, ...dataVals);
      const placeholders = allCols.map((_, ci) => `$${base + ci + 1}`);
      return `(${placeholders.join(', ')})`;
    });

    const sql = `INSERT INTO ${quoteIdent(table)} (${colSql}) VALUES ${tuples.join(', ')}`;
    const res = await client.query(sql, values);
    inserted += res.rowCount || 0;
  }
  return inserted;
}

/**
 * High-level: load all captured weeks for ONE (report, store).
 * Does the per-store delete ONCE, then inserts every week's rows.
 *
 * @param table   destination table name
 * @param store   store name
 * @param weeksData array of { columns, rows, sourceFile, week:{startISO,endISO} }
 * @returns { deleted, inserted }
 */
async function loadStore(table, store, weeksData) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Union the column set across all weeks (schemas should match, but be safe).
    const allColumns = [];
    const seen = new Set();
    for (const wd of weeksData) {
      for (const c of wd.columns) {
        if (!seen.has(c)) {
          seen.add(c);
          allColumns.push(c);
        }
      }
    }
    const columnMap = buildColumnMap(allColumns);

    await ensureTable(client, table, columnMap);
    const deleted = await deleteStoreRows(client, table, store);

    let inserted = 0;
    for (const wd of weeksData) {
      inserted += await insertRows(client, table, columnMap, wd.rows, {
        store,
        weekStart: wd.week.startISO,
        weekEnd: wd.week.endISO,
        sourceFile: wd.sourceFile,
      });
    }

    await client.query('COMMIT');
    return { deleted, inserted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  loadStore,
  closePool,
  // exported for testing
  sanitizeColumn,
  buildColumnMap,
};
