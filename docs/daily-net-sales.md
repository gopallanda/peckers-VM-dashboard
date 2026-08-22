# Daily sales feed (Sauce Management)

> **2026-08-22 — pivoted from net sales to gross sales.** The VM Hub chart
> this sync pulls was changed from `Net Sales by Channel` to `Gross Sales`.
> Everything below now describes **gross sales** (VAT-inclusive, before
> discounts/refunds), not net sales. File, table, view, and route names still
> say "net-sales" — that naming was left as-is rather than renamed everywhere;
> treat it as legacy, not as a description of the metric. The reconciliation
> in §9 was only ever run against the old net-sales chart and has **not**
> been redone for gross sales.

One **gross sales** figure per store per business day, pulled from Vita Mojo
every night and served to the Sauce Management project over HTTP.

There is **no channel breakdown**: one number per store per day.

Sauce Management **never** touches Supabase directly. It only ever calls this
API.

> References to a separate "Cash-Flow app" below are historical — that app was
> never built. Both the API and the nightly sync live in **this** repo, served
> by `server.js`. See the amendment in §5.

---

## 1. How it fits together

> **2026-08-22 — GitHub Actions removed from the daily path.** The daily sync
> now runs **on the same host that serves this API**, as a child process of
> `server.js`. cron-job.org calls the trigger route directly; there is no
> `workflow_dispatch`, no `GH_DISPATCH_TOKEN`, and no SMTP alert. The
> **weekly** sync is unchanged and still runs on GitHub Actions via `sync.yml`.

```
cron-job.org                                    cron-job.org
  job 1 — 00:30 daily                             job 2 — hourly
      │                                                 │
      │ POST /api/internal/trigger-daily-sync           │ GET /api/internal/health-check
      │ Bearer DAILY_SYNC_TRIGGER_SECRET                │ Bearer DAILY_SYNC_TRIGGER_SECRET
      │                                                 │ 503 when stale ──▶ cron-job.org emails you
      ▼                                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  HOST  ·  node server.js  ·  PUBLIC_DEPLOY=1                 │
│                                                              │
│   trigger route ──spawn──▶ node src/daily/sync.js            │
│   (returns 202 at once)    (Playwright, ~1-2 min)            │
│                                    │                         │
│                                    ▼                         │
│                            VM Analytics Supabase             │
│                            vm_daily_net_sales_raw            │
│                            vm_v_daily_net_sales              │
│                            vm_daily_sync_runs                │
│                                    │                         │
│   GET /api/sauce/daily-net-sales ◀─┘ (reads the view only)   │
└──────────────────────────────────────────────────────────────┘
                          ▲
                          │ Bearer SAUCE_API_KEY
                    Sauce Management
```

**cron-job.org is a scheduler, not a host.** All it does is send an HTTP
request on a timer — it cannot run Node and it cannot run Playwright. That is
the whole reason a host is required: something has to be listening at a public
HTTPS URL for cron-job.org to call, and that same something runs the scrape.

Why the trigger returns **202 immediately** instead of running the scrape
inside the request: cron-job.org aborts a request after 30s on the free tier,
and a run takes 1–2 minutes. A synchronous endpoint would be recorded as failed
every single night even when it worked perfectly.

Why the scrape is a **child process** rather than an in-process call:
`src/daily/sync.js` runs on import and calls `process.exit(1)` on failure —
requiring it would take the API server down with it. See
`src/api/daily-sync-runner.js`.

Why the timing is driven externally rather than by GitHub's `schedule:`:
GitHub's cron is best-effort and can be delayed by many minutes under load. The
whole run has to finish before the **weekly** sync starts at 01:30 UTC, which
is also why the runner carries a hard 20-minute watchdog
(`DAILY_SYNC_TIMEOUT_MS`).

---

## 2. The cron-job.org jobs

Create **two** jobs. The second one is not optional — see §6 for why.

### Job 1 — the nightly trigger

| Field | Value |
|---|---|
| Title | `Peckers daily sales sync` |
| URL | `https://<your-host>/api/internal/trigger-daily-sync` |
| Method | `POST` |
| Header | `Authorization: Bearer <DAILY_SYNC_TRIGGER_SECRET>` |
| Schedule | **00:30, daily** |
| Timezone | `Europe/London` |
| Failure notification | **Enable it.** |

