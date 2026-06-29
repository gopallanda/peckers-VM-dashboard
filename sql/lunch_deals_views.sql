-- ===========================================================================
-- lunch_deals_views.sql
-- ---------------------
-- "Lunch Time Deals" analytics for the Daypart dashboard.
--
-- Source: vm_meal_deals_sold (raw), loaded from the VM Hub report
--   "Meal Deals Sold (table) (weekly)". The extractor pulls it once per store
--   with a single-store filter applied, so the meta `store` column is correct
--   and net_sales / counts are already per store.
--
-- Raw columns (all TEXT): store, week_start, week_end (meta) +
--   week_commencing, meal_deal_name, no_of_meal_deals, net_sales.
--
-- Apply after kpi_views.sql (needs the vm_num() helper):
--   psql "$SUPABASE_DB_URL" -f sql/lunch_deals_views.sql
-- ===========================================================================

-- Per store/week/meal-deal breakdown — powers the detail table + trading graph.
CREATE OR REPLACE VIEW vm_v_lunch_deals_by_item AS
SELECT
  store,
  week_start,
  week_end,
  btrim(meal_deal_name)                               AS meal_deal_name,
  SUM(vm_num(no_of_meal_deals))::numeric(12,0)        AS deals_sold,
  SUM(vm_num(net_sales))::numeric(12,2)               AS net_sales,
  CASE WHEN SUM(vm_num(no_of_meal_deals)) > 0
       THEN (SUM(vm_num(net_sales)) / SUM(vm_num(no_of_meal_deals)))::numeric(12,2)
       ELSE 0::numeric(12,2) END                      AS aov
FROM vm_meal_deals_sold
WHERE store IS NOT NULL AND week_start IS NOT NULL
  AND meal_deal_name IS NOT NULL AND btrim(meal_deal_name) <> ''
GROUP BY store, week_start, week_end, btrim(meal_deal_name);

-- Per store/week totals with week-on-week revenue growth — powers the KPI cards.
CREATE OR REPLACE VIEW vm_v_lunch_deals AS
WITH base AS (
  SELECT
    store,
    week_start,
    week_end,
    SUM(vm_num(no_of_meal_deals))::numeric(12,0) AS deals_sold,
    SUM(vm_num(net_sales))::numeric(12,2)        AS net_sales
  FROM vm_meal_deals_sold
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND meal_deal_name IS NOT NULL AND btrim(meal_deal_name) <> ''
  GROUP BY store, week_start, week_end
)
SELECT
  *,
  CASE WHEN deals_sold > 0
       THEN (net_sales / deals_sold)::numeric(12,2)
       ELSE 0::numeric(12,2) END AS aov,
  LAG(net_sales) OVER w          AS prev_net_sales,
  ROUND(100 * (net_sales - LAG(net_sales) OVER w)
        / NULLIF(LAG(net_sales) OVER w, 0), 1)::numeric(6,1) AS net_sales_wow_pct
FROM base
WINDOW w AS (PARTITION BY store ORDER BY week_start);

GRANT SELECT ON vm_v_lunch_deals, vm_v_lunch_deals_by_item TO anon, authenticated;

-- Delivery vs in-store split for meal deals. The weekly "Meal Deals Sold" report
-- has no channel column, so the split comes from the line-item table
-- vm_detailed_sales_info, where create_source distinguishes delivery (own +
-- platforms) from in-store (pos / kiosk / online). One meal deal = one distinct
-- meal_deal_basket_uuid; net_sales summed across that basket's lines.
CREATE OR REPLACE VIEW vm_v_lunch_deals_channel AS
WITH lines AS (
  SELECT store, week_start, week_end,
         meal_deal_basket_uuid,
         CASE WHEN lower(btrim(create_source)) = 'delivery'
              THEN 'delivery' ELSE 'in_store' END AS channel,
         vm_num(net_sales) AS net_sales
  FROM vm_detailed_sales_info
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND meal_deal_basket_uuid IS NOT NULL AND btrim(meal_deal_basket_uuid) <> ''
    AND meal_deal_name IS NOT NULL AND btrim(meal_deal_name) <> ''
)
SELECT store, week_start, week_end, channel,
       COUNT(DISTINCT meal_deal_basket_uuid)            AS deal_baskets,
       SUM(net_sales)::numeric(12,2)                    AS net_sales,
       CASE WHEN COUNT(DISTINCT meal_deal_basket_uuid) > 0
            THEN (SUM(net_sales) / COUNT(DISTINCT meal_deal_basket_uuid))::numeric(12,2)
            ELSE 0::numeric(12,2) END                   AS aov
FROM lines
GROUP BY store, week_start, week_end, channel;

GRANT SELECT ON vm_v_lunch_deals_channel TO anon, authenticated;

-- Per-CHANNEL meal-deal mix (finer than delivery/in-store). create_source is
-- authoritative for the delivery vs in-store group (so totals reconcile with
-- vm_v_lunch_deals_channel); within delivery the payment integration names the
-- platform. In-store channels mirror the executive dashboard's channel names.
CREATE OR REPLACE VIEW vm_v_lunch_deals_channel_detail AS
WITH lines AS (
  SELECT store, week_start, week_end,
         meal_deal_basket_uuid,
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
    AND meal_deal_basket_uuid IS NOT NULL AND btrim(meal_deal_basket_uuid) <> ''
    AND meal_deal_name IS NOT NULL AND btrim(meal_deal_name) <> ''
)
SELECT store, week_start, week_end, channel_group, channel_name,
       COUNT(DISTINCT meal_deal_basket_uuid)            AS deal_baskets,
       SUM(net_sales)::numeric(12,2)                    AS net_sales,
       CASE WHEN COUNT(DISTINCT meal_deal_basket_uuid) > 0
            THEN (SUM(net_sales) / COUNT(DISTINCT meal_deal_basket_uuid))::numeric(12,2)
            ELSE 0::numeric(12,2) END                   AS aov
FROM lines
GROUP BY store, week_start, week_end, channel_group, channel_name;

GRANT SELECT ON vm_v_lunch_deals_channel_detail TO anon, authenticated;
