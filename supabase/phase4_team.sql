-- ============================================================================
-- SDVsolution — Phase 4: team invites + roles
-- Run ONCE in Supabase → SQL Editor (after setup.sql / phase2 / phase3).
--
-- Adds:
--   * Four real roles: owner · admin · editor · viewer.
--       - owner  : billing + team + edit  (first user of a company)
--       - admin  : team + edit
--       - editor : edit only
--       - viewer : read-only (does NOT count as a billed editor)
--     Legacy 'member' rows are treated as 'editor' by the app.
--   * public.invitations — an owner/admin pre-authorizes a teammate's email
--     (any domain, so contractors work) with a role. When that person signs up
--     with the invited email, the sign-up trigger drops them into the inviting
--     org with the invited role — no email service required.
--   * RLS so an owner/admin can manage their own org's members + invites, and
--     nobody can touch another company's rows.
-- ============================================================================

-- ---------- role of the caller -------------------------------------------
create or replace function public.current_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.memberships where user_id = auth.uid();
$$;

-- ---------- is the caller an owner or admin of their org? -----------------
create or replace function public.is_org_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role in ('owner','admin') from public.memberships where user_id = auth.uid()),
    false);
$$;

-- ---------- invitations (pre-authorized emails) ---------------------------
create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,                        -- lowercased work/personal email
  role        text not null default 'editor',       -- editor | viewer | admin
  invited_by  uuid references auth.users(id),
  status      text not null default 'pending',      -- pending | accepted | revoked
  created_at  timestamptz not null default now(),
  unique (org_id, email)
);
create index if not exists invitations_email_idx on public.invitations (lower(email));
create index if not exists invitations_org_idx   on public.invitations (org_id);

-- ---------- can this email join a company (anon-callable) -----------------
-- AuthGate calls this before sign-up so an INVITED contractor on a personal
-- domain (gmail, etc.) isn't blocked by the "use your work email" rule.
create or replace function public.email_is_invited(addr text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.invitations
    where lower(email) = lower(addr) and status = 'pending');
$$;
grant execute on function public.email_is_invited(text) to anon, authenticated;

-- ============================================================================
-- Sign-up trigger — invite takes precedence over email-domain auto-join.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  dom  text := public.email_domain(new.email);
  org  uuid;
  inv  public.invitations%rowtype;
begin
  -- 1) Was this email invited? If so, join THAT org with the invited role.
  select * into inv from public.invitations
   where lower(email) = lower(new.email) and status = 'pending'
   order by created_at desc limit 1;

  if inv.id is not null then
    insert into public.memberships (user_id, org_id, email, role)
    values (new.id, inv.org_id, new.email, inv.role)
    on conflict (user_id) do nothing;
    update public.invitations set status = 'accepted' where id = inv.id;
    return new;
  end if;

  -- 2) Otherwise fall back to company-domain auto-join.
  if dom is null or dom = '' then
    return new;
  end if;

  select id into org from public.organizations where domain = dom;
  if org is null then
    insert into public.organizations (domain, name)
    values (dom, initcap(split_part(dom, '.', 1)))
    returning id into org;
    insert into public.memberships (user_id, org_id, email, role)
    values (new.id, org, new.email, 'owner')          -- first user = owner
    on conflict (user_id) do nothing;
  else
    insert into public.memberships (user_id, org_id, email, role)
    values (new.id, org, new.email, 'editor')         -- teammate by domain
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
alter table public.invitations enable row level security;

-- Owner/admin can see + manage their org's invitations.
drop policy if exists inv_select on public.invitations;
create policy inv_select on public.invitations
  for select using (org_id = public.current_org_id() and public.is_org_admin());

drop policy if exists inv_insert on public.invitations;
create policy inv_insert on public.invitations
  for insert with check (org_id = public.current_org_id() and public.is_org_admin());

drop policy if exists inv_update on public.invitations;
create policy inv_update on public.invitations
  for update using (org_id = public.current_org_id() and public.is_org_admin());

drop policy if exists inv_delete on public.invitations;
create policy inv_delete on public.invitations
  for delete using (org_id = public.current_org_id() and public.is_org_admin());

-- Owner/admin can change roles + remove members within their org.
-- (Existing policies mem_select_own_org + mem_update_self stay in place.)
drop policy if exists mem_admin_update on public.memberships;
create policy mem_admin_update on public.memberships
  for update using (org_id = public.current_org_id() and public.is_org_admin());

drop policy if exists mem_admin_delete on public.memberships;
create policy mem_admin_delete on public.memberships
  for delete using (org_id = public.current_org_id() and public.is_org_admin());

-- ============================================================================
-- Safety net: never let a company end up with zero owners. Blocks demoting or
-- removing the last owner.
-- ============================================================================
create or replace function public.guard_last_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_org uuid := coalesce(old.org_id, new.org_id);
  owners_left int;
begin
  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    select count(*) into owners_left
      from public.memberships
     where org_id = target_org and role = 'owner'
       and user_id <> old.user_id;
    if owners_left = 0 then
      raise exception 'Cannot remove or demote the last owner of the company. Promote another member to owner first.';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_guard_last_owner on public.memberships;
create trigger trg_guard_last_owner
  before update or delete on public.memberships
  for each row execute function public.guard_last_owner();
