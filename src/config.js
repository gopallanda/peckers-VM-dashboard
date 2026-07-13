'use strict';

/**
 * config.js
 * ---------
 * Central configuration for the VM Hub -> Supabase sync.
 *
 *  - REPORTS         : the *report whitelist* (only these are ever synced).
 *  - STORES          : which stores to pull (Test Store excluded).
 *  - getWeeks()      : the Mon–Sun week windows to pull.
 *  - CHANNEL_BUCKET  : the channel -> fulfilment-bucket mapping (edit here).
 *  - NAV             : the *navigation whitelist* (only /mp1-reporting allowed).
 *
 * Everything tunable lives here so the rest of the code stays mechanical.
 */

require('dotenv').config();

// ---------------------------------------------------------------------------
// Small env helpers
// ---------------------------------------------------------------------------
function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

// ---------------------------------------------------------------------------
// Report whitelist — SYNC ONLY THESE.
// `chart` must be typed EXACTLY as it appears in the VM Hub "Chart" dropdown.
// ---------------------------------------------------------------------------
const REPORTS = [
  //── Executive Dashboard ── Already synced ────────────────────────────────
  {
    chart: 'Net Sales by Channel',
    table: 'vm_net_sales_by_channel',
    feeds: 'Net Sales, Delivery %, Collection %, Eat-In %, WoW, delivery sub-channels',
  },
  {
    chart: 'Number of Orders by channel (fulfilment date)',
    table: 'vm_orders_by_channel',
    feeds: 'Number of Orders, AOV',
  },
  {
    chart: 'New vs return customer metrics',
    table: 'vm_customer_metrics',
    feeds: 'Customer Count',
  },

  // ── Product Performance Dashboard ── Already synced ──────────────────────
  {
    chart: 'Top Menu Items Sold',
    table: 'vm_top_menu_items_sold',
    feeds: 'Best sellers, revenue, units sold',
  },
  {
    chart: 'Products sold (with uuid)',
    table: 'vm_products_sold',
    feeds: 'Product performance, WoW tracking',
  },
  {
    chart: 'Products sold with modifiers and size',
    table: 'vm_products_modifiers_size',
    feeds: 'Modifier analysis',
  },
  {
    chart: 'Top selling items per store per menu',
    table: 'vm_top_items_store_menu',
    feeds: 'Store-level product rankings',
  },
  {
    chart: 'Sales by External Category',
    table: 'vm_sales_external_category',
    feeds: 'Category performance',
  },
  {
    chart: 'Gross Sales by Category',
    table: 'vm_gross_sales_category',
    feeds: 'Category revenue',
  },

  // ── Daypart Analysis Dashboard ── Already synced ─────────────────────────
  {
    chart: 'Average order activity per hour per weekday',
    table: 'vm_hourly_order_activity',
    feeds: 'Hourly trading patterns',
  },
  {
    chart: 'Average order activity per weekday',
    table: 'vm_weekday_order_activity',
    feeds: 'Weekday trends',
  },
  {
    chart: 'Customer order activity',
    table: 'vm_customer_order_activity',
    feeds: 'Customer behaviour patterns',
  },
  {
    chart: 'Sales overview by fulfilment date',
    table: 'vm_sales_fulfilment_date',
    feeds: 'Revenue by time period',
  },
  {
    chart: 'Detailed Sales Info',
    table: 'vm_detailed_sales_info',
    feeds: 'Supporting daypart calculations',
  },

  {

  chart:'Menu Category Sales',
  table:'vm_menu_category_sales',
  feeds:'o find meal oxes and platters',
  },

  // ── Lunch Time Deals (Daypart dashboard) ── NEW ──────────────────────────
  // Pulled per store (extractor applies a single-store filter), so net_sales
  // and counts are per store. Feeds vm_v_lunch_deals / vm_v_lunch_deals_by_item.
  {
    chart: 'Meal Deals Sold',
    table: 'vm_meal_deals_sold',
    feeds: 'Lunch Time Deals: orders, revenue, AOV, per-deal breakdown',
  },
  {
    chart: 'Meals Deals Sold by store',
    table:'vm_meal_deals_sold_by_store',
     feeds: 'Lunch Time Deals: orders, revenue, AOV, per-deal breakdown',
  },

  // ── Delivery Platform Performance Dashboard ── Already synced ────────────
  {
    chart: 'Gross Sales by Store and Channel',
    table: 'vm_sales_store_channel',
    feeds: 'Channel revenue',
  },
  {
    chart: 'Deliveroo Sales Analysis by Store',
    table: 'vm_deliveroo_analysis',
    feeds: 'Deliveroo performance',
  },
  {
    chart: 'Delivery fee summary',
    table: 'vm_delivery_fee_summary',
    feeds: 'Delivery costs',
  },
  {
    chart: 'Delivery Info',
    table: 'vm_delivery_info',
    feeds: 'Delivery metrics',
  },

  // ── Store Comparison Dashboard ── Already synced ─────────────────────────
  {
    chart: 'Gross Sales by Store',
    table: 'vm_gross_sales_store',
    feeds: 'Store revenue',
  },
  {
    chart: 'Gross ATV by Store',
    table: 'vm_gross_atv_store',
    feeds: 'Store AOV',
  },
  {
    chart: 'Customers: New vs Repeat by store',
    table: 'vm_customer_store_metrics',
    feeds: 'Store customer metrics',
  },

  // ── Orders (renamed to real VM Hub chart names) ──────────────────────────
  {
    chart: 'Orders by Channel',
    table: 'vm_orders_store_channel',
    feeds: 'Channel orders',
  },
  {
    chart: 'Orders by store, brand, & channel',
    table: 'vm_orders_store',
    feeds: 'Store orders',
  },
];

