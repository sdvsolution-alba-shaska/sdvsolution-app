-- ============================================================================
-- SDVsolution — Phase 3: Stripe billing columns on organizations
-- Run once in Supabase → SQL Editor, after setup.sql and phase2_workspaces.sql.
--
-- The Stripe webhook (api/stripe-webhook.js) writes these using the service_role
-- key, which bypasses RLS. Clients can READ their own org (existing RLS), so the
-- app can show the current plan; only the server can change billing fields.
-- ============================================================================

alter table public.organizations
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text,
  add column if not exists plan_status            text,          -- trialing | active | past_due | canceled
  add column if not exists seats                  integer not null default 1,
  add column if not exists current_period_end     timestamptz;

-- plan already exists (default 'trial'); values used: trial | basic | pro | enterprise
create index if not exists organizations_stripe_customer_idx
  on public.organizations (stripe_customer_id);
