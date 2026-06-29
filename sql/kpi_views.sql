-- ===========================================================================
-- kpi_views.sql
-- -------------
-- SQL KPI layer for the Peckers VM Analytics dashboards.
--
-- Computes every KPI from the raw vm_* tables (all columns are TEXT — the
-- loader is schema-agnostic, so ALL numeric casting + business logic lives
-- here, not in the app).
--
-- IMPORTANT schema facts (confirmed against real synced CSVs):
--   * The loader adds meta columns: store, week_start (DATE), week_end (DATE).
--     `store` is the CANONICAL store name ("Peckers Hitchin") set per sync run
--     and is the one to GROUP/FILTER by.
--   * When a report's own CSV also has a "store" column, it is loaded as
--     `store_2` (because `store` is reserved). Several reports embed aggregate
--     rows ("~Total", "~All stores", "~Average") in store_2 / the date column —
--     these MUST be filtered out or totals double/triple count.
--
-- Run after a sync:
--   psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql
-- ===========================================================================


-- ===========================================================================
-- 0. HELPER FUNCTIONS
-- ===========================================================================

-- 0.1 Cast messy TEXT -> NUMERIC (strips currency, commas, %, stray chars)
CREATE OR REPLACE FUNCTION vm_num(t text)
RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(coalesce(t,''), '[^0-9.\-]', '', 'g'), '')::numeric;
$$;

