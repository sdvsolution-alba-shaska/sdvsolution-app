-- ============================================================================
-- SDVsolution — Phase 7: Ethernet backbone K-Matrix storage
-- Run ONCE in Supabase → SQL Editor (after phase6). Safe to re-run.
--
-- The ETH K-Matrix can hold hundreds of PDUs and tens of thousands of signals (an imported BackboneETH.lua is
-- ~4.8 MB as JSON). Keeping it inside the workspace document would re-upload it on every edit, so it gets its own
-- row per company, stored gzip-compressed (base64) — about 0.5 MB for a full backbone — and saved only when it changes.
-- Everyone in the company can read it; owners, admins and editors can write it (viewers are read-only).
-- ============================================================================
create table if not exists public.eth_kmatrix (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  data_gz     text not null,                 -- base64( gzip( JSON ) )
  pdus        int,
  signals     int,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);
alter table public.eth_kmatrix enable row level security;

drop policy if exists ethkm_select on public.eth_kmatrix;
create policy ethkm_select on public.eth_kmatrix for select using (org_id = public.current_org_id());
drop policy if exists ethkm_insert on public.eth_kmatrix;
create policy ethkm_insert on public.eth_kmatrix for insert with check (
  org_id = public.current_org_id() and coalesce(public.current_role(), '') <> 'viewer');
drop policy if exists ethkm_update on public.eth_kmatrix;
create policy ethkm_update on public.eth_kmatrix for update using (
  org_id = public.current_org_id() and coalesce(public.current_role(), '') <> 'viewer');
grant select, insert, update on public.eth_kmatrix to authenticated;
