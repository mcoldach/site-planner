-- Zoning-only jurisdiction tier: enrich parcels, but no claims/compliance yet.
-- These municipalities (Manitou Springs, Monument, Fountain) declare an authoritative
-- parcel_source so the two-phase lookup re-fetches their parcels in Phase 2 and maps
-- zoning + address + owner from their own GIS layers (richer than the statewide locator).
--
-- This is the enrichment tier ONLY: parsed claims and compliance checking are Track C.
-- Setting parcel_source here gets a parcel its zoning code / situs / owner; it does NOT
-- imply any cited rules or feasibility checks exist for that jurisdiction yet.
--
-- field_map maps our canonical raw_attrs key -> SOURCE field name, so every source
-- normalizes into the same shape classify_zoning/upsert_parcel already consume
-- (parcel_id, situsAdd, zoningCode, owner, landAcres, legalDesc).

-- Manitou Springs: city parcels layer (FeatureServer/0).
update public.jurisdictions
set parcel_source = jsonb_build_object(
  'endpoint',     'https://services6.arcgis.com/JvLU4FaQtqrjGWfU/arcgis/rest/services/Manitou_Springs_Parcels_April_1_2025/FeatureServer/0/query',
  'query_format', 'featureserver',
  'apn_field',    'PARCEL',
  'field_map',    jsonb_build_object(
                    'parcel_id', 'PARCEL',
                    'situsAdd',  'SitusAddress',
                    'zoningCode','Zoning_Abr',
                    'owner',     'owner',
                    'landAcres', 'AreaAcres',
                    'legalDesc', 'legalDesc'
                  )
)
where slug = 'manitou_springs';

-- Monument: town parcels layer (FeatureServer/0).
update public.jurisdictions
set parcel_source = jsonb_build_object(
  'endpoint',     'https://services6.arcgis.com/u1HrbEbmGq2zQWj2/arcgis/rest/services/All_info_Town_Parcels/FeatureServer/0/query',
  'query_format', 'featureserver',
  'apn_field',    'PARCEL',
  'field_map',    jsonb_build_object(
                    'parcel_id', 'PARCEL',
                    'situsAdd',  'E911_Address',
                    'zoningCode','ZONING',
                    'owner',     'OWNER1',
                    'landAcres', 'Acreage',
                    'legalDesc', 'PARTIALLEGAL'
                  )
)
where slug = 'monument';

-- Fountain: city GIS parcels layer (FeatureServer/28).
update public.jurisdictions
set parcel_source = jsonb_build_object(
  'endpoint',     'https://services.arcgis.com/5gc69Jsswzt1M6r4/arcgis/rest/services/Fountain_GIS_Parcels/FeatureServer/28/query',
  'query_format', 'featureserver',
  'apn_field',    'PARCEL',
  'field_map',    jsonb_build_object(
                    'parcel_id', 'PARCEL',
                    'situsAdd',  'LOCATION',
                    'zoningCode','ZONING',
                    'owner',     'OWNER1',
                    'landAcres', 'ACREAGE',
                    'legalDesc', 'LEGAL'
                  )
)
where slug = 'fountain';
