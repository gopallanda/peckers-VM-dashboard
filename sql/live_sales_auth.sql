-- ---------------------------------------------------------------------------
-- vm_live_auth — the VM Hub refresh token for the LIVE gross-sales endpoint
-- (GET /api/live/gross-sales, see docs/live-gross-sales.md).
--
-- Why a table and not just the VM_REFRESH_TOKEN env var: VM Hub MAY rotate the
-- refresh token on use, and Render's disk is ephemeral. If it rotates and the
-- new value only lives in memory, the next restart would come back with a dead
-- token. So after every successful refresh the server upserts the current
-- token here, and reads it back before falling back to the env var.
--
-- Single row (id is pinned to 1).
--
-- RLS is ENABLED WITH NO POLICIES on purpose: the anon/publishable key and
-- PostgREST can read nothing. Only the direct Postgres connection
-- (SUPABASE_DB_URL, which bypasses RLS as the table owner) can see the token.
--
-- Run once in the Supabase SQL editor. Idempotent.
-- ---------------------------------------------------------------------------

create table if not exists vm_live_auth (
  id            int         primary key default 1 check (id = 1),
  refresh_token text        not null,
  updated_at    timestamptz not null default now()
);

alter table vm_live_auth enable row level security;

-- To force the server back onto the VM_REFRESH_TOKEN env var (e.g. after
-- re-authenticating and updating Render), run:
--   delete from vm_live_auth;
