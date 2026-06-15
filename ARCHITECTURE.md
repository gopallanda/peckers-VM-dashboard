# Executive Dashboard Architecture

**Decoupled, framework-agnostic design** for the Peckers Executive Dashboard.

---

## 🏗️ Layers

```
┌─────────────────────────────────────────────────────────┐
│                    PRESENTATION LAYER                   │
│                  (Framework Flexible)                   │
├─────────────────────────────────────────────────────────┤
│  React      │  Next.js    │  Vue     │  Plain HTML     │
│  Components │  Pages      │  Comps   │  + JS           │
└─────────────────────────────────────────────────────────┘
                          ↓
              Consumes: /api/kpis/*
                          ↓
┌─────────────────────────────────────────────────────────┐
│                      API LAYER                          │
│                  (Framework: Express)                   │
├─────────────────────────────────────────────────────────┤
│  server.js (Entry point)                               │
│  src/api/routes.js (REST endpoints)                    │
│  src/api/kpi-service.js (Pure business logic)          │
└─────────────────────────────────────────────────────────┘
                          ↓
              Queries: vm_v_exec_dashboard*
                          ↓
┌─────────────────────────────────────────────────────────┐
│                      DATA LAYER                         │
│                  (Database: Supabase)                   │
├─────────────────────────────────────────────────────────┤
│  SQL Views (sql/kpi_views.sql)                         │
│  ├─ vm_v_exec_dashboard (8 KPIs)                       │
│  ├─ vm_v_exec_dashboard_with_wow (+ WoW growth)       │
│  ├─ vm_v_weekly_base (aggregates)                      │
│  └─ Helper functions (vm_bucket, vm_num)               │
│                          ↓                              │
│  Raw Tables (from npm run sync)                        │
│  ├─ vm_net_sales_by_channel                            │
│  ├─ vm_orders_by_channel                               │
│  └─ vm_customer_metrics                                │
└─────────────────────────────────────────────────────────┘
```

---

## 🔄 Data Flow

### Sync → Views → API → Frontend

```
1. DATA COLLECTION (npm run sync)
   ├─ Log in to VM Hub (auth.json session)
   ├─ For each whitelisted report:
   │  ├─ Select report (Chart dropdown)
   │  ├─ Set store (Hitchin or Stevenage)
   │  ├─ Set date range (Monday-Sunday weeks)
   │  └─ Export CSV from Metabase embed
   └─ Load CSV rows into Supabase
      ├─ vm_net_sales_by_channel
      ├─ vm_orders_by_channel
      └─ vm_customer_metrics

2. COMPUTE KPIs (sql/kpi_views.sql)
   ├─ Cast TEXT → NUMERIC (vm_num function)
   ├─ Bucket channels (vm_bucket function)
   ├─ Aggregate by store/week
   ├─ Compute 8 KPIs:
   │  ├─ Net Sales (sum)
   │  ├─ Orders (sum)
   │  ├─ AOV (Net Sales ÷ Orders)
   │  ├─ Customer Count (new + return)
   │  ├─ Delivery % (sales ÷ total × 100)
   │  ├─ Collection % (same)
   │  ├─ Eat-In % (same)
   │  └─ WoW Growth % (LAG window function)
   └─ Populate vm_v_exec_dashboard view

3. SERVE API (src/api/)
   ├─ kpi-service.js (queries views, returns JSON)
   ├─ routes.js (REST endpoints)
   └─ server.js (Express, listens on :3000)

4. RENDER FRONTEND (dashboard/)
   ├─ Fetch from /api/stores, /api/weeks
   ├─ Fetch from /api/kpis/single (single store)
   │  or /api/kpis/comparison (all stores)
   └─ Render KPI cards + comparison view
```

---

## 📁 Project Structure

```
vm-extractor/
├─ src/
│  ├─ sync/                      # Data sync (existing)
│  │  ├─ auth.js                 # One-time login
│  │  ├─ extract.js              # Playwright + VM Hub
│  │  ├─ load.js                 # Supabase loader
│  │  └─ index.js                # Orchestrator
│  │
│  └─ api/                        # NEW: API layer
│     ├─ kpi-service.js          # Pure data logic (queries views)
│     └─ routes.js               # Express routes
│
├─ sql/
│  └─ kpi_views.sql              # UPDATED: Enhanced with all 8 KPIs
│
├─ dashboard/                     # NEW: Frontend
│  └─ index.html                 # HTML + vanilla JS (can be replaced)
│
├─ server.js                      # NEW: Express entry point
├─ package.json                   # UPDATED: Added express
├─ .env                           # Config (git-ignored)
├─ .gitignore
├─ API.md                         # NEW: API documentation
├─ SETUP.md                       # NEW: Setup guide
├─ ARCHITECTURE.md                # This file
└─ README.md
```

---

## 🔑 Key Design Decisions

### 1. **Data Layer is Framework-Agnostic**
- SQL views (`vm_v_exec_dashboard`) compute all KPIs independently
- Column names and types are standardized (numeric, not TEXT)
- Any language can query these views: Python, Go, Node, etc.
- Swapping Express for FastAPI doesn't affect the views

### 2. **Business Logic in kpi-service.js, Not in Routes**
- `kpi-service.js` is pure — no Express dependencies
- Can be imported into other contexts (CLI, batch jobs, etc.)
- Routes in `routes.js` are thin — just HTTP wrappers

### 3. **Numeric Types at the Source**
- `vm_num()` and `vm_bucket()` functions in SQL cast to NUMERIC
- API returns proper JSON numbers, not strings
- Frontend never has to parse or convert

