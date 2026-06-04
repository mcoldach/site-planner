-- Lift the limit-1 parcel guard in check_scheme_compliance so the function
-- handles multi-parcel site assemblages. The function signature is unchanged;
-- only the internal resolution of parcel geometry and zone codes changes.
--
-- Key changes vs the cutover version:
--   * Parcel resolution: ST_Union of ALL parcels in the site → _site_geom
--   * Site area: ST_Area of the merged geometry
--   * Zone codes: classify_zoning called per distinct raw zone code across
--     all parcels; results unioned into _codes
--   * Jurisdiction: resolved from the centroid of the merged geometry
--   * Setback inset: buffered from _site_geom (merged boundary)
--   * Coverage: footprint union area / site area (merged)
--   * Footprint + height loops: unchanged (already per-footprint)

set search_path = public, extensions;

create or replace function public.check_scheme_compliance(_scheme_id uuid, _constraint_codes text[] default null::text[])
returns jsonb
language plpgsql
stable
as $function$
declare
  _site_id        uuid;
  _site_geom      extensions.geometry;
  _primary_parcel_id uuid;
  _codes          text[];
  _classification jsonb;
  _jurisdiction_id uuid;
  _results        jsonb := '[]'::jsonb;
  _site_area      numeric;
  _sb_front numeric; _sb_side numeric; _sb_rear numeric;
  _sb_uniform numeric; _sb_role text;
  _sb_ref text; _sb_url text;
  _inset extensions.geometry;
  _sb_result text;
  _union_geom extensions.geometry;
  _union_area numeric;
  _claim record;
  _fp record;
  _zone_rec record;
  _kind text;
  _entry jsonb;
