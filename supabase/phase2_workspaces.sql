-- ============================================================================
-- SDVsolution — Phase 2: per-company workspace persistence
-- Run this AFTER setup.sql, once, in Supabase → SQL Editor.
--
-- Stores each company's entire working state (requirements, K-Matrix / imported
-- DBC-LDF-ARXML, baselines, review status, standards, etc.) as one JSON document
-- per organization. RLS guarantees a company can only read/write its own row,
-- so Company X's data is never visible to Company Y — enforced on the server.
-- ============================================================================

create table if not exists public.workspaces (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table public.workspaces enable row level security;

-- read + write only your own company's workspace
drop policy if exists ws_select on public.workspaces;
create policy ws_select on public.workspaces
  for select using (org_id = public.current_org_id());

drop policy if exists ws_insert on public.workspaces;
create policy ws_insert on public.workspaces
  for insert with check (org_id = public.current_org_id());

drop policy if exists ws_update on public.workspaces;
create policy ws_update on public.workspaces
  for update using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());

-- make sure the app role can reach the table (RLS still gates every row)
grant select, insert, update on public.workspaces to authenticated;