// ---------------------------------------------------------------------------
// Stores (Test Store deliberately excluded). Comma-separated env override.
// ---------------------------------------------------------------------------
const STORES = env('STORES', 'Peckers Hitchin,Peckers Stevenage')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Channel -> fulfilment-bucket mapping.
// Centralised here AND mirrored in sql/kpi_views.sql — keep the two in sync.
// Matching is case-insensitive and substring-based against the channel value.
// ---------------------------------------------------------------------------
const CHANNEL_BUCKET = [
  { match: 'eat in', bucket: 'eat_in' },
  { match: 'eat-in', bucket: 'eat_in' },
  { match: 'take-away', bucket: 'collection' },
  { match: 'takeaway', bucket: 'collection' },
  { match: 'collection', bucket: 'collection' },
  { match: 'click & collect', bucket: 'collection' },
  { match: 'click and collect', bucket: 'collection' },
  { match: 'own-delivery', bucket: 'delivery' },
  { match: 'own delivery', bucket: 'delivery' },
  { match: 'delivery', bucket: 'delivery' },
  { match: 'uber eats', bucket: 'delivery' },
  { match: 'deliveroo', bucket: 'delivery' },
  { match: 'just eat', bucket: 'delivery' },
];

function bucketFor(channel) {
  const c = String(channel || '').toLowerCase();
  for (const { match, bucket } of CHANNEL_BUCKET) {
    if (c.includes(match)) return bucket;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Navigation whitelist. The only VM Hub page the browser may ever open.
// Login/SSO/auth paths are allowed so the session can establish; everything
// else on the hub host (Stores, Users, Analytics, ...) is blocked.
// ---------------------------------------------------------------------------
const NAV = {
  allowedPathPrefixes: ['/mp1-reporting'],
  // Substrings that mark an auth flow we must NOT block.
  authPathHints: ['login', 'signin', 'sign-in', 'auth', 'sso', 'oauth', 'callback'],
};

// ---------------------------------------------------------------------------
// Date helpers (all in UTC to avoid DST/local-tz drift)
// ---------------------------------------------------------------------------
function pad(n) {
  return String(n).padStart(2, '0');
}
function parseISO(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmtISO(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function fmtUK(d) {
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
function addDays(d, n) {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function mondayOf(d) {
  // 0=Mon ... 6=Sun
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(d, -dow);
}

/**
 * Returns the list of week windows to pull, oldest first.
 * Each item: { weekStart: Date, weekEnd: Date, startISO, endISO, startUK, endUK }
 *
 *  - If START_DATE and END_DATE are BOTH set -> a single explicit window.
 *  - Otherwise the last N complete Mon–Sun weeks (N = WEEKS_BACK).
 */
function getWeeks(now = new Date()) {
  const startEnv = env('START_DATE');
  const endEnv = env('END_DATE');

  let windows = [];

  if (startEnv && endEnv) {
    const s = parseISO(startEnv);
    const e = parseISO(endEnv);
    windows = [{ weekStart: s, weekEnd: e }];
  } else {
    const weeksBack = Math.max(1, parseInt(env('WEEKS_BACK', '4'), 10) || 4);
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const thisMonday = mondayOf(today);
    const lastMonday = addDays(thisMonday, -7); // start of the most recent COMPLETE week
    for (let i = weeksBack - 1; i >= 0; i--) {
      const wStart = addDays(lastMonday, -7 * i);
      const wEnd = addDays(wStart, 6);
      windows.push({ weekStart: wStart, weekEnd: wEnd });
    }
  }

  return windows.map((w) => ({
    ...w,
    startISO: fmtISO(w.weekStart),
    endISO: fmtISO(w.weekEnd),
    startUK: fmtUK(w.weekStart),
    endUK: fmtUK(w.weekEnd),
  }));
}

// ---------------------------------------------------------------------------
// Misc runtime config
// ---------------------------------------------------------------------------
const RUNTIME = {
  hubUrl: env('VM_HUB_URL', 'https://hub.vitamojo.com'),
  reportingPath: '/mp1-reporting',
  email: env('VM_HUB_EMAIL', ''),
  password: env('VM_HUB_PASSWORD', ''),
  dbUrl: env('SUPABASE_DB_URL', ''),
  headless: bool('HEADLESS', true),
  debugShots: bool('DEBUG_SHOTS', false),
  interval: 'Weekly',
  authFile: 'auth.json',
  downloadsDir: 'downloads',
  debugDir: 'debug',
  maxRetries: 3,
};

module.exports = {
  REPORTS,
  STORES,
  CHANNEL_BUCKET,
  bucketFor,
  NAV,
  RUNTIME,
  getWeeks,
  // exported for tests / reuse
  fmtISO,
  fmtUK,
  parseISO,
  addDays,
  mondayOf,
};
