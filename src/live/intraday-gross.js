'use strict';

/**
 * intraday-gross.js
 * -----------------
 * Today's gross sales (so far) per store, from ThoughtSpot's "Order Items"
 * model. See docs/live-gross-sales.md.
 *
 * GROSS is defined by the runtime parameter overrides below, not by a column.
 * With exactly these two overrides, [Sales] for 2026-09-16 reconciled to the
 * penny with vm_v_daily_net_sales.gross_sales (the nightly feed).
 *
 * Query choices, all established by scripts/live-probe.js on 2026-09-17:
 *  - Explicit [Order Date] = 'MM/DD/YYYY' for the Europe/London date, NOT
 *    [Order Date].today — ThoughtSpot evaluates "today" in the TS user's
 *    timezone (UTC), which is yesterday's London date between 00:00 and 01:00
 *    BST. ISO dates are rejected by the search parser.
 *  - HOURLY timeline, not 15/30-minute: [Order At] is date-only in this model,
 *    so the liveboard's own "15 Minute Time Window" formula collapses to a
 *    single 00:00 bucket. [Hour of Day] is the finest real grain and is
 *    already Europe/London local time.
 */

const { searchData, LiveError } = require('./thoughtspot-client');

const STORES = ['Peckers Hitchin', 'Peckers Stevenage'];
const GROSS_PARAMS = {
  param1: 'Sales Type', paramVal1: 'gross sales',
  param2: 'Exclude Service Charge and Tip', paramVal2: 'false',
};
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const TZ = 'Europe/London';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const aov = (sales, orders) => (orders > 0 ? round2(sales / orders) : null);

/** Europe/London calendar parts for an instant. */
function londonParts(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    tsDate: `${parts.month}/${parts.day}/${parts.year}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Column index by name; a renamed column is a ThoughtSpot change worth failing loudly on. */
function col(result, name) {
  const i = result.columnNames.indexOf(name);
  if (i === -1) {
    throw new LiveError('TS_QUERY_FAILED', `expected column "${name}", got ${JSON.stringify(result.columnNames)}`);
  }
  return i;
}

async function fetchGross({ dayOffset }) {
  const now = new Date();
  const nowLondon = londonParts(now);
  // Noon-anchored so a DST change can never shift the date by an hour into the wrong day.
  const target = dayOffset === 0
    ? nowLondon
    : londonParts(new Date(Date.parse(`${nowLondon.isoDate}T12:00:00Z`) + dayOffset * 86400000));
  const dateFilter = `[Order Date] = '${target.tsDate}'`;

  const [totalsRes, hourlyRes] = await Promise.all([
    searchData(`[Sales] [Orders] [Store] ${dateFilter}`, GROSS_PARAMS),
    searchData(`[Sales] [Orders] [Store] [Hour of Day] ${dateFilter}`, GROSS_PARAMS),
  ]);

  // By store — always both stores, zero when ThoughtSpot has no rows yet.
  const byStoreMap = new Map(STORES.map((s) => [s, { store: s, grossSales: 0, orders: 0 }]));
  {
    const iStore = col(totalsRes, 'Store');
    const iSales = col(totalsRes, 'Total Sales');
    const iOrders = col(totalsRes, 'Orders');
    for (const row of totalsRes.rows) {
      const entry = byStoreMap.get(row[iStore]);
      if (!entry) continue; // another store on the tenant — not ours
      entry.grossSales += Number(row[iSales]) || 0;
      entry.orders += Number(row[iOrders]) || 0;
    }
  }
  const byStore = [...byStoreMap.values()].map((e) => ({
    store: e.store,
    grossSales: round2(e.grossSales),
    orders: e.orders,
    aov: aov(e.grossSales, e.orders),
  }));

  const totalSales = byStore.reduce((a, s) => a + s.grossSales, 0);
  const totalOrders = byStore.reduce((a, s) => a + s.orders, 0);

  // Timeline — both stores combined, per hour.
  const perHour = new Map();
  {
    const iStore = col(hourlyRes, 'Store');
    const iHour = col(hourlyRes, 'Hour of Day');
    const iSales = col(hourlyRes, 'Total Sales');
    for (const row of hourlyRes.rows) {
      if (!byStoreMap.has(row[iStore])) continue;
      const h = Number(row[iHour]);
      perHour.set(h, (perHour.get(h) || 0) + (Number(row[iSales]) || 0));
    }
  }
  const timeline = [];
  if (perHour.size > 0) {
    const first = Math.min(...perHour.keys());
    // Today: only windows that have started (the current hour is in progress).
    // A past day: through the last hour that traded.
    const last = dayOffset === 0 ? nowLondon.hour : Math.max(...perHour.keys());
    let cumulative = 0;
    for (let h = first; h <= last; h++) {
      const sales = perHour.get(h) || 0;
      cumulative += sales;
      timeline.push({ time: `${String(h).padStart(2, '0')}:00`, grossSales: round2(sales), cumulative: round2(cumulative) });
    }
  }

  return {
    businessDate: target.isoDate,
    asOf: now.toISOString(),
    sourceLatencyMinutes: '15-30',
    salesType: 'gross sales (incl. service charge & tip)',
    stale: false,
    totals: { grossSales: round2(totalSales), orders: totalOrders, aov: aov(totalSales, totalOrders) },
    byStore,
    timelineGranularity: 'hour',
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Cache, single-flight, stale-while-error, health bookkeeping
// ---------------------------------------------------------------------------
let lastGood = null;          // last successful result for dayOffset 0
let lastGoodAt = 0;
let inFlight = null;
const status = { lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null };

/**
 * @param {object} [opts]
 * @param {number} [opts.dayOffset=0] - DEBUG ONLY (e.g. -1 to reconcile
 *   yesterday against the nightly feed). Not exposed over HTTP; bypasses the
 *   cache and does not touch health status.
 */
async function getLiveGrossSales({ dayOffset = 0 } = {}) {
  if (dayOffset !== 0) return fetchGross({ dayOffset });

  const today = londonParts(new Date()).isoDate;
  if (lastGood && lastGood.businessDate === today && Date.now() - lastGoodAt < CACHE_TTL_MS) {
    return lastGood;
  }

  if (!inFlight) {
    inFlight = fetchGross({ dayOffset: 0 })
      .then((result) => {
        lastGood = result;
        lastGoodAt = Date.now();
        status.lastSuccessAt = result.asOf;
        return result;
      })
      .catch((err) => {
        status.lastErrorAt = new Date().toISOString();
        status.lastErrorCode = err.code || 'LIVE_UNAVAILABLE';
        console.error(`[live] gross-sales fetch failed (${status.lastErrorCode}): ${err.message}`);
        throw err;
      })
      .finally(() => { inFlight = null; });
  }

  try {
    return await inFlight;
  } catch (err) {
    const sameDay = lastGood && lastGood.businessDate === londonParts(new Date()).isoDate;
    if (sameDay && Date.now() - lastGoodAt < STALE_MAX_AGE_MS) {
      return { ...lastGood, stale: true, error: err.code || 'LIVE_UNAVAILABLE' };
    }
    throw err;
  }
}

function getLiveStatus() {
  return { ...status };
}

module.exports = { getLiveGrossSales, getLiveStatus, londonParts, LiveError };
