-- ===========================================================================
-- daily_net_sales.sql
-- -------------------
-- Daily sales feed for the Sauce Management integration.
--
-- Purely ADDITIVE. This file creates only NEW objects and touches nothing the
-- weekly VM Analytics sync owns. It must be safe to re-run at any time.
--
--   psql "$SUPABASE_DB_URL" -f sql/daily_net_sales.sql
--
-- Apply AFTER sql/kpi_views.sql, which defines the vm_num() helper this file
-- depends on. vm_num() is NOT redefined here.
--
-- ---------------------------------------------------------------------------
-- 2026-08-22: PIVOTED FROM NET SALES TO GROSS SALES
-- ---------------------------------------------------------------------------
-- src/daily/config.js's DAILY_REPORT.chart was changed from 'Net Sales by
-- Channel' to 'Gross Sales'. That chart's CSV has a different shape --
-- `week_commencing, gross_sales` (no `channel` column) instead of
-- `week_commencing, channel, net_sales` -- so vm_daily_net_sales_raw.net_sales
-- and .channel are NULL for every row captured under the new chart, and a new
-- gross_sales column carries the real numbers.
--
-- The view below now aggregates gross_sales, not net_sales. Gross sales is
-- VAT-inclusive and BEFORE discounts/refunds -- a materially different number
-- from net sales, and NOT the figure the Phase-0 reconciliation in section
-- "RECONCILIATION" below validated. If that reconciliation matters for Gross
-- Sales too, redo it before trusting this feed for anything financial.
--
-- Object and file names still say "net_sales" (table, view, this file, the
-- API route /api/sauce/daily-net-sales) -- renaming every one of those was
-- judged not worth the churn for a same-day pivot. Treat "net_sales" in those
-- names as legacy/historical, not as a description of what the data now is.
-- Old rows synced before this pivot still have real values in `net_sales` and
-- NULL in `gross_sales`; the view will show no figure for those dates unless
-- they are re-synced under the new chart.
--
-- ---------------------------------------------------------------------------
-- WHY week_start CARRIES A *DAILY* BUSINESS DATE
-- ---------------------------------------------------------------------------
-- src/daily/sync.js writes through the EXISTING loadStore(), which is
-- idempotent per (store, week_start): delete-then-insert inside one
-- transaction, scoped only to the dates in the current run. Setting
-- week_start = week_end = the business date buys that idempotency for free --
-- re-pulling a day (late delivery-platform settlement, a missed cron) replaces
-- exactly that day and nothing else, with zero new write code and zero risk to
-- the weekly tables.
--
-- So in vm_daily_net_sales_raw, `week_start` is a DAY, not a Monday. That is
-- deliberate. Do not "fix" it.
--
-- ---------------------------------------------------------------------------
-- WHY THE VIEW IGNORES THE CSV'S OWN `week_commencing` COLUMN
-- ---------------------------------------------------------------------------
-- Verified against 7 single-day pulls (10-16 Aug 2026, Peckers Hitchin): the
-- "Net Sales by Channel" CSV always reports `week_commencing` as the MONDAY of
-- the containing week, even when the filter window is one single day. Every one
-- of those 7 days came back as 2026-08-10. Grouping on it would collapse all
-- lookback days onto one date and silently triple-count. The business date is
-- the meta `week_start` the sync sets, and only that.
--
-- ---------------------------------------------------------------------------
-- RECONCILIATION (the basis for using this chart at all)
-- ---------------------------------------------------------------------------
-- Peckers Hitchin, week 2026-08-10..2026-08-16:
--   sum of 7 single-day pulls = 11560.96
--   existing weekly rows      = 11560.96   (difference 0.00)
-- The chart is business-date based at day granularity, so a daily window is a
-- legitimate slice of the same number the Executive Dashboard shows.
-- ===========================================================================


-- ===========================================================================
-- 1. RAW LANDING TABLE
-- ===========================================================================
-- Pre-created so this file can be applied BEFORE the first sync run (the view
-- below needs the columns to exist). The shape mirrors exactly what
-- load.js ensureTable() would build: the five meta columns plus one TEXT column
-- per CSV header. loadStore() then runs CREATE TABLE IF NOT EXISTS / ADD COLUMN
-- IF NOT EXISTS over the top, so both orders of operation converge.
--
-- CSV headers confirmed from the live embed export (Metabase returns its
-- UNDERLYING column names here, not the display labels):
--   'Net Sales by Channel' (pre-2026-08-22): week_commencing, channel, net_sales
--   'Gross Sales'          (current)       : week_commencing, gross_sales
-- Both column sets are kept side by side so historical net_sales rows are not
-- lost; only one of net_sales / gross_sales is populated per row, depending on
-- which chart was live when that row was synced.
CREATE TABLE IF NOT EXISTS vm_daily_net_sales_raw (
  id               BIGSERIAL PRIMARY KEY,
  store            TEXT,
  week_start       DATE,          -- the BUSINESS DATE (see header)
  week_end         DATE,          -- always equal to week_start
  source_file      TEXT,
  ingested_at      TIMESTAMPTZ DEFAULT now(),
  week_commencing  TEXT,          -- Monday of the containing week -- NOT usable
  channel          TEXT,          -- only populated under the old 'Net Sales by Channel' chart
  net_sales        TEXT,          -- only populated under the old 'Net Sales by Channel' chart
  gross_sales      TEXT           -- populated under the current 'Gross Sales' chart
);

