# Brief: building the Loyalty & Discounts dashboard (Peckers / vm-extractor)

Context for a new chat. Everything below was checked against the live Supabase
database on 2026-10-16.

## 1. Where the data comes from

- **Source:** Vita Mojo (VM Hub) EPOS reporting, scraped weekly by the
  `vm-extractor` repo (Node, Playwright) into **Supabase Postgres**.
- **Two stores:** `Peckers Hitchin`, `Peckers Stevenage`.
- **Cadence:** a GitHub Actions run every Monday ~01:30 UTC loads the previous
  complete Mon–Sun week. Core sales reports load first (`npm run sync`), then the
  loyalty step (`npm run sync:loyalty`).
- **Raw tables are all TEXT.** Every raw `vm_*` table stores CSV values as text,
  plus meta columns `id, store, week_start DATE, week_end DATE, source_file,
  ingested_at`. `store` is the canonical store name the sync ran for;
  `week_start` is always a Monday. Numeric casting belongs in SQL views.
- **View conventions (existing):** views are named `vm_v_*`, built in `sql/*.sql`,
  and end with `GRANT SELECT ... TO anon, authenticated`. They always filter
  `store IS NOT NULL AND week_start IS NOT NULL`. Week-on-week uses
  `LAG(x) OVER (PARTITION BY store ORDER BY week_start)` with `NULLIF(...,0)`.
  Week maths is in UTC; wall-clock / trading-hours analysis is in Europe/London.
- **Helper functions:** `vm_num(text)` strips £/commas/% and casts to numeric.
  **Bug for these tables:** `vm_num('0E-17')` returns **17**, not 0 (see §5).
- **Consumer:** an external Next.js app reads the `vm_v_*` views through the
  Supabase **anon** key.

## 2. The loyalty / discount tables

Coverage: weeks **2026-03-02 → 2026-10-05** (32 weeks), both stores, fully
backfilled and reconciled. Each later week is added automatically.

### Weekly tables (one load per store per Mon–Sun week)

**`vm_loyalty_per_customer`** — 7,444 rows, weeks from 2026-04-13
- **Grain:** one row per loyalty member who earned or redeemed points at that
  store that week.
- **Columns:** `user_uuid`, plus `points_earnt_*` and `points_redeemed_*` for
  each channel: `click_collect`, `kiosk`, `opat`, `delivery`. Values are
  integers stored as text.
- No rows before mid-April (the scheme launched 2026-04-14).

**`vm_loyalty_per_channel`** — 164 rows, weeks from 2026-05-04
- **Grain:** one row per channel per store-week. Channels: `click & collect`,
  `kiosk`, `own delivery`, `pos`.
- **Columns:** `channel`, `points_earnt`, `points_redeemed`.
- **Values are SHARES (0–1, summing to 1 per store-week), not points.** Never
  sum shares across stores.
- 11 store-weeks are missing on purpose (**NO-DATA**). VM Hub's own query fails
  whenever nobody redeemed points that week (the share calculation divides by
  zero): Hitchin 04-13, 04-20, 04-27, 05-11, 06-01; Stevenage 04-13, 04-20,
  04-27, 05-04, 05-11, 05-18. Show these as "no redemptions", not as gaps.
- This table has a `pos` (till) channel; `vm_loyalty_per_customer` doesn't.
  The two don't reconcile exactly.

**`vm_discounts_info_customer`** — 7,198 rows, all 32 weeks
- **Grain:** one row per discounted order (`order_uuid` is unique).
- **Columns:** `order_uuid, discount_name, discount_code, created_at,
  collection_at, store_2, channel, payment_method, order_status, order_number,
  table_number, gross_sales_before_discounts_and_refunds, discounts, refunds,
  gross_sales, vatable_sales, non_vatable_sales, vat, net_sales,
  deprecated_current_vat, deprecated_current_net_sales, products_ordered`
  (free text like "1x Halloumi Fries; 1x …").
- **channel values:** Kiosk 3,008 · Just Eat 1,555 · Till (takeaway) 1,526 ·
  Own Delivery 600 · Click & Collect 373 · Till (eat-in) 97 · Deliveroo 39.
