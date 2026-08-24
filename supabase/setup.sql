-- ============================================================================
-- SDVsolution — multi-tenant auth schema + Row-Level Security (RLS)
-- Run this once in Supabase → SQL Editor → New query → paste → Run.
--
-- What it does:
--   * Each COMPANY = one row in public.organizations, keyed by email domain.
--   * When a user confirms sign-up, a trigger reads their email domain and:
--       - joins them to the existing org for that domain, OR
--       - creates the org (they become its 'owner') if it's the first user.
--   * RLS guarantees a user can only ever read/write rows for THEIR org.
--     This is the part that makes "Company X email -> Company X data only"
--     actually secure, because it runs on the server, not in the browser.
--
-- Phase 1 ships organizations + memberships (access control). Phase 2 adds the
-- requirements tables (projects/requirements/...) — a template is included at
-- the bottom, commented out, so the pattern is ready when you migrate data.
-- ============================================================================

-- ---------- helper: extract domain from an email --------------------------
create or replace function public.email_domain(addr text)
returns text language sql immutable as $$
  select lower(split_part(addr, '@', 2));
$$;

-- ---------- organizations (one per company domain) ------------------------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  domain      text not null unique,            -- e.g. 'companyx.com'
  name        text not null,                   -- defaults to the domain; editable later
  plan        text not null default 'trial',   -- trial | basic | pro | enterprise
  created_at  timestamptz not null default now()
);

-- ---------- memberships (which user belongs to which org) -----------------
create table if not exists public.memberships (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role        text not null default 'member',  -- owner | admin | member
  created_at  timestamptz not null default now()
);
create index if not exists memberships_org_idx on public.memberships(org_id);

-- ---------- convenience: the caller's org id ------------------------------
create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.memberships where user_id = auth.uid();
$$;

-- ============================================================================
-- Trigger: assign each new user to their company on sign-up.
-- Fires when a row is created in auth.users (Supabase's built-in users table).
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  dom  text := public.email_domain(new.email);
  org  uuid;
begin
  if dom is null or dom = '' then
    return new;  -- no domain; nothing to do
  end if;

  -- find or create the org for this domain
  select id into org from public.organizations where domain = dom;
  if org is null then
    insert into public.organizations (domain, name)
    values (dom, initcap(split_part(dom, '.', 1)))
    returning id into org;

    -- first user of a brand-new company workspace becomes its owner
    insert into public.memberships (user_id, org_id, email, role)
    values (new.id, org, new.email, 'owner')
    on conflict (user_id) do nothing;
  else
    -- teammate joining an existing company
    insert into public.memberships (user_id, org_id, email, role)
    values (new.id, org, new.email, 'member')
    on conflict (user_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Row-Level Security
-- ============================================================================
alter table public.organizations enable row level security;
alter table public.memberships   enable row level security;

-- a user can read only their own org
drop policy if exists org_select_own on public.organizations;
create policy org_select_own on public.organizations
  for select using (id = public.current_org_id());

-- a user can read memberships only within their own org
drop policy if exists mem_select_own_org on public.memberships;
create policy mem_select_own_org on public.memberships
  for select using (org_id = public.current_org_id());

-- a user can read/update their own membership row
drop policy if exists mem_update_self on public.memberships;
create policy mem_update_self on public.memberships
  for update using (user_id = auth.uid());

-- ============================================================================
-- PHASE 2 TEMPLATE (commented out) — company-isolated requirements data.
-- Uncomment and extend when you migrate the tool's stores into the DB. Every
-- tenant table follows the SAME pattern: an org_id column + an RLS policy that
-- checks org_id = current_org_id(). That single rule enforces isolation.
-- ============================================================================
-- create table if not exists public.projects (
--   id         uuid primary key default gen_random_uuid(),
--   org_id     uuid not null references public.organizations(id) on delete cascade,
--   name       text not null,
--   created_by uuid references auth.users(id),
--   created_at timestamptz not null default now()
-- );
-- alter table public.projects enable row level security;
-- create policy projects_rw on public.projects
--   using (org_id = public.current_org_id())
--   with check (org_id = public.current_org_id());
--
-- create table if not exists public.requirements (
--   id         uuid primary key default gen_random_uuid(),
--   org_id     uuid not null references public.organizations(id) on delete cascade,
--   project_id uuid references public.projects(id) on delete cascade,
--   req_id     text,           -- e.g. SYS-001
--   level      text,           -- SYS | SWE | HWE
--   payload    jsonb not null default '{}',
--   updated_at timestamptz not null default now()
-- );
-- alter table public.requirements enable row level security;
-- create policy requirements_rw on public.requirements
--   using (org_id = public.current_org_id())
--   with check (org_id = public.current_org_id());
