-- =============================================================================
-- check_scheme_compliance — the constraint-aware compliance engine.
-- Takes a scheme (footprint + height) and a constraint set (approved claims),
-- dispatches each claim to a typed check-kind, returns per-constraint results
-- carrying value + citation + method (provenance on every line).
--
-- Signature (scheme + constraint-set): _constraint_codes null => derive from the
-- parcel's current classified zoning; supplied => hypothetical set (rezoning seam).
--
-- BONES for "more restrictions": the engine is a dispatcher over typed check-kinds.
-- V1 implements spatial_inset (setback), area_ratio (coverage), scalar_max (height).
-- Recognized-but-unimplemented kinds (parking, FAR, greenspace) return honest
-- not_evaluated — adding them later is filling a socket, not a rewrite.
--
-- V1 SIMPLIFICATIONS (logged, honestly labeled in results):
--  * setback applied UNIFORM-CONSERVATIVE (most-restrictive role value as a single
--    inward buffer). Per-role values are captured in the result. Directional
--    edge-role assignment is the next layer (needs a road/frontage layer).
--  * setback.*.max ignored (rare; no valued instances in data).
-- =============================================================================

-- map a rule_key to its check-kind
create or replace function check_kind_for(_rule_key text)
returns text language sql immutable as $$
  select case
    when _rule_key like 'setback.%.min'                              then 'spatial_inset'
    when _rule_key in ('lot.coverage.max')                           then 'area_ratio'
    when _rule_key like 'greenspace.%' or _rule_key like 'far.%'     then 'area_ratio'
    when _rule_key in ('height.max','height.max.principal')          then 'scalar_max'
    when _rule_key like 'parking.%'                                  then 'count_ratio'
    else 'unknown'
  end;
$$;

create or replace function check_scheme_compliance(
  _scheme_id uuid,
  _constraint_codes text[] default null
)
returns jsonb
language plpgsql stable
as $$
declare
  _footprint     extensions.geometry;
  _height_ft     numeric;
  _parcel_geom   extensions.geometry;
  _parcel_id     uuid;
  _parcel_zone   text;
  _zoning_raw    text;
  _codes         text[];
  _classification jsonb;
  _results       jsonb := '[]'::jsonb;
  _parcel_area   numeric;
  _foot_area     numeric;

  -- setback aggregation (per-role values captured = bones for directional)
  _sb_front numeric; _sb_side numeric; _sb_rear numeric;
  _sb_uniform numeric; _sb_role text;
  _sb_ref text; _sb_url text;
  _inset extensions.geometry;
  _sb_result text;

  _claim record;
  _kind text;
  _entry jsonb;