- **Top discount_name values:** "Loyalty - Free Milkshake for signup" 3,316 ·
  "JustEat Discount" 1,555 · "Blue Light Card Discount" 621 ·
  "Loyalty Gamma - Choose a side" 317 · "Loyalty Beta - pick one (…)" 207 ·
  "OG Burger Over 20 £" 198 · "Soft Launch Peckers Stevenage" 119 ·
  "10% off Instore Visit" 115.
- **Text quirks:** `discount_name` has trailing spaces, so always `btrim()`.
  `discount_code` is blank for 5,969 of 7,198 rows.
- `created_at` / `collection_at` are ISO-8601 UTC text (`2026-10-09T18:06:11.661Z`):
  cast with `::timestamptz`.
- `store_2` is the report's own store column and always equals `store`.
- `order_status` is almost all `collected` (1 `ready-to-collect`).

**`vm_loyalty_users`** — 5,506 rows, all 32 weeks
- **Grain:** one row per customer account **registered** that week (a sign-up
  list).
- **Columns:** `registered_at` (ISO UTC text), `user_uuid`, `lang`, `store_2`,
  `user_role`.
- Filter `user_role = 'customer'`: one row is a `kiosk` device account.
- **Hitchin anomaly:** Hitchin jumps from ~20–30 to 590–815 sign-ups a week from
  2026-04-13 (launch week); Stevenage stays at ~30–75. No duplicates; it's VM
  Hub's attribution, possibly app sign-ups credited to Hitchin by default
  (unconfirmed). Caveat it, or ask Vita Mojo, before comparing stores.

**`vm_sales_by_discount_type`** — 587 rows, all 32 weeks
- **Grain:** one row per promotion per store-week.
- **Columns:** `promotion_name`, `gross_sales_generated`, `total_discounts`.
  Numbers have long decimals like `123.000000000000000000000000000`.
- **Top promotions:** Blue Light Card Discount, Loyalty Gamma - Choose a side,
  First Delivery, Loyalty Beta, JustEat Discount, Soft Launch Peckers Stevenage,
  OG Burger Over 20 £, 10% off Instore Visit, Free Churros, Loyalty Alpha - Meals.

### Snapshot tables (state at the time of the weekly run)

These are stamped with `week_start` = the week being synced, and history only
starts at **2026-10-05**. Each weekly run adds one more week, building a time
series. They can't be backfilled.

**`vm_loyalty_earnt_redeemed`** — 14,609 rows (Hitchin 9,699 + Stevenage 4,910)
- **Grain:** one row per loyalty member attributed to a store. A member appears
  under one store only.
- **Columns:** `uuid` (= user uuid), `balance_accrued`, `balance_redeemed`,
  `current_balance`, `last_activity_date` (ISO UTC).
- 8,427 members have `last_activity_date = 2026-04-14T01:00:03Z`. That's a bulk
  import at launch: members carried over with a balance but no activity since.
  Exclude them for "active members".

**`vm_loyalty_lifetime_per_customer`** — 2,862 rows, `store = 'All stores'`
- The chart ignores the store filter, so it's estate-wide.
- **Grain:** one row per member with any loyalty activity.
- **Columns:** `user_uuid`, `points_balance`, and `points_earnt_*` /
  `points_redeemed_*` per channel (click_collect, kiosk, opat, delivery).
- Every member here also appears in `vm_loyalty_earnt_redeemed`, but the
  balances agree only ~1 in 3 times. The two charts define balance differently,
  so don't mix them in one KPI.

## 3. Joining loyalty to sales (important)

- **Customer level:** `vm_detailed_sales_info.customer_id` carries a tenant
  prefix. **Join on `customer_id = 'Peckers_' || user_uuid`**; a bare
  `customer_id = user_uuid` matches nothing. Match rates: per_customer
  2,839/2,842, lifetime 2,841/2,862, users 4,339/5,506 (the rest signed up but
  have no orders in the synced data), earnt_redeemed 6,037/14,609.