Expected response: `202`. A `409` means the previous night's run is somehow
still going after ~24 hours; cron-job.org will flag it, which is intended.

The endpoint returns **`202 Accepted` immediately** and does not wait for the
scrape. A green history on this job therefore means "the sync was requested",
**not** "the sync succeeded". That is what Job 2 is for.

### Job 2 — the staleness alarm

| Field | Value |
|---|---|
| Title | `Peckers daily sales — stale check` |
| URL | `https://<your-host>/api/internal/health-check` |
| Method | `GET` |
| Header | `Authorization: Bearer <DAILY_SYNC_TRIGGER_SECRET>` |
| Schedule | **hourly** (or once a day around 08:00 — anything that gets seen) |
| Timezone | `Europe/London` |
| Failure notification | **Enable it.** |

This route returns `503` when no successful run has completed in more than 26
hours, so cron-job.org's own failure email becomes the alarm. It replaces the
SMTP failure alert the GitHub Actions workflow used to send, at no cost and
with nothing new to configure.

### Worked example

At **00:30 GMT on 22 August**, cron-job.org fires. The workflow runs and fetches
net sales for:

| Business date | Why |
|---|---|
| **21 August** | yesterday — the figure Sauce Management wants |
| 20 August | re-pulled for late-settlement self-healing |
| 19 August | re-pulled for late-settlement self-healing |

Sauce Management then reads 21 August from the API.

The extra two days are **not a historical backfill**. Delivery-platform figures
can still settle after midnight, so D-1 read at 00:30 is not always final.
Because the load is idempotent per `(store, date)`, re-pulling D-1/D-2/D-3 every
night lets a late correction overwrite itself and silently repairs any single
night the cron missed. Controlled by `DAILY_LOOKBACK_DAYS` (default `3`).

"Yesterday" is computed in **`Europe/London`**, not UTC — a business date is a
local trading-day concept.

---

## 3. Environment variables

Everything the daily sync needs now lives on **one host**, set through that
host's environment-variable UI (or a `.env` file on a VPS). There are no
GitHub Actions secrets for the daily sync any more.

### Required on the host

| Variable | Purpose | How to get it |
|---|---|---|
| `VM_HUB_EMAIL` | VM Hub login | same value the weekly sync uses |
| `VM_HUB_PASSWORD` | VM Hub login | same value the weekly sync uses |
| `SUPABASE_DB_URL` | reads and writes VM Analytics Postgres | session-pooler URI; percent-encode `@ : / ? # [ ] %` in the password |
| `STORES` | which stores to pull | `Peckers Hitchin,Peckers Stevenage` |
| `SAUCE_API_KEY` | bearer token the **teammate** sends | `openssl rand -hex 32` |
| `DAILY_SYNC_TRIGGER_SECRET` | bearer token **cron-job.org** sends | `openssl rand -hex 32` — a *different* value |
| `PUBLIC_DEPLOY` | `1` on any internet-facing host | see the warning below |
| `HEADLESS` | must be `1` on a server | `1` |
| `TZ` | log timestamps | `Europe/London` |

> **`SAUCE_API_KEY` and `DAILY_SYNC_TRIGGER_SECRET` must be two different
> values.** `SAUCE_API_KEY` only reads sales figures; `DAILY_SYNC_TRIGGER_SECRET`
> can start a VM Hub scrape. Sharing one token would let the teammate kick off
> scrapes, and rotating the teammate's key would silently kill the nightly cron.

> **`PUBLIC_DEPLOY=1` is a security requirement, not a preference.**
> `/api/stores`, `/api/weeks` and `/api/kpis/*` have **no authentication at
> all**, and `server.js` sends `Access-Control-Allow-Origin: *`. On localhost
> that is harmless. On a public URL, leaving `PUBLIC_DEPLOY` unset publishes
> every store's revenue, margin and labour KPIs to anyone who finds the
> hostname — no token, no login, from any browser. With it set, only the
> bearer-authenticated `/api/sauce/*` and `/api/internal/*` routes respond;
> the Sauce Management integration needs nothing else.

