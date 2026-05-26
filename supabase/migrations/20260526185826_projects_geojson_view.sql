-- =============================================================================
-- projects_geojson — each project with its site's merged geometry, for map
-- rendering. Mirrors the parcels_geojson view pattern used by fetchAllParcels.
--
-- V1 sites are single-parcel (assemblage-of-one); ST_Union makes this
-- multi-parcel-ready with no change when sites span multiple parcels later.
-- Geometry computation stays in PostGIS (principle #5: one spatial truth store).
--
-- Returns:
--   id, name, constraint_basis — project identity + the rezoning-basis seam
--   geometry  — the site outline (union of the site's parcels), for the
--               zoomed-in outline layer
--   centroid  — the point for the zoomed-out dot + label layer
-- =============================================================================

create or replace view projects_geojson as
select
  p.id,
  p.name,
  p.constraint_basis,
  extensions.ST_AsGeoJSON(extensions.ST_Union(pa.geometry))::jsonb            as geometry,
  extensions.ST_AsGeoJSON(extensions.ST_Centroid(extensions.ST_Union(pa.geometry)))::jsonb as centroid
from projects p
join sites s         on s.project_id = p.id
join site_parcels sp on sp.site_id = s.id
join parcels pa      on pa.id = sp.parcel_id
group by p.id, p.name, p.constraint_basis;
