-- ===========================================================================
-- kpi_views.sql
-- ---------------------------------------------------------------------------
-- Turns the synced vm_* tables into the 8 Executive Dashboard KPIs:
--   Net Sales · Number of Orders · AOV · Customer Count ·
--   Delivery % · Collection % · Eat-In % · Week-on-Week Growth %
--
-- Run after a sync:
--   psql "$SUPABASE_DB_URL" -f sql/kpi_views.sql
--
-- IMPORTANT — column names:
--   The loader creates one TEXT column per CSV header (dynamic schema), so the
--   EXACT column names depend on what VM Hub emits. The views below assume the
--   most likely names and cast TEXT -> numeric here (not at load time). After
--   your first sync, run e.g.
--       \d vm_net_sales_by_channel
--   and adjust the column references marked TODO(confirm-on-first-run).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Channel -> fulfilment-bucket mapping (CENTRALISED HERE).
--    Mirrors src/config.js CHANNEL_BUCKET — keep the two in sync.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vm_bucket(channel text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(coalesce(channel,'')) LIKE '%eat in%'          THEN 'eat_in'
    WHEN lower(coalesce(channel,'')) LIKE '%eat-in%'          THEN 'eat_in'
    WHEN lower(coalesce(channel,'')) LIKE '%click & collect%' THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%click and collect%' THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%take-away%'       THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%takeaway%'        THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%collection%'      THEN 'collection'
    WHEN lower(coalesce(channel,'')) LIKE '%own-delivery%'    THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%own delivery%'    THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%uber eats%'       THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%deliveroo%'       THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%just eat%'        THEN 'delivery'
    WHEN lower(coalesce(channel,'')) LIKE '%delivery%'        THEN 'delivery'
    ELSE 'other'
  END;
$$;

-- Helper: tolerant TEXT -> numeric (strips currency symbols, commas, %).
CREATE OR REPLACE FUNCTION vm_num(t text)
RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(coalesce(t,''), '[^0-9.\-]', '', 'g'), '')::numeric;
$$;

-- ---------------------------------------------------------------------------
-- 1. Net sales, bucketed by fulfilment type, per store/week.
--    CSV columns confirmed: week_commencing, channel, net_sales.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vm_v_net_sales_bucketed AS
SELECT
  store,
  week_start,
  week_end,
  channel                              AS channel,
  vm_bucket(channel)                   AS bucket,
  SUM(vm_num(net_sales))               AS net_sales
FROM vm_net_sales_by_channel
GROUP BY store, week_start, week_end, channel;

-- ---------------------------------------------------------------------------
-- 2. Orders per store/week (sum across channels).
--    CSV columns confirmed: week_commencing, channel, number_of_orders.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vm_v_orders_weekly AS
SELECT
  store,
  week_start,
  week_end,
  SUM(vm_num(number_of_orders))        AS num_orders
FROM vm_orders_by_channel
GROUP BY store, week_start, week_end;

-- ---------------------------------------------------------------------------
-- 3. New vs return customers per store/week.
--    CSV columns confirmed: order_window, new_customer_orders,
--    return_customer_orders, new_customer_order_value, return_customer_order_value,
--    new_customer_atv, return_customer_atv.
--    NOTE: this report counts ORDERS by customer type (new vs returning) plus
--    their revenue/ATV — there is no distinct headcount column, so "Customer
--    Count" is taken here as identified orders (new + return).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vm_v_customers_weekly AS
SELECT
  store,
  week_start,
  week_end,
  SUM(vm_num(new_customer_orders))         AS new_customer_orders,
  SUM(vm_num(return_customer_orders))      AS return_customer_orders,
  SUM(vm_num(new_customer_orders)) + SUM(vm_num(return_customer_orders)) AS customer_count,
  SUM(vm_num(new_customer_order_value))    AS new_customer_value,
  SUM(vm_num(return_customer_order_value)) AS return_customer_value
FROM vm_customer_metrics
GROUP BY store, week_start, week_end;

