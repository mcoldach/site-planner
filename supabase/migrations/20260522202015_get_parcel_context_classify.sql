-- Scope 1: integrate classify_zoning into get_parcel_context.
-- Additive + widening only. Existing keys (parcel, jurisdiction, claims) unchanged in shape.
-- Changes:
--   1. Call classify_zoning on raw_attrs->>'zoningCode' after jurisdiction resolution.
--   2. Match claims against ALL base codes (set), not the single zone_district_code string.
--      -> split-zone parcels (I-2 RR-5) now pull every base district's claims.
--   3. Also match overlay codes (no overlay claims exist yet; contributes nothing until authored).
--   4. Add 'classification' to the return so the sidebar can surface overlay + unclassified codes.
-- No resolution/merge logic (deferred to rule-keys ontology per the CAD-O most-restrictive finding).

create or replace function get_parcel_context(_parcel_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  _parcel_geom        extensions.geometry;
  _parcel_zone        text;
  _parcel_zoning_raw  text;
  _parcel_jsonb       jsonb;
  _jurisdiction_id    uuid;
  _jurisdiction_jsonb jsonb;
  _classification     jsonb;
  _match_codes        text[];
  _claims_jsonb       jsonb;
begin
  select
    p.geometry,
    p.zone_district_code,
    p.raw_attrs->>'zoningCode',
    jsonb_build_object(
      'id',                 p.id,
      'source_apn',         p.source_apn,
      'source_system',      p.source_system,
      'label',              p.label,
      'zone_district_code', p.zone_district_code,
      'geometry',           extensions.ST_AsGeoJSON(p.geometry)::jsonb,
      'raw_attrs',          p.raw_attrs,
      'retrieved_at',       p.retrieved_at,
      'source_url',         p.source_url
    )
  into _parcel_geom, _parcel_zone, _parcel_zoning_raw, _parcel_jsonb
  from parcels p
  where p.id = _parcel_id;

  if not found then
    return null;
  end if;

  select
    j.id,
    jsonb_build_object(
      'id',                   j.id,
      'slug',                 j.slug,
      'name',                 j.name,
      'authority_type',       j.authority_type,
      'code_label',           j.code_label,
      'code_home_url',        j.code_home_url,
      'current_code_version', j.current_code_version
    )
  into _jurisdiction_id, _jurisdiction_jsonb
  from jurisdictions j
  where extensions.ST_Contains(j.boundary, _parcel_geom)
  order by case j.authority_type
    when 'municipal'             then 0
    when 'county_unincorporated' then 1
    when 'county'                then 2
    when 'state'                 then 3
    when 'federal'               then 4
    when 'special_district'      then 5
    else                              99
  end asc
  limit 1;

  if _jurisdiction_id is null then
    return jsonb_build_object(
      'parcel',         _parcel_jsonb,
      'jurisdiction',   null,
      'classification', public.classify_zoning(null, _parcel_zoning_raw),
      'claims',         '[]'::jsonb
    );
  end if;

  -- Classify the full raw zoning string against this jurisdiction's registry.
  -- Falls back to the stored base zone if raw zoningCode is absent.
  _classification := public.classify_zoning(
    _jurisdiction_id,
    coalesce(_parcel_zoning_raw, _parcel_zone)
  );

  -- Build the set of codes to match claims against: all base codes + all overlay codes.
  select array_agg(elem->>'code')
  into _match_codes
  from (
    select jsonb_array_elements(_classification->'base_codes')    as elem
    union all
    select jsonb_array_elements(_classification->'overlay_codes') as elem
  ) codes;

  -- Safety net: if classification produced no codes (e.g. registry miss on a
  -- legacy string), fall back to the stored base zone so we never regress to
  -- fewer claims than Phase 0 showed.
  if _match_codes is null or array_length(_match_codes, 1) is null then
    _match_codes := array[_parcel_zone];
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',                 c.id,
        'jurisdiction_id',    c.jurisdiction_id,
        'zone_district_code', c.zone_district_code,
        'rule_key',           c.rule_key,
        'value_text',         c.value_text,
        'value_numeric',      c.value_numeric,
        'value_unit',         c.value_unit,
        'section_ref',        c.section_ref,
        'section_url',        c.section_url,
        'source_snapshot',    jsonb_build_object(
          'title', s.title,
          'url',   s.url
        )
      )
      order by c.zone_district_code asc nulls first, c.rule_key asc
    ),
    '[]'::jsonb
  )
  into _claims_jsonb
  from claims c
  join source_snapshots s on s.id = c.source_snapshot_id
  where c.jurisdiction_id = _jurisdiction_id
    and c.review_state = 'approved'
    and (
      c.zone_district_code is null
      or c.zone_district_code = any (_match_codes)
    );

  return jsonb_build_object(
    'parcel',         _parcel_jsonb,
    'jurisdiction',   _jurisdiction_jsonb,
    'classification', _classification,
    'claims',         _claims_jsonb
  );
end;
$$;
