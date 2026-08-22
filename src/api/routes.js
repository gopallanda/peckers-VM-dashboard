'use strict';

/**
 * routes.js
 * ---------
 * Express.js routes for the Executive Dashboard API.
 * All endpoints return clean JSON (numeric types, proper structure).
 * Can be consumed by any frontend (React, Next.js, Vue, plain HTML, etc.).
 */

const crypto = require('crypto');
const express = require('express');
const kpiService = require('./kpi-service');
const dailySalesService = require('./daily-sales-service');
const dailySyncRunner = require('./daily-sync-runner');

const router = express.Router();

// Middleware: error handler for async endpoints
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ---------------------------------------------------------------------------
// Bearer auth for the /sauce/* and /internal/* routes.
//
// These are server-to-server: constant-time comparison, no CORS carve-out
// (the blanket Access-Control-Allow-Origin: * in server.js still applies at
// the HTTP layer, but without a valid token every guarded request gets a
// 401 body regardless of origin), no cookie auth. If Sauce Management ever
// needs this from a browser it must proxy through its own backend — putting
// SAUCE_API_KEY in a client bundle would publish it.
//
// Two DIFFERENT tokens, deliberately:
//   SAUCE_API_KEY             — read-only sales data, held by the teammate
//   DAILY_SYNC_TRIGGER_SECRET — can start a scrape, held by cron-job.org
// Sharing one token would mean the teammate could kick off VM Hub scrapes, and
// that rotating the teammate's key would silently break the nightly cron.
// ---------------------------------------------------------------------------
function bearerGuard(envName) {
  return function guard(req, res, next) {
    const expected = process.env[envName];
    if (!expected) {
      return res.status(500).json({ error: envName + ' not configured on the server' });
    }

    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid bearer token' });
    }

    next();
  };
}

const requireSauceApiKey = bearerGuard('SAUCE_API_KEY');
const requireTriggerSecret = bearerGuard('DAILY_SYNC_TRIGGER_SECRET');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// GET /api/stores
// Get all available stores
// ---------------------------------------------------------------------------
router.get('/stores', asyncHandler(async (req, res) => {
  const stores = await kpiService.getStores();
  res.json({ stores });
}));

// ---------------------------------------------------------------------------
// GET /api/weeks
// Get all available weeks
// ---------------------------------------------------------------------------
router.get('/weeks', asyncHandler(async (req, res) => {
  const weeks = await kpiService.getWeeks();
  res.json({ weeks });
}));

// ---------------------------------------------------------------------------
// GET /api/kpis/single?store=<store>&week_start=<date>
// Get KPIs for a single store
//
// Query params:
//   store (required): e.g. "Peckers Hitchin"
//   week_start (optional): ISO date (YYYY-MM-DD). If not set, returns latest.
//
// Response: { success: true, data: {...} }
// ---------------------------------------------------------------------------
router.get('/kpis/single', asyncHandler(async (req, res) => {
  const { store, week_start } = req.query;

  if (!store) {
    return res.status(400).json({ error: 'store query param is required' });
  }

  const kpi = await kpiService.getKPIsForStore({ store, week_start });

  if (!kpi) {
    return res.status(404).json({ error: `No KPI data found for store=${store}` });
  }

  res.json({ success: true, data: kpi });
}));

// ---------------------------------------------------------------------------
// GET /api/kpis/multiple?stores=<s1>,<s2>&week_start=<date>
// Get KPIs for multiple stores (comparison)
//
// Query params:
//   stores (required): comma-separated store names, e.g. "Peckers Hitchin,Peckers Stevenage"
//   week_start (optional): ISO date. If not set, returns latest.
//
// Response: { success: true, data: { hitchin: {...}, stevenage: {...} } }
// ---------------------------------------------------------------------------
router.get('/kpis/multiple', asyncHandler(async (req, res) => {
  const { stores, week_start } = req.query;

  if (!stores) {
    return res.status(400).json({ error: 'stores query param is required (comma-separated)' });
  }

  const storeList = stores.split(',').map((s) => s.trim());
  const kpis = await kpiService.getKPIsForStores({ stores: storeList, week_start });

  res.json({ success: true, data: kpis });
}));

