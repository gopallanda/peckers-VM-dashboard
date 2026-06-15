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
const PORT = process.env.API_PORT || 3000;

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

// API endpoints
app.use('/api', apiRoutes);

// Static dashboard (served from dashboard/ folder)
app.use(express.static(path.join(__dirname, 'dashboard')));

// Home route → serve dashboard HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// Catch-all for SPA (if using React/Next.js, return index.html)
app.get('*', (req, res) => {
  // Only for non-API routes
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html')).catch(() => {
      res.status(404).json({ error: 'Not found' });
    });
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('');
  console.log('========================================================');
  console.log(' Executive Dashboard API');
  console.log(`  Server: http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log('========================================================');
  console.log('');
  console.log('Endpoints:');
  console.log('  GET /api/stores                        → list all stores');
  console.log('  GET /api/weeks                         → list all weeks');
  console.log('  GET /api/kpis/single?store=...&week_start=...  → single store');
  console.log('  GET /api/kpis/multiple?stores=...     → multiple stores');
  console.log('  GET /api/kpis/comparison?week_start=... → full comparison');
  console.log('');
});