- **Other id shapes:** `customer_id` also has values like `Peckers_<16 hex>`,
  `Peckers_gb:<uuid>`, `Peckers_H…`, `Peckers_P…`. These are non-member / guest /
  other identifiers and won't match loyalty uuids.
- **Order level:** `vm_discounts_info_customer.order_uuid =
  vm_detailed_sales_info.order_uuid` (7,053 of 7,198 match).
  `vm_detailed_sales_info` has **one row per order line**, so use
  `COUNT(DISTINCT order_uuid)` and don't sum order-level discount values across
  joined lines.
- **`vm_detailed_sales_info`** is the granular sales table: one row per order
  line, 274,703 rows, weeks 2026-03-02 → 2026-10-05. Columns include
  `order_uuid, customer_id, created_at, store, create_source, payment_method,
  category_name, menu_name, promotion_name, discounts, gross_sales, net_sales,
  eat_in_takeaway`. `COUNT(DISTINCT order_uuid)` per store-week matches the
  exec dashboard. There's a canonical channel CASE in `sql/kpi_views.sql`
  (Deliveroo / Uber Eats / Just Eat / Own Delivery / Click & Collect / Kiosk /
  Till eat-in / Till takeaway).

## 4. Personal data: none, keep it that way

- **Nothing personal is stored.** Names, emails, phone numbers, birth dates,
  marketing opt-in and the Acteol CRM id were stripped before load.
  `npm run verify:loyalty` checks there's no such column.
- **Customers are identified only by pseudonymous uuid.** Views granted to
  **anon** (the public Next.js key) should be aggregated: counts, sums and
  shares per store/week/channel/promotion. Keep per-customer rows (uuid-level)
  out of anon-granted views.

## 5. Gotchas for the SQL views

1. **Scientific notation:** `vm_num()` misreads values like `0E-17` (it returns
   17). For these tables cast safely, e.g.
   `CASE WHEN btrim(x) ~ '^-?[0-9.]+(E[-+]?[0-9]+)?$' THEN btrim(x)::numeric END`,
   or add a helper such as `vm_num_sci(text)`.
2. **Zero rows can be genuine:** pre-launch weeks (before 2026-04-13) have no
   loyalty-points rows, and NO-DATA per-channel weeks have none either. Use
   `vm_v_available_weeks` (or a generated week series) and `LEFT JOIN`, so
   empty weeks show as 0 / "no redemptions", not missing.
3. **Never sum per-channel shares;** compute shares from points where possible.
4. **`btrim()` text** like `discount_name` and `promotion_name`.
5. **Snapshot KPIs** (balances, liability) only have history from 2026-10-05.
6. **Hitchin sign-up attribution caveat** (see `vm_loyalty_users`).

## 6. KPI ideas the data supports

- **Sign-ups:** new members per week per store, with WoW.
- **Points:** earned vs redeemed per week, per store and per channel (from
  `vm_loyalty_per_customer` sums), redemption rate, active earners per week.
- **Points liability:** outstanding points (`current_balance` / `points_balance`)
  over time (snapshots, from 2026-10-05).
- **Discounts:** cost by promotion per week (`vm_sales_by_discount_type`), and
  discounted orders and their net sales by channel and promotion
  (`vm_discounts_info_customer`).
- **Discount penetration:** discounted orders ÷ all orders, using
  `COUNT(DISTINCT order_uuid)` from `vm_detailed_sales_info` per store-week.
- **Members vs non-members:** order count, AOV and net sales for loyalty members
  (join via `'Peckers_' || user_uuid`) against everyone else; repeat rate of
  members.
- **Signup offer:** the "Loyalty - Free Milkshake for signup" uptake and its
  cost.

## 7. Where things live in the repo

- `src/config.js` → `LOYALTY_REPORTS` (chart → table map, kinds).
- `docs/loyalty-sync.md` → full sync behaviour.
- `sql/*.sql` → existing views (`kpi_views.sql` defines the helpers; apply it
  first).
- New loyalty views should go in a new file, e.g. `sql/loyalty_views.sql`,
  following the conventions above.
