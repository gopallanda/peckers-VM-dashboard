# Live gross sales (intraday)

`GET /api/live/gross-sales` returns **today's gross sales so far**, per store,
with an hourly timeline. It reads Vita Mojo's ThoughtSpot live over plain HTTP.
No Playwright, no Chromium, and no database for the figures, so it fits
comfortably on Render free (512 MB).

It is a separate feature from the nightly feed (`docs/daily-net-sales.md`) and
shares nothing with it except the Postgres pool and the host.

> **Risk: this runs on Vita Mojo's internal endpoints, not a published API.**
> VM Hub has no public API. Every URL below is something the VM Hub web app
> calls for itself. Vita Mojo can rename, re-permission or remove any of them
> without notice. The ThoughtSpot model's column names (`Sales`, `Orders`,
> `Store`, `Hour of Day`, `Order Date`) and the `Sales Type` parameter can
> change the same way. The code fails loudly (`503` + a code) rather than
> guessing, and `/api/internal/live-health` exists so you hear about it.

---

## 1. How it works

```
consumer ──Bearer LIVE_SALES_API_KEY──▶ GET /api/live/gross-sales
                                             │  5-min in-memory cache
                                             ▼
             ┌───────── ThoughtSpot session (reused ≤ 20 min) ─────────┐
             │ 1 VM Hub refresh ─▶ 2 TS token ─▶ 3 TS cookie           │
             └──────────────────────────────┬──────────────────────────┘
                                             ▼
                        4 searchdata × 2 (store totals, store × hour)

cron-job.org ──Bearer DAILY_SYNC_TRIGGER_SECRET──▶ GET /api/internal/live-health
```

Code:

| File | Role |
|---|---|
| `src/live/thoughtspot-client.js` | steps 1-4, session single-flight, 401/403 re-login |
| `src/live/token-store.js` | refresh token in `vm_live_auth`, env fallback |
| `src/live/intraday-gross.js` | the queries, shaping, cache, stale-while-error |
| `src/api/routes.js` | the two routes |
| `scripts/live-probe.js` | read-only discovery (`npm run live-probe`) |
| `sql/live_sales_auth.sql` | the token table (run once in Supabase) |

## 2. The auth chain

1. `POST https://vmos2.vmos.io/user/v1/auth/refresh/<REFRESH_TOKEN>` (no body)
   → `201 { payload: { token: { value, refresh }, user: { email, … } } }`.
   A dead token gives `400 { vmosCode: "US-04" }`. The token must not have quotes
   around it (`auth.json` stores it JSON-quoted, and the code strips them).
2. `POST https://vmos2.vmos.io/tenant/v1/reporting/thoughtspot/auth`
   with `Authorization: Bearer <value>`, body `{"email": user.email}`
   → `201`, body = ThoughtSpot token (sometimes JSON-quoted; quotes are stripped).
3. `POST https://vitamojo.thoughtspot.cloud/callosum/v1/session/login/token`
   (form: `username`, `auth_token`, `redirect: 'manual'`)
   → `302` with `JSESSIONID` + `clientId` cookies.
4. `POST https://vitamojo.thoughtspot.cloud/api/rest/2.0/searchdata`
   with the cookies and `X-Requested-By: ThoughtSpot`, against the
   **Order Items** model `eff271e3-51a6-4dbd-ade1-7612d73d366f`.

Steps 1-3 run once per ~20 minutes and are shared by all concurrent callers.
Any 401/403 from ThoughtSpot triggers one fresh login and one retry.

**Refresh token resolution:** the `vm_live_auth` row first, then
`VM_REFRESH_TOKEN`. The env token is tried only when the DB token is
rejected with US-04 and the env value is different. After a successful
refresh, if the current token differs from the DB row, it is written back
to the row. That covers two cases: VM Hub rotated the token, or the row was
dead and the env token worked. On 2026-09-17 a refresh returned the **same**
token, so rotation has not been observed, but the store is there in case it
happens.

## 3. What "gross" means here, and the evidence

Gross is defined by two ThoughtSpot runtime parameters, not by a column:

```json
{ "param1": "Sales Type", "paramVal1": "gross sales",
  "param2": "Exclude Service Charge and Tip", "paramVal2": "false" }
```

That is VAT-inclusive gross, **including service charge and tip**. Other
`Sales Type` values exist (`net sales`, `gross sales before discounts`,
`net sales ignoring discounts`) and are not used.

**Reconciliation:** for 2026-09-16, `[Sales] [Store]` with exactly these
overrides returned Hitchin **1293.64** and Stevenage **2419.69**. Both are
identical to `vm_v_daily_net_sales.gross_sales` for that date. The check was
re-run through the service code itself on 2026-09-17 (see the commit message).

Do **not** switch to `metadata/liveboard/data` on the Intraday Sales liveboard.
Its "Net Sales …" tiles ignore the `Sales Type` parameter.

### Queries

```
[Sales] [Orders] [Store] [Order Date] = 'MM/DD/YYYY'
[Sales] [Orders] [Store] [Hour of Day] [Order Date] = 'MM/DD/YYYY'
```

What `npm run live-probe` established (2026-09-17):

- **Date:** an explicit Europe/London date, not `[Order Date].today`.
  ThoughtSpot's user timezone is UTC, so between 00:00 and 01:00 BST "today" is
  still yesterday's London date. The search parser only accepts `MM/DD/YYYY`
  literals and rejects ISO dates.