// ---------------------------------------------------------------------------
// GET /api/kpis/comparison?week_start=<date>
// Get all stores with full comparison metrics (diff, winner, etc.)
// Best for dashboard comparison view.
//
// Query params:
//   week_start (optional): ISO date. If not set, returns latest.
//
// Response: {
//   success: true,
//   data: {
//     week_start: "2026-06-01",
//     week_end: "2026-06-07",
//     stores: { hitchin: {...}, stevenage: {...} },
//     comparison: {
//       net_sales: { values: {...}, diff: 2469.13, diff_pct: "19.9", winner: "hitchin" },
//       ...
//     }
//   }
// }
// ---------------------------------------------------------------------------
router.get('/kpis/comparison', asyncHandler(async (req, res) => {
  const { week_start } = req.query;

  const data = await kpiService.getAllStoresComparison({ week_start });

  if (!data) {
    return res.status(404).json({ error: 'No KPI data available' });
  }

  res.json({ success: true, data });
}));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// GET /api/sauce/daily-net-sales?store=<slug>&date=<YYYY-MM-DD>
// GET /api/sauce/daily-net-sales?store=<slug>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>
//
// Server-to-server feed for Sauce Management. See docs/daily-net-sales.md §5
// for the full contract. Requires `Authorization: Bearer <SAUCE_API_KEY>`.
//
// Returns `gross_sales`, not `net_sales`, as of 2026-08-22 (VM Hub chart was
// switched from 'Net Sales by Channel' to 'Gross Sales' — see the pivot note
// at the top of sql/daily_net_sales.sql). The route path is unchanged.
//
// A missing day returns 404 with a reason — never 0. A silent zero is
// indistinguishable from a genuine day of no trade and would get reported.
// ---------------------------------------------------------------------------
router.get('/sauce/daily-net-sales', requireSauceApiKey, asyncHandler(async (req, res) => {
  const { store, date, from, to } = req.query;

  if (!store) {
    return res.status(400).json({ error: 'store query param is required (e.g. hitchin, stevenage)' });
  }
  if (!date && !(from && to)) {
    return res.status(400).json({ error: 'either date, or both from and to, is required' });
  }

  if (date) {
    const row = await dailySalesService.getOne({ store, date });
    if (!row) {
      const status = await dailySalesService.getFeedStatus();
      return res.status(404).json({
        reason: `no data for store=${store} date=${date}`,
        last_synced_at: status.last_synced_at,
        latest_business_date: status.latest_business_date,
      });
    }
    return res.json({
      store: row.store_slug,
      store_name: row.store,
      business_date: row.business_date,
      gross_sales: Number(row.gross_sales),
      currency: 'GBP',
      last_synced_at: row.last_synced_at,
    });
  }

  if (to < from) {
    return res.status(400).json({ error: '`to` must not be before `from`' });
  }

  const { rows, missingDates } = await dailySalesService.getRange({ store, from, to });
  if (rows.length === 0) {
    const status = await dailySalesService.getFeedStatus();
    return res.status(404).json({
      reason: `no data for store=${store} in range ${from}..${to}`,
      last_synced_at: status.last_synced_at,
      latest_business_date: status.latest_business_date,
    });
  }

  return res.json({
    store,
    from,
    to,
    missing_dates: missingDates,
    data: rows.map((row) => ({
      store: row.store_slug,
      store_name: row.store,
      business_date: row.business_date,
      gross_sales: Number(row.gross_sales),
      currency: 'GBP',
      last_synced_at: row.last_synced_at,
    })),
  });
}));

// ---------------------------------------------------------------------------
// GET /api/sauce/health
// Latest run, latest successful run, and whether the feed is stale.
// ---------------------------------------------------------------------------
router.get('/sauce/health', requireSauceApiKey, asyncHandler(async (req, res) => {
  const health = await dailySalesService.getHealth();
  res.json(health);
}));

