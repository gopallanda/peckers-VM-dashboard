'use strict';

/**
 * routes.js
 * ---------
 * Express.js routes for the Executive Dashboard API.
 * All endpoints return clean JSON (numeric types, proper structure).
 * Can be consumed by any frontend (React, Next.js, Vue, plain HTML, etc.).
 */

const express = require('express');
const kpiService = require('./kpi-service');

const router = express.Router();

// Middleware: error handler for async endpoints
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

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
// Error handler (must be last)
// ---------------------------------------------------------------------------
router.use((err, req, res, next) => {
  console.error('[API Error]', err.message);
  res.status(500).json({ error: err.message });
});

module.exports = router;
