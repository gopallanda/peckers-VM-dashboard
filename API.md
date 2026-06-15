# Executive Dashboard API

**Framework-agnostic REST API** for the Peckers Executive Dashboard KPIs.

The API is:
- ✅ **Decoupled**: SQL views compute KPIs independently of the API framework
- ✅ **Reusable**: Can be consumed by React, Next.js, Vue, Python, mobile apps, etc.
- ✅ **Swappable**: Can be replaced with FastAPI, Go, etc. without changing the data layer
- ✅ **Clean**: All responses use proper numeric types (not TEXT)

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Create the KPI views in Supabase
```bash
psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql
```

### 3. Start the API server
```bash
npm run api-start
```

Server runs on `http://localhost:3000`

---

## API Endpoints

### Base URL
```
http://localhost:3000/api
```

### 1. GET `/stores`
List all available stores.

**Response:**
```json
{
  "stores": ["Peckers Hitchin", "Peckers Stevenage"]
}
```

---

### 2. GET `/weeks`
List all available weeks (ISO dates).

**Response:**
```json
{
  "weeks": [
    { "week_start": "2026-06-01", "week_end": "2026-06-07" },
    { "week_start": "2026-05-25", "week_end": "2026-05-31" }
  ]
}
```

---

### 3. GET `/kpis/single`
Get KPIs for a single store.

**Query Params:**
- `store` (required): Store name, e.g. `"Peckers Hitchin"`
- `week_start` (optional): ISO date (YYYY-MM-DD). If omitted, returns latest week.

**Example:**
```
GET /api/kpis/single?store=Peckers%20Hitchin&week_start=2026-06-01
```

**Response:**
```json
{
  "success": true,
  "data": {
    "store": "Peckers Hitchin",
    "week_start_iso": "2026-06-01",
    "week_end_iso": "2026-06-07",
    "net_sales": 25432.50,
    "number_of_orders": 456,
    "aov": 55.75,
    "customer_count": 200,
    "delivery_pct": 45.2,
    "collection_pct": 35.8,
    "eat_in_pct": 19.0,
    "new_customer_count": 50,
    "return_customer_count": 150,
    "new_customer_pct": 25.0,
    "delivery_sales_amount": 11469.82,
    "collection_sales_amount": 9104.80,
    "eat_in_sales_amount": 4857.88,
    "net_sales_wow_pct": 5.3,
    "orders_wow_pct": 2.1,
    "customers_wow_pct": 3.0
  }
}
```

---

### 4. GET `/kpis/multiple`
Get KPIs for multiple stores (side-by-side comparison).

**Query Params:**
- `stores` (required): Comma-separated store names, e.g. `"Peckers Hitchin,Peckers Stevenage"`
- `week_start` (optional): ISO date (YYYY-MM-DD). If omitted, returns latest week.

**Example:**
```
GET /api/kpis/multiple?stores=Peckers%20Hitchin,Peckers%20Stevenage&week_start=2026-06-01
```

**Response:**
```json
{
  "success": true,
  "data": {
    "hitchin": {
      "store": "Peckers Hitchin",
      "net_sales": 25432.50,
      ...
    },
    "stevenage": {
      "store": "Peckers Stevenage",
      "net_sales": 19876.25,
      ...
    }
  }
}
```

---

### 5. GET `/kpis/comparison`
Get all stores with **full comparison metrics** (diff, winner, percentages).

Best for a comparison dashboard view where you want to highlight differences and winners.

**Query Params:**
- `week_start` (optional): ISO date (YYYY-MM-DD). If omitted, returns latest week.

**Example:**
```
GET /api/kpis/comparison?week_start=2026-06-01
```

**Response:**
```json
{
  "success": true,
  "data": {
    "week_start": "2026-06-01",
    "week_end": "2026-06-07",
    "stores": {
      "hitchin": {
        "store": "Peckers Hitchin",
        "net_sales": 25432.50,
        ...
      },
      "stevenage": {
        "store": "Peckers Stevenage",
        "net_sales": 19876.25,
        ...
      }
    },
    "comparison": {
      "net_sales": {
        "values": { "hitchin": 25432.50, "stevenage": 19876.25 },
        "diff": 5556.25,
        "diff_pct": "21.8",
        "winner": "hitchin"
      },
      "number_of_orders": {
        "values": { "hitchin": 456, "stevenage": 412 },
        "diff": 44,
        "diff_pct": "9.6",
        "winner": "hitchin"
      },
      "aov": {
        "values": { "hitchin": 55.75, "stevenage": 48.24 },
        "diff": 7.51,
        "diff_pct": "13.5",
        "winner": "hitchin"
      },
      ...
    }
  }
}
```

