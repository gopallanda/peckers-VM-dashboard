# Deploying the daily sales feed — the zero-cost path

How to get from "it works on my laptop" to "my teammate has a URL and the sync
runs itself every night", **for £0/month**.

Read `daily-net-sales.md` first for what the thing actually does. This file is
only about putting it on the internet.

---

## 0. The two things to understand before you start

**1. cron-job.org is a scheduler, not a host.** It sends an HTTP request on a
timer. That is all. It cannot run Node, it cannot run Playwright, and it cannot
serve an API.

**2. This repo does two jobs with opposite resource profiles.** That is the
whole reason the setup looks split:

| Job | Needs | Runs on |
|---|---|---|
| **Scrape** — `src/daily/sync.js` | Playwright + Chromium, ~1 GB RAM, Docker | GitHub Actions |
| **Serve** — `/api/sauce/*` | Express + `pg`, ~80 MB, no Docker | Render free tier |

Putting both on one box is the obvious design and it is what earlier versions
of this doc described. It cannot be done for free: Render's free and Starter
tiers are both 512 MB, Chromium needs ~1 GB, and the first Render plan that
fits is ~$25/mo. Splitting them costs nothing, because GitHub's runners already
install Chromium for free.

**Docker is only ever the scrape's problem.** Under the split topology you do
not use the `Dockerfile` at all — Render runs the native Node runtime.

---

## 1. The free stack

| Piece | Service | Free allowance | What you need |
|---|---|---|---|
| Database | Supabase | already yours | — |
| Scrape | GitHub Actions | 2,000 min/mo (private repo) | ~250 min/mo |
| API host | Render | 512 MB, 750 instance-hrs/mo | ~80 MB, ~730 hrs |
| Scheduler | cron-job.org | 50 jobs | 3 jobs |
| Alerting | cron-job.org email + Gmail SMTP | free | — |

---

## 2. Generate the two tokens

```bash
node -e "console.log('SAUCE_API_KEY='+require('crypto').randomBytes(32).toString('hex'));console.log('DAILY_SYNC_TRIGGER_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
```

- `SAUCE_API_KEY` → Render **and** your teammate's backend. Read-only sales.
- `DAILY_SYNC_TRIGGER_SECRET` → Render **and** cron-job.org. Reaches `/api/internal/*`.

Two **different** values. See the warning in `daily-net-sales.md` §3.

These are *shared secrets*: the same string lives in two places, because
`bearerGuard` compares what arrives against what is configured. Leaving
`SAUCE_API_KEY` off Render does not open the route — it makes every request
return **500**.

---

## 3. GitHub setup

### 3.1 Repo secrets

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `VM_HUB_EMAIL` | already set for the weekly sync |
| `VM_HUB_PASSWORD` | already set |
| `SUPABASE_DB_URL` | already set |
| `VM_AUTH_JSON` | optional, already set |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | your Gmail address |
| `SMTP_PASS` | a Gmail **app password**, not your login password |
| `ALERT_EMAIL_TO` | where failures go |

The five `SMTP_*`/`ALERT_*` ones are new — the daily workflow's failure step
needs them. Without them that step errors and a failed sync tells you nothing.

> Gmail app password: Google Account → Security → 2-Step Verification →
> App passwords. Requires 2FA to be on.

### 3.2 The dispatch token

Settings (your account, not the repo) → Developer settings → Personal access
tokens → **Fine-grained tokens** → Generate new token:

- **Repository access**: Only select repositories → this repo
- **Permissions** → Repository permissions → **Actions: Read and write**
- **Expiration**: 1 year (the maximum)

Copy it now — GitHub shows it once. It goes into cron-job.org only, never into
a repo secret and never onto Render.

> When it expires, cron-job.org job 1 starts returning `401` and emails you.
> That is by design, but put a calendar reminder in anyway.

---

## 4. Apply the SQL (once)

```bash
psql "$SUPABASE_DB_URL" -f sql/daily_net_sales.sql
```

Safe to re-run. Must run **after** `sql/kpi_views.sql`, which defines the
`vm_num()` helper it depends on.

---

## 5. Render setup

1. Sign up at <https://render.com> with your GitHub account.
2. Dashboard → **New +** → **Web Service**.
3. Connect the repository. Grant Render access to it if prompted.
4. Configure:

| Field | Value |
|---|---|
| Name | `peckers-sales-api` (becomes `peckers-sales-api.onrender.com`) |
| Language / Runtime | **Node** — *not* Docker |
| Branch | `main` |
| Build command | `npm ci` |
| Start command | `node server.js` |
| Instance type | **Free** |

