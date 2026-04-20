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