begin
  -- Resolve the scheme's site
  select s.site_id into _site_id
  from schemes s where s.id = _scheme_id;
  if _site_id is null then return null; end if;

  -- Merged site geometry from ALL parcels in the assemblage.
  -- min(p.id) gives a deterministic "primary" parcel for the return value.
  select extensions.ST_Union(p.geometry), min(p.id)
    into _site_geom, _primary_parcel_id
  from site_parcels sp
  join parcels p on p.id = sp.parcel_id
  where sp.site_id = _site_id;
  if _site_geom is null then return null; end if;

  _site_area := extensions.ST_Area(_site_geom::extensions.geography);

  -- Zone resolution
  if _constraint_codes is not null then
    _codes := _constraint_codes;
  else
    -- Jurisdiction from the centroid of the merged site geometry
    select j.id into _jurisdiction_id
    from jurisdictions j
    where j.authority_type <> 'county'
      and extensions.ST_Contains(j.boundary, extensions.ST_Centroid(_site_geom))
    order by case j.authority_type
      when 'municipal' then 0 when 'county_unincorporated' then 1 else 9 end
    limit 1;

    -- Classify each distinct zone code across all parcels in the assemblage
    _codes := array[]::text[];
    for _zone_rec in
      select distinct coalesce(p.raw_attrs->>'zoningCode', p.zone_district_code) as zone_input,
                      p.zone_district_code as fallback_code
      from site_parcels sp
      join parcels p on p.id = sp.parcel_id
      where sp.site_id = _site_id
        and coalesce(p.raw_attrs->>'zoningCode', p.zone_district_code) is not null
    loop
      _classification := public.classify_zoning(_jurisdiction_id, _zone_rec.zone_input);
      _codes := _codes || coalesce(
        (select array_agg(elem->>'code')
         from (
           select jsonb_array_elements(_classification->'base_codes') elem
           union all
           select jsonb_array_elements(_classification->'overlay_codes') elem
         ) x),
        array[_zone_rec.fallback_code]
      );
    end loop;
    -- Deduplicate
    _codes := (select array_agg(distinct c) from unnest(_codes) c);
    -- Last resort: raw zone_district_code from any parcel
    if _codes is null or array_length(_codes, 1) is null then
      select array_agg(distinct p.zone_district_code) into _codes
      from site_parcels sp
      join parcels p on p.id = sp.parcel_id
      where sp.site_id = _site_id
        and p.zone_district_code is not null;
    end if;
  end if;

  -- SETBACK inset from the merged site boundary (uniform-conservative)
  select max(case when rule_key='setback.front.min' then value_numeric end),
         max(case when rule_key='setback.side.min'  then value_numeric end),
         max(case when rule_key='setback.rear.min'  then value_numeric end),
         max(section_ref), max(section_url)
    into _sb_front, _sb_side, _sb_rear, _sb_ref, _sb_url
  from claims
  where review_state='approved' and zone_district_code = any(_codes)
    and rule_key in ('setback.front.min','setback.side.min','setback.rear.min');

  if coalesce(_sb_front,_sb_side,_sb_rear) is not null then
    _sb_uniform := greatest(coalesce(_sb_front,0), coalesce(_sb_side,0), coalesce(_sb_rear,0));
    _sb_role := case _sb_uniform
                  when _sb_rear then 'rear' when _sb_front then 'front' else 'side' end;
    _inset := extensions.ST_Buffer(_site_geom::extensions.geography, -(_sb_uniform*0.3048))::extensions.geometry;

    for _fp in
      select id, ordinal, label, footprint
      from scheme_footprints where scheme_id = _scheme_id order by ordinal
    loop
      _sb_result := case
        when _inset is null or extensions.ST_IsEmpty(_inset) then 'fail'
        when extensions.ST_Contains(_inset, _fp.footprint) then 'pass' else 'fail' end;
      _results := _results || jsonb_build_object(
        'rule_key','setback.*.min','check_kind','spatial_inset',
        'result',_sb_result,'method','uniform_conservative',
        'value_used_ft',_sb_uniform,'driving_role',_sb_role,
        'role_values',jsonb_build_object('front',_sb_front,'side',_sb_side,'rear',_sb_rear),
        'footprint_id',_fp.id,'ordinal',_fp.ordinal,'label',_fp.label,
        'note','Uniform most-restrictive setback applied; directional/edge-role check pending',
        'citation',jsonb_build_object('section_ref',_sb_ref,'section_url',_sb_url));
    end loop;
  end if;

  -- Coverage: union of all footprints vs merged site area
  _union_geom := (select extensions.ST_Union(footprint) from scheme_footprints where scheme_id = _scheme_id);
  _union_area := extensions.ST_Area(_union_geom::extensions.geography);

  for _claim in
    select rule_key, value_numeric, value_unit, section_ref, section_url
    from claims
    where review_state='approved' and zone_district_code = any(_codes)
      and rule_key not like 'setback.%'
  loop
    _kind := check_kind_for(_claim.rule_key);

    if _kind = 'area_ratio' and _claim.rule_key = 'lot.coverage.max' then
      if _claim.value_numeric is null then
        _entry := jsonb_build_object('result','not_evaluated','reason','no approved value');
      else
        _entry := jsonb_build_object(
          'result', case when (_union_area/_site_area*100) <= _claim.value_numeric then 'pass' else 'fail' end,
          'actual_pct', round((_union_area/_site_area*100)::numeric,1),
          'limit_pct', _claim.value_numeric,
          'margin_pct', round((_claim.value_numeric - _union_area/_site_area*100)::numeric,1));
      end if;
      _results := _results || (_entry || jsonb_build_object(
        'rule_key',_claim.rule_key,'check_kind',_kind,
        'citation',jsonb_build_object('section_ref',_claim.section_ref,'section_url',_claim.section_url)));

    elsif _kind = 'scalar_max' then
      for _fp in
        select id, ordinal, label, height_ft
        from scheme_footprints where scheme_id = _scheme_id order by ordinal
      loop
        if _fp.height_ft is null then
          _entry := jsonb_build_object('result','not_evaluated','reason','footprint has no height_ft');
        elsif _claim.value_numeric is null then
          _entry := jsonb_build_object('result','not_evaluated','reason','no approved value');
        else
          _entry := jsonb_build_object(
            'result', case when _fp.height_ft <= _claim.value_numeric then 'pass' else 'fail' end,
            'actual_ft', _fp.height_ft, 'limit_ft', _claim.value_numeric,
            'margin_ft', _claim.value_numeric - _fp.height_ft);
        end if;
        _results := _results || (_entry || jsonb_build_object(
          'rule_key',_claim.rule_key,'check_kind',_kind,
          'footprint_id',_fp.id,'ordinal',_fp.ordinal,'label',_fp.label,
          'citation',jsonb_build_object('section_ref',_claim.section_ref,'section_url',_claim.section_url)));
      end loop;

    else
      _entry := jsonb_build_object('result','not_evaluated',
                  'reason', case when _kind='unknown' then 'unrecognized constraint'
                                 else 'check kind '||_kind||' not yet implemented' end);
      _results := _results || (_entry || jsonb_build_object(
        'rule_key',_claim.rule_key,'check_kind',_kind,
        'citation',jsonb_build_object('section_ref',_claim.section_ref,'section_url',_claim.section_url)));
    end if;
  end loop;

  return jsonb_build_object(
    'scheme_id',_scheme_id,'parcel_id',_primary_parcel_id,
    'constraint_codes',_codes,'results',_results);
end;
$function$;
