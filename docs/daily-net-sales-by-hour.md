# Daily net sales, at hour grain

**Added:** 2026-09-24
**Entry point:** `npm run sync:daily` (same command as before — this is a second
chart inside the existing daily pipeline, not a new pipeline)

Read `daily-net-sales.md` first for how the daily sync works. This file covers
only what was added on top of it.

---

## 1. The problem this closes

Vita Mojo net sales was imported at **week** grain and at **hour-of-week** grain,
never at **day** grain. Two screens in `peckers-cashflow` need a per-day net
figure and neither could read one, so both **estimated** it: take the week's
correct net total, split it across Mon–Sun using the shape of a different,
**gross** revenue column.

That is structurally wrong, not just imprecise. The gross-to-net gap moves with
channel mix — Friday carries Deliveroo/Uber commission, Wednesday is mostly
walk-ins — so the split was biased, not noisy. Peckers Stevenage, week
commencing 2026-09-14:

| | Mon | Tue | Wed | Thu | Fri | Sat | Sun | Week |
|---|---|---|---|---|---|---|---|---|
| VM Hub (truth) | 1,481.78 | 1,536.79 | 2,094.57 | 1,800.92 | 3,530.51 | 3,638.64 | 2,583.70 | 16,666.91 |
| Daypart heat map (estimated) | 1,489.90 | 1,544.70 | 2,118.86 | 1,802.58 | 3,497.69 | 3,631.33 | 2,581.84 | 16,666.90 |
| error | +8.12 | +7.91 | **+24.29** | +1.66 | **−32.82** | −7.31 | −1.86 | **0.00** |

The week total was exactly right in both — an apportionment always shares out
the correct total. Only the split was wrong, which is why this hid for so long.

Full diagnosis: `peckers-cashflow/docs/DAILY_NET_SALES_GAP.md`.

---

## 2. What was added

One chart, pulled one business date at a time, into its own table.

| | |
|---|---|
| Chart | `Net Sales by Hour` (VM Hub dropdown text, exact) |
| Table | `vm_daily_net_sales_by_hour_raw` |
| Views | `vm_v_daily_net_sales_by_hour`, `vm_v_daily_net_sales_by_day` |
| SQL | `sql/daily_net_sales_by_hour.sql` |
| Config | `src/daily/config.js` → `ALL_DAILY_REPORTS[1]` |

CSV columns are exactly `hour, net_sales`. `week_start` and `week_end` both
carry the **business date** — the same deliberate trick the Sauce feed uses, so
`loadStore()`'s delete-then-insert per `(store, week_start)` gives idempotency
per day for free. **Do not "fix" it.**

### One chart, both grains

A single-day window returns that day's hour buckets, and those buckets sum to
the day's net total. Verified with `scripts/probe-daily-hourly.js` before any of
this was built:

| Date | rows | sum of hours | VM Hub | diff |
|---|---|---|---|---|
| 2026-09-18 | 12 | 3530.5100 | 3,530.51 | 0.00 |
| 2026-09-16 | 11 | 2094.5717 | 2,094.57 | 0.00 @2dp |

So `vm_v_daily_net_sales_by_day` is a **view over the same rows**, not a second
extraction. An earlier plan called for a separate `Net Sales by Channel` daily
pull for day totals; the probe made it redundant and it was dropped, halving
both the backfill and the nightly cost.

The residual sub-penny (`2094.5717`, not `...5700`) is the sixths-of-a-penny
artefact of item-level VAT removal (whole-pence gross ÷ 1.2 = × 5⁄6). **Compare
days at 2dp, never at 4.**

---

## 3. What did NOT change

This was the binding constraint on the whole change, so it is worth stating
explicitly:

- **The weekly sync.** Untouched. `src/config.js`, `src/extract.js`,
  `src/load.js` and `src/index.js` have no changes at all.
- **The Sauce Management feed.** `vm_daily_net_sales_raw`,
  `vm_v_daily_net_sales`, `/api/sauce/*` and `src/live/intraday-gross.js` are
  not referenced by any new object. The `Gross Sales` chart still runs first,
  every night, exactly as before.
- **`getBusinessDates()`.** Signature and return shape unchanged — the workflow
  calls it directly at `daily-net-sales.yml:122`.
- **`vm_net_sales_by_hour`** (the weekly hour-of-week table) still syncs and is
  still the fallback. Nothing was deleted.

### The health signal is deliberately scoped

`vm_daily_sync_runs.status` is what `/api/sauce/health` turns into a staleness
alarm for a third party. It is now computed from **critical** charts only
(`critical: true` in `ALL_DAILY_REPORTS`).

A failing `Net Sales by Hour` pull still:
- prints in the run summary,
- lands in the ledger's `error` text,
- exits non-zero, turning the workflow red and firing the SMTP alert.

What it does **not** do is tell Sauce Management that their own perfectly-good
feed has gone stale.

And a run that selects **no** critical chart — any backfill — writes no ledger
row at all, so a backfill cannot reset the staleness clock either.

---

## 4. Loop order is load-bearing

`date (newest-first) → chart → store`. All three levels matter:

