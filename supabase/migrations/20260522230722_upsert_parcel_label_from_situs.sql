-- Populate parcels.label from raw_attrs->>'situsAdd' when not otherwise set.
-- Fetched parcels (via lookup-parcel) had null label; situs address is in raw_attrs.
-- situsAdd = parcel location (correct); ownerAdd = owner mailing address (wrong, do not use).
-- Adds label derivation to existing upsert_parcel; all other behavior identical.

create or replace function upsert_parcel(
  _source_apn     text,
  _source_system  text,
  _geojson        jsonb,
  _raw_attrs      jsonb,
  _retrieved_at   timestamptz,
  _source_url     text
) returns uuid
language plpgsql
as $$
declare
  _id    uuid;
  _geom  extensions.geometry;
  _label text;
begin
  _geom := extensions.ST_Multi(extensions.ST_GeomFromGeoJSON(_geojson::text));

  -- Derive label from situs (parcel-location) address; null if absent.
  _label := nullif(trim(coalesce(_raw_attrs->>'situsAdd', '')), '');

  insert into parcels (
    source_apn, source_system, geometry, raw_attrs, retrieved_at, source_url, label
  )
  values (
    _source_apn,
    _source_system,
    _geom::extensions.geometry(MultiPolygon, 4326),
    coalesce(_raw_attrs, '{}'::jsonb),
    _retrieved_at,
    _source_url,
    _label
  )
  on conflict (source_system, source_apn) do update set
    geometry     = excluded.geometry,
    raw_attrs    = excluded.raw_attrs,
    retrieved_at = excluded.retrieved_at,
    source_url   = excluded.source_url,
    label        = coalesce(parcels.label, excluded.label),  -- preserve hand-filled labels
    updated_at   = now()
  returning id into _id;

  return _id;
end;
$$;
