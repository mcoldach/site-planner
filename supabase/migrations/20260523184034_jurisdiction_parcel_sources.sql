-- Two-phase parcel lookup: each jurisdiction declares its authoritative parcel source.
-- Phase 1 (locate): always query the statewide layer for geometry.
-- Phase 2 (authoritative): resolve jurisdiction from geometry, and if it declares a
--   distinct parcel_source, re-fetch the authoritative record + map its fields.
-- A null parcel_source means "the statewide locator IS authoritative; do not re-fetch."
--
-- field_map maps SOURCE field name -> our canonical raw_attrs key, so every source
-- normalizes into the same shape classify_zoning/upsert_parcel already consume
-- (parcel_id, situsAdd, zoningCode, owner, landAcres, legalDesc).

alter table public.jurisdictions
  add column if not exists parcel_source jsonb;

-- Colorado Springs: authoritative city LandRecords layer (MapServer/4).
-- Serves EPSG:2232 -> we request outSR=4326 & f=geojson at query time.
-- APN format confirmed identical to statewide (e.g. 7336400022) -> no key crosswalk.
update public.jurisdictions
set parcel_source = jsonb_build_object(
  'endpoint',     'https://gis.coloradosprings.gov/arcgis/rest/services/GeneralUse/LandRecords/MapServer/4/query',
  'query_format', 'mapserver',
  'apn_field',    'PARCEL',
  'field_map',    jsonb_build_object(
                    'parcel_id', 'PARCEL',
                    'situsAdd',  'ADDRESS1',
                    'zoningCode','ZONING',
                    'owner',     'OwnerName',
                    'landAcres', 'ACREAGE',
                    'legalDesc', 'LEGAL'
                  )
)
where slug = 'colorado_springs';

-- El Paso County (unincorporated): the statewide locator is itself authoritative.
-- Explicit null = "do not re-fetch; use the Phase-1 statewide record as-is."
update public.jurisdictions
set parcel_source = null
where slug = 'el_paso_county_unincorporated';
