-- =============================================================================
-- Project / Site (Assemblage) / Scheme hierarchy — Phase 1 per the build plan
-- ("Model Projects, Parcels, Assemblages, Constraints, Schemes").
--
-- Project        — top-level container; carries the constraint BASIS (rezoning
--                  seam, as data not workflow: current zoning vs hypothetical).
-- Site           — an Assemblage of one-or-more parcels (via site_parcels join).
-- site_parcels   — join table; V1 creates single-parcel sites, but the shape
--                  supports multi-parcel assemblage as a data op, not a migration.
-- schemes        — RE-HOMED from parcel_id -> site_id (table is empty; clean swap).
--
-- RLS-ready (owner_id on projects), RLS deferred per Phase-0/1 posture.
-- DEFERRED with seams in place: rezoning WORKFLOW/UI (Phase 3; basis field is the
-- seam), multi-parcel assemblage merge logic (engine note below), proforma (Phase 4).
-- =============================================================================

-- ---- Projects -------------------------------------------------------------
create table projects (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid,                                   -- future RLS
  name             text not null,
  constraint_basis jsonb not null default '{"mode":"current_zoning"}'::jsonb,
    -- mode='current_zoning' -> derive constraints from the site's parcels' zoning.
    -- mode='hypothetical', zone_codes=[...] -> rezoning scenario; feeds
    -- check_scheme_compliance._constraint_codes. The UI to set this is Phase 3.
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger projects_set_updated_at
  before update on projects for each row execute function set_updated_at();

-- ---- Sites (Assemblage) ---------------------------------------------------
create table sites (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index sites_project_id_idx on sites (project_id);

create trigger sites_set_updated_at
  before update on sites for each row execute function set_updated_at();

-- ---- Site <-> Parcel assemblage join --------------------------------------
create table site_parcels (
  site_id    uuid not null references sites(id) on delete cascade,
  parcel_id  uuid not null references parcels(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (site_id, parcel_id)
);

create index site_parcels_parcel_id_idx on site_parcels (parcel_id);

-- ---- Re-home schemes: parcel_id -> site_id --------------------------------
-- schemes is empty (test fixture deleted), so this is a clean structural swap,
-- no data migration. A scheme belongs to a Site (assemblage), not a bare parcel.
alter table schemes drop constraint schemes_parcel_id_fkey;
alter table schemes drop column parcel_id;
alter table schemes add column site_id uuid references sites(id) on delete cascade;
create index schemes_site_id_idx on schemes (site_id);

comment on table projects is 'Top-level container. constraint_basis carries the rezoning seam (data, not workflow).';
comment on table sites is 'Assemblage of one-or-more parcels (via site_parcels). The operational ground for schemes.';
comment on table site_parcels is 'Site<->parcel assemblage. V1 single-parcel; multi-parcel is a data op, not a migration.';
