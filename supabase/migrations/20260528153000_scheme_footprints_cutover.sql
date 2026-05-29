-- 20260528153000_scheme_footprints_cutover.sql
-- Phase 2, Opener A — step 2 of 5: CUTOVER (breaks the frontend until step 3+).
-- Rewrites save_scheme/update_scheme/check_scheme_compliance + the views to
-- read scheme_footprints instead of the legacy schemes.footprint column.
-- Legacy schemes.footprint / schemes.height_ft stay populated with the FIRST
-- footprint as a safety net; they are NOT dropped this phase.
--
-- Compliance semantics:
--   * coverage = area of ST_Union(all footprints) / parcel area  (scheme-level)
--   * setback  = uniform-conservative inset, tested PER footprint; the
--                scheme fails if ANY footprint pokes outside the inset
--   * height   = PER footprint, each footprint's height_ft vs the cap
-- Every result entry keeps its section_ref/section_url citation; per-footprint
-- entries also carry footprint_id/ordinal/label so the UI can group by building.
-- Parcel resolution is unchanged (V1 one-parcel-per-site, limit 1). Assemblage
-- arrives WITH a rezone, so that block later becomes merged-site-boundary +
-- scenario zoning; the limit 1 is the seam.

set search_path = public, extensions;

-- ---- functions: drop old signatures, then create new ----------------------
drop function if exists public.save_scheme(uuid, text, jsonb, numeric);
drop function if exists public.update_scheme(uuid, text, jsonb, numeric);

create or replace function public.save_scheme(_project_id uuid, _name text, _footprints jsonb)
returns uuid
language plpgsql
as $function$
declare
  _site_id uuid;
  _scheme_id uuid;
  _fp jsonb;
  _ord int := 0;
begin
  select id into _site_id from sites where project_id = _project_id order by created_at limit 1;
  if _site_id is null then
    raise exception 'save_scheme: no site found for project %', _project_id;
  end if;
  if _footprints is null or jsonb_typeof(_footprints) <> 'array' or jsonb_array_length(_footprints) = 0 then
    raise exception 'save_scheme: _footprints must be a non-empty JSON array';
  end if;

  -- legacy columns = first footprint (safety net this phase)
  insert into schemes (site_id, name, footprint, height_ft)
  values (
    _site_id, _name,
    extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON((_footprints->0->'geojson')::text), 4326),
    nullif(_footprints->0->>'height_ft','')::numeric
  )
  returning id into _scheme_id;

  for _fp in select * from jsonb_array_elements(_footprints)
  loop
    insert into scheme_footprints (scheme_id, ordinal, label, use_code, footprint, height_ft)
    values (
      _scheme_id, _ord,
      nullif(_fp->>'label',''),
      nullif(_fp->>'use_code',''),
      extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON((_fp->'geojson')::text), 4326),
      nullif(_fp->>'height_ft','')::numeric
    );
    _ord := _ord + 1;
  end loop;

  return _scheme_id;
end;
$function$;

create or replace function public.update_scheme(_scheme_id uuid, _name text, _footprints jsonb)
returns uuid
language plpgsql
as $function$
declare
  _fp jsonb;
  _ord int := 0;
begin
  if _footprints is null or jsonb_typeof(_footprints) <> 'array' or jsonb_array_length(_footprints) = 0 then
    raise exception 'update_scheme: _footprints must be a non-empty JSON array';
  end if;

  update schemes
  set name = _name,
      footprint = extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON((_footprints->0->'geojson')::text), 4326),
      height_ft = nullif(_footprints->0->>'height_ft','')::numeric,
      updated_at = now()
  where id = _scheme_id;
  if not found then
    raise exception 'update_scheme: scheme % not found', _scheme_id;
  end if;

  -- replace the child set wholesale (Terra Draw hands us every feature on save)
  delete from scheme_footprints where scheme_id = _scheme_id;
  for _fp in select * from jsonb_array_elements(_footprints)
  loop
    insert into scheme_footprints (scheme_id, ordinal, label, use_code, footprint, height_ft)
    values (
      _scheme_id, _ord,
      nullif(_fp->>'label',''),
      nullif(_fp->>'use_code',''),
      extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON((_fp->'geojson')::text), 4326),
      nullif(_fp->>'height_ft','')::numeric
    );
    _ord := _ord + 1;
  end loop;

  return _scheme_id;
