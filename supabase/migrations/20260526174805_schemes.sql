-- =============================================================================
-- Schemes — the editable parametric design layer (per canonical vocabulary).
-- A Scheme is a building footprint + parameters drawn against a parcel, which
-- gets checked against a constraint set (the parcel's approved cited claims) by
-- check_scheme_compliance. Scheme is scoped to a PARCEL for now; the eventual
-- Project/Site/Assemblage hierarchy can wrap this later without restructuring.
--
-- RLS-ready but NOT enabled (consistent with Phase 0 posture; auth/RLS is a
-- focused follow-up). owner_id column exists so RLS policies are additive later.
-- =============================================================================

create table schemes (
  id            uuid primary key default gen_random_uuid(),
  parcel_id     uuid not null references parcels(id) on delete cascade,
  owner_id      uuid,                              -- for future RLS; null in open phase
  name          text,                              -- optional user label
  footprint     extensions.geometry(Polygon, 4326) not null,
  height_ft     numeric,                           -- building height parameter
  params        jsonb not null default '{}'::jsonb, -- extensible: future stories, use, etc.
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index schemes_parcel_id_idx on schemes (parcel_id);
create index schemes_footprint_gix on schemes using gist (footprint);

create trigger schemes_set_updated_at
  before update on schemes
  for each row execute function set_updated_at();

comment on table schemes is
  'Editable parametric design layer: a building footprint + parameters drawn '
  'against a parcel, checked against cited constraints by check_scheme_compliance. '
  'Scheme scoped to parcel now; Project/Site hierarchy wraps later. RLS deferred.';
