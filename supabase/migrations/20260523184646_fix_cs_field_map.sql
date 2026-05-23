-- Fix CS field map: the parcel situs address is ParcelAdr, NOT ADDRESS1.
-- Real record for 7336400022 showed: ADDRESS1 = " " (empty), ADDRESS2 =
-- "3640 CAMELS RIDGE LN" (owner MAILING address, not situs), ParcelAdr =
-- "0 POLK ST" (the actual parcel location). Field names are misleading; mapping
-- verified against a live record. situsAdd -> ParcelAdr.

update public.jurisdictions
set parcel_source = jsonb_set(
  parcel_source,
  '{field_map}',
  jsonb_build_object(
    'parcel_id',  'PARCEL',
    'situsAdd',   'ParcelAdr',
    'zoningCode', 'ZONING',
    'owner',      'OwnerName',
    'landAcres',  'ACREAGE',
    'legalDesc',  'LEGAL',
    'ownerMail',  'ADDRESS2'
  )
)
where slug = 'colorado_springs';
