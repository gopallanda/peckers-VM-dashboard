# Executive Dashboard Setup Guide

Complete guide to set up the **Peckers Executive Dashboard** from data sync to live dashboard.

---

## 📋 Prerequisites

- Node.js 18+ ([download](https://nodejs.org/))
- PostgreSQL client (psql) — comes with PostgreSQL, or install [standalone](https://www.postgresql.org/download/)
- Supabase project ([sign up free](https://supabase.com/))
- VM Hub account with `auth.json` session saved (from `npm run auth`)

---

## 🚀 Full Setup (5 minutes)

### Step 1: Install dependencies
```bash
cd vm-extractor
npm install
```

### Step 2: Create KPI views in Supabase
```bash
psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql
```

This creates:
- `vm_v_exec_dashboard` — all 8 KPIs with proper numeric types
- `vm_v_exec_dashboard_with_wow` — above + Week-on-Week growth
- Helper functions for channel bucketing and numeric casting

**Verify** the views were created:
```bash
psql "$SUPABASE_DB_URL" -c "\dv vm_v_*"
```

### Step 3: Run the data sync (if not already done)
```bash
npm run sync
```

This populates:
- `vm_net_sales_by_channel`
- `vm_orders_by_channel`
- `vm_customer_metrics`

### Step 4: Start the API server
```bash
npm run api-start
```

Output:
```
========================================================
 Executive Dashboard API
  Server: http://localhost:3000
  API: http://localhost:3000/api
  Dashboard: http://localhost:3000
========================================================

Endpoints:
  GET /api/stores                        → list all stores
  GET /api/weeks                         → list all weeks
  GET /api/kpis/single?store=...         → single store
  GET /api/kpis/multiple?stores=...      → multiple stores
  GET /api/kpis/comparison?week_start=... → full comparison
```

### Step 5: Open the dashboard
Open **http://localhost:3000** in your browser.

You should see:
- Store selector (dropdown)
- Week selector (dropdown)
- 8 KPI cards (Net Sales, Orders, AOV, etc.)
- Comparison view when "All Stores" is selected

---

## 🎯 What Each Component Does

### Data Layer (SQL)
```
vm_net_sales_by_channel  ─┐
vm_orders_by_channel     ├─→ vm_v_exec_dashboard ──→ JSON
vm_customer_metrics      ─┘
```

The views (`sql/kpi_views.sql`) compute:
1. **Channel bucketing** — map Uber Eats, Deliveroo, etc. → delivery/collection/eat_in
2. **Numeric casting** — convert TEXT → NUMERIC (no type conversion needed in API)
3. **Aggregation** — sum across channels per store/week
4. **KPI calculation** — AOV = Net Sales ÷ Orders, percentages, WoW growth, etc.

### API Layer (Node.js + Express)
```
/api/stores              → fetch available stores
/api/weeks               → fetch available weeks
/api/kpis/single        → fetch one store's KPIs
/api/kpis/multiple      → fetch multiple stores (comparison)
/api/kpis/comparison    → fetch all stores + diff/winner metrics
```

Returns **clean JSON** with numeric types — ready for any frontend.

### Frontend (HTML + JavaScript)
```
dashboard/index.html  → store selector → fetch from /api → render KPI cards
```

Can be replaced with:
- React component (hooks)
- Next.js page
- Vue component
- Any JavaScript framework

---

## 🔄 Typical Workflow

**Every week (or daily):**

1. **Sync data** (automated or manual):
   ```bash
   npm run sync
   ```

2. **Dashboard updates automatically** — no redeploy needed (views auto-compute).

3. **View the dashboard** at http://localhost:3000 — selector shows latest data.

---

## 📱 Using with React / Next.js

### Step 1: Create a reusable hook

```javascript
// useKPIs.js
import { useEffect, useState } from 'react';

export function useKPIs(store, weekStart) {
  const [kpi, setKpi] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (store) params.append('store', store);
    if (weekStart) params.append('week_start', weekStart);

    fetch(`/api/kpis/single?${params}`)
      .then(r => r.json())
      .then(d => { setKpi(d.data); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [store, weekStart]);

  return { kpi, loading, error };
}
```

### Step 2: Use in your component

```javascript
// DashboardPage.jsx
import { useKPIs } from './useKPIs';

export default function Dashboard() {
  const [store, setStore] = useState('Peckers Hitchin');
  const { kpi, loading, error } = useKPIs(store);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      <select value={store} onChange={e => setStore(e.target.value)}>
        <option>Peckers Hitchin</option>
        <option>Peckers Stevenage</option>
      </select>

      <div className="kpi-grid">
        <KPICard label="Net Sales" value={kpi?.net_sales} unit="₹" />
        <KPICard label="Orders" value={kpi?.number_of_orders} unit="" />
        <KPICard label="AOV" value={kpi?.aov} unit="₹" />
        <KPICard label="WoW Growth" value={kpi?.net_sales_wow_pct} unit="%" />
      </div>
    </div>
  );
}
```

---

## 📊 Advanced: Using Views Directly

If you want to **skip the API** and query SQL directly from React/Python:

```javascript
// Next.js Server Component
export default async function Dashboard() {
  const kpis = await fetch('postgresql://', {
    query: 'SELECT * FROM vm_v_exec_dashboard WHERE store = $1',
    params: ['Peckers Hitchin']
  });

  return <KPIDisplay data={kpis} />;
}
```

Or in Python:

```python
import psycopg2

conn = psycopg2.connect(os.environ['SUPABASE_DB_URL'])
cur = conn.cursor()
cur.execute('SELECT * FROM vm_v_exec_dashboard WHERE store = %s', ['Peckers Hitchin'])
kpi = cur.fetchone()
print(f"Net Sales: ₹{kpi['net_sales']}")
```

---

## 🐛 Troubleshooting

### "SUPABASE_DB_URL not set"
```bash
# Check your .env file
cat .env | grep SUPABASE_DB_URL

# If missing, add it:
SUPABASE_DB_URL=postgresql://postgres.xxxxx:password@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
```

### "No KPI data found"
1. Run the sync first: `npm run sync`
2. Verify tables exist: `psql "$SUPABASE_DB_URL" -c "\dt vm_*"`
3. Verify views exist: `psql "$SUPABASE_DB_URL" -c "\dv vm_v_*"`

### Dashboard shows "Loading..." forever
1. Check API is running: `curl http://localhost:3000/api/health`
2. Check browser console (F12) for errors
3. Check API logs in terminal

### "Column not found" error in views
The view expects specific CSV column names from VM Hub. If they differ, edit `sql/kpi_views.sql`:
```bash
# See what columns are in each table:
psql "$SUPABASE_DB_URL" -c "\d vm_net_sales_by_channel"
psql "$SUPABASE_DB_URL" -c "\d vm_orders_by_channel"
psql "$SUPABASE_DB_URL" -c "\d vm_customer_metrics"

# Update the view queries to match the actual column names
```

---

## 📦 Deployment

### To cloud (Render, Railway, Heroku):

1. **Push to Git**
   ```bash
   git add .
   git commit -m "Add Executive Dashboard API"
   git push
   ```

2. **Set environment variables** in your cloud provider:
   ```
   SUPABASE_DB_URL=postgresql://...
   ```

3. **Set startup command**:
   ```
   npm install && psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql && npm run api-start
   ```

4. **Deploy & done** — API lives at your cloud URL (e.g., https://myapp.render.com)

---

## 🔐 Security Notes

- **`SUPABASE_DB_URL` is secret** — never commit to Git. Use `.env` (in `.gitignore`) or env vars.
- **API allows CORS from any origin** (for dev). In production, restrict in `server.js`.
- **Views are read-only** — the API only queries, never inserts/updates.

---

## 📚 Next Steps

1. **Read [API.md](./API.md)** for all endpoint details.
2. **Build your frontend** — React, Next.js, Vue, or any framework.
3. **Connect your BI tool** — query the views with Metabase, Grafana, etc.
4. **Schedule sync** — set up `npm run sync` on a cron job or GitHub Actions.

---

## 📞 Support

- **SQL issues?** Check `sql/kpi_views.sql` comments.
- **API issues?** Check `src/api/kpi-service.js` documentation.
- **Frontend issues?** See `dashboard/index.html` or [API.md](./API.md).