-- ---------------------------------------------------------------------------
-- 4. Executive weekly KPIs (everything except WoW).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vm_v_exec_weekly AS
WITH sales AS (
  SELECT
    store, week_start, week_end,
    SUM(net_sales) FILTER (WHERE bucket = 'delivery')   AS delivery_sales,
    SUM(net_sales) FILTER (WHERE bucket = 'collection') AS collection_sales,
    SUM(net_sales) FILTER (WHERE bucket = 'eat_in')     AS eat_in_sales,
    SUM(net_sales)                                       AS net_sales
  FROM vm_v_net_sales_bucketed
  GROUP BY store, week_start, week_end
)
SELECT
  s.store,
  s.week_start,
  s.week_end,
  s.net_sales,
  o.num_orders,
  CASE WHEN o.num_orders > 0
       THEN round(s.net_sales / o.num_orders, 2) END                AS aov,
  c.customer_count,
  c.new_customer_orders,
  c.return_customer_orders,
  round(100 * coalesce(c.new_customer_orders,0)
        / NULLIF(c.customer_count,0), 1)                                AS new_customer_pct,
  round(100 * coalesce(s.delivery_sales,0)   / NULLIF(s.net_sales,0), 1) AS delivery_pct,
  round(100 * coalesce(s.collection_sales,0) / NULLIF(s.net_sales,0), 1) AS collection_pct,
  round(100 * coalesce(s.eat_in_sales,0)     / NULLIF(s.net_sales,0), 1) AS eat_in_pct,
  s.delivery_sales,
  s.collection_sales,
  s.eat_in_sales
FROM sales s
LEFT JOIN vm_v_orders_weekly    o ON o.store = s.store AND o.week_start = s.week_start
LEFT JOIN vm_v_customers_weekly c ON c.store = s.store AND c.week_start = s.week_start;

-- ---------------------------------------------------------------------------
-- 5. Week-on-week growth (needs >= 2 weeks in the window).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vm_v_exec_wow AS
SELECT
  store,
  week_start,
  week_end,
  net_sales,
  num_orders,
  aov,
  customer_count,
  delivery_pct,
  collection_pct,
  eat_in_pct,
  lag(net_sales) OVER w                                            AS prev_net_sales,
  round(
    100 * (net_sales - lag(net_sales) OVER w)
          / NULLIF(lag(net_sales) OVER w, 0), 1)                   AS net_sales_wow_pct,
  round(
    100 * (num_orders - lag(num_orders) OVER w)
          / NULLIF(lag(num_orders) OVER w, 0), 1)                  AS orders_wow_pct,
  round(
    100 * (customer_count - lag(customer_count) OVER w)
          / NULLIF(lag(customer_count) OVER w, 0), 1)              AS customers_wow_pct
FROM vm_v_exec_weekly
WINDOW w AS (PARTITION BY store ORDER BY week_start);

-- ---------------------------------------------------------------------------
-- 6. Delivery sub-channel week-on-week growth
--    (e.g. Uber Eats vs Deliveroo vs Own-delivery individually).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vm_v_delivery_subchannel_wow AS
WITH d AS (
  SELECT store, week_start, week_end, channel,
         SUM(net_sales) AS net_sales
  FROM vm_v_net_sales_bucketed
  WHERE bucket = 'delivery'
  GROUP BY store, week_start, week_end, channel
)
SELECT
  store,
  week_start,
  week_end,
  channel,
  net_sales,
  lag(net_sales) OVER w AS prev_net_sales,
  round(
    100 * (net_sales - lag(net_sales) OVER w)
          / NULLIF(lag(net_sales) OVER w, 0), 1) AS wow_pct
FROM d
WINDOW w AS (PARTITION BY store, channel ORDER BY week_start);

-- ---------------------------------------------------------------------------
-- 7. Reconciliation: latest complete week per store, so the user can compare
--    these numbers directly against what VM Hub shows on screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vm_v_reconciliation_latest AS
SELECT e.*
FROM vm_v_exec_weekly e
JOIN (
  SELECT store, max(week_start) AS max_week
  FROM vm_v_exec_weekly
  GROUP BY store
) m ON m.store = e.store AND m.max_week = e.week_start
ORDER BY e.store;