### Optional on the host

| Variable | Default | Purpose |
|---|---|---|
| `DAILY_LOOKBACK_DAYS` | `3` | how many days back from yesterday to re-pull |
| `DAILY_SYNC_TIMEOUT_MS` | `1200000` (20 min) | hard kill for a wedged run |
| `API_PORT` | `3000` | most hosts inject their own `PORT` |
| `API_HOST` | `0.0.0.0` | required in a container |
| `VM_AUTH_JSON` | — | not used by the host; see below |
| `DAILY_START_DATE` / `DAILY_END_DATE` | — | manual re-run window — **never set these permanently on the host** |

> **Do not leave `DAILY_START_DATE`/`DAILY_END_DATE` set on the host.** A value
> left over from a manual re-run would pin every future nightly run to that old
> date. The trigger route defends against this — it deletes both from the child
> process's environment unless the request body supplies a range — but do not
> rely on that. Use the request body (§7), not the host config.
>
> They are also deliberately not called `START_DATE`/`END_DATE`: those belong to
> the weekly sync and mean a Mon–Sun **week** window.

### About `auth.json`

The GitHub Actions workflow restored a saved Playwright `storageState` from a
`VM_AUTH_JSON` secret. On the host this is unnecessary: `src/auto-auth.js` logs
in with `VM_HUB_EMAIL`/`VM_HUB_PASSWORD` when there is no valid saved session,
and writes a fresh `auth.json` that persists for as long as the container
lives. A redeploy wipes it and the next run simply logs in again.

### GitHub Actions secrets

Still needed, but **only for the weekly sync** (`sync.yml`): `VM_HUB_EMAIL`,
`VM_HUB_PASSWORD`, `SUPABASE_DB_URL`, `VM_AUTH_JSON`. Nothing new to add.

The `SMTP_*`, `ALERT_EMAIL_TO`, `GH_DISPATCH_TOKEN`, `GH_REPO_OWNER`,
`GH_REPO_NAME` and `GH_DISPATCH_REF` values described in earlier revisions of
this document are **no longer used by anything**. Do not create them.

## 4. Applying the SQL

Run once against the VM Analytics Supabase, **after** `sql/kpi_views.sql` (which
defines the `vm_num()` helper this file depends on):

```bash
psql "$SUPABASE_DB_URL" -f sql/daily_net_sales.sql
```

It is safe to re-run — everything is `CREATE ... IF NOT EXISTS` or
`CREATE OR REPLACE`. It creates only new objects:

| Object | What it is |
|---|---|
| `vm_daily_net_sales_raw` | landing table, one row per (store, date, channel) |
| `vm_daily_sync_runs` | run ledger — tells "no sales" apart from "never ran" |
| `vm_v_daily_net_sales` | the consumer-facing view, one row per (store, date) |

> **`week_start` in `vm_daily_net_sales_raw` holds a single DAY, not a Monday.**
> That is deliberate. It reuses `loadStore()`'s existing per-`(store, week_start)`
> delete-then-insert idempotency, so re-pulling a date replaces exactly that
> date with zero new write code. Don't "fix" it. The same note is at the top of
> both `sql/daily_net_sales.sql` and `src/daily/sync.js`.

> **Ignore the CSV's own `week_commencing` column.** VM Hub reports it as the
> Monday of the containing week even for a single-day window — all seven days of
> a test week came back as the same Monday. Grouping on it would collapse every
> lookback day onto one date. The business date is the meta `week_start`.

---

## 5. The API

> **Amendment:** the sections above describe a separate `peckers-cashflow` app
> as the API host. That app doesn't exist yet, so `/api/sauce/*` is
> implemented directly in **this repo** instead, on the Express server already
> serving the Executive Dashboard (`server.js` + `src/api/routes.js`, started
> with `npm run api-start`). Everything below — the routes, params, response
> shapes, auth — is unchanged; only the host differs. `SAUCE_API_KEY` is a
> `vm-extractor` env var (see `.env.example`), not a `peckers-cashflow` one.

All endpoints are **server-to-server**: bearer auth compared in constant time,
no CORS header, no cookie auth. If Sauce Management needs this in a browser, it
must proxy through its own backend — putting `SAUCE_API_KEY` in a client bundle
would publish it.

