-- ============================================================================
-- SDVsolution — Phase 5: build jobs, build files, runners
-- Run ONCE in Supabase → SQL Editor, AFTER setup.sql / phase2 / phase3 / phase4.
--
-- A "build" takes an approved Behavior Model FROM A BASELINE, generates C + unit tests,
-- compiles and runs them on a runner, and records the result + the generated files.
--
--   builds       one row per job. `model` is a frozen copy of the Behavior Model exactly
--                as stored in the chosen baseline (the immutable build input).
--   build_files  the text files a build produced (generated C, test results XML, manifest).
--   runners      registered workers. org_id NULL = the managed fleet; otherwise a runner a
--                customer runs on their own infrastructure (it only ever sees that org's jobs).
--
-- Security model:
--   * Users can only READ their own company's builds/files (RLS). They cannot insert or
--     update builds directly — job creation goes through /api/builds, which re-checks the
--     build gate on the server (approved + QM-confirmed model, from a baseline).
--   * Runners never get a database key. They call /api/runner with a revocable token whose
--     SHA-256 hash is stored here; the plain token is shown once at creation.
--   * `runners` has NO user-facing policies: it is reachable only via the service-role API.
-- ============================================================================

create table if not exists public.builds (
  id               uuid primary key default gen_random_uuid(),
  build_no         bigint generated always as identity,          -- shown as B-<n>
  org_id           uuid not null references public.organizations(id) on delete cascade,
  requested_by     uuid references auth.users(id),
  requested_email  text,
  bm_id            text not null,                                 -- e.g. BM-L2-BODY-00194
  function_id      text not null,
  title            text,
  baseline_id      text not null,
  baseline_name    text,
  model            jsonb not null,                                -- frozen Behavior Model from the baseline
  model_hash       text not null,
  generator_version text,
  pool             text not null default 'managed' check (pool in ('managed','customer')),
  status           text not null default 'queued'
                   check (status in ('queued','running','passed','failed','errored','canceled')),
  runner_id        uuid,
  attempts         int  not null default 0,
  created_at       timestamptz not null default now(),
  claimed_at       timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  last_heartbeat   timestamptz,
  result           jsonb,                                         -- steps, test counts, tool versions
  log              text                                           -- tail of the runner log (size-capped by the API)
);
create index if not exists builds_queue_idx on public.builds (status, pool, created_at);
create index if not exists builds_org_idx   on public.builds (org_id, created_at desc);

create table if not exists public.build_files (
  build_id   uuid not null references public.builds(id) on delete cascade,
  name       text not null,
  content    text not null,
  sha256     text not null,
  bytes      int  not null,
  primary key (build_id, name)
);

create table if not exists public.runners (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references public.organizations(id) on delete cascade,   -- NULL = managed fleet
  name         text not null,
  token_hash   text not null unique,                                          -- sha256(token); plain token never stored
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  info         jsonb not null default '{}'::jsonb                             -- runner-reported versions (compiler, node …)
);
create index if not exists runners_org_idx on public.runners (org_id);

-- ---------- row level security ----------------------------------------------
alter table public.builds      enable row level security;
alter table public.build_files enable row level security;
alter table public.runners     enable row level security;     -- no policies: service-role API only

drop policy if exists builds_select on public.builds;
create policy builds_select on public.builds for select using (org_id = public.current_org_id());

drop policy if exists build_files_select on public.build_files;
create policy build_files_select on public.build_files for select using (
  exists (select 1 from public.builds b where b.id = build_files.build_id and b.org_id = public.current_org_id()));

grant select on public.builds, public.build_files to authenticated;
-- (no insert/update/delete grants: only the service-role API writes these tables)

-- ---------- atomic job claim ------------------------------------------------
-- A runner asks for the next queued job in its pool. `for update skip locked` means two
-- runners can never take the same job. A customer runner only sees its own org's jobs.
create or replace function public.claim_build(p_runner uuid, p_org uuid, p_pool text)
returns setof public.builds language plpgsql security definer set search_path = public as $$
begin
  return query
  with next as (
    select id from public.builds
     where status = 'queued' and pool = p_pool and (p_org is null or org_id = p_org)
     order by created_at
     for update skip locked
     limit 1)
  update public.builds b
     set status = 'running', runner_id = p_runner, claimed_at = now(),
         started_at = now(), last_heartbeat = now(), attempts = b.attempts + 1
    from next where b.id = next.id
  returning b.*;
end $$;

-- A runner that dies mid-job stops sending heartbeats. Put its job back in the queue
-- (up to 3 attempts), otherwise mark it errored so it never hangs forever.
create or replace function public.requeue_stale_builds(p_minutes int default 5)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.builds
     set status = case when attempts < 3 then 'queued' else 'errored' end,
         runner_id = null,
         finished_at = case when attempts < 3 then null else now() end,
         result = case when attempts < 3 then result else jsonb_build_object('error', 'runner stopped responding (3 attempts)') end
   where status = 'running' and last_heartbeat < now() - make_interval(mins => p_minutes);
  get diagnostics n = row_count; return n;
end $$;

revoke all on function public.claim_build(uuid, uuid, text)  from public, anon, authenticated;
revoke all on function public.requeue_stale_builds(int)      from public, anon, authenticated;
grant execute on function public.claim_build(uuid, uuid, text) to service_role;
grant execute on function public.requeue_stale_builds(int)     to service_role;
