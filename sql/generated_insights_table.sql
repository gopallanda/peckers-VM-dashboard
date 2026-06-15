-- ===========================================================================
-- generated_insights_table.sql
-- ----------------------------
-- Cache table for AI-generated (or rule-based) weekly dashboard summaries.
--
-- Run ONCE in the VM Analytics Supabase project (same project as kpi_views.sql).
-- After this, the Next.js API route /api/vm-analytics/insights will read from
-- this table on cache hit instead of calling Claude, so Claude is only called
-- once per (dashboard, week) pair — the first time any user views that page.
--
-- Usage:
--   psql "$SUPABASE_DB_URL" -f sql/generated_insights_table.sql
-- ===========================================================================

CREATE TABLE IF NOT EXISTS vm_generated_insights (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start_iso DATE         NOT NULL,
  dashboard      TEXT         NOT NULL,   -- 'executive' | 'products' | 'daypart' | 'delivery' | 'store-comparison'
  summary        TEXT         NOT NULL,
  bullets        TEXT[]       NOT NULL DEFAULT '{}',
  source         TEXT         NOT NULL DEFAULT 'rules', -- 'claude' | 'rules'
  generated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- One cached insight per (week, dashboard). Upsert overwrites on conflict.
  CONSTRAINT vm_generated_insights_week_dashboard UNIQUE (week_start_iso, dashboard)
);

-- ---------------------------------------------------------------------------
-- RLS: The anon key (used by the server-side Next.js API route) must be able
-- to read and write. The data is AI-generated summaries — not sensitive.
-- ---------------------------------------------------------------------------
ALTER TABLE vm_generated_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vm_insights_select" ON vm_generated_insights;
CREATE POLICY "vm_insights_select"
  ON vm_generated_insights FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "vm_insights_insert" ON vm_generated_insights;
CREATE POLICY "vm_insights_insert"
  ON vm_generated_insights FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "vm_insights_update" ON vm_generated_insights;
CREATE POLICY "vm_insights_update"
  ON vm_generated_insights FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Allow the frontend anon key to query this table.
GRANT SELECT, INSERT, UPDATE ON vm_generated_insights TO anon, authenticated;