### `GET /api/sauce/daily-net-sales`

```
Authorization: Bearer <SAUCE_API_KEY>
```

| Param | Required | Notes |
|---|---|---|
| `store` | yes | slug: `hitchin` or `stevenage` — never the display name |
| `date` | either | single business date, `YYYY-MM-DD` |
| `from` + `to` | either | inclusive range; returns an array under `data` |

Single date:

```json
{
  "store": "hitchin",
  "store_name": "Peckers Hitchin",
  "business_date": "2026-08-21",
  "gross_sales": 1234.56,
  "currency": "GBP",
  "last_synced_at": "2026-08-22T00:34:11Z"
}
```

(Field is `gross_sales`, not `net_sales` — see the pivot note at the top of
this document. The endpoint path itself did not change.)

Range responses add `from`, `to`, `missing_dates` and `data`. `missing_dates`
names any day in the range with no row, so the consumer cannot total a
gap-ridden range and unknowingly report a low number.

**A missing day returns `404` with an explicit `reason` — never `0`.** This is
the most important behaviour in the endpoint. A silent zero is
indistinguishable from a genuine day of no trade, and a zero gets rendered,
believed, and never investigated. The 404 body still carries `last_synced_at`
and `latest_business_date` so the caller can tell "the feed is current and that
day really is absent" from "the feed is behind".

The endpoint reads **only** `vm_v_daily_net_sales`. It exposes the slug rather
than the display name, so renaming a store in VM Hub cannot break Sauce
Management.

### `GET /api/sauce/health`

Same bearer key. Returns the latest run, the latest **successful** run, and a
`stale` flag.

```json
{
  "stale": false,
  "stale_threshold_hours": 26,
  "hours_since_last_success": 4.21,
  "last_successful_run_at": "2026-08-22T00:34:11Z",
  "latest_run": { "id": 12, "status": "ok", "rows_loaded": 45, "...": "..." }
}
```

`stale` = no run with `status='ok'` in more than **26 hours** (24h cadence plus
two hours of headroom). `partial` deliberately does **not** count as success — a
partial run means at least one store is missing a day, which is exactly what
this endpoint exists to surface.

Returns `200` even when stale: the check itself succeeded. A non-2xx would mean
"health check broken", which is a different fact.

### `POST /api/internal/trigger-daily-sync`

```
Authorization: Bearer <DAILY_SYNC_TRIGGER_SECRET>
```

Starts the scrape as a child process on this host and returns **`202`
immediately** — it does not wait. Optional JSON body `{"start_date": "...",
"end_date": "..."}` for a manual re-run (§7); send no body for the normal
window.

| Status | Meaning |
|---|---|
| `202` | accepted; the scrape is running in the background |
| `400` | malformed range (not `YYYY-MM-DD`, only one of the two, end before start) |
| `401` | missing or wrong bearer token |
| `409` | a run is already in flight — the lock is held |

There is **one lock and one watchdog**. Two concurrent runs would fight over the
same VM Hub session, so a second trigger gets `409` rather than queueing. The
watchdog kills a run after `DAILY_SYNC_TIMEOUT_MS` (20 min) and releases the
lock — without it, one wedged night would reject every night thereafter and the
feed would be dead permanently.

### `GET /api/internal/health-check`

```
Authorization: Bearer <DAILY_SYNC_TRIGGER_SECRET>
```

Same body as `/api/sauce/health` plus a `runner` object describing what *this
process* last ran, but returns **`503` when `stale` is true** instead of `200`.

That status code is the entire point: it lets cron-job.org's own failure
notification act as the alarm (§2, Job 2). `/api/sauce/health` deliberately
keeps returning `200` when stale — the check itself succeeded, and Sauce
Management reads the flag from the body — so the two cannot be merged.

`runner.last_run_this_process` is empty after a restart or redeploy. That is why
`stale` is computed from the `vm_daily_sync_runs` ledger in Postgres and not
from in-memory state.

---

## 6. Monitoring — three independent layers

The trigger is fire-and-forget, so **cron-job.org's Job 1 only ever sees the
202**. A green history on that job is perfectly compatible with a feed that has
been dead for a week. Hence three layers:

