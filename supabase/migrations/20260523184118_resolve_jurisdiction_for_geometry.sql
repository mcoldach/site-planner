-- Resolve which jurisdiction owns a given geometry, and return its parcel_source.
-- Used by the lookup-parcel Edge Function (Phase 2: after locating geometry via the
-- statewide layer, determine the authoritative source).
-- Mirrors get_parcel_context's resolution EXACTLY: centroid-in-boundary (edge-slop
-- tolerant), municipal precedence, excludes the 'county' base row.
-- Input: a GeoJSON geometry (jsonb). Returns the jurisdiction + its parcel_source, or null.

create or replace function public.resolve_jurisdiction_for_geometry(_geojson jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  _geom     extensions.geometry;
  _centroid extensions.geometry;
  _result   jsonb;
begin
  _geom := extensions.ST_GeomFromGeoJSON(_geojson::text);
  _centroid := extensions.ST_Centroid(_geom);

  select jsonb_build_object(
    'id',            j.id,
    'slug',          j.slug,
    'name',          j.name,
    'authority_type', j.authority_type,
    'parcel_source', j.parcel_source
  )
  into _result
  from jurisdictions j
  where j.authority_type <> 'county'                       -- exclude boundary-engine base row
    and extensions.ST_Contains(j.boundary, _centroid)      -- centroid: tolerant of edge slop
  order by case j.authority_type
    when 'municipal'             then 0
    when 'county_unincorporated' then 1
    when 'state'                 then 3
    when 'federal'               then 4
    when 'special_district'      then 5
    else                              99
  end asc
  limit 1;

  return _result;  -- null if no jurisdiction contains the centroid
end;
$$;
