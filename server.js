'use strict';

/**
 * server.js
 * ---------
 * Express.js application that serves:
 *  - REST API endpoints for the Executive Dashboard KPIs
 *  - Static dashboard HTML/JS
 *
 * Start with: npm run api-start
 * API endpoint: http://localhost:3000/api/...
 * Dashboard: http://localhost:3000
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const apiRoutes = require('./src/api/routes');

const app = express();

// PORT before API_PORT, deliberately. Render, Railway, Fly and Heroku all
// inject PORT and route traffic to whatever they injected — a service that
// ignores it binds the wrong port and the platform reports the deploy as
// failed with no useful error. API_PORT stays as the local/self-hosted knob
// (it is what .env.example documents), so `npm run api-start` is unchanged.
const PORT = process.env.PORT || process.env.API_PORT || 3000;

// Bind to 0.0.0.0 in a container — the default would only accept connections
// from inside the container itself and the platform's router could never
// reach it.
const HOST = process.env.API_HOST || '0.0.0.0';

// ---------------------------------------------------------------------------
// PUBLIC_DEPLOY — set to 1 on any internet-facing host.
//
// /api/stores, /api/weeks and /api/kpis/* have NO authentication, and the CORS
// header below is `*`. That is fine on localhost. On a public URL it would
// publish every store's revenue, margin and labour KPIs to anyone who guesses
// the hostname — no token, no login, from any browser on the internet.
//
// The Sauce Management integration does not need any of those routes. It only
// calls /api/sauce/*, which is bearer-authenticated. So on a public host we
// serve the authenticated routes and nothing else.
//
// Unset (the default) preserves the existing local behaviour exactly, so
// `npm run api-start` and the dashboard keep working as they always have.
// ---------------------------------------------------------------------------
const PUBLIC_DEPLOY = process.env.PUBLIC_DEPLOY === '1';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS: allow any origin (for React/Next.js dev, external dashboards, etc.)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// On a public host, refuse the unauthenticated dashboard API before it can
// reach the router. Kept as a prefix check rather than a per-route guard so a
// route added later is closed by default rather than open by default.
if (PUBLIC_DEPLOY) {
  // NOTE: these are mount-relative. Inside `app.use('/api', ...)` Express
  // strips the mount path, so req.path here is '/sauce/...', NOT '/api/sauce/...'.
  const OPEN_PREFIXES = ['/sauce/', '/internal/'];
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || OPEN_PREFIXES.some((p) => req.path.startsWith(p))) {
      return next();
    }
    return res.status(404).json({ error: 'API endpoint not found' });
  });
}

// API endpoints
app.use('/api', apiRoutes);

if (!PUBLIC_DEPLOY) {
  // Static dashboard (served from dashboard/ folder)
  app.use(express.static(path.join(__dirname, 'dashboard')));

  // Home route → serve dashboard HTML
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
  });
}

// Catch-all
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  if (PUBLIC_DEPLOY) {
    return res.status(404).json({ error: 'Not found' });
  }
  // SPA fallback for the local dashboard. sendFile's error path is a callback,
  // not a promise — chaining .catch() on it throws a TypeError instead of
  // handling the missing file.
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'), (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  console.log('');
  console.log('========================================================');
  console.log(' Executive Dashboard API');
  console.log(`  Listening on ${HOST}:${PORT}`);
  console.log(`  Mode: ${PUBLIC_DEPLOY ? 'PUBLIC_DEPLOY (authenticated routes only)' : 'local (all routes + dashboard)'}`);
  console.log('========================================================');
  console.log('');
  console.log('Endpoints:');
  if (!PUBLIC_DEPLOY) {
    console.log('  GET  /api/stores                        → list all stores');
    console.log('  GET  /api/weeks                         → list all weeks');
    console.log('  GET  /api/kpis/single?store=...&week_start=...  → single store');
    console.log('  GET  /api/kpis/multiple?stores=...      → multiple stores');
    console.log('  GET  /api/kpis/comparison?week_start=... → full comparison');
  }
  console.log('  GET  /api/sauce/daily-net-sales         → daily feed   [Bearer SAUCE_API_KEY]');
  console.log('  GET  /api/sauce/health                  → feed status  [Bearer SAUCE_API_KEY]');
  console.log('  POST /api/internal/trigger-daily-sync   → run sync now [Bearer DAILY_SYNC_TRIGGER_SECRET]');
  console.log('  GET  /api/internal/health-check         → 503 if stale [Bearer DAILY_SYNC_TRIGGER_SECRET]');
  console.log('');
});
