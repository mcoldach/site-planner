-- 20260528140000_scheme_footprints_table.sql
-- Phase 2, Opener A (multi-polygon schemes) — step 1 of 5: ADDITIVE ONLY.
-- Creates the scheme_footprints child table (one parametric primitive per row:
-- own geometry/height/use/params) and backfills one row per existing scheme
-- from the legacy single-footprint columns. NON-BREAKING: schemes.footprint,
-- schemes.height_ft, and all existing RPCs/views are untouched and keep working.

set search_path = public, extensions;

create table if not exists public.scheme_footprints (
  id          uuid primary key default gen_random_uuid(),
  scheme_id   uuid not null references public.schemes(id) on delete cascade,
  ordinal     integer not null default 0,
  label       text,
  use_code    text,
  footprint   extensions.geometry(Polygon, 4326) not null,
  height_ft   numeric,
  params      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists scheme_footprints_geom_gix
  on public.scheme_footprints using gist (footprint);
create index if not exists scheme_footprints_scheme_ordinal_ix
  on public.scheme_footprints (scheme_id, ordinal);

drop trigger if exists set_updated_at on public.scheme_footprints;
create trigger set_updated_at
  before update on public.scheme_footprints
  for each row execute function public.set_updated_at();

alter table public.scheme_footprints enable row level security;

drop policy if exists scheme_footprints_select on public.scheme_footprints;
create policy scheme_footprints_select on public.scheme_footprints
  for select to authenticated
  using (exists (
    select 1 from public.schemes s
    where s.id = scheme_footprints.scheme_id and s.owner_id = auth.uid()
  ));

drop policy if exists scheme_footprints_modify on public.scheme_footprints;
create policy scheme_footprints_modify on public.scheme_footprints
  for all to authenticated
  using (exists (
    select 1 from public.schemes s
    where s.id = scheme_footprints.scheme_id and s.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.schemes s
    where s.id = scheme_footprints.scheme_id and s.owner_id = auth.uid()
  ));

insert into public.scheme_footprints (scheme_id, ordinal, label, footprint, height_ft)
select s.id, 0, 'Building 1', s.footprint, s.height_ft
from public.schemes s
where s.footprint is not null
  and not exists (
    select 1 from public.scheme_footprints f where f.scheme_id = s.id
  );