// ---------------------------------------------------------------------------
// POST /api/internal/trigger-daily-sync
//
// Called by cron-job.org once a night. Requires
// `Authorization: Bearer <DAILY_SYNC_TRIGGER_SECRET>`.
//
// Returns 202 IMMEDIATELY and does not wait for the scrape. This is not a
// stylistic choice: cron-job.org aborts a request after 30s (free tier) and a
// full run takes several minutes, so a synchronous endpoint would be recorded
// as failed every single night even when it worked.
//
// The consequence is that a green cron-job.org history means "the sync was
// requested", NOT "the sync succeeded" — which is exactly why
// GET /api/internal/health-check below exists.
//
// Optional JSON body for a manual re-run of a specific inclusive range:
//   { "start_date": "2026-08-20", "end_date": "2026-08-20" }
// Both or neither. Re-running is always safe: the load is idempotent per
// (store, date). See docs/daily-net-sales.md section 7.
// ---------------------------------------------------------------------------
router.post('/internal/trigger-daily-sync', requireTriggerSecret, (req, res) => {
  const { start_date: startDate, end_date: endDate } = req.body || {};

  if ((startDate && !endDate) || (endDate && !startDate)) {
    return res.status(400).json({ error: 'start_date and end_date must be set together, or neither' });
  }
  // Strictly validated because these values are handed to a child process as
  // environment variables. Anything that is not exactly YYYY-MM-DD is refused.
  if (startDate && (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate))) {
    return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD' });
  }
  if (startDate && endDate < startDate) {
    return res.status(400).json({ error: 'end_date must not be before start_date' });
  }

  const { started, run } = dailySyncRunner.start({
    source: req.get('user-agent') || 'http-trigger',
    startDate,
    endDate,
  });

  if (!started) {
    // Deliberately a 4xx so cron-job.org records it as a FAILURE and emails.
    // A run still in flight when the next night's trigger arrives means the
    // previous one has been going for ~24h — that is worth waking up for.
    return res.status(409).json({
      error: 'a daily sync is already running',
      running_since: run.startedAt,
      pid: run.pid,
    });
  }

  return res.status(202).json({
    accepted: true,
    started_at: run.startedAt,
    range: run.range,
    note: 'sync runs in the background; poll GET /api/sauce/health for the result',
  });
});

// ---------------------------------------------------------------------------
// GET /api/internal/health-check
//
// The alarm. Identical data to GET /api/sauce/health, but returns 503 when the
// feed is stale instead of 200.
//
// Why a second endpoint rather than changing /api/sauce/health: that one is
// documented to return 200 even when stale, because the check itself
// succeeded, and Sauce Management reads the `stale` flag from the body. This
// one exists purely so cron-job.org's own failure notification can be used as
// a free monitor — point a second cron job at it and any non-2xx emails you.
//
// This replaces the SMTP failure alert that the GitHub Actions workflow used
// to send. Without it, a nightly scrape could fail silently forever: the
// trigger endpoint's 202 tells cron-job.org nothing about whether the scrape
// that followed actually worked.
// ---------------------------------------------------------------------------
router.get('/internal/health-check', requireTriggerSecret, asyncHandler(async (req, res) => {
  const health = await dailySalesService.getHealth();
  res.status(health.stale ? 503 : 200).json({
    ...health,
    // The in-process view: what this server itself last ran. Empty after a
    // restart or redeploy, which is why `stale` is computed from the database
    // ledger and not from this.
    runner: {
      running: dailySyncRunner.isRunning(),
      current: dailySyncRunner.getCurrent(),
      last_run_this_process: dailySyncRunner.getLastRun(),
    },
  });
}));

// ---------------------------------------------------------------------------
// Error handler (must be last)
// ---------------------------------------------------------------------------
router.use((err, req, res, next) => {
  console.error('[API Error]', err.message);
  res.status(500).json({ error: err.message });
});

module.exports = router;