- **Timeline is hourly, not 15-minute.** `[Order At]` is date-only in this
  model: `.detailed`, `.hourly` and `'hour of day'` all come back as
  midnight/0. The model's `[Time Window]` is always `"00:00"`, and the
  liveboard's own "Sales by 15 Minute Time Window" tile returns a single bucket.
  `[Hour of Day]` is the finest real grain. It is already London local time:
  sales start at hour 11, and `[Time of Day]` labels read "lunch 11am-3pm".
- `[Orders]` is the order count (the liveboard's Orders tile uses it). AOV is
  computed here as gross ÷ orders.

## 4. Response

```json
{
  "businessDate": "2026-09-17",
  "asOf": "2026-09-17T11:40:02.113Z",
  "sourceLatencyMinutes": "15-30",
  "salesType": "gross sales (incl. service charge & tip)",
  "stale": false,
  "totals":  { "grossSales": 812.40, "orders": 41, "aov": 19.81 },
  "byStore": [
    { "store": "Peckers Hitchin",   "grossSales": 300.10, "orders": 15, "aov": 20.01 },
    { "store": "Peckers Stevenage", "grossSales": 512.30, "orders": 26, "aov": 19.70 }
  ],
  "timelineGranularity": "hour",
  "timeline": [ { "time": "11:00", "grossSales": 120.50, "cumulative": 120.50 } ]
}
```

- Both stores are always present; a store with no orders yet shows `0` and `aov: null`.
- `timeline` covers both stores combined. It runs from the first trading hour
  to the current London hour, which is still in progress. Hours with no sales
  inside that range are `0`.
- Money is rounded to 2 dp. `Cache-Control: no-store`.
- VM Hub is 15-30 minutes behind the till, and this endpoint adds up to 5 more
  minutes of cache.
- **Stale-while-error:** if a refresh fails but a result for the **same
  business date** is under 3 hours old, it is returned with `"stale": true`
  and `"error": "<CODE>"`.
- Otherwise `503 { "error": "live gross sales unavailable", "code": "<CODE>" }`.

## 5. Health check (cron-job.org)

`GET /api/internal/live-health` with `Authorization: Bearer <DAILY_SYNC_TRIGGER_SECRET>`.

- `200` if a live fetch succeeded in the last 90 minutes, or if it is outside
  trading hours (London 00:00-10:30).
- Otherwise the endpoint performs a fetch itself: `200` on success, `503 { code }`
  on failure. A stale answer counts as a failure.

Poll it every 30-60 minutes. cron-job.org emails on any non-2xx. Last-success
is held in memory, so after a Render spin-down the first poll does a real login.
That is intended.

## 6. Environment

| Var | Where | Notes |
|---|---|---|
| `LIVE_SALES_API_KEY` | Render | bearer for `/api/live/*`; `openssl rand -hex 32`. Separate from `SAUCE_API_KEY` and `DAILY_SYNC_TRIGGER_SECRET`. |
| `VM_REFRESH_TOKEN` | Render | fallback refresh token, no quotes |
| `SUPABASE_DB_URL` | Render (already set) | used for `vm_live_auth` |
| `DAILY_SYNC_TRIGGER_SECRET` | Render + cron-job.org (already set) | guards `/api/internal/live-health` |
| `PUBLIC_DEPLOY=1` | Render (already set) | `/live/` is on the allow-list in `server.js` |

One-off: run `sql/live_sales_auth.sql` in the Supabase SQL editor. Until then,
the server logs a warning and runs on `VM_REFRESH_TOKEN` alone.

## 7. Rotating / replacing the refresh token

When the health check reports `AUTH_REFRESH_INVALID`:

1. `npm run auth` (log in to VM Hub; this rewrites `auth.json`).
2. **Command A1** prints the new refresh token with its quotes stripped:
   ```bash
   node -e "const a=require('./auth.json');const o=a.origins.find(o=>o.origin.includes('vmos2.vmos.io'));console.log(o.localStorage.find(x=>x.name==='refresh-token').value.replace(/^\"+|\"+$/g,''))"
   ```
3. Put that value in Render → Environment → `VM_REFRESH_TOKEN` (this redeploys).
4. In the Supabase SQL editor: `delete from vm_live_auth;` so the dead DB row
   is not tried first. The next successful login writes the new token back.
5. `curl` the health check with the trigger secret and expect `200`.

Treat the token like a password: it logs in as the VM Hub user. Do not paste it
into chat, tickets or logs.

## 8. Failure modes

| `code` | Meaning | Action |
|---|---|---|
| `AUTH_REFRESH_INVALID` | VM Hub rejected the refresh token (US-04), or none is configured | §7 |
| `AUTH_REFRESH_FAILED` | VM Hub refresh errored or timed out (not US-04) | usually transient; if persistent, VM Hub changed the endpoint |
| `AUTH_TS_FAILED` | ThoughtSpot token or cookie login failed | the VM Hub user may have lost analytics access, or the endpoint changed |
| `TS_QUERY_FAILED` | `searchdata` errored, timed out, or returned unexpected columns | run `npm run live-probe`; a renamed column or parameter shows up there |
| `LIVE_UNAVAILABLE` | anything else | check Render logs (`[live]` lines) |

All HTTP calls time out after 20 s. Tokens are never logged. Note that the
refresh token is part of the step-1 URL, so request URLs are never logged either.
