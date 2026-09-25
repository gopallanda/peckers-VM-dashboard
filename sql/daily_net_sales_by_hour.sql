-- ===========================================================================
-- daily_net_sales_by_hour.sql
-- ---------------------------
-- DAILY NET sales at HOUR grain, per store per business date.
--
-- Purely ADDITIVE. This file creates only NEW objects. It touches nothing the
-- weekly VM Analytics sync owns, and nothing the Sauce Management feed owns
-- (vm_daily_net_sales_raw / vm_v_daily_net_sales are NOT referenced here).
-- It must be safe to re-run at any time.
--
--   psql "$SUPABASE_DB_URL" -f sql/daily_net_sales_by_hour.sql
--
-- Apply AFTER sql/kpi_views.sql, which defines the vm_num() helper this file
-- depends on. vm_num() is NOT redefined here.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Vita Mojo net sales was imported at WEEK grain and at HOUR-OF-WEEK grain,
-- never at DAY grain. Two dashboards in peckers-cashflow need a per-day net
-- figure and neither could read one, so both ESTIMATED it: they took the
-- correct week total and split it across Mon-Sun using the shape of a
-- different, GROSS revenue column.
--
-- That is structurally wrong, not merely imprecise. The gross-to-net gap moves
-- with channel mix, so delivery-heavy days came out understated and walk-in
-- days overstated. Measured for Peckers Stevenage, week commencing 2026-09-14:
--
--   Day  VM Hub (truth)   Daypart heat map (estimated)   error
--   Wed        2,094.57                       2,118.86   +1.1%
--   Fri        3,530.51                       3,497.69   -1.0%
--
-- The week total was exactly right in both -- an apportionment always shares
-- out the correct total. Only the split was wrong. The full diagnosis is in
-- peckers-cashflow/docs/DAILY_NET_SALES_GAP.md.
--
-- ---------------------------------------------------------------------------
-- WHY ONE CHART SERVES BOTH GRAINS
-- ---------------------------------------------------------------------------
-- Probed before this table was designed (scripts/probe-daily-hourly.js,
-- Peckers Stevenage, single-day window, start === end):
--
--   2026-09-18   12 hour rows   sum = 3530.5100   VM Hub 3530.51   diff 0.00
--   2026-09-16   11 hour rows   sum = 2094.5717   VM Hub 2094.57   diff 0.00 @2dp
--
-- So the chart returns THAT DAY's hour buckets, and those buckets sum to the
-- day's net total. A second day-total chart would be redundant, which is why
-- vm_v_daily_net_sales_by_day below is a view over the same rows rather than a
-- separate extraction.
--
-- The residual sub-penny (2094.5717, not ...5700) is the known sixths-of-a-
-- penny artefact of item-level VAT removal: whole-pence gross / 1.2 = x 5/6,
-- and summing many such values preserves the sixths. It is NOT a rounding bug.
-- Reconcile days at 2dp; never at 4.
--
-- ---------------------------------------------------------------------------
-- WHY week_start CARRIES A *DAILY* BUSINESS DATE
-- ---------------------------------------------------------------------------
-- Identical to sql/daily_net_sales.sql, and for the identical reason.
-- src/daily/sync.js writes through the EXISTING loadStore(), which is
-- idempotent per (store, week_start): delete-then-insert inside one
-- transaction, scoped only to the dates in the current run. Setting
-- week_start = week_end = the business date buys that idempotency for free --
-- re-pulling a day replaces exactly that day and nothing else, with zero new
-- write code.
--
-- So in vm_daily_net_sales_by_hour_raw, `week_start` is a DAY, not a Monday.
-- That is deliberate. Do not "fix" it.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A SEPARATE TABLE FROM vm_daily_net_sales_raw
-- ---------------------------------------------------------------------------
-- Not tidiness -- correctness. loadStore() refreshes by (store, week_start) and
-- has NO chart dimension. Two charts writing one table for the same
-- (store, date) would delete each other's rows on every run, and whichever
-- loaded last would be the only survivor. One chart, one table. Always.
-- ===========================================================================


-- ===========================================================================
-- 1. RAW LANDING TABLE
-- ===========================================================================
-- Pre-created so this file can be applied BEFORE the first sync run (the views
-- below need the columns to exist). The shape mirrors exactly what load.js
-- ensureTable() would build: the five meta columns plus one TEXT column per CSV
-- header. loadStore() then runs CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS over the top, so both orders of operation converge.
--
-- CSV headers confirmed from the live embed export (Metabase returns its
-- UNDERLYING column names here, not the display labels). For 'Net Sales by
-- Hour' at a single-day window they are exactly:  hour, net_sales
--
-- Note there is NO week_commencing column on this chart -- unlike 'Net Sales by
-- Channel', which carries one and reports the containing MONDAY even for a
-- one-day window. Nothing here needs guarding against that trap, but do not
-- assume its absence if the chart is ever changed.
CREATE TABLE IF NOT EXISTS vm_daily_net_sales_by_hour_raw (
  id           BIGSERIAL PRIMARY KEY,
  store        TEXT,
  week_start   DATE,          -- the BUSINESS DATE (see header)
  week_end     DATE,          -- always equal to week_start
  source_file  TEXT,
  ingested_at  TIMESTAMPTZ DEFAULT now(),
  hour         TEXT,          -- trading hour, 0-23, as the CSV gives it
  net_sales    TEXT           -- ex-VAT, after discounts and refunds
);

