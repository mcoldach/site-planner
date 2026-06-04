-- Project management: RLS on views, archive/delete, colors/icons.
--
-- 1. security_invoker on projects_geojson and schemes_geojson so they respect
--    the existing RLS policies on the underlying tables (projects, schemes, etc).
--    Without this, all users see all projects on the map.
-- 2. archived_at on projects for soft-archive (hidden from default view).
-- 3. color + icon on projects for visual customization on the map.

-- ---- New columns -----------------------------------------------------------

alter table projects
  add column if not exists archived_at timestamptz,
  add column if not exists color       text not null default '#3b4664',
  add column if not exists icon        text not null default 'dot';

-- ---- Rebuild projects_geojson with security_invoker + archive filter --------

drop view if exists projects_geojson;

create view projects_geojson
  with (security_invoker = true)
as
select
  p.id,
  p.name,
  p.constraint_basis,
  p.color,
  p.icon,
  p.archived_at,
  extensions.ST_AsGeoJSON(extensions.ST_Union(pa.geometry))::jsonb            as geometry,
  extensions.ST_AsGeoJSON(extensions.ST_Centroid(extensions.ST_Union(pa.geometry)))::jsonb as centroid
from projects p
join sites s         on s.project_id = p.id
join site_parcels sp on sp.site_id = s.id
join parcels pa      on pa.id = sp.parcel_id
where p.archived_at is null
group by p.id, p.name, p.constraint_basis, p.color, p.icon, p.archived_at;

-- ---- Rebuild schemes_geojson with security_invoker -------------------------

drop view if exists schemes_geojson;

create view schemes_geojson
  with (security_invoker = true)
as
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
