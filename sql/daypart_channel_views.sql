-- ===========================================================================
-- daypart_channel_views.sql
-- -------------------------
-- Finer daypart × channel breakdown for the Daypart Analysis dashboard.
--
-- The original vm_v_daypart_summary view only split the day into Orders /
-- Revenue / AOV per daypart, and vm_v_daypart_channel only split each daypart
-- into Delivery vs In-store. The dashboard now needs the delivery group broken
-- into Own Delivery vs the Aggregate platforms (Deliveroo + Uber Eats + Just
-- Eat), plus an Eat-in cut — none of which existed in any app-readable view.
--
-- Both views below are derived from the line-item table vm_detailed_sales_info
-- (the same source vm_v_lunch_deals_channel_detail already uses), so the channel
-- logic is identical and the numbers reconcile with the rest of the suite.
--
-- OPENING-HOURS FILTER (business rule):
--   Peckers Hitchin trades 12:00–22:00, Peckers Stevenage 11:30–22:00. Orders
--   rung up before opening (staff meals / test orders) are excluded so the
--   daypart figures reflect real trading. Times are evaluated in Europe/London
--   local time (created_at is stored in UTC).
--
-- Run after a sync (and after kpi_views.sql), e.g.:
--   psql "$SUPABASE_DB_URL" -f sql/daypart_channel_views.sql
-- ===========================================================================

-- Drop first (rollup depends on the detail view) so column-type changes vs any
-- pre-existing definitions don't trip CREATE OR REPLACE. Order matters.
DROP VIEW IF EXISTS vm_v_daypart_channel;
DROP VIEW IF EXISTS vm_v_daypart_channel_detail;

-- 3.4 Per-CHANNEL daypart detail (one row per store/week/daypart/channel).
--     channel_group is "delivery" | "in_store" (authoritative, from
--     create_source); channel_name mirrors the executive dashboard's channels.
CREATE OR REPLACE VIEW vm_v_daypart_channel_detail AS
WITH lines AS (
  SELECT
    store, week_start, week_end,
    order_uuid,
    -- created_at is loaded as TEXT (schema-agnostic loader); cast to timestamptz
    -- then convert to Europe/London local wall-clock (handles BST/GMT).
    (created_at::timestamptz AT TIME ZONE 'Europe/London') AS local_ts,
    CASE WHEN lower(btrim(create_source)) = 'delivery'
         THEN 'delivery' ELSE 'in_store' END AS channel_group,
    CASE
      WHEN lower(btrim(create_source)) = 'delivery' THEN
        CASE
          WHEN lower(payment_method) LIKE '%deliveroo%' THEN 'Deliveroo'
          WHEN lower(payment_method) LIKE '%uber%'      THEN 'Uber Eats'
          WHEN lower(payment_method) LIKE '%just%eat%'  THEN 'Just Eat'
          ELSE 'Own Delivery'
        END
      WHEN lower(btrim(create_source)) = 'online' THEN 'Click & Collect'
      WHEN lower(btrim(create_source)) = 'kiosk'  THEN 'Kiosk'
      WHEN lower(btrim(eat_in_takeaway)) = 'eat-in' THEN 'Till (eat-in)'
      ELSE 'Till (takeaway)'
    END AS channel_name,
    vm_num(net_sales) AS net_sales
  FROM vm_detailed_sales_info
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND order_uuid IS NOT NULL AND btrim(order_uuid) <> ''
    AND created_at IS NOT NULL
    -- Only rows whose created_at looks like an ISO timestamp, so the cast above
    -- can never error on stray aggregate / junk rows.
    AND created_at ~ '^\d{4}-\d{2}-\d{2}[ T]'
),
open_lines AS (
  SELECT *,
    EXTRACT(HOUR FROM local_ts)::numeric AS order_hour
  FROM lines
  WHERE
    -- Keep only orders at/after each store's opening time (local).
    (store ILIKE '%hitchin%'   AND local_ts::time >= TIME '12:00')
    OR (store ILIKE '%stevenage%' AND local_ts::time >= TIME '11:30')
    OR (store NOT ILIKE '%hitchin%' AND store NOT ILIKE '%stevenage%')
)
SELECT
  store, week_start, week_end,
  vm_daypart(order_hour)      AS daypart,
  vm_daypart_rank(order_hour) AS daypart_rank,
  channel_group,
  channel_name,
  COUNT(DISTINCT order_uuid)        AS orders,
  SUM(net_sales)::numeric(12,2)     AS net_sales,
  CASE WHEN COUNT(DISTINCT order_uuid) > 0
       THEN (SUM(net_sales) / COUNT(DISTINCT order_uuid))::numeric(12,2)
       ELSE 0::numeric(12,2) END    AS aov
FROM open_lines
GROUP BY store, week_start, week_end,
         vm_daypart(order_hour), vm_daypart_rank(order_hour),
         channel_group, channel_name
ORDER BY store, week_start DESC, daypart_rank;

GRANT SELECT ON vm_v_daypart_channel_detail TO anon, authenticated;


-- 3.5 Delivery vs In-store rollup per daypart (recreated as a rollup of the
--     detail view so the two always reconcile, and so it inherits the same
--     opening-hours filter). The dashboard reads this for the headline
--     Delivery / In-store AOV columns.
CREATE OR REPLACE VIEW vm_v_daypart_channel AS
SELECT
  store, week_start, week_end,
  daypart, daypart_rank,
  CASE WHEN channel_group = 'delivery' THEN 'Delivery' ELSE 'In-store' END AS channel,
  SUM(orders)                     AS orders,
  SUM(net_sales)::numeric(12,2)   AS net_sales,
  CASE WHEN SUM(orders) > 0
       THEN (SUM(net_sales) / SUM(orders))::numeric(12,2)
       ELSE 0::numeric(12,2) END  AS aov
FROM vm_v_daypart_channel_detail
GROUP BY store, week_start, week_end, daypart, daypart_rank,
         CASE WHEN channel_group = 'delivery' THEN 'Delivery' ELSE 'In-store' END
ORDER BY store, week_start DESC, daypart_rank;

GRANT SELECT ON vm_v_daypart_channel TO anon, authenticated;