> **Do not pick Docker.** The `Dockerfile` in this repo builds the 1.5 GB
> Playwright image for the scrape. On the free tier it will not fit.

5. **Environment variables** — Advanced → Add Environment Variable:

```
SUPABASE_DB_URL=<your session-pooler URI>
SAUCE_API_KEY=<from step 2>
DAILY_SYNC_TRIGGER_SECRET=<from step 2>
PUBLIC_DEPLOY=1
SCRAPE_ENABLED=0
API_HOST=0.0.0.0
TZ=Europe/London
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

Do **not** set `API_PORT`. Render injects `PORT` and `server.js` prefers it.

Why each of the two unusual ones:

- `PUBLIC_DEPLOY=1` — closes `/api/stores`, `/api/weeks` and `/api/kpis/*`,
  which have no authentication at all. **Verified in step 6.**
- `SCRAPE_ENABLED=0` — this host has no Chromium. Without the flag, a POST to
  the trigger route would spawn a child that fails and write a bogus `'failed'`
  row into the run ledger, making the health-check alarm on a healthy feed.

6. **Create Web Service**. First build takes 2–4 minutes. Copy the URL.

---

## 6. Verify the deploy — before you hand out any key

Replace `<host>` and the tokens throughout.

**The security check. This one matters most:**

```bash
curl -i https://<host>/api/stores
```

Expect **404**. If it returns store data, `PUBLIC_DEPLOY` did not take, and
every store's revenue, margin and labour KPIs are public. Stop and fix it.

**Auth is live:**

```bash
curl -i "https://<host>/api/sauce/daily-net-sales?store=hitchin&date=2026-08-21"
```

Expect **401** (no token sent).

**The feed answers:**

```bash
curl -s -H "Authorization: Bearer $SAUCE_API_KEY" "https://<host>/api/sauce/health"
```

Expect **200** and a JSON body with a `stale` field. Right after a fresh deploy
with no sync yet, `stale` will be `true` — that is correct.

**The keep-alive route:**

```bash
curl -s https://<host>/api/health
```

Expect `{"status":"ok"}` with no token.

**The trigger is correctly disabled:**

```bash
curl -i -X POST -H "Authorization: Bearer $DAILY_SYNC_TRIGGER_SECRET" "https://<host>/api/internal/trigger-daily-sync"
```

Expect **501** with `this host does not run the scrape`. A 202 here means
`SCRAPE_ENABLED=0` did not take.

---

## 7. Test the scrape before wiring the scheduler

GitHub → **Actions** → *Daily VM Hub → Supabase Net Sales* → **Run workflow** →
leave the date inputs blank → **Run workflow**.

Watch it. It takes 5–8 minutes. Then:

```bash
curl -s -H "Authorization: Bearer $SAUCE_API_KEY" "https://<host>/api/sauce/health"
```

`stale` should now be `false` and `last_successful_run_at` should be minutes
old. Then fetch a real figure — use yesterday's date:

```bash
curl -s -H "Authorization: Bearer $SAUCE_API_KEY" "https://<host>/api/sauce/daily-net-sales?store=hitchin&date=2026-08-21"
```

Expect a `gross_sales` number. **Sanity-check it against VM Hub before you tell
your teammate the feed is live.**

Now test the dispatch API by hand, exactly as cron-job.org will call it:

```bash
curl -i -X POST -H "Authorization: Bearer $GH_PAT" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -d '{"ref":"main"}' https://api.github.com/repos/<owner>/<repo>/actions/workflows/daily-net-sales.yml/dispatches
```

Expect **204 No Content** and a new run appearing in the Actions tab. If you
get 404, the PAT lacks Actions write or is scoped to the wrong repo — GitHub
returns 404 rather than 403 for permission failures on private repos.

---

## 8. cron-job.org setup

Sign up at <https://cron-job.org>. Create **three** jobs. Headers go under the
job's **Advanced** tab.

### Job 1 — nightly trigger

| Field | Value |
|---|---|
| Title | `Peckers daily sales sync` |
| URL | `https://api.github.com/repos/<owner>/<repo>/actions/workflows/daily-net-sales.yml/dispatches` |
| Method | `POST` |
| Headers | `Authorization: Bearer <PAT>`<br>`Accept: application/vnd.github+json`<br>`X-GitHub-Api-Version: 2022-11-28`<br>`Content-Type: application/json` |
| Request body | `{"ref":"main"}` |
| Schedule | every day at **00:30** |
| Timezone | `Europe/London` |
| Notify on failure | **on** |

Expected response `204`.

### Job 2 — keep-alive

| Field | Value |
|---|---|
| Title | `Peckers API keep-alive` |
| URL | `https://<host>/api/health` |
| Method | `GET` |
| Headers | none |
| Schedule | every **10 minutes** |
| Notify on failure | **off** |

Render's free tier sleeps after 15 minutes idle and takes ~50s to wake. Without
this, every one of your teammate's daily requests hits a cold start.

Budget: 730 hours a month against Render's 750 free instance-hours. It fits —
but it means this can be your **only** free Render service.

### Job 3 — staleness alarm

| Field | Value |
|---|---|
| Title | `Peckers daily sales — stale check` |
| URL | `https://<host>/api/internal/health-check` |
| Method | `GET` |
| Headers | `Authorization: Bearer <DAILY_SYNC_TRIGGER_SECRET>` |
| Schedule | hourly |
| Timezone | `Europe/London` |
| Notify on failure | **on** |

Returns `503` when nothing has succeeded in 26 hours. This is the only thing
that catches a run that **never started** — the workflow's SMTP alert can only
fire for a run that started and then failed, and job 1 sees nothing but a `204`.

Use **"Run now"** on job 1 once and confirm the history shows `204`.

---

## 9. What to send your teammate

Send the API key over a password manager share, not email or Slack.

> **Peckers daily sales API**
>
> Base URL: `https://<host>`
> Auth: `Authorization: Bearer <SAUCE_API_KEY>` on every request
>
> **One day:**
> `GET /api/sauce/daily-net-sales?store=hitchin&date=2026-08-21`
>
> ```json
> {
>   "store": "hitchin",
>   "store_name": "Peckers Hitchin",
>   "business_date": "2026-08-21",
>   "gross_sales": 2683.63,
>   "currency": "GBP",
>   "last_synced_at": "2026-08-22T07:34:28.805Z"
> }
> ```
>
> **A range:**
> `GET /api/sauce/daily-net-sales?store=hitchin&from=2026-08-01&to=2026-08-21`
> Returns `data` (an array) plus `missing_dates`.
>
> **Feed status:** `GET /api/sauce/health` → always `200`; read the `stale` flag.
>
> **Things to know:**
> - **Server-to-server only.** The key goes in your backend's environment
>   variables. Never in browser JavaScript or a mobile app — anyone could read
>   it from view-source. Your page calls your backend; your backend calls us.
> - `store` is a slug — `hitchin` or `stevenage` — never the display name.
> - Data lands each night by about 00:40 UK time.
> - **A missing day returns `404`, never `0`.** Do not treat a 404 as zero
>   sales. The 404 body uses `reason` (not `error`) and carries
>   `last_synced_at` and `latest_business_date` so you can tell "no trade that
>   day" from "the feed is behind". Branch on the status code, not the body.
> - `missing_dates` on a range response names every gap. Check it before
>   totalling a range, or you will report a number that is too low.
> - The figure is **gross sales** — VAT-inclusive, before discounts and refunds
>   — despite the `net-sales` in the URL. The path name is legacy.
> - **Figures for the last 3 days can still change.** Delivery platforms settle
>   late and we re-pull D-1 to D-3 every night so corrections self-heal. If you
>   cache, re-fetch a rolling 3-day window rather than just yesterday.
> - Please poll once a day after ~00:45 UK, not on a tight loop.

---

## 10. If you ever outgrow free

The all-in-one topology — one Docker host running both the scrape and the API —
is still fully supported by the code. On a box with ≥1 GB RAM (Hetzner CX22
~£4/mo, or Oracle Cloud Always Free):

- build the `Dockerfile`, which is the Playwright image
- set `SCRAPE_ENABLED=1` (or leave it unset) and add `VM_HUB_EMAIL`,
  `VM_HUB_PASSWORD`, `STORES`, `HEADLESS=1`
- point cron-job.org job 1 at `POST /api/internal/trigger-daily-sync` with
  `Authorization: Bearer <DAILY_SYNC_TRIGGER_SECRET>`, expecting `202`
- drop the GitHub PAT and the keep-alive job

**Do not run both trigger paths at once.** Two scrapes at 00:30 would collide
over the same VM Hub session.

---

## 11. After it's live

- **Rotating the teammate's key:** change `SAUCE_API_KEY` on Render, restart,
  send them the new value. Nothing else is affected.
- **The weekly sync is untouched.** It still runs on `sync.yml` at 01:30 UTC
  Mondays. The daily run's 20-minute cap exists to guarantee it has finished
  before then.
- **Supabase free projects pause after ~7 days of inactivity.** The nightly
  writes prevent this — but note the compounding failure: ignore the staleness
  alarm for a week and the database pauses, taking the API down too.
- **Re-running a specific date:** Actions → Run workflow, and fill in
  `start_date` and `end_date`. Safe: the load is idempotent per `(store, date)`.
