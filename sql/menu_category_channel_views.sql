-- ===========================================================================
-- menu_category_channel_views.sql
-- -------------------------------
-- Menu-category × channel breakdown for the Daypart Analysis dashboard's
-- "Meal Boxes & Platters" / "Platters" tables (and any other menu category).
--
-- The synced vm_menu_category_sales report gives weekly order_count / net_sales
-- per menu category, but with NO channel split. To show AOV per channel
-- (In-store, Delivery, Own Delivery, Aggregator) — exactly like the
-- "Performance by Time Period" table — we derive the same figures from the
-- line-item table vm_detailed_sales_info, where the menu category lives in
-- `category_name` (note: it carries trailing whitespace, so btrim() it).
--
-- The channel logic is identical to vm_v_daypart_channel_detail and
-- vm_v_lunch_deals_channel_detail (create_source + payment_method +
-- eat_in_takeaway), so the numbers reconcile with the rest of the suite.
--
-- NO opening-hours filter is applied here (unlike the daypart views): the goal
-- is to reconcile with the raw vm_menu_category_sales report, whose totals
-- include every order. Verified to match exactly — e.g. Peckers Hitchin
-- 2026-06-08 "Meal Boxes & Platters" = 8 orders / £177.50, "Platters" = 2 / £26.67.
--
-- Run after a sync (and after kpi_views.sql), e.g.:
--   psql "$SUPABASE_DB_URL" -f sql/menu_category_channel_views.sql
-- ===========================================================================

DROP VIEW IF EXISTS vm_v_menu_category_channel;

-- One row per store/week/menu_category/channel_group/channel_name.
--   channel_group is "delivery" | "in_store" (authoritative, from create_source).
--   channel_name mirrors the executive dashboard's channels.
-- orders = distinct orders containing a line in that category & channel; an
-- order belongs to a single channel, so per-channel order counts sum back to
-- the category total without double counting.
CREATE OR REPLACE VIEW vm_v_menu_category_channel AS
WITH lines AS (
  SELECT
    store, week_start, week_end,
    order_uuid,
    btrim(category_name) AS menu_category,
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
    -- Drop blank / service-fee category lines; they are not a menu category.
    AND category_name IS NOT NULL AND btrim(category_name) <> ''
)
SELECT
  store, week_start, week_end,
  menu_category,
  channel_group,
  channel_name,
  COUNT(DISTINCT order_uuid)        AS orders,
  SUM(net_sales)::numeric(12,2)     AS net_sales,
  CASE WHEN COUNT(DISTINCT order_uuid) > 0
       THEN (SUM(net_sales) / COUNT(DISTINCT order_uuid))::numeric(12,2)
       ELSE 0::numeric(12,2) END    AS aov
FROM lines
GROUP BY store, week_start, week_end, menu_category, channel_group, channel_name
ORDER BY store, week_start DESC, menu_category, channel_name;

GRANT SELECT ON vm_v_menu_category_channel TO anon, authenticated;