-- Same index loadStore() creates; named identically so it is not duplicated.
CREATE INDEX IF NOT EXISTS vm_daily_net_sales_by_hour_raw_store_week_idx
  ON vm_daily_net_sales_by_hour_raw (store, week_start);


-- ===========================================================================
-- 2. HOUR-GRAIN VIEW  -- feeds the Daypart net heat map
-- ===========================================================================
-- One row per (store, business_date, hour). This is what replaces
-- buildNetHeatmap()'s apportionment: the heat map can GROUP BY business_date
-- and hour with both margins exact, instead of splitting each hour's weekly
-- total across Mon-Sun by a gross weekday shape.
--
-- store_slug, not the display name, is what consumers should key on: renaming a
-- store in VM Hub then cannot break them. The mapping is copied verbatim from
-- sql/daily_net_sales.sql so the two feeds always agree on a store's slug.
--
-- Aggregate-row guards: several VM reports embed roll-up rows ("~Total",
-- "~All stores", "~Average") which double-count if summed. This report was
-- checked across live single-day CSVs and carries none, but the '~%' guard is
-- kept because it costs nothing and covers VM Hub adding one later.
--
-- The `hour ~ '^[0-9]+$'` filter is the same defence in numeric form: a
-- non-numeric hour value is by definition not a trading hour, so it is a
-- roll-up row and must never reach a SUM.
CREATE OR REPLACE VIEW vm_v_daily_net_sales_by_hour AS
SELECT
  store,
  CASE
    WHEN lower(store) LIKE '%hitchin%'   THEN 'hitchin'
    WHEN lower(store) LIKE '%stevenage%' THEN 'stevenage'
    -- Fallback so a third store is exposed rather than silently dropped:
    -- "Peckers Foo Bar" -> "foo-bar".
    ELSE regexp_replace(
           lower(trim(regexp_replace(store, '^\s*peckers\s+', '', 'i'))),
           '[^a-z0-9]+', '-', 'g')
  END                                                AS store_slug,
  week_start                                         AS business_date,
  btrim(hour)::int                                   AS hour,
  ROUND(SUM(vm_num(net_sales)), 2)::numeric(14, 2)   AS net_sales,
  MAX(ingested_at)                                   AS last_synced_at
FROM vm_daily_net_sales_by_hour_raw
WHERE store IS NOT NULL
  AND week_start IS NOT NULL
  AND store NOT LIKE '~%'
  AND btrim(coalesce(hour, '')) ~ '^[0-9]+$'
GROUP BY store, week_start, btrim(hour)::int;


-- ===========================================================================
-- 3. DAY-GRAIN VIEW  -- feeds the Labour Cost weekday breakdown
-- ===========================================================================
-- One row per (store, business_date). This is the TRUE daily net sales figure
-- that did not exist anywhere before: getLabourWeekdayBreakdown() can read it
-- directly instead of computing (shapeShare / shapeTotal) * weekNet.
--
-- NAMING: this is net sales. The older vm_v_daily_net_sales serves GROSS
-- despite its name -- that view was repointed to the 'Gross Sales' chart on
-- 2026-08-22 for Sauce Management and its name was left alone rather than break
-- a live third-party route. The two are NOT interchangeable. If you want net,
-- this is the view.
--
-- Aggregated from the RAW table, deliberately NOT from the hour view above:
-- summing already-rounded hours would compound up to ~12 half-penny roundings
-- into the day total. Rounding once, at the end, keeps the day tied to VM Hub.
--
-- trading_hours is carried because it makes a bad pull obvious at a glance -- a
-- day that suddenly reports 3 trading hours instead of 11-12 was truncated, and
-- would otherwise just look like a quiet day.
CREATE OR REPLACE VIEW vm_v_daily_net_sales_by_day AS
SELECT
  store,
  CASE
    WHEN lower(store) LIKE '%hitchin%'   THEN 'hitchin'
    WHEN lower(store) LIKE '%stevenage%' THEN 'stevenage'
    ELSE regexp_replace(
           lower(trim(regexp_replace(store, '^\s*peckers\s+', '', 'i'))),
           '[^a-z0-9]+', '-', 'g')
  END                                                AS store_slug,
  week_start                                         AS business_date,
  ROUND(SUM(vm_num(net_sales)), 2)::numeric(14, 2)   AS net_sales,
  COUNT(*)                                           AS trading_hours,
  MAX(ingested_at)                                   AS last_synced_at
FROM vm_daily_net_sales_by_hour_raw
WHERE store IS NOT NULL
  AND week_start IS NOT NULL
  AND store NOT LIKE '~%'
  AND btrim(coalesce(hour, '')) ~ '^[0-9]+$'
GROUP BY store, week_start;


-- ===========================================================================
-- 4. GRANTS
-- ===========================================================================
-- The Cash-Flow app reads the VM Analytics project with its ANON key, matching
-- every other vm_v_* view. Without this the dashboard sees an empty result and
-- silently falls back to the estimated figures this whole feed exists to
-- replace -- so if the heat map still looks apportioned after a backfill, check
-- this grant first.
GRANT SELECT ON vm_v_daily_net_sales_by_hour TO anon, authenticated;
GRANT SELECT ON vm_v_daily_net_sales_by_day  TO anon, authenticated;