- **Dates outermost and descending** — `applyFilters()` sets the start field
  before the end field, so a start landing after the end still on the form
  inverts the range, wedges the calendar popover and kills the browser session
  for every subsequent pull. This was reproduced: ascending died on day 2 of 7,
  descending completed 7/7.
- **Chart must not be outermost** — it would walk the dates down for chart 1,
  then jump from the oldest date back up to the newest to begin chart 2. That is
  precisely the inversion above.
- **Chart above store** — `selectChart()` short-circuits when the dropdown
  already shows the wanted chart, so both stores pull under one chart switch
  instead of three.

---

## 5. Running it

### Nightly
Nothing to do. `npm run sync:daily` now pulls both charts for D-1/D-2/D-3.
Roughly 6 extra browser pulls per night.

### Backfill
```bash
DAILY_CHARTS="Net Sales by Hour" \
DAILY_START_DATE=2026-08-01 DAILY_END_DATE=2026-08-31 \
npm run sync:daily
```

**Run backfills locally, a month at a time.** Both scheduled paths cap a run at
20 minutes — `daily-net-sales.yml` via `timeout-minutes`, and the HTTP trigger
via `DAILY_SYNC_TIMEOUT_MS` — and a multi-month backfill will be killed by both.
Locally there is no cap and no Actions minutes are spent. Chunking by month also
means a wedged session costs one month, not the whole backfill.

`DAILY_CHARTS` is mandatory here. Without it the backfill would also re-pull
`Gross Sales` for every historical day and rewrite the table the live Sauce feed
reads.

### Kill switch
```bash
DAILY_CHARTS="Gross Sales"
```
Restores exactly the pre-2026-09-24 nightly behaviour with an env change and no
deploy.

### Reconciling
```bash
node scripts/reconcile-daily-hourly.js --days
```
Sums the daily rows per Mon–Sun week and compares against `vm_net_sales_by_hour`
— a source that was already proven exact at week grain. Tolerance is 5p per
week, covering seven 2dp roundings. Pass explicit `YYYY-MM-DD` week starts to
narrow it.

---

## 5a. The backfill that was actually run (2026-09-24)

`2026-03-02 .. 2026-09-23`, both stores, 8 monthly chunks, ~400 browser pulls.

**Result:** 206 days per store, no gaps. All **56** complete store-weeks
reconcile against `vm_net_sales_by_hour` within 1-2p. Neither
`vm_daily_sync_runs` nor `vm_daily_net_sales_raw` was touched, confirming the
two isolation guarantees in §3 under real load rather than in theory.

### One chunk stalled, and it will happen again

The July chunk captured 4 days and then **hung for 99 minutes** — process alive,
~0.09 CPU-seconds per 20s, no new CSV written. It had to be killed by hand; it
was not going to recover.

What is known: it was blocked on I/O somewhere in the filter/wait path after a
successful pull. What it is **not**: `captureViaCsv` passes
`timeout: 120000` to its request, so the CSV fetch is not the unbounded wait.
The exact cause was not isolated. If you go looking, run with `DEBUG_SHOTS=1`
and compare the last `_filters` screenshot against a healthy one.

Consequences worth holding on to:

- **Chunk the backfill.** This is why. One month was lost, not the whole run.
  Because `loadStore()` only writes once every date in a chunk is captured, a
  killed chunk writes *nothing* — so the loss is the whole chunk, and smaller
  chunks are cheaper. The retry used half-months and both halves passed.
- **A stalled run needs a human.** `withRetry` never fired, so nothing in the
  script noticed. Locally there is no timeout at all; in CI the workflow's
  `timeout-minutes: 20` is what kills it, which is a concrete reason not to
  raise that value casually.
- **Nothing needed cleaning up.** The load is idempotent per `(store, date)`, so
  the retry just filled the gap.
- **Watch for INCOMPLETE, not just MISMATCH.** While July was missing, the
  reconciler compared 2-day weeks against full week totals. Partial weeks are
  now reported as `INCOMPLETE (n/7 days)` and excluded from the failure count —
  a partial week can never tie, and treating it as a mismatch hides real ones.

---

## 6. Handoff to the dashboard repo

Both consumers live in `peckers-cashflow` and both read VM with the **anon**
key, which is why `sql/daily_net_sales_by_hour.sql` grants `SELECT` to `anon`.
If the heat map still looks apportioned after a backfill, check that grant
first.

| Consumer | Today | After |
|---|---|---|
| `buildNetHeatmap()` | splits each hour's weekly net across Mon–Sun by a gross weekday shape | `GROUP BY business_date, hour` on `vm_v_daily_net_sales_by_hour` — both margins exact |
| `getLabourWeekdayBreakdown()` | `(shapeShare / shapeTotal) * weekNet` | read `vm_v_daily_net_sales_by_day.net_sales` directly |

Keep `vm_v_daypart_weekday` and the gross columns as a fallback — delete
nothing. The "derived / indicative" caveats in the UI copy can come out only for
dates the backfill actually covers.

**Still unchecked:** whether any *other* week-grained net source in
`lib/vm-analytics/queries.ts` is being apportioned the same way. Sweep it before
calling this closed.

**Landmine, unrelated but adjacent:** `vm_v_daypart_weekday.aov` is **gross**
AOV (~15% overstated). No page renders it today. Do not wire it up without
converting.