---

### 6. GET `/health`
Health check.

**Response:**
```json
{ "status": "ok" }
```

---

## Error Handling

All errors return a JSON response with HTTP status and error message:

```json
{
  "error": "store query param is required"
}
```

Common errors:
- `400 Bad Request`: Missing or invalid query params
- `404 Not Found`: No data found for the requested store/week
- `500 Internal Server Error`: Database or server error

---

## Data Types

All KPI values are returned as **numeric types** (not strings):

| KPI | Type | Example | Notes |
|---|---|---|---|
| `net_sales` | numeric(12,2) | 25432.50 | Rupees |
| `number_of_orders` | numeric(10,0) | 456 | Count |
| `aov` | numeric(10,2) | 55.75 | Rupees per order |
| `customer_count` | numeric(10,0) | 200 | Count |
| `delivery_pct` | numeric(5,1) | 45.2 | Percentage 0-100 |
| `collection_pct` | numeric(5,1) | 35.8 | Percentage 0-100 |
| `eat_in_pct` | numeric(5,1) | 19.0 | Percentage 0-100 |
| `new_customer_pct` | numeric(5,1) | 25.0 | Percentage 0-100 |
| `*_wow_pct` | numeric(6,1) | 5.3 | Week-on-Week % change |

---

## Using with React / Next.js

### Example: Fetch single store KPIs

```javascript
// React Hook
const [kpi, setKpi] = useState(null);

useEffect(() => {
  fetch(`/api/kpis/single?store=Peckers%20Hitchin`)
    .then(r => r.json())
    .then(({ data }) => setKpi(data));
}, []);

return (
  <div>
    <h2>Net Sales: ₹{kpi?.net_sales?.toLocaleString('en-IN')}</h2>
    <p>Orders: {kpi?.number_of_orders}</p>
    <p>AOV: ₹{kpi?.aov?.toFixed(2)}</p>
  </div>
);
```

### Example: Fetch comparison

```javascript
const [comparison, setComparison] = useState(null);

useEffect(() => {
  fetch(`/api/kpis/comparison`)
    .then(r => r.json())
    .then(({ data }) => setComparison(data));
}, []);

return (
  <div>
    {Object.entries(comparison?.comparison || {}).map(([metric, comp]) => (
      <div key={metric}>
        <h3>{metric}</h3>
        <p>Hitchin: {comp.values.hitchin}</p>
        <p>Stevenage: {comp.values.stevenage}</p>
        <p>Winner: {comp.winner}</p>
      </div>
    ))}
  </div>
);
```

---

## Using with Python / FastAPI

The API can be easily replicated in FastAPI or queried directly from Python:

```python
import requests
import json

# Fetch KPIs
response = requests.get('http://localhost:3000/api/kpis/comparison')
data = response.json()['data']

# Use in your FastAPI app
@app.get('/dashboard')
def dashboard():
    return {
        'week': f"{data['week_start']} to {data['week_end']}",
        'stores': data['stores'],
        'comparison': data['comparison']
    }
```

---

## Database Schema (for reference)

The API queries these views (created by `sql/kpi_views.sql`):

- `vm_v_exec_dashboard` — 8 KPIs per store/week with proper numeric types
- `vm_v_exec_dashboard_with_wow` — above + Week-on-Week growth %
- `vm_v_latest_week` — the most recent week

Source tables:
- `vm_net_sales_by_channel` — raw sales data by channel
- `vm_orders_by_channel` — raw order counts by channel
- `vm_customer_metrics` — new vs. return customer data

---

## CORS

The API allows requests from any origin (for development). In production, restrict to your domain:

Edit `server.js`:
```javascript
res.header('Access-Control-Allow-Origin', 'https://yourdomain.com');
```

---

## Environment Variables

Ensure your `.env` file has:
```
SUPABASE_DB_URL=postgresql://...
API_PORT=3000  # (optional, defaults to 3000)
```

---

## Deployment

### To deploy on Render, Railway, or Heroku:

1. Push code to Git
2. Set `SUPABASE_DB_URL` env var in the platform
3. Run `npm install && psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql`
4. Start command: `npm run api-start`
5. Port: `3000`

---

## Development

For live-reloading during development:
```bash
npm run api-dev
```
(requires `nodemon` to be installed)