1. **Job 1's failure notification** — catches a trigger that never fired at all
   (host down or asleep, wrong secret, expired TLS cert). Also catches the
   `409` case, where the previous run never finished.
2. **Job 2 → `GET /api/internal/health-check`** — catches the case Job 1
   structurally cannot see: the trigger was accepted, the scrape then failed,
   and nobody noticed. Returns `503` after 26 hours without a successful run,
   which turns cron-job.org's failure email into the alarm. **This is the
   replacement for the workflow's SMTP alert.** Without it the feed can die
   silently.
3. **`GET /api/sauce/health`** — the same data, always `200`, for the teammate's
   app to read the `stale` flag from. Check it when a number looks wrong.

The host's own log stream is the fourth thing to reach for: every line of the
scrape is echoed there prefixed `[sync:daily]`, and the runner's own decisions
are prefixed `[trigger]`.

A failure never corrupts good data: a date that fails to extract is **skipped,
not loaded**, so the previous good figure for that day is left standing rather
than overwritten with an undercount. A partial Metabase result fails loudly
rather than loading quietly.

---

## 7. Manually re-running a specific date

POST the trigger route with a range in the body. Both fields must be set
together, the range is inclusive, and it is pulled newest-first:

```bash
curl -X POST https://<your-host>/api/internal/trigger-daily-sync \
  -H "Authorization: Bearer $DAILY_SYNC_TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"start_date":"2026-08-18","end_date":"2026-08-20"}'
```

Send no body at all for the normal window (yesterday plus the lookback days) —
identical to what the nightly cron does.

Locally, without the API:

```bash
DAILY_START_DATE=2026-08-20 DAILY_END_DATE=2026-08-20 npm run sync:daily
```

Re-running is always safe. The load is idempotent per `(store, date)`: it
deletes exactly that date and re-inserts, inside one transaction, leaving every
other date untouched.

`start_date`/`end_date` are validated against `^\d{4}-\d{2}-\d{2}$` before being
handed to the child process, because they reach it as environment variables.

A re-run competes with the nightly cron for the same lock — a `409` means one is
already in flight, so wait rather than retrying in a loop.

---

## 8. Ordering constraint (read before editing `src/daily/`)

`getBusinessDates()` returns dates **newest first**, and that is load-bearing.

The VM Hub filter bar is a date-**range** picker, and `extract.js`'s
`applyFilters()` always sets the START field before the END field. If a new
start lands *after* the end still sitting on the form, the range is momentarily
inverted: the start field's calendar popover then refuses to close and
permanently overlays the end-date input, so every later click in that browser
session times out. Retries don't help — they re-enter from the same wedged DOM.

Walking the dates **downwards** means each new start is always earlier than the
end already on the form. The reporting page's own default end date is today, so
the first hop into yesterday is safe too.

This was reproduced and fixed by ordering alone: ascending died on day 2 of 7,
descending completed 7/7 with zero retries. It is fixed **caller-side, in
`src/daily/config.js`** — which is what keeps `extract.js`, and therefore the
weekly sync, untouched.

---

## 9. Reconciliation record

Before any of this was built, the daily approach was checked against data the
weekly sync had already stored.

**Peckers Hitchin, week 2026-08-10 → 2026-08-16**, pulled as 7 single-day
windows (`start === end`) and summed:

| | |
|---|---|
| Sum of 7 single-day pulls | `11560.96` |
| Existing weekly rows in `vm_net_sales_by_channel` | `11560.96` |
| Difference | **`0.00` (0.0000%)** |

So `Net Sales by Channel` really is business-date based at day granularity, and
a one-day window is a legitimate slice of the same number the Executive
Dashboard reports.

Also confirmed at the same time:

- The CSV header carrying net sales is **`net_sales`** — the embed endpoint
  exports Metabase's *underlying* column names, not the display label
  `"Net Sales"`. Full header row: `week_commencing,channel,net_sales`.
- The report contains **no `~` aggregate rows** (`~Total`, `~All stores`,
  `~Average`) and has **no store column of its own**, so there is no `store_2`.
  The view still carries `NOT LIKE '~%'` guards in case VM Hub adds a roll-up
  row later.
