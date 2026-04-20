-- =============================================================================
-- Phase 0 — Seed helpers
-- Date: 2026-04-19
--
-- Summary: RPC used by scripts/seed_jurisdictions.ts to upsert a jurisdiction
-- row with its boundary geometry derived from a GeoJSON payload. The SQL side
-- owns the geometry conversion (ST_GeomFromGeoJSON + ST_Multi) so the seed
-- script never hand-builds WKT. source_snapshots are inserted directly from
-- the JS client; no RPC is needed for that path.
--
-- SECURITY: In Phase 0 this function is only invoked server-side by the seed
-- script using the service role key. No explicit GRANTs are added here; RLS
-- and role-scoped grants are a Phase 1 concern.
-- =============================================================================

create or replace function upsert_jurisdiction(
  _slug                 text,
  _name                 text,
  _authority            authority_type_t,
  _geojson              jsonb,
  _code_label           text,
  _code_home_url        text,
  _current_code_version text,
  _notes                text
) returns uuid
language plpgsql
as $$
declare
  _id   uuid;
  _geom extensions.geometry;
begin
  -- Qualify with extensions. because PostGIS lives in the extensions schema on
  -- Supabase and this function does not assume a specific search_path.
  _geom := extensions.ST_Multi(extensions.ST_GeomFromGeoJSON(_geojson::text));

  insert into jurisdictions (
    slug, name, authority_type, boundary,
    code_label, code_home_url, current_code_version, notes
  )
  values (
    _slug, _name, _authority, _geom,
    _code_label, _code_home_url, _current_code_version, _notes
  )
  on conflict (slug) do update set
    name                 = excluded.name,
    authority_type       = excluded.authority_type,
    boundary             = excluded.boundary,
    code_label           = excluded.code_label,
    code_home_url        = excluded.code_home_url,
    current_code_version = excluded.current_code_version,
    notes                = excluded.notes,
    updated_at           = now()
  returning id into _id;

  return _id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Parcel seed: upsert from Colorado Public Parcels (or similar) GeoJSON geometry
-- + attributes. Invoked by scripts/seed_parcels.ts (service role).
-- -----------------------------------------------------------------------------

create or replace function upsert_parcel(
  _source_apn     text,
  _source_system  text,
  _geojson        jsonb,
  _raw_attrs      jsonb,
  _retrieved_at   timestamptz,
  _source_url     text
) returns uuid
language plpgsql
as $$
declare
  _id   uuid;
  _geom extensions.geometry;
begin
  _geom := extensions.ST_Multi(extensions.ST_GeomFromGeoJSON(_geojson::text));

  insert into parcels (
    source_apn, source_system, geometry, raw_attrs, retrieved_at, source_url
  )
  values (
    _source_apn,
    _source_system,
    _geom::extensions.geometry(MultiPolygon, 4326),
    coalesce(_raw_attrs, '{}'::jsonb),
    _retrieved_at,
    _source_url
  )
  on conflict (source_system, source_apn) do update set
    geometry     = excluded.geometry,
    raw_attrs    = excluded.raw_attrs,
    retrieved_at = excluded.retrieved_at,
    source_url   = excluded.source_url,
    updated_at   = now()
  returning id into _id;

  return _id;
end;
$$;

-- Post-seed summary for scripts/seed_parcels.ts (jurisdiction resolution + acres).

create or replace function parcel_seed_summary(_source_apns text[])
returns table (
  source_apn text,
  area_acres double precision,
  resolved_jurisdiction text
)
language sql
stable
as $$
  select
    p.source_apn,
    (extensions.ST_Area((p.geometry)::geography) / 4046.86)::double precision as area_acres,
    case
      when extensions.ST_Contains(
        (select boundary from jurisdictions where slug = 'colorado_springs'),
        p.geometry
      ) then 'colorado_springs'
      when extensions.ST_Contains(
        (select boundary from jurisdictions where slug = 'el_paso_county_unincorporated'),
        p.geometry
      ) then 'el_paso_county_unincorporated'
      else 'unknown'
    end as resolved_jurisdiction
  from parcels p
  where p.source_apn = any (_source_apns);
$$;
