-- ============================================================================
-- SDVsolution — Phase 6: shared files (e.g. ARXML .zip packages)
-- Run ONCE in Supabase → SQL Editor (after setup.sql and phase2–phase5). Safe to re-run.
--
-- Adds:
--   * A PRIVATE storage bucket "shared-files". Each company's files live under a folder named
--     after its org id, so one company can never see another's files.
--   * public.upload_grants — the emails an owner/admin has allowed to UPLOAD. Owners and admins
--     can always upload. Everyone in the company (owner/admin/editor/viewer) can DOWNLOAD.
--   * public.shared_files — one row per uploaded file (name, size, SHA-256, who, when, note).
--   * Seeds an upload grant + a viewer invitation for uploader@example.com in the
--     sdvsolution.com company (viewers are read-only and not billed as editors).
-- ============================================================================

-- ---------- who may upload --------------------------------------------------
create table if not exists public.upload_grants (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,                       -- lowercased
  granted_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (org_id, email)
);
alter table public.upload_grants enable row level security;

create or replace function public.can_upload_files()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_org_admin() or exists (
    select 1 from public.upload_grants g
    where g.org_id = public.current_org_id()
      and lower(g.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
grant execute on function public.can_upload_files() to authenticated;

drop policy if exists ug_select on public.upload_grants;
create policy ug_select on public.upload_grants for select using (org_id = public.current_org_id());
drop policy if exists ug_insert on public.upload_grants;
create policy ug_insert on public.upload_grants for insert with check (org_id = public.current_org_id() and public.is_org_admin());
drop policy if exists ug_delete on public.upload_grants;
create policy ug_delete on public.upload_grants for delete using (org_id = public.current_org_id() and public.is_org_admin());
grant select, insert, delete on public.upload_grants to authenticated;

-- ---------- file catalogue ----------------------------------------------------
create table if not exists public.shared_files (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  path          text not null unique,              -- <org_id>/<uuid>/<file name> in the bucket
  name          text not null,
  bytes         bigint not null,
  sha256        text,
  note          text,
  uploaded_by   uuid references auth.users(id) default auth.uid(),
  uploader_email text,
  created_at    timestamptz not null default now()
);
create index if not exists shared_files_org_idx on public.shared_files (org_id, created_at desc);
alter table public.shared_files enable row level security;

drop policy if exists sf_select on public.shared_files;
create policy sf_select on public.shared_files for select using (org_id = public.current_org_id());
drop policy if exists sf_insert on public.shared_files;
create policy sf_insert on public.shared_files for insert with check (
  org_id = public.current_org_id() and public.can_upload_files() and uploaded_by = auth.uid());
drop policy if exists sf_delete on public.shared_files;
create policy sf_delete on public.shared_files for delete using (
  org_id = public.current_org_id() and (public.is_org_admin() or uploaded_by = auth.uid()));
grant select, insert, delete on public.shared_files to authenticated;

-- ---------- private bucket + storage policies --------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('shared-files', 'shared-files', false, 52428800)   -- 50 MB per file
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "shared files: company can read" on storage.objects;
create policy "shared files: company can read" on storage.objects for select to authenticated using (
  bucket_id = 'shared-files' and (storage.foldername(name))[1] = public.current_org_id()::text);

drop policy if exists "shared files: granted users upload" on storage.objects;
create policy "shared files: granted users upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'shared-files' and (storage.foldername(name))[1] = public.current_org_id()::text and public.can_upload_files());

drop policy if exists "shared files: admin or uploader delete" on storage.objects;
create policy "shared files: admin or uploader delete" on storage.objects for delete to authenticated using (
  bucket_id = 'shared-files' and (storage.foldername(name))[1] = public.current_org_id()::text
  and (public.is_org_admin() or owner = auth.uid()));

-- ---------- seed: uploader@example.com may upload (sdvsolution.com company) ----------
do $$
declare org uuid;
begin
  select id into org from public.organizations where domain = 'sdvsolution.com';
  if org is null then
    raise notice 'No sdvsolution.com company found — add the upload grant from the app instead.';
    return;
  end if;
  insert into public.upload_grants (org_id, email) values (org, 'uploader@example.com')
    on conflict (org_id, email) do nothing;
  -- Invite him into the company as a viewer (read-only, not a billed editor) unless he is already a member.
  if not exists (select 1 from public.memberships where org_id = org and lower(email) = 'uploader@example.com') then
    insert into public.invitations (org_id, email, role, status) values (org, 'uploader@example.com', 'viewer', 'pending')
      on conflict (org_id, email) do update set status = 'pending', role = excluded.role;
  end if;
end $$;