### 4. **Simple Frontend for Flexibility**
- `dashboard/index.html` is vanilla HTML + JS (no framework lock-in)
- Can be replaced with React, Next.js, Vue, etc.
- All consumers share the same `/api/*` endpoints

### 5. **Full-Width Comparison Metrics**
- `/api/kpis/comparison` endpoint returns not just values, but:
  - Diff (absolute difference)
  - Diff % (relative difference)
  - Winner (which store is ahead)
- Enables rich comparison UIs without client-side math

---

## 🔀 Extension Points

### Add a new KPI?

1. **SQL view** (`sql/kpi_views.sql`):
   ```sql
   -- Add to vm_v_exec_dashboard view:
   my_new_kpi::numeric(10,2) AS my_new_kpi
   ```

2. **API auto-includes it** — no code change needed, next `npm run api-start` will serve it.

3. **Frontend auto-displays it** — if using the provided HTML, add a KPI card definition and reload.

### Use with FastAPI instead of Express?

1. **Create `api/main.py`**:
   ```python
   from fastapi import FastAPI
   import psycopg2

   app = FastAPI()

   @app.get("/api/kpis/single")
   def get_kpi(store: str, week_start: str = None):
       # Query vm_v_exec_dashboard
       # Return same JSON structure
   ```

2. **SQL views unchanged** — FastAPI queries the same views.

3. **Frontend unchanged** — it fetches from `/api/kpis/*` regardless of backend language.

### Use with Grafana / Metabase?

1. **Add Supabase as data source** in Grafana/Metabase.
2. **Query the views directly**:
   ```sql
   SELECT * FROM vm_v_exec_dashboard
   WHERE store = 'Peckers Hitchin'
   ORDER BY week_start DESC
   LIMIT 1
   ```
3. **Create dashboards** — no API needed.

---

## 🧪 Testing Strategy

### Unit Tests (Recommended)

```javascript
// test/kpi-service.test.js
const kpiService = require('../src/api/kpi-service');

describe('kpiService', () => {
  test('getKPIsForStore returns numeric types', async () => {
    const kpi = await kpiService.getKPIsForStore({
      store: 'Peckers Hitchin'
    });
    expect(typeof kpi.net_sales).toBe('number');
    expect(typeof kpi.number_of_orders).toBe('number');
  });
});
```

### Integration Tests

```javascript
// test/api.test.js
const request = require('supertest');
const app = require('../server');

describe('API', () => {
  test('GET /api/kpis/single returns 8 KPIs', async () => {
    const res = await request(app)
      .get('/api/kpis/single?store=Peckers%20Hitchin');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('net_sales');
    expect(res.body.data).toHaveProperty('aov');
    // ... check all 8
  });
});
```

### SQL Tests

```sql
-- test/views.sql
SELECT * FROM vm_v_exec_dashboard WHERE store = 'Peckers Hitchin';
-- Verify: columns exist, types are numeric, no NULLs in key fields
```

---

## 📈 Performance Considerations

### Indexes (created by kpi_views.sql)
```sql
CREATE INDEX idx_exec_dashboard_store_week
  ON vm_net_sales_by_channel (store, week_start DESC);
```

Ensures queries filter by store + week efficiently.

### View Materialization (if needed later)

If views get slow (unlikely at current data size), materialize them:
```sql
CREATE MATERIALIZED VIEW vm_v_exec_dashboard_mat AS
SELECT * FROM vm_v_exec_dashboard;

CREATE INDEX ON vm_v_exec_dashboard_mat (store, week_start DESC);

-- Refresh weekly:
REFRESH MATERIALIZED VIEW vm_v_exec_dashboard_mat;
```

### Caching (optional)

Add Redis caching in `kpi-service.js`:
```javascript
const cache = require('redis').createClient();

async function getKPIsForStore(opts) {
  const key = `kpi:${opts.store}:${opts.week_start}`;
  const cached = await cache.get(key);
  if (cached) return JSON.parse(cached);
  // ... query DB, cache result
}
```

---

## 🚀 Deployment Checklist

- [ ] Views created in Supabase: `psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql`
- [ ] Data synced: `npm run sync`
- [ ] Dependencies installed: `npm install`
- [ ] `.env` configured with `SUPABASE_DB_URL`
- [ ] API tested locally: `npm run api-start` → `curl http://localhost:3000/api/health`
- [ ] Frontend tested: Open http://localhost:3000 → can select store/week
- [ ] CORS configured (if API on different domain)
- [ ] Secrets in environment variables (not `.env`)
- [ ] Monitoring set up (error logs, query metrics)
- [ ] Backup plan for data (Supabase daily backups by default)

---

## 🔐 Security

- ✅ **Views are read-only** — no INSERT/UPDATE/DELETE via API
- ✅ **Type safety** — all data cast to proper types in SQL, no code injection via user input
- ✅ **Parameterized queries** — `kpi-service.js` uses `$1, $2` placeholders
- ⚠️ **CORS** — currently allows all origins (fine for dev, restrict in prod)
- ⚠️ **Auth** — no auth implemented yet (consider JWT middleware if needed)

---

## 📚 Further Reading

- [API.md](./API.md) — All 6 endpoints documented
- [SETUP.md](./SETUP.md) — Step-by-step setup for this project
- [src/api/kpi-service.js](./src/api/kpi-service.js) — Comments on each function
- [sql/kpi_views.sql](./sql/kpi_views.sql) — Comments on view logic
