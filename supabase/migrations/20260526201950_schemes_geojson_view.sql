-- schemes_geojson: each scheme with its footprint as GeoJSON, for loading saved
-- schemes back onto the map + workspace. Mirrors projects_geojson / parcels_geojson.
create or replace view schemes_geojson as
select
  s.id,
  s.site_id,
  si.project_id,
  s.name,
  s.height_ft,
  extensions.ST_AsGeoJSON(s.footprint)::jsonb as footprint,
  round((extensions.ST_Area(s.footprint::extensions.geography) * 10.7639)::numeric, 0) as footprint_sf,
  s.created_at
from schemes s
join sites si on si.id = s.site_id;