end;
$function$;

create or replace function public.check_scheme_compliance(_scheme_id uuid, _constraint_codes text[] default null::text[])
returns jsonb
language plpgsql
stable
as $function$
declare
  _parcel_geom    extensions.geometry;
  _parcel_id      uuid;
  _parcel_zone    text;
  _zoning_raw     text;
  _codes          text[];
  _classification jsonb;
  _results        jsonb := '[]'::jsonb;
  _parcel_area    numeric;
  _sb_front numeric; _sb_side numeric; _sb_rear numeric;
  _sb_uniform numeric; _sb_role text;
  _sb_ref text; _sb_url text;
  _inset extensions.geometry;
  _sb_result text;
  _union_geom extensions.geometry;
  _union_area numeric;
  _claim record;
  _fp record;
  _kind text;
  _entry jsonb;
begin
  -- V1: one parcel per site (limit 1). SEAM: assemblage replaces this with the
  -- merged site boundary + scenario zoning; nothing below assumes single-parcel.
  select p.id, p.geometry, p.zone_district_code, p.raw_attrs->>'zoningCode'
    into _parcel_id, _parcel_geom, _parcel_zone, _zoning_raw
  from schemes s
  join sites si        on si.id = s.site_id
  join site_parcels sp on sp.site_id = si.id
  join parcels p       on p.id = sp.parcel_id
  where s.id = _scheme_id
  limit 1;
  if not found then return null; end if;

  if _constraint_codes is not null then
    _codes := _constraint_codes;
  else
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

  -- SETBACK inset built ONCE from the parcel (uniform-conservative; directional
  -- edge-role still backlog), then tested per footprint below.
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
    _inset := extensions.ST_Buffer(_parcel_geom::extensions.geography, -(_sb_uniform*0.3048))::extensions.geometry;

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

  -- coverage uses the UNION of all footprints (no double-count on overlap)
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
          'result', case when (_union_area/_parcel_area*100) <= _claim.value_numeric then 'pass' else 'fail' end,
          'actual_pct', round((_union_area/_parcel_area*100)::numeric,1),
          'limit_pct', _claim.value_numeric,
          'margin_pct', round((_claim.value_numeric - _union_area/_parcel_area*100)::numeric,1));
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
    'scheme_id',_scheme_id,'parcel_id',_parcel_id,
    'constraint_codes',_codes,'results',_results);
end;
$function$;

-- ---- views ----------------------------------------------------------------
-- scheme_footprints_geojson: one row per footprint (the load-for-edit path).
create or replace view public.scheme_footprints_geojson
with (security_invoker = true) as
select f.id, f.scheme_id, s.site_id, si.project_id,
       f.ordinal, f.label, f.use_code, f.height_ft,
       extensions.ST_AsGeoJSON(f.footprint)::jsonb as footprint,
       round((extensions.ST_Area(f.footprint::extensions.geography) * 10.7639)::numeric, 0) as footprint_sf,
       f.created_at
from scheme_footprints f
join schemes s on s.id = f.scheme_id
join sites si  on si.id = s.site_id;

-- schemes_geojson: scheme-level summary. Column set changes (drops footprint
-- and height_ft, adds footprint_count), so DROP then CREATE — replace can't
-- remove columns.
drop view if exists public.schemes_geojson;
create view public.schemes_geojson
with (security_invoker = true) as
select s.id, s.site_id, si.project_id, s.name, s.created_at,
       count(f.id) as footprint_count,
       round((extensions.ST_Area(extensions.ST_Union(f.footprint)::extensions.geography) * 10.7639)::numeric, 0) as footprint_sf
from schemes s
join sites si on si.id = s.site_id
left join scheme_footprints f on f.scheme_id = s.id
group by s.id, s.site_id, si.project_id, s.name, s.created_at;
