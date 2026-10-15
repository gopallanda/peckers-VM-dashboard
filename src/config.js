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

//   // ── Product Performance Dashboard ── Already synced ──────────────────────
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

  //product level net sales table
  {
  chart: 'Net sales per product (with bundle UUID)',   // must match the dropdown text EXACTLY
  table: 'vm_net_sales_per_product',
  feeds: 'Item-level NET sales (product_uuid) — Product Performance net revenue',
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
  feeds:'to find meal boxes and platters',
  },
  {
    chart: 'Net Sales by Hour',
    table: 'vm_net_sales_by_hour',
    feeds: 'hourly net sales of items'
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
// LOYALTY reports — synced by src/loyalty.js (`npm run sync:loyalty`), NEVER by
// index.js. Kept out of REPORTS on purpose: index.js skips
// vm_refresh_all_snapshots() if ANY report fails, and a flaky customer-level
// chart must never block that refresh. The weekly workflow runs the loyalty
// step after the core sync, and SKIP_LOYALTY=1 turns it off.
//
// Every field was decided from the live hub in Phase 0 (src/inspect_loyalty.js,
// 2026-10-15), not assumed:
//   kind      'weekly'   -> output changes with the date range; one load per
//                           (store, Mon–Sun week); backfillable.
//             'snapshot' -> output ignores the date range (point-in-time state);
//                           pulled once per run and stamped with the last
//                           complete week. NEVER backfilled — past weeks would
//                           get today's numbers.
//   perStore  true  -> Stores filter changes the output; one pull per store.
//             false -> Stores filter has no effect; pulled once and loaded as
//                      'All stores' (or split by a store column if the CSV has
//                      one). Never loaded under both store names (double count).
//   columns   the EXACT raw headers seen in Phase 0. Any new or missing header
//             fails the report instead of loading it: a new column on a
//             customer-level chart could be personal data that load.js would
//             otherwise turn straight into a TEXT column.
//   idColumn  pseudonymous key that must be present (customer/user uuid, or
//             order_uuid for Discounts Info, which joins to
//             vm_detailed_sales_info.order_uuid -> customer_id). Kept.
//   dropColumns extra personal-data header regexes on top of LOYALTY_PII_DEFAULT.
//   csvTimeoutMs per-fetch CSV timeout (core stays at 120s).
//
// "Loyalty - Current Balance" is deliberately absent: its CSV has headers but
// zero rows for every store selection. Balances come from the two charts below.
// ---------------------------------------------------------------------------
const LOYALTY_ALL_STORES = 'All stores';

// Headers matching any of these are removed from `columns` AND every row before
// anything is written to disk or Supabase. Case-insensitive.
const LOYALTY_PII_DEFAULT = [
  /^((first|last|full|sur|given|customer|user|member|account)[ _-]?)?name$/i,
  /e-?mail/i,
  /phone|mobile|^tel$|telephone/i,
  /address|street|post[ _-]?code|zip|^city$|^town$|county/i,
  /birth|^dob$/i,
  /marketing|consent|opt[ _-]?in/i,
  /card[ _-]?(number|token|last|pan)|payment[ _-]?token|^token$|^pan$|last[ _-]?4|fingerprint/i,
];

const LOYALTY_REPORTS = [
  {
    // One row per loyalty member attributed to the selected store (uuid unique
    // per store; the two stores' member sets don't overlap). Per-member running
    // totals + last_activity_date — not an event ledger. Date filter ignored.
    chart: 'Loyalty earnt and redeemed',
    table: 'vm_loyalty_earnt_redeemed',
    kind: 'snapshot',
    perStore: true,
    idColumn: 'uuid',
    columns: ['uuid', 'email', 'balance_accrued', 'balance_redeemed', 'current_balance', 'last_activity_date'],
  },
  {
    // Share of points earnt/redeemed per channel (values sum to 1, not points).
    chart: 'Loyalty per channel',
    table: 'vm_loyalty_per_channel',
    kind: 'weekly',
    perStore: true,
    idColumn: null,
    columns: ['channel', 'points_earnt', 'points_redeemed'],
  },
  {
    chart: 'Loyalty per customer (with filters)',
    table: 'vm_loyalty_per_customer',
    kind: 'weekly',
    perStore: true,
    idColumn: 'user_uuid',
    columns: [
      'user_uuid',
      'points_earnt_click_collect', 'points_redeemed_click_collect',
      'points_earnt_kiosk', 'points_redeemed_kiosk',
      'points_earnt_opat', 'points_redeemed_opat',
      'points_earnt_delivery', 'points_redeemed_delivery',
    ],
  },
  {
    // One row per discounted order. No customer uuid: order_uuid is the key.
    chart: 'Discounts Info (with promo code & customer info)',
    table: 'vm_discounts_info_customer',
    kind: 'weekly',
    perStore: true,
    idColumn: 'order_uuid',
    columns: [
      'order_uuid', 'discount_name', 'discount_code', 'customer_name', 'user_email', 'created_at',
      'collection_at', 'store', 'channel', 'payment_method', 'order_status', 'order_number',
      'table_number', 'gross_sales_before_discounts_and_refunds', 'discounts', 'refunds',
      'gross_sales', 'vatable_sales', 'non_vatable_sales', 'vat', 'net_sales',
      'deprecated_current_vat', 'deprecated_current_net_sales', 'products_ordered', 'marketing_opt_in',
    ],
  },
  {
    // Identical output whatever the Stores filter says -> estate-wide.
    chart: 'Lifetime loyalty per customer',
    table: 'vm_loyalty_lifetime_per_customer',
    kind: 'snapshot',
    perStore: false,
    idColumn: 'user_uuid',
    columns: [
      'user_uuid', 'points_balance',
      'points_earnt_click_collect', 'points_redeemed_click_collect',
      'points_earnt_kiosk', 'points_redeemed_kiosk',
      'points_earnt_opat', 'points_redeemed_opat',
      'points_earnt_delivery', 'points_redeemed_delivery',
    ],
  },
  {
    // Customer sign-ups (user_role = customer), filtered by registered_at — a
    // weekly sign-up list, not a snapshot. acteol_ctc_id is a third-party CRM
    // contact id that links back to personal data, so it is dropped too.
    chart: 'Users',
    table: 'vm_loyalty_users',
    kind: 'weekly',
    perStore: true,
    idColumn: 'user_uuid',
    columns: [
      'registered_at', 'user_uuid', 'marketing_opt_in', 'email', 'name', 'lang', 'store',
      'user_phone_number', 'birth_date', 'acteol_ctc_id', 'user_role',
    ],
    dropColumns: [/^acteol/i],
  },
  {
    // Heavy query: 131s for one store-week cold, and 504s on the first fetch
    // (297s for Stevenage in the timed dry run). LAST on purpose: if it ever
    // overruns the workflow step's 25-minute timeout, only this chart is lost.
    chart: 'Sales Generated by Discount Type',
    table: 'vm_sales_by_discount_type',
    kind: 'weekly',
    perStore: true,
    idColumn: null,
    columns: ['promotion_name', 'gross_sales_generated', 'total_discounts'],
    csvTimeoutMs: 300000,
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

/**
 * Week windows for the LOYALTY step only, oldest first (same shape as getWeeks).
 *
 *  - fromISO unset -> just the last complete Mon–Sun week (the weekly run).
 *  - fromISO set   -> ONE window per Mon–Sun week from fromISO up to toISO, or
 *                     the last complete week when toISO is unset.
 *
 * Deliberately separate from getWeeks() and blind to START_DATE / END_DATE:
 * getWeeks() with both set returns ONE window covering the whole range, so a
 * backfill built on it would stamp every row with a single week_start.
 * Both bounds must be Mondays and the range must not reach an unfinished week —
 * we refuse rather than guess.
 */
function getLoyaltyWeeks(fromISO, toISO, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const lastMonday = addDays(mondayOf(today), -7);
  const asMonday = (s, name) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new Error(`${name}=${s} is not YYYY-MM-DD.`);
    const d = parseISO(s);
    if (fmtISO(d) !== s) throw new Error(`${name}=${s} is not a real date.`);
    if (d.getUTCDay() !== 1) throw new Error(`${name}=${s} is not a Monday.`);
    return d;
  };

  let first = lastMonday;
  let last = lastMonday;
  if (fromISO) {
    first = asMonday(fromISO, 'LOYALTY_FROM');
    if (toISO) last = asMonday(toISO, 'LOYALTY_TO');
    if (last > lastMonday) {
      throw new Error(`Week ${fmtISO(last)} is not complete yet (last complete week starts ${fmtISO(lastMonday)}).`);
    }
    if (first > last) throw new Error(`LOYALTY_FROM ${fromISO} is after the last week ${fmtISO(last)}.`);
  }

  const windows = [];
  for (let s = first; s <= last; s = addDays(s, 7)) {
    const e = addDays(s, 6);
    windows.push({
      weekStart: s,
      weekEnd: e,
      startISO: fmtISO(s),
      endISO: fmtISO(e),
      startUK: fmtUK(s),
      endUK: fmtUK(e),
    });
  }
  return windows;
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
  LOYALTY_REPORTS,
  LOYALTY_PII_DEFAULT,
  LOYALTY_ALL_STORES,
  getLoyaltyWeeks,
  bool,
  // exported for tests / reuse
  fmtISO,
  fmtUK,
  parseISO,
  addDays,
  mondayOf,
};
