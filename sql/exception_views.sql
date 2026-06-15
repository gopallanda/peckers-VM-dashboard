-- ===========================================================================
-- exception_views.sql
-- -------------------
-- Supporting analytics for the Weekly Exception Report dashboard (7th VM
-- dashboard). Source: vm_detailed_sales_info — one row per order LINE, where
-- order_uuid is the order id, menu_name the item, meal_deal_basket_uuid the
-- meal-deal basket. Cross-checked: COUNT(DISTINCT order_uuid) per store/week
-- equals the executive dashboard order counts exactly.
--
-- Apply after kpi_views.sql:  psql "$SUPABASE_DB_URL" -f sql/exception_views.sql
-- ===========================================================================

-- 7.1 Attachment base — for each (store, week, item): how many distinct orders
--     contained the item vs total distinct orders. attach_pct = share of orders
--     that included the item.
CREATE OR REPLACE VIEW vm_v_attachment_base AS
WITH order_totals AS (
  SELECT store, week_start, week_end,
         COUNT(DISTINCT order_uuid) AS total_orders
  FROM vm_detailed_sales_info
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND order_uuid IS NOT NULL AND btrim(order_uuid) <> ''
  GROUP BY store, week_start, week_end
),
item_orders AS (
  SELECT store, week_start,
         menu_name AS item_name,
         COUNT(DISTINCT order_uuid)            AS orders_with_item,
         SUM(vm_num(menu_items_sold))::numeric(12,1) AS units
  FROM vm_detailed_sales_info
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND order_uuid IS NOT NULL AND btrim(order_uuid) <> ''
    AND menu_name IS NOT NULL AND btrim(menu_name) <> ''
    -- exclude non-product service lines (mirrors vm_v_product_performance)
    AND lower(menu_name) NOT LIKE '%delivery fee%'
    AND lower(menu_name) NOT LIKE '%service charge%'
  GROUP BY store, week_start, menu_name
)
SELECT
  io.store, io.week_start, ot.week_end, io.item_name,
  io.orders_with_item, io.units, ot.total_orders,
  CASE WHEN ot.total_orders > 0
       THEN (100.0 * io.orders_with_item / ot.total_orders)::numeric(6,1)
       ELSE 0::numeric(6,1) END AS attach_pct
FROM item_orders io
JOIN order_totals ot
  ON ot.store = io.store AND ot.week_start = io.week_start;

-- 7.2 Attachment with WoW — prior-week attach_pct + percentage-point delta.
CREATE OR REPLACE VIEW vm_v_attachment_with_wow AS
SELECT *,
  LAG(attach_pct) OVER w AS prev_attach_pct,
  (attach_pct - LAG(attach_pct) OVER w)::numeric(6,1) AS attach_pct_delta
FROM vm_v_attachment_base
WINDOW w AS (PARTITION BY store, item_name ORDER BY week_start);

-- 7.3 Meal-deal penetration with WoW — distinct meal-deal baskets per store/week.
CREATE OR REPLACE VIEW vm_v_meal_deals AS
WITH base AS (
  SELECT store, week_start, week_end,
         COUNT(DISTINCT meal_deal_basket_uuid) AS deal_baskets
  FROM vm_detailed_sales_info
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND meal_deal_name IS NOT NULL AND btrim(meal_deal_name) <> ''
    AND meal_deal_basket_uuid IS NOT NULL AND btrim(meal_deal_basket_uuid) <> ''
  GROUP BY store, week_start, week_end
)
SELECT *,
  LAG(deal_baskets) OVER w AS prev_deal_baskets,
  (deal_baskets - LAG(deal_baskets) OVER w) AS deal_baskets_delta
FROM base
WINDOW w AS (PARTITION BY store ORDER BY week_start);

-- 7.4 Menu-category performance with WoW. The external-category report is mostly
--     blank for these stores, so categories come from vm_products_modifiers_size
--     (which carries real menu categories: Sides, Wings & Tenders, Burgers, …).
CREATE OR REPLACE VIEW vm_v_menu_category_wow AS
WITH base AS (
  SELECT store, week_start, week_end,
         btrim(category) AS category,
         SUM(vm_num(gross_sales))::numeric(12,2) AS gross_sales
  FROM vm_products_modifiers_size
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND category IS NOT NULL AND btrim(category) <> ''
    AND lower(category) NOT LIKE '%delivery fee%'
    AND lower(category) NOT LIKE '%service charge%'
  GROUP BY store, week_start, week_end, btrim(category)
)
SELECT *,
  ROUND(100 * (gross_sales - LAG(gross_sales) OVER w)
        / NULLIF(LAG(gross_sales) OVER w, 0), 1)::numeric(6,1) AS gross_sales_wow_pct
FROM base
WINDOW w AS (PARTITION BY store, category ORDER BY week_start);

GRANT SELECT ON vm_v_attachment_base, vm_v_attachment_with_wow, vm_v_meal_deals,
  vm_v_menu_category_wow TO anon, authenticated;
