-- Make upsert_jurisdiction dissolve undissolved MultiPolygon input.
--
-- The DOLA / COOIT Municipal Boundaries layer publishes one row per annexation
-- event, not one row per municipality. The Phase 2 municipal seed script
-- aggregates these annexation polygons into a single MultiPolygon per city and
-- relies on this function to dissolve them into a clean boundary before
-- storage. ST_UnaryUnion on already-dissolved input is a no-op, so existing
-- rows and future single-polygon callers are unaffected. ST_Multi at the
-- outer position ensures the column's MultiPolygon type is preserved when
-- the dissolve happens to collapse to a single Polygon.
create or replace function public.upsert_jurisdiction(
  _slug text, _name text, _authority authority_type_t, _geojson jsonb,
  _code_label text, _code_home_url text, _current_code_version text, _notes text
)
returns uuid
language plpgsql
as $function$
declare
  _id   uuid;
  _geom extensions.geometry;
begin
  -- Qualify with extensions. because PostGIS lives in the extensions schema on
  -- Supabase and this function does not assume a specific search_path.
  _geom := extensions.ST_Multi(
            extensions.ST_UnaryUnion(
              extensions.ST_GeomFromGeoJSON(_geojson::text)
            )
          );
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
$function$;
