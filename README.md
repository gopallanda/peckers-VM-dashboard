# vm-extractor

Headless sync of **Vita Mojo (VM Hub) MP1 reporting** into **Supabase (Postgres)**
for the Pickers restaurant business (two stores: **Peckers Hitchin** and
**Peckers Stevenage**).

It logs in to VM Hub **once** (you do the login + MFA by hand), saves the
session, then on every scheduled run reuses that session, opens **only** the
`/mp1-reporting` page, and for each whitelisted report × store × week:

1. selects the report in the Metabase **iframe**,
2. sets **Interval = Weekly**, the **date range**, and a **single store**,
3. waits for the query to finish,
4. captures the data via **CSV export** (falling back to reading the table),
5. writes it into a `vm_*` table in Supabase (full-refresh per store).

SQL views (`sql/kpi_views.sql`) turn those tables into the 8 executive KPIs.

---

## Why a headless browser

The report is an embedded, cross-origin **Metabase iframe**. A headless
Playwright browser can reach into it with frame locators (`page.frameLocator`),
type into its inputs, wait for the query network call, and read the result —
things the live interactive tooling can't do because keystrokes don't cross the
iframe boundary there.

There are **two whitelists**:

- **Report whitelist** (`REPORTS` in `src/config.js`) — only 3 of VM Hub's ~171
  reports are synced.
- **Navigation whitelist** (`NAV` in `src/config.js`) — the browser may only
  open `/mp1-reporting`. A hard nav guard aborts any document navigation to
  another VM Hub module (Stores, Users, Analytics, …) so it can never disrupt
  live ordering.

---

## What gets synced

| Chart name (typed exactly into the Chart dropdown)      | Table                      | Feeds                                                              |
| ------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `Net Sales by Channel`                                  | `vm_net_sales_by_channel`  | Net Sales, Delivery/Collection/Eat-In %, WoW, delivery sub-channels |
| `Number of Orders by channel (fulfilment date)`         | `vm_orders_by_channel`     | Number of Orders, AOV                                             |
| `New vs return customer metrics`                        | `vm_customer_metrics`      | Customer Count                                                    |

All three are per-store reports, so we pull **once per store** by setting the
Stores filter to a single store each time. Every row carries a `store` column
plus `week_start`, `week_end`, `source_file`, `ingested_at`.

### The 8 KPIs

Net Sales · Number of Orders · AOV (Net Sales ÷ Orders) · Customer Count ·
Delivery Sales % · Collection Sales % · Eat-In Sales % · Week-on-Week Growth %.

Channel → fulfilment bucket mapping is centralised in **two** places (keep in
sync): `CHANNEL_BUCKET` in `src/config.js` and `vm_bucket()` in
`sql/kpi_views.sql`.

- Eat In → `eat_in`
- Take-away / Collection / Click & Collect → `collection`
- Delivery / Own-delivery / Uber Eats / Deliveroo / Just Eat → `delivery`

---

## Setup & first run

```bash
cd vm-extractor
npm install && npx playwright install chromium

cp .env.example .env
#   then edit .env:
#   - VM_HUB_PASSWORD (optional convenience; only used by `npm run auth`)
#   - SUPABASE_DB_URL (Supabase > Project Settings > Database > Connection
#       string > URI — fill <region> and the DB password)
#   - START_DATE / END_DATE for the first one-off (e.g. 2026-06-01 / 2026-06-07)

npm run auth      # opens a HEADED browser — log in + complete MFA yourself,
                  # then press ENTER in the terminal to save auth.json

npm run sync      # headless: pulls the window for BOTH stores, loads vm_ tables

psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql   # (re)create the KPI views
```

Then query, e.g.:

```sql
SELECT * FROM vm_v_exec_weekly ORDER BY store, week_start;
SELECT * FROM vm_v_exec_wow    ORDER BY store, week_start;
SELECT * FROM vm_v_reconciliation_latest;   -- compare against VM Hub on screen
```

### Date window

- Default: the last **`WEEKS_BACK`** complete **Mon–Sun** weeks (default 4).
- Override: set **both** `START_DATE` and `END_DATE` (`YYYY-MM-DD`) — they win.
- Week-on-Week needs **≥ 2** weeks in the window.

---

