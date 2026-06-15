'use strict';

/**
 * kpi-service.js
 * ---------------
 * Pure data logic: queries the KPI views and returns clean JSON.
 * Independent of any API framework (Express, FastAPI, etc.).
 * Can be used by:
 *  - Express.js (Node)
 *  - FastAPI (Python)
 *  - Any React/Next.js frontend directly
 *  - Grafana, Metabase, etc. (via SQL)
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

/**
 * Get all unique stores from the database.
 * @returns {Promise<string[]>} List of store names
 */
async function getStores() {
  const res = await getPool().query(
    `SELECT DISTINCT store FROM vm_v_exec_dashboard
     WHERE store IS NOT NULL
     ORDER BY store`
  );
  return res.rows.map((r) => r.store);
}

/**
 * Get all weeks available in the database.
 * @returns {Promise<{week_start: string, week_end: string}[]>}
 */
async function getWeeks() {
  const res = await getPool().query(
    `SELECT DISTINCT week_start_iso AS week_start, week_end_iso AS week_end
     FROM vm_v_exec_dashboard
     ORDER BY week_start DESC`
  );
  return res.rows;
}

/**
 * Get KPIs for a single store for a given week (or latest if not specified).
 *
 * @param {object} opts
 *  - store: string (e.g. "Peckers Hitchin")
 *  - week_start: string (ISO date, optional — if null, use latest)
 * @returns {Promise<object>} Single store KPIs
 *  {
 *    store: "Peckers Hitchin",
 *    week_start: "2026-06-01",
 *    week_end: "2026-06-07",
 *    net_sales: 12345.67,
 *    number_of_orders: 456,
 *    aov: 27.05,
 *    customer_count: 200,
 *    delivery_pct: 45.2,
 *    collection_pct: 35.8,
 *    eat_in_pct: 19.0,
 *    new_customer_count: 50,
 *    return_customer_count: 150,
 *    new_customer_pct: 25.0,
 *    net_sales_wow_pct: 5.3,
 *    orders_wow_pct: 2.1,
 *    customers_wow_pct: 3.0
 *  }
 */
async function getKPIsForStore(opts) {
  const { store, week_start } = opts;

  if (!store) {
    throw new Error('store is required');
  }

  let query = `
    SELECT *
    FROM vm_v_exec_dashboard_with_wow
    WHERE store = $1
  `;
  const params = [store];

  if (week_start) {
    query += ` AND week_start_iso = $2`;
    params.push(week_start);
  }

  query += ` ORDER BY week_start DESC LIMIT 1`;

  const res = await getPool().query(query, params);

  if (res.rows.length === 0) {
    return null;
  }

  return res.rows[0];
}

/**
 * Get KPIs for multiple stores (for comparison).
 *
 * @param {object} opts
 *  - stores: string[] (e.g. ["Peckers Hitchin", "Peckers Stevenage"])
 *  - week_start: string (ISO date, optional)
 * @returns {Promise<object>} { hitchin: {...}, stevenage: {...} }
 */
async function getKPIsForStores(opts) {
  const { stores, week_start } = opts;

  if (!stores || !Array.isArray(stores) || stores.length === 0) {
    throw new Error('stores array is required');
  }

  const results = {};

  for (const store of stores) {
    const kpi = await getKPIsForStore({ store, week_start });
    // Normalize store name to a key (e.g. "Peckers Hitchin" -> "hitchin")
    const key = store.toLowerCase().split(' ').pop();
    results[key] = kpi;
  }

  return results;
}

/**
 * Get KPIs for all stores for a given week (or latest).
 * Returns as both individual and aggregated/comparison format.
 *
 * @param {object} opts
 *  - week_start: string (ISO date, optional)
 * @returns {Promise<object>}
 *  {
 *    week_start: "2026-06-01",
 *    week_end: "2026-06-07",
 *    stores: {
 *      hitchin: { store: "Peckers Hitchin", net_sales: 12345.67, ... },
 *      stevenage: { store: "Peckers Stevenage", net_sales: 9876.54, ... }
 *    },
 *    comparison: {
 *      net_sales: { hitchin: 12345.67, stevenage: 9876.54, diff: 2469.13, diff_pct: 19.9 },
 *      ...
 *    }
 *  }
 */
async function getAllStoresComparison(opts = {}) {
  const { week_start } = opts;

  // Get all stores
  const allStores = await getStores();
  const kpis = await getKPIsForStores({ stores: allStores, week_start });

  // If no data, return empty
  const firstStore = Object.values(kpis)[0];
  if (!firstStore) {
    return null;
  }

  // Build comparison metrics
  const comparison = {};
  const kpiFields = [
    'net_sales',
    'number_of_orders',
    'aov',
    'customer_count',
    'delivery_pct',
    'collection_pct',
    'eat_in_pct',
    'new_customer_pct',
  ];

  for (const field of kpiFields) {
    const values = {};
    let maxVal = -Infinity;

    for (const [key, kpi] of Object.entries(kpis)) {
      const val = parseFloat(kpi[field]) || 0;
      values[key] = val;
      if (val > maxVal) maxVal = val;
    }

    // Compute diff and % diff
    const storeKeys = Object.keys(values);
    let diff = null;
    let diff_pct = null;

    if (storeKeys.length === 2) {
      const [v1, v2] = Object.values(values);
      diff = Math.abs(v1 - v2);
      if (maxVal !== 0) {
        diff_pct = ((diff / maxVal) * 100).toFixed(1);
      }
    }

    comparison[field] = {
      values,
      diff,
      diff_pct,
      winner: storeKeys.length === 2 ? Object.keys(values)[Object.values(values).indexOf(maxVal)] : null,
    };
  }

  return {
    week_start: firstStore.week_start_iso,
    week_end: firstStore.week_end_iso,
    stores: kpis,
    comparison,
  };
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = {
  getStores,
  getWeeks,
  getKPIsForStore,
  getKPIsForStores,
  getAllStoresComparison,
  closePool,
};
