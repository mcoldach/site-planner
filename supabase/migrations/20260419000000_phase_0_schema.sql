-- =============================================================================
-- Phase 0 — Constraint-Aware Site Planning Workbench
-- Date: 2026-04-19
--
-- Summary: Initial schema for jurisdictions, parcels, source snapshots, and
-- claims. Establishes the cited-truth backbone (claims -> source_snapshots)
-- and the spatial primitives needed for parcel lookup and parcel-to-
-- jurisdiction resolution via PostGIS.
--
-- SECURITY: No Row-Level Security is enabled in Phase 0. There is no auth
-- yet; all access is server-side via the service role. Phase 1 introduces
-- auth + RLS policies. Do not expose this schema to untrusted clients yet.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "postgis";    -- spatial types and ops
create extension if not exists "vector";     -- pgvector enabled, unused in Phase 0

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type source_class_t as enum (
  'official',
  'professional',
  'project_note',
  'ai_inference'
);

create type review_state_t as enum (
  'extracted',
  'reviewed',
  'approved',
  'superseded',
  'conflicted',
  'rejected'
);

create type authority_type_t as enum (
  'municipal',
  'county_unincorporated',
  'county',
  'state',
  'federal',
  'special_district'
);

-- -----------------------------------------------------------------------------
-- Shared trigger: maintain updated_at on every row update
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Table: jurisdictions
-- The authoritative governing body. Parcel-to-jurisdiction resolution is done
-- by ST_Contains(jurisdictions.boundary, parcels.geometry) at query time,
-- so annexations and boundary changes do not require parcel reloads.
-- -----------------------------------------------------------------------------
create table jurisdictions (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique,
  name                  text not null,
  authority_type        authority_type_t not null,
  boundary              extensions.geometry(MultiPolygon, 4326) not null,
  code_label            text,
  code_home_url         text,
  current_code_version  text,
  effective_date        date,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index jurisdictions_boundary_gix
  on jurisdictions
  using gist (boundary);

create trigger jurisdictions_set_updated_at
  before update on jurisdictions
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Table: parcels
-- Cached parcel features from public sources. No FK to jurisdictions; that
-- relationship is resolved spatially.
-- -----------------------------------------------------------------------------
create table parcels (
  id                  uuid primary key default gen_random_uuid(),
  source_apn          text not null,
  source_system       text not null,
  label               text,
  zone_district_code  text,
  geometry            extensions.geometry(MultiPolygon, 4326) not null,
  raw_attrs           jsonb not null default '{}'::jsonb,
  retrieved_at        timestamptz not null,
  source_url          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (source_system, source_apn)
);

create index parcels_geometry_gix
  on parcels
  using gist (geometry);

create index parcels_zone_district_code_idx
  on parcels (zone_district_code);

create trigger parcels_set_updated_at
  before update on parcels
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Table: source_snapshots
-- Real provenance for every cited fact. Self-referential supersession lets us
-- preserve historical versions (e.g., a prior UDC ordinance) while pointing
-- to its replacement.
-- -----------------------------------------------------------------------------
create table source_snapshots (
  id              uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid references jurisdictions(id),
  title           text not null,
  url             text not null,
  source_class    source_class_t not null,
  retrieved_at    timestamptz not null,
  effective_date  date,
  checksum        text,
  license         text,
  notes           text,
  superseded_at   timestamptz,
  superseded_by   uuid references source_snapshots(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger source_snapshots_set_updated_at
  before update on source_snapshots
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Table: claims
-- Every user-visible rule. Each claim cites exactly one source_snapshot and
-- carries a review_state from day one so Phase 2 (Docling/LLM extraction)
-- can use the same table without schema churn.
-- -----------------------------------------------------------------------------
create table claims (
  id                  uuid primary key default gen_random_uuid(),
  jurisdiction_id     uuid not null references jurisdictions(id),
  zone_district_code  text,
  rule_key            text not null,
  value_text          text,
  value_numeric       numeric,
  value_unit          text,
  source_snapshot_id  uuid not null references source_snapshots(id),
  section_ref         text not null,
  section_url         text,
  source_class        source_class_t not null,
  review_state        review_state_t not null default 'approved',
  claim_version       int not null default 1,
  retrieved_at        timestamptz not null,
  effective_at        date,
  superseded_at       timestamptz,
  superseded_by       uuid references claims(id),
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index claims_lookup_idx
  on claims (jurisdiction_id, zone_district_code, rule_key);

create index claims_approved_idx
  on claims (review_state)
  where review_state = 'approved';

create trigger claims_set_updated_at
  before update on claims
  for each row execute function set_updated_at();