## Confirm-on-first-run selectors

Some selectors live inside the Metabase iframe and can't be guaranteed without
the live DOM. They're best-effort and marked `TODO(confirm-on-first-run)` in the
code. To confirm/adjust them, run headed with screenshots:

```bash
HEADLESS=0 DEBUG_SHOTS=1 npm run sync
```

Screenshots land in `./debug`. The two most likely to need a tweak:

- **The CSV export button** (`captureViaCsv` in `src/extract.js`) — bottom-right
  download icon of the result table.
- **The login form** (`src/auth.js`, `assertLoggedIn` in `src/extract.js`).

Other iframe controls to verify if a run misbehaves: the Chart / Interval /
Stores react-select widgets and the Start/End date inputs
(`controlByLabel`, `chooseReactSelect`, `selectSingleStore`, `setDate`).

After the first sync, also confirm the real CSV column names and adjust the
`TODO(confirm-on-first-run)` references in `sql/kpi_views.sql`:

```bash
psql "$SUPABASE_DB_URL" -c '\d vm_net_sales_by_channel'
psql "$SUPABASE_DB_URL" -c '\d vm_orders_by_channel'
psql "$SUPABASE_DB_URL" -c '\d vm_customer_metrics'
```

The loader stores every column as `TEXT`; numeric casting happens in the views
(`vm_num()`), so adjusting a column name is a one-line edit.

---

## How the data load works

- **Dynamic schema:** the loader reads the CSV header and creates one `TEXT`
  column per CSV column (+ metadata columns). New columns are added with
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so it tolerates VM Hub renaming or
  adding columns.
- **Idempotent / full-refresh per store:** each run deletes the store's existing
  rows in a table, then inserts the freshly captured weeks, inside a
  transaction. Re-running is safe.
- All writes go through `SUPABASE_DB_URL` with `pg`. The **publishable API key
  cannot create tables or insert** and is never used for writes.

---

## Robustness

- Each report extraction is retried up to **3×** with exponential backoff.
- A **run summary** prints per report/store (rows loaded, ok / partial /
  failed).
- The process **exits non-zero** if anything failed (so CI marks the run red).

---

## Scheduling (GitHub Actions)

`.github/workflows/sync.yml` runs **Mondays 04:00 UTC** and on manual dispatch.

Required repository **secrets**:

| Secret            | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `VM_AUTH_JSON`    | Contents of your locally generated `auth.json` (the saved session) |
| `SUPABASE_DB_URL` | The Supabase Postgres connection string                           |
| `VM_HUB_URL`      | `https://hub.vitamojo.com`                                         |
| `VM_HUB_EMAIL`    | The VM Hub login email                                            |
| `STORES`          | `Peckers Hitchin,Peckers Stevenage`                               |

Create `VM_AUTH_JSON` from your saved session:

```bash
# after `npm run auth`
gh secret set VM_AUTH_JSON < vm-extractor/auth.json
```

The manual-dispatch form also accepts `start_date`, `end_date`, `weeks_back`.

### Session expiry

The saved session **expires**, and if MFA is enforced, unattended runs will
eventually fail on a login page (the sync detects this and exits with a clear
message). When that happens, re-run `npm run auth` locally and refresh the
`VM_AUTH_JSON` secret.

The durable alternative that removes the browser entirely is the official
**Vita Mojo Reporting API v2** — request access from your account manager. With
it, `src/extract.js` can be swapped for plain HTTP calls and the session/MFA
problem disappears.

---

## File structure

```
vm-extractor/
  package.json
  .env.example
  .gitignore
  src/
    config.js     # whitelist (REPORTS), STORES, date logic, channel map, nav guard config
    auth.js       # one-time headed login -> auth.json
    extract.js    # Playwright: iframe, select report, set Weekly/date/store, CSV export; nav guard
    load.js       # pg: dynamic table creation + full-refresh-per-store insert
    index.js      # orchestrator: loop reports x stores x weeks, retry, summary
  sql/
    kpi_views.sql # 8 KPIs + week-on-week + delivery sub-channel + reconciliation views
  .github/workflows/sync.yml
  README.md
```

`.env`, `auth.json`, `downloads/`, and `debug/` are git-ignored — never commit
secrets or the saved session.