-- Re-run target for environments where the table pre-dates the Gross Sales
-- pivot: loadStore() already adds this column dynamically on the next sync,
-- but this makes a bare `psql -f` apply (before any sync has run) converge to
-- the same schema too.
ALTER TABLE vm_daily_net_sales_raw ADD COLUMN IF NOT EXISTS gross_sales TEXT;

-- Same index loadStore() creates; named identically so it is not duplicated.
CREATE INDEX IF NOT EXISTS vm_daily_net_sales_raw_store_week_idx
  ON vm_daily_net_sales_raw (store, week_start);


-- ===========================================================================
-- 2. RUN LEDGER
-- ===========================================================================
-- One row per daily sync run. Its purpose is to tell apart two states the raw
-- table cannot distinguish on its own:
--     "the store genuinely sold nothing that day"   (run ok, no rows)
--     "the sync never ran / failed"                 (no run row, or status<>'ok')
-- /api/sauce/health reads the latest row to decide whether the feed is stale.
CREATE TABLE IF NOT EXISTS vm_daily_sync_runs (
  id             BIGSERIAL PRIMARY KEY,
  business_dates TEXT[],          -- ISO dates attempted, e.g. {2026-08-20,2026-08-19}
  status         TEXT,            -- 'running' | 'ok' | 'partial' | 'failed'
  rows_loaded    INT,
  error          TEXT,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);

-- The health endpoint always wants the most recent run, and the most recent
-- SUCCESSFUL run; both are covered by ordering on started_at.
CREATE INDEX IF NOT EXISTS vm_daily_sync_runs_started_idx
  ON vm_daily_sync_runs (started_at DESC);


-- ===========================================================================
-- 3. THE CONSUMER-FACING VIEW
-- ===========================================================================
-- One row per (store, business_date). This is the ONLY object
-- /api/sauce/daily-net-sales reads.
--
-- store_slug, not the display name, is what the API exposes: renaming a store
-- in VM Hub then cannot break the Sauce Management consumer.
--
-- Aggregate-row guards: several VM reports embed roll-up rows ("~Total",
-- "~All stores", "~Average") which double-count if summed. This particular
-- report was checked across 7 days of live CSVs and carries NONE -- and it has
-- no store column of its own, so there is no `store_2` here to filter (a
-- reference to a non-existent column would make this whole file fail to
-- apply). The '~%' guards below are kept anyway because they cost nothing and
-- cover VM Hub adding a roll-up row later. If a `store_2` column ever DOES
-- appear via loader schema drift, add `AND coalesce(store_2,'') NOT LIKE '~%'`.
-- Aggregates gross_sales (see the 2026-08-22 pivot note at the top of this
-- file). A row synced before the pivot has gross_sales = NULL, so SUM()
-- ignores it and that date reports no figure under this view -- it is not
-- silently backfilled from the old net_sales column, which would mix two
-- different metrics under one field without saying so.
--
-- DROP + CREATE rather than CREATE OR REPLACE: Postgres refuses to REPLACE a
-- view when a column's output NAME changes (net_sales -> gross_sales), even
-- though the type is identical. This still converges to the same end state on
-- a re-run, and GRANT below is re-issued unconditionally either way.
DROP VIEW IF EXISTS vm_v_daily_net_sales;
CREATE VIEW vm_v_daily_net_sales AS
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
  END                                                   AS store_slug,
  week_start                                            AS business_date,
  ROUND(SUM(vm_num(gross_sales)), 2)::numeric(14, 2)    AS gross_sales,
  MAX(ingested_at)                                      AS last_synced_at
FROM vm_daily_net_sales_raw
WHERE store IS NOT NULL
  AND week_start IS NOT NULL
  AND store NOT LIKE '~%'
  AND coalesce(channel, '')         NOT LIKE '~%'
  AND coalesce(week_commencing, '') NOT LIKE '~%'
GROUP BY store, week_start;


-- ===========================================================================
-- 4. GRANTS
-- ===========================================================================
-- The Cash-Flow app reads the VM Analytics project with its anon key, matching
-- every other vm_v_* view.
GRANT SELECT ON vm_v_daily_net_sales TO anon, authenticated;

-- /api/sauce/health reads the run ledger through that same anon key. Granting
-- the table (not just a view) is consistent with how the rest of this project
-- exposes vm_* objects; the ledger holds no customer data, only run status and
-- sync error text.
GRANT SELECT ON vm_daily_sync_runs TO anon, authenticated;