begin
  -- ---- load scheme + parcel
  select s.footprint, s.height_ft, p.id, p.geometry, p.zone_district_code,
         p.raw_attrs->>'zoningCode'
    into _footprint, _height_ft, _parcel_id, _parcel_geom, _parcel_zone, _zoning_raw
  from schemes s join parcels p on p.id = s.parcel_id
  where s.id = _scheme_id;
  if not found then return null; end if;

  -- ---- constraint set: explicit codes, else derive from current zoning
  if _constraint_codes is not null then
    _codes := _constraint_codes;
  else
    -- resolve jurisdiction to classify; reuse classify_zoning via the parcel's jurisdiction
    _classification := public.classify_zoning(
      (select j.id from jurisdictions j
        where j.authority_type <> 'county'
          and extensions.ST_Contains(j.boundary, extensions.ST_Centroid(_parcel_geom))
        order by case j.authority_type
          when 'municipal' then 0 when 'county_unincorporated' then 1 else 9 end
        limit 1),
      coalesce(_zoning_raw, _parcel_zone)
    );
    select array_agg(elem->>'code') into _codes
    from (
      select jsonb_array_elements(_classification->'base_codes') elem
      union all
      select jsonb_array_elements(_classification->'overlay_codes') elem
    ) x;
    if _codes is null then _codes := array[_parcel_zone]; end if;
  end if;

  _parcel_area := extensions.ST_Area(_parcel_geom::extensions.geography);
  _foot_area   := extensions.ST_Area(_footprint::extensions.geography);

  -- =========================================================================
  -- SETBACK (spatial_inset) — uniform-conservative, per-role values captured.
  -- =========================================================================
  select max(case when rule_key='setback.front.min' then value_numeric end),
         max(case when rule_key='setback.side.min'  then value_numeric end),
         max(case when rule_key='setback.rear.min'  then value_numeric end),
         max(section_ref), max(section_url)
    into _sb_front, _sb_side, _sb_rear, _sb_ref, _sb_url
  from claims
  where review_state='approved' and zone_district_code = any(_codes)
    and rule_key in ('setback.front.min','setback.side.min','setback.rear.min');

  if coalesce(_sb_front,_sb_side,_sb_rear) is not null then
    -- most-restrictive available role value drives the uniform buffer (conservative)
    _sb_uniform := greatest(coalesce(_sb_front,0), coalesce(_sb_side,0), coalesce(_sb_rear,0));
    _sb_role := case _sb_uniform
                  when _sb_rear then 'rear' when _sb_front then 'front' else 'side' end;
    -- buffer in feet -> meters (1 ft = 0.3048 m); negative buffer = inward inset
    _inset := extensions.ST_Buffer(_parcel_geom::extensions.geography, -(_sb_uniform*0.3048))::extensions.geometry;
    _sb_result := case
      when _inset is null or extensions.ST_IsEmpty(_inset) then 'fail'
      when extensions.ST_Contains(_inset, _footprint) then 'pass' else 'fail' end;

    _entry := jsonb_build_object(
      'rule_key','setback.*.min','check_kind','spatial_inset',
      'result', _sb_result,
      'method','uniform_conservative',
      'value_used_ft', _sb_uniform,
      'driving_role', _sb_role,
      'role_values', jsonb_build_object('front',_sb_front,'side',_sb_side,'rear',_sb_rear),
      'note','Uniform most-restrictive setback applied; directional/edge-role check pending',
      'citation', jsonb_build_object('section_ref',_sb_ref,'section_url',_sb_url)
    );
    _results := _results || _entry;
  end if;

  -- =========================================================================
  -- Dispatch remaining claims (coverage, height, and recognized-but-unimplemented)
  -- =========================================================================
  for _claim in
    select rule_key, value_numeric, value_unit, section_ref, section_url
    from claims
    where review_state='approved' and zone_district_code = any(_codes)
      and rule_key not like 'setback.%'        -- setbacks handled above
  loop
    _kind := check_kind_for(_claim.rule_key);

    if _kind = 'area_ratio' and _claim.rule_key = 'lot.coverage.max' then
      if _claim.value_numeric is null then
        _entry := jsonb_build_object('result','not_evaluated','reason','no approved value');
      else
        _entry := jsonb_build_object(
          'result', case when (_foot_area/_parcel_area*100) <= _claim.value_numeric
                         then 'pass' else 'fail' end,
          'actual_pct', round((_foot_area/_parcel_area*100)::numeric,1),
          'limit_pct', _claim.value_numeric,
          'margin_pct', round((_claim.value_numeric - _foot_area/_parcel_area*100)::numeric,1));
      end if;

    elsif _kind = 'scalar_max' then
      if _height_ft is null then
        _entry := jsonb_build_object('result','not_evaluated','reason','scheme has no height_ft');
      elsif _claim.value_numeric is null then
        _entry := jsonb_build_object('result','not_evaluated','reason','no approved value');
      else
        _entry := jsonb_build_object(
          'result', case when _height_ft <= _claim.value_numeric then 'pass' else 'fail' end,
          'actual_ft', _height_ft, 'limit_ft', _claim.value_numeric,
          'margin_ft', _claim.value_numeric - _height_ft);
      end if;

    else
      -- recognized-but-unimplemented (parking/far/greenspace) or unknown
      _entry := jsonb_build_object('result','not_evaluated',
                  'reason', case when _kind='unknown'
                                 then 'unrecognized constraint'
                                 else 'check kind '||_kind||' not yet implemented' end);
    end if;

    _results := _results || (_entry || jsonb_build_object(
      'rule_key', _claim.rule_key, 'check_kind', _kind,
      'citation', jsonb_build_object('section_ref',_claim.section_ref,'section_url',_claim.section_url)));
  end loop;

  return jsonb_build_object(
    'scheme_id', _scheme_id, 'parcel_id', _parcel_id,
    'constraint_codes', _codes, 'results', _results);
end;
$$;
