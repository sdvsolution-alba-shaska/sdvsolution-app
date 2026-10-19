-- ============================================================================
-- One-off fix: move uploader@example.com into the SDVsolution company.
--
-- Why: his account existed before he was invited, so the sign-up rule put him in his OWN
-- company ("Oem", by email domain) as its owner. Files he uploads go to that company,
-- which SDVsolution can't see. This moves him into the sdvsolution.com company as a viewer
-- (he keeps upload rights through the upload list) and removes the now-empty Oem company.
--
-- Before running: George should DELETE the file he uploaded (Shared files → Delete), because
-- after the move he can no longer reach his old company's files. Then run this, then he re-uploads.
-- Run in Supabase → SQL Editor. Safe to re-run.
-- ============================================================================
do $$
declare
  sdv  uuid;
  old_org uuid;
  others int;
begin
  select id into sdv from public.organizations where domain = 'sdvsolution.com';
  if sdv is null then raise exception 'No sdvsolution.com company found.'; end if;

  select org_id into old_org from public.memberships where lower(email) = 'uploader@example.com';
  if old_org is null then raise exception 'uploader@example.com has no account yet — he should sign up first.'; end if;
  if old_org = sdv then raise notice 'Already in the SDVsolution company — nothing to move.'; return; end if;

  -- the last-owner guard would block moving the only owner of the old company
  alter table public.memberships disable trigger trg_guard_last_owner;
  update public.memberships set org_id = sdv, role = 'viewer' where lower(email) = 'uploader@example.com';
  alter table public.memberships enable trigger trg_guard_last_owner;

  update public.invitations set status = 'accepted' where org_id = sdv and lower(email) = 'uploader@example.com';
  insert into public.upload_grants (org_id, email) values (sdv, 'uploader@example.com') on conflict (org_id, email) do nothing;

  -- remove the old company only if nobody else is in it
  select count(*) into others from public.memberships where org_id = old_org;
  if others = 0 then
    delete from public.organizations where id = old_org;
    raise notice 'Moved George into SDVsolution and removed his empty company.';
  else
    raise notice 'Moved George into SDVsolution; his old company still has % member(s) and was kept.', others;
  end if;
end $$;

-- Check: should show sdvsolution.com · viewer
select m.email, o.domain, m.role from public.memberships m join public.organizations o on o.id = m.org_id
 where lower(m.email) = 'uploader@example.com';