-- 0.2 Channel -> fulfilment bucket (delivery / collection / eat_in / other)
--     Mirrors src/config.js CHANNEL_BUCKET — keep in sync.
CREATE OR REPLACE FUNCTION vm_bucket(channel text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(coalesce(channel,'')) LIKE '%eat in%'            THEN 'eat_in'
    WHEN lower(coalesce(channel,'')) LIKE '%eat-in%'            THEN 'eat_in'
    WHEN lower(coalesce(channel,'')) LIKE '%kiosk%'             THEN 'eat_in'
    WHEN lower(coalesce(channel,'')) LIKE '%click & collect%'   THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%click and collect%' THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%take-away%'         THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%takeaway%'          THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%collection%'        THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%own-delivery%'      THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%own delivery%'      THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%uber%'              THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%deliveroo%'         THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%just eat%'          THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%delivery%'          THEN 'delivery'
    ELSE 'other'
  END;
$$;

-- 0.3 Channel -> canonical platform label for the Delivery dashboard
CREATE OR REPLACE FUNCTION vm_platform(channel text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(coalesce(channel,'')) LIKE '%deliveroo%'        THEN 'Deliveroo'
    WHEN lower(coalesce(channel,'')) LIKE '%uber%'             THEN 'Uber Eats'
    WHEN lower(coalesce(channel,'')) LIKE '%just eat%'         THEN 'Just Eat'
    WHEN lower(coalesce(channel,'')) LIKE '%own%'              THEN 'Own Delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%direct%'           THEN 'Own Delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%kiosk%'            THEN 'In-store'
    WHEN lower(coalesce(channel,'')) LIKE '%counter%'          THEN 'In-store'
    WHEN lower(coalesce(channel,'')) LIKE '%pos%'              THEN 'In-store'
    WHEN lower(coalesce(channel,'')) LIKE '%eat in%'           THEN 'In-store'
    WHEN lower(coalesce(channel,'')) LIKE '%walk%'             THEN 'In-store'
    WHEN lower(coalesce(channel,'')) LIKE '%click%'            THEN 'Collection'
    WHEN lower(coalesce(channel,'')) LIKE '%collection%'       THEN 'Collection'
    ELSE coalesce(NULLIF(trim(channel),''), 'Other')
  END;
$$;

-- 0.4 Hour-of-day -> daypart label + sort rank
CREATE OR REPLACE FUNCTION vm_daypart(hour numeric)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN hour >= 5  AND hour < 11 THEN 'Morning (5-11am)'
    WHEN hour >= 11 AND hour < 14 THEN 'Lunch (11-2pm)'
    WHEN hour >= 14 AND hour < 17 THEN 'Afternoon (2-5pm)'
    WHEN hour >= 17 AND hour < 20 THEN 'Dinner (5-8pm)'
    WHEN hour >= 20 AND hour < 24 THEN 'Night (8-12pm)'
    ELSE 'Late (12-5am)'
  END;
$$;

CREATE OR REPLACE FUNCTION vm_daypart_rank(hour numeric)
RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN hour >= 5  AND hour < 11 THEN 1
    WHEN hour >= 11 AND hour < 14 THEN 2
    WHEN hour >= 14 AND hour < 17 THEN 3
    WHEN hour >= 17 AND hour < 20 THEN 4
    WHEN hour >= 20 AND hour < 24 THEN 5
    ELSE 6
  END;
$$;


-- ===========================================================================
-- 1. EXECUTIVE DASHBOARD
--    Sources: vm_net_sales_by_channel, vm_orders_by_channel, vm_customer_metrics
-- ===========================================================================

-- 1.1 Net sales by fulfilment bucket
CREATE OR REPLACE VIEW vm_v_net_sales_bucketed AS
SELECT
  store,
  week_start,
  week_end,
  channel,
  vm_bucket(channel) AS bucket,
  vm_num(net_sales)  AS net_sales_amount
FROM vm_net_sales_by_channel
WHERE store IS NOT NULL AND week_start IS NOT NULL;

-- 1.2 Weekly aggregates per store (sum across all channels)
CREATE OR REPLACE VIEW vm_v_weekly_base AS
WITH sales AS (
  SELECT
    store, week_start, week_end,
    SUM(net_sales_amount) FILTER (WHERE bucket = 'delivery')   AS delivery_sales,
    SUM(net_sales_amount) FILTER (WHERE bucket = 'collection') AS collection_sales,
    SUM(net_sales_amount) FILTER (WHERE bucket = 'eat_in')     AS eat_in_sales,
    SUM(net_sales_amount)                                       AS total_net_sales
  FROM vm_v_net_sales_bucketed
  GROUP BY store, week_start, week_end
),
orders AS (
  SELECT store, week_start,
         SUM(vm_num(number_of_orders)) AS total_orders
  FROM vm_orders_by_channel
  WHERE store IS NOT NULL AND week_start IS NOT NULL
  GROUP BY store, week_start
),
customers AS (
  SELECT store, week_start,
         SUM(vm_num(new_customer_orders)) + SUM(vm_num(return_customer_orders)) AS total_customers,
         SUM(vm_num(new_customer_orders))    AS new_customers,
         SUM(vm_num(return_customer_orders)) AS return_customers
  FROM vm_customer_metrics
  WHERE store IS NOT NULL AND week_start IS NOT NULL
  GROUP BY store, week_start
)
SELECT
  s.store, s.week_start, s.week_end,
  s.total_net_sales,
  COALESCE(o.total_orders, 0)     AS total_orders,
  COALESCE(c.total_customers, 0)  AS total_customers,
  COALESCE(c.new_customers, 0)    AS new_customers,
  COALESCE(c.return_customers, 0) AS return_customers,
  s.delivery_sales, s.collection_sales, s.eat_in_sales
FROM sales s
LEFT JOIN orders o    ON o.store = s.store AND o.week_start = s.week_start
LEFT JOIN customers c ON c.store = s.store AND c.week_start = s.week_start
ORDER BY s.store, s.week_start DESC;

-- 1.3 MAIN executive view: 8 KPIs (numeric types)
CREATE OR REPLACE VIEW vm_v_exec_dashboard AS
SELECT
  store, week_start, week_end,
  week_start::text AS week_start_iso,
  week_end::text   AS week_end_iso,
  COALESCE(total_net_sales, 0)::numeric(12,2) AS net_sales,
  COALESCE(total_orders, 0)::numeric(10,0)    AS number_of_orders,
  CASE WHEN total_orders > 0
       THEN (total_net_sales / total_orders)::numeric(10,2)
       ELSE 0::numeric(10,2) END AS aov,
  COALESCE(total_customers, 0)::numeric(10,0) AS customer_count,
  CASE WHEN total_net_sales > 0
       THEN (100 * COALESCE(delivery_sales,0)   / total_net_sales)::numeric(5,1)
       ELSE 0::numeric(5,1) END AS delivery_pct,
  CASE WHEN total_net_sales > 0
       THEN (100 * COALESCE(collection_sales,0) / total_net_sales)::numeric(5,1)
       ELSE 0::numeric(5,1) END AS collection_pct,
  CASE WHEN total_net_sales > 0
       THEN (100 * COALESCE(eat_in_sales,0)     / total_net_sales)::numeric(5,1)
       ELSE 0::numeric(5,1) END AS eat_in_pct,
  COALESCE(new_customers, 0)::numeric(10,0)    AS new_customer_count,
  COALESCE(return_customers, 0)::numeric(10,0) AS return_customer_count,
  COALESCE(delivery_sales, 0)::numeric(12,2)   AS delivery_sales_amount,
  COALESCE(collection_sales, 0)::numeric(12,2) AS collection_sales_amount,
  COALESCE(eat_in_sales, 0)::numeric(12,2)     AS eat_in_sales_amount
FROM vm_v_weekly_base
WHERE store IS NOT NULL
ORDER BY store, week_start DESC;

-- 1.4 Executive + Week-on-Week growth (KPI 8)
CREATE OR REPLACE VIEW vm_v_exec_dashboard_with_wow AS
SELECT
  *,
  ROUND(100 * (net_sales - LAG(net_sales) OVER w)
        / NULLIF(LAG(net_sales) OVER w, 0), 1)::numeric(6,1) AS net_sales_wow_pct,
  ROUND(100 * (number_of_orders - LAG(number_of_orders) OVER w)
        / NULLIF(LAG(number_of_orders) OVER w, 0), 1)::numeric(6,1) AS orders_wow_pct,
  ROUND(100 * (customer_count - LAG(customer_count) OVER w)
        / NULLIF(LAG(customer_count) OVER w, 0), 1)::numeric(6,1) AS customers_wow_pct,
  ROUND(100 * (aov - LAG(aov) OVER w)
        / NULLIF(LAG(aov) OVER w, 0), 1)::numeric(6,1) AS aov_wow_pct
FROM vm_v_exec_dashboard
WINDOW w AS (PARTITION BY store ORDER BY week_start);

-- 1.5 Latest week helper
CREATE OR REPLACE VIEW vm_v_latest_week AS
SELECT week_start, week_end FROM vm_v_weekly_base
ORDER BY week_start DESC
LIMIT 1;

CREATE INDEX IF NOT EXISTS idx_net_sales_store_week
  ON vm_net_sales_by_channel (store, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_orders_chan_store_week
  ON vm_orders_by_channel (store, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_customer_metrics_store_week
  ON vm_customer_metrics (store, week_start DESC);


-- ===========================================================================
-- 2. PRODUCT PERFORMANCE DASHBOARD
--    Sources: vm_top_menu_items_sold  (menu_item_name, gross_sales, menu_items_sold)
--             vm_sales_external_category (date, store_2, external_category,
--                                         gross_sales, net_sales, vat, orders)
--             vm_gross_sales_category (week_commencing, category, gross_sales)
-- ===========================================================================

-- 2.1 Per-item performance with WoW (units + revenue).
--     Excludes non-product service lines (delivery fee, service charge).
CREATE OR REPLACE VIEW vm_v_product_performance AS
SELECT
  store, week_start, week_end,
  menu_item_name            AS item_name,
  vm_num(menu_items_sold)   AS units_sold,
  vm_num(gross_sales)       AS gross_sales,
  CASE WHEN vm_num(menu_items_sold) > 0
       THEN (vm_num(gross_sales) / vm_num(menu_items_sold))::numeric(10,2)
       ELSE 0::numeric(10,2) END AS avg_item_price,
  ROUND(100 * (vm_num(menu_items_sold)
        - LAG(vm_num(menu_items_sold)) OVER w)
        / NULLIF(LAG(vm_num(menu_items_sold)) OVER w, 0), 1)::numeric(6,1) AS units_wow_pct,
  ROUND(100 * (vm_num(gross_sales)
        - LAG(vm_num(gross_sales)) OVER w)
        / NULLIF(LAG(vm_num(gross_sales)) OVER w, 0), 1)::numeric(6,1) AS revenue_wow_pct
FROM vm_top_menu_items_sold
WHERE store IS NOT NULL AND week_start IS NOT NULL
  AND menu_item_name IS NOT NULL
  AND lower(menu_item_name) NOT LIKE '%delivery fee%'
  AND lower(menu_item_name) NOT LIKE '%service charge%'
WINDOW w AS (PARTITION BY store, menu_item_name ORDER BY week_start);

-- 2.2 Category performance (external category) with WoW.
CREATE OR REPLACE VIEW vm_v_category_performance AS
WITH agg AS (
  SELECT
    store, week_start, week_end,
    external_category,
    SUM(vm_num(gross_sales)) AS gross_sales,
    SUM(vm_num(net_sales))   AS net_sales,
    SUM(vm_num(orders))      AS orders
  FROM vm_sales_external_category
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND external_category IS NOT NULL
    AND external_category NOT LIKE '~%'
    AND coalesce(store_2,'') NOT LIKE '~%'
  GROUP BY store, week_start, week_end, external_category
)
SELECT
  store, week_start, week_end,
  external_category,
  gross_sales::numeric(12,2) AS gross_sales,
  net_sales::numeric(12,2)   AS net_sales,
  orders::numeric(10,0)      AS orders,
  CASE WHEN orders > 0 THEN (gross_sales / orders)::numeric(10,2)
       ELSE 0::numeric(10,2) END AS aov,
  ROUND(100 * (gross_sales - LAG(gross_sales) OVER w)
        / NULLIF(LAG(gross_sales) OVER w, 0), 1)::numeric(6,1) AS gross_sales_wow_pct
FROM agg
WINDOW w AS (PARTITION BY store, external_category ORDER BY week_start);

CREATE INDEX IF NOT EXISTS idx_top_menu_items_store_week
  ON vm_top_menu_items_sold (store, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_sales_ext_cat_store_week
  ON vm_sales_external_category (store, week_start DESC);


-- ===========================================================================
-- 3. DAYPART ANALYSIS DASHBOARD
--    Sources: vm_hourly_order_activity (weekday, order_hour, avg_daily_sales,
--                                       avg_daily_orders)
--             vm_weekday_order_activity (weekday, avg_daily_sales, avg_daily_orders)
-- ===========================================================================

-- 3.1 Hourly detail (for the heat/line charts)
CREATE OR REPLACE VIEW vm_v_daypart_hourly AS
SELECT
  store, week_start, week_end,
  vm_num(weekday_id)        AS weekday_id,
  weekday,
  vm_num(order_hour)        AS order_hour,
  vm_daypart(vm_num(order_hour))      AS daypart,
  vm_daypart_rank(vm_num(order_hour)) AS daypart_rank,
  vm_num(avg_daily_orders)  AS avg_orders,
  vm_num(avg_daily_sales)   AS avg_revenue
FROM vm_hourly_order_activity
WHERE store IS NOT NULL AND week_start IS NOT NULL
  AND order_hour IS NOT NULL;

-- 3.2 Daypart summary: Orders / Revenue / AOV per time period (the spec table)
CREATE OR REPLACE VIEW vm_v_daypart_summary AS
WITH agg AS (
  SELECT
    store, week_start, week_end,
    vm_daypart(vm_num(order_hour))      AS daypart,
    vm_daypart_rank(vm_num(order_hour)) AS daypart_rank,
    SUM(vm_num(avg_daily_orders)) AS orders,
    SUM(vm_num(avg_daily_sales))  AS revenue
  FROM vm_hourly_order_activity
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND order_hour IS NOT NULL
  GROUP BY store, week_start, week_end,
           vm_daypart(vm_num(order_hour)), vm_daypart_rank(vm_num(order_hour))
)
SELECT
  store, week_start, week_end,
  daypart, daypart_rank,
  orders::numeric(10,1)  AS orders,
  revenue::numeric(12,2) AS revenue,
  CASE WHEN orders > 0 THEN (revenue / orders)::numeric(10,2)
       ELSE 0::numeric(10,2) END AS aov
FROM agg
ORDER BY store, week_start DESC, daypart_rank;

-- 3.3 Weekday trends: Orders / Revenue / AOV per weekday
CREATE OR REPLACE VIEW vm_v_daypart_weekday AS
SELECT
  store, week_start, week_end,
  vm_num(weekday_id)        AS weekday_id,
  weekday,
  vm_num(avg_daily_orders)::numeric(10,1) AS orders,
  vm_num(avg_daily_sales)::numeric(12,2)  AS revenue,
  CASE WHEN vm_num(avg_daily_orders) > 0
       THEN (vm_num(avg_daily_sales) / vm_num(avg_daily_orders))::numeric(10,2)
       ELSE 0::numeric(10,2) END AS aov
FROM vm_weekday_order_activity
WHERE store IS NOT NULL AND week_start IS NOT NULL
ORDER BY store, week_start DESC, weekday_id;

CREATE INDEX IF NOT EXISTS idx_hourly_order_store_week
  ON vm_hourly_order_activity (store, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_weekday_order_store_week
  ON vm_weekday_order_activity (store, week_start DESC);


-- ===========================================================================
-- 4. DELIVERY PLATFORM PERFORMANCE DASHBOARD
--    Primary source: vm_orders_store (timeframe, store_2, brand, channel,
--                                     order_count, gross_sales, net_sales)
--    Cross-check:     vm_sales_store_channel, vm_orders_store_channel
-- ===========================================================================

-- 4.1 Per-channel weekly totals (long format, one row per channel)
CREATE OR REPLACE VIEW vm_v_delivery_channel AS
WITH agg AS (
  SELECT
    store, week_start, week_end,
    vm_platform(channel) AS platform,
    vm_bucket(channel)   AS bucket,
    SUM(vm_num(order_count)) AS orders,
    SUM(vm_num(gross_sales)) AS gross_sales,
    SUM(vm_num(net_sales))   AS net_sales
  FROM vm_orders_store
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND channel IS NOT NULL AND trim(channel) <> ''
    AND channel NOT LIKE '~%'
    AND coalesce(store_2,'') NOT LIKE '~%'
    AND coalesce(timeframe,'') NOT LIKE '~%'
  GROUP BY store, week_start, week_end, vm_platform(channel), vm_bucket(channel)
)
SELECT
  store, week_start, week_end,
  platform, bucket,
  orders::numeric(10,0)      AS orders,
  gross_sales::numeric(12,2) AS gross_sales,
  net_sales::numeric(12,2)   AS net_sales,
  CASE WHEN orders > 0 THEN (gross_sales / orders)::numeric(10,2)
       ELSE 0::numeric(10,2) END AS aov,
  ROUND(100 * (gross_sales - LAG(gross_sales) OVER w)
        / NULLIF(LAG(gross_sales) OVER w, 0), 1)::numeric(6,1) AS gross_sales_wow_pct
FROM agg
WINDOW w AS (PARTITION BY store, platform ORDER BY week_start);

-- 4.2 Delivery platform mix: each platform's share of revenue + orders
CREATE OR REPLACE VIEW vm_v_delivery_mix AS
WITH totals AS (
  SELECT store, week_start,
         SUM(gross_sales) AS total_sales,
         SUM(orders)      AS total_orders
  FROM vm_v_delivery_channel
  GROUP BY store, week_start
)
SELECT
  d.store, d.week_start, d.week_end,
  d.platform, d.bucket,
  d.orders, d.gross_sales, d.net_sales, d.aov,
  CASE WHEN t.total_sales > 0
       THEN (100 * d.gross_sales / t.total_sales)::numeric(5,1)
       ELSE 0::numeric(5,1) END AS revenue_share_pct,
  CASE WHEN t.total_orders > 0
       THEN (100 * d.orders / t.total_orders)::numeric(5,1)
       ELSE 0::numeric(5,1) END AS orders_share_pct,
  d.gross_sales_wow_pct
FROM vm_v_delivery_channel d
JOIN totals t ON t.store = d.store AND t.week_start = d.week_start
ORDER BY d.store, d.week_start DESC, d.gross_sales DESC;

CREATE INDEX IF NOT EXISTS idx_orders_store_store_week
  ON vm_orders_store (store, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_sales_store_channel_store_week
  ON vm_sales_store_channel (store, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_orders_store_channel_store_week
  ON vm_orders_store_channel (store, week_start DESC);


-- ===========================================================================
-- 5. STORE COMPARISON DASHBOARD
--    Sources: vm_gross_sales_store, vm_gross_atv_store,
--             vm_customer_store_metrics, vm_orders_store, vm_net_sales_by_channel
--    NOTE: No labour data is synced from VM Hub, so Labour Cost / Labour %
--          cannot be computed here. They can be layered on later from a manual
--          input table (e.g. vm_labour_cost). This view exposes everything that
--          IS derivable today.
-- ===========================================================================
CREATE OR REPLACE VIEW vm_v_store_comparison AS
WITH gross_sales AS (
  SELECT store, week_start, week_end,
         SUM(vm_num(gross_sales)) AS gross_sales
  FROM vm_gross_sales_store
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND coalesce(store_2,'')        NOT LIKE '~%'
    AND coalesce(week_commencing,'') NOT LIKE '~%'
  GROUP BY store, week_start, week_end
),
orders AS (
  SELECT store, week_start,
         SUM(vm_num(order_count)) AS total_orders,
         SUM(vm_num(net_sales))   AS net_sales
  FROM vm_orders_store
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND coalesce(store_2,'')  NOT LIKE '~%'
    AND coalesce(timeframe,'') NOT LIKE '~%'
  GROUP BY store, week_start
),
atv AS (
  SELECT store, week_start,
         AVG(vm_num(gross_atv)) AS gross_atv
  FROM vm_gross_atv_store
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND coalesce(store_2,'')        NOT LIKE '~%'
    AND coalesce(week_commencing,'') NOT LIKE '~%'
  GROUP BY store, week_start
),
customers AS (
  SELECT store, week_start,
         SUM(vm_num(new_customers))    AS new_customers,
         SUM(vm_num(repeat_customers)) AS repeat_customers,
         SUM(vm_num(total_customers))  AS total_customers
  FROM vm_customer_store_metrics
  WHERE store IS NOT NULL AND week_start IS NOT NULL
    AND coalesce(store_2,'')  NOT LIKE '~%'
    AND coalesce(timeframe,'') NOT LIKE '~%'
  GROUP BY store, week_start
),
delivery_mix AS (
  SELECT store, week_start,
         SUM(vm_num(net_sales)) FILTER (WHERE vm_bucket(channel) = 'delivery') AS delivery_sales,
         SUM(vm_num(net_sales)) AS total_sales
  FROM vm_net_sales_by_channel
  WHERE store IS NOT NULL AND week_start IS NOT NULL
  GROUP BY store, week_start
)
SELECT
  g.store, g.week_start, g.week_end,
  COALESCE(g.gross_sales, 0)::numeric(12,2)  AS gross_sales,
  COALESCE(o.net_sales, 0)::numeric(12,2)    AS net_sales,
  COALESCE(o.total_orders, 0)::numeric(10,0) AS total_orders,
  COALESCE(
    a.gross_atv,
    CASE WHEN COALESCE(o.total_orders,0) > 0 THEN g.gross_sales / o.total_orders ELSE 0 END
  )::numeric(10,2) AS aov,
  COALESCE(c.new_customers, 0)::numeric(10,0)    AS new_customers,
  COALESCE(c.repeat_customers, 0)::numeric(10,0) AS repeat_customers,
  COALESCE(c.total_customers, 0)::numeric(10,0)  AS total_customers,
  CASE WHEN COALESCE(c.total_customers,0) > 0
       THEN (100 * c.new_customers / c.total_customers)::numeric(5,1)
       ELSE 0::numeric(5,1) END AS new_customer_pct,
  CASE WHEN COALESCE(dm.total_sales,0) > 0
       THEN (100 * COALESCE(dm.delivery_sales,0) / dm.total_sales)::numeric(5,1)
       ELSE 0::numeric(5,1) END AS delivery_mix_pct,
  ROUND(100 * (g.gross_sales - LAG(g.gross_sales) OVER w)
        / NULLIF(LAG(g.gross_sales) OVER w, 0), 1)::numeric(6,1) AS gross_sales_wow_pct
FROM gross_sales g
LEFT JOIN orders o       ON o.store = g.store AND o.week_start = g.week_start
LEFT JOIN atv a          ON a.store = g.store AND a.week_start = g.week_start
LEFT JOIN customers c    ON c.store = g.store AND c.week_start = g.week_start
LEFT JOIN delivery_mix dm ON dm.store = g.store AND dm.week_start = g.week_start
WHERE g.store IS NOT NULL
WINDOW w AS (PARTITION BY g.store ORDER BY g.week_start)
ORDER BY g.store, g.week_start DESC;

CREATE INDEX IF NOT EXISTS idx_gross_sales_store_week
  ON vm_gross_sales_store (store, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_gross_atv_store_week
  ON vm_gross_atv_store (store, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_customer_store_metrics_week
  ON vm_customer_store_metrics (store, week_start DESC);


-- ===========================================================================
-- 6. SHARED HELPERS FOR THE APP
-- ===========================================================================

-- 6.1 All available (store, week) pairs, latest first — drives selectors.
CREATE OR REPLACE VIEW vm_v_available_weeks AS
SELECT DISTINCT week_start, week_end, week_start::text AS week_start_iso
FROM vm_v_weekly_base
WHERE week_start IS NOT NULL
ORDER BY week_start DESC;


-- ===========================================================================
-- 7. GRANTS — let the Supabase anon/authenticated roles read the views
--    (the Next.js app reads through the publishable/anon key). Views run with
--    owner privileges, so SELECT on the view is sufficient.
-- ===========================================================================
DO $$
DECLARE v text;
BEGIN
  FOR v IN
    SELECT table_name FROM information_schema.views
    WHERE table_schema = 'public' AND table_name LIKE 'vm_v_%'
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', v);
  END LOOP;
END $$;
