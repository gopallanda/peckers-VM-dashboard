# Quick Start — Executive Dashboard

Get the dashboard running in **5 minutes**.

---

## Prerequisites
- Node.js 18+ installed
- `psql` installed (PostgreSQL client)
- `.env` file with `SUPABASE_DB_URL` set
- Data already synced (from `npm run sync`)

---

## 5-Minute Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Create KPI views
```bash
psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql
```

**Verify** it worked:
```bash
psql "$SUPABASE_DB_URL" -c "\dv vm_v_exec_dashboard"
```

### 3. Start API server
```bash
npm run api-start
```

You should see:
```
========================================================
 Executive Dashboard API
  Server: http://localhost:3000
  API: http://localhost:3000/api
  Dashboard: http://localhost:3000
========================================================
```

### 4. Test API (in another terminal)
```bash
curl http://localhost:3000/api/health
# Response: {"status":"ok"}
```

### 5. Open dashboard
```
http://localhost:3000
```

Select a store and week — see your KPIs! 🎉

---

## What You Get

- ✅ 8 KPI metrics for each store
- ✅ Store selector (Hitchin / Stevenage / Both)
- ✅ Week selector (latest first)
- ✅ Comparison view (when "Both" selected)
- ✅ Responsive design (works on mobile)
- ✅ REST API for custom frontends

---

## Next: Use the API from Your App

### React example:
```javascript
useEffect(() => {
  fetch('/api/kpis/single?store=Peckers%20Hitchin')
    .then(r => r.json())
    .then(d => setKpi(d.data));
}, []);
```

### Next.js example:
```javascript
const kpi = await fetch('http://localhost:3000/api/kpis/single?store=...')
  .then(r => r.json())
  .then(d => d.data);
```

### Direct database query:
```javascript
const client = new Client(process.env.SUPABASE_DB_URL);
const res = await client.query('SELECT * FROM vm_v_exec_dashboard WHERE store = $1', ['Peckers Hitchin']);
```

---

## Common Commands

```bash
# Start dashboard (port 3000)
npm run api-start

# Live-reload for development
npm run api-dev

# Sync data from VM Hub (weekly)
npm run sync

# Recreate KPI views after changing sql/kpi_views.sql
psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql

# View all KPI endpoints
curl http://localhost:3000/api/stores
curl http://localhost:3000/api/weeks
curl "http://localhost:3000/api/kpis/single?store=Peckers%20Hitchin"
curl "http://localhost:3000/api/kpis/comparison"
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "SUPABASE_DB_URL not set" | Add it to `.env` file |
| "No data found" | Run `npm run sync` first |
| Dashboard shows "Loading..." | Check API is running: `curl http://localhost:3000/api/health` |
| "view not found" | Run `psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql` again |

---

## Need More Help?

- **Full API docs**: [API.md](./API.md)
- **Setup & deployment**: [SETUP.md](./SETUP.md)
- **Architecture & design**: [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Implementation details**: [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)

---

**Ready?** → Run `npm install && psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql && npm run api-start` and open http://localhost:3000
