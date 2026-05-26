-- save_scheme: insert a scheme (drawn footprint + height + name) under a site,
-- converting the footprint GeoJSON to PostGIS geometry server-side
-- (principle #5: geometry handling lives in PostGIS, not the client).
-- Returns the new scheme id so the caller can immediately run compliance.
--
-- V1: caller passes the project id; we resolve its (single) site. When a project
-- has multiple sites later, this takes a site_id directly instead.

create or replace function save_scheme(
  _project_id uuid,
  _name text,
  _footprint_geojson jsonb,
  _height_ft numeric
)
returns uuid
language plpgsql
as $$
declare
  _site_id uuid;
  _scheme_id uuid;
begin
  -- resolve the project's site (V1: one site per project)
  select id into _site_id
  from sites
  where project_id = _project_id
  order by created_at
  limit 1;
  if _site_id is null then
    raise exception 'save_scheme: no site found for project %', _project_id;
  end if;

  insert into schemes (site_id, name, footprint, height_ft)
  values (
    _site_id,
    _name,
    extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(_footprint_geojson::text), 4326),
    _height_ft
  )
  returning id into _scheme_id;

  return _scheme_id;
end;
$$;
