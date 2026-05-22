-- Generalized unincorporated-territory engine (corrected: schema-qualified geography cast).
-- Models "unincorporated = county MINUS its municipalities" for ANY county.
-- Spatial municipality->county membership; slug-convention pairing '{county}'/'{county}_unincorporated'.

-- 1. Promote raw county polygon into its own 'county' row (non-destructive base).
insert into jurisdictions (slug, name, authority_type, boundary, code_label, code_home_url, current_code_version, notes)
select
  'el_paso_county',
  'El Paso County (whole)',
  'county',
  j.boundary,
  j.code_label,
  j.code_home_url,
  j.current_code_version,
  'Raw county polygon. Non-destructive subtraction base for refresh_unincorporated_boundary(). Not resolved against directly.'
from jurisdictions j
where j.slug = 'el_paso_county_unincorporated'
on conflict (slug) do nothing;

-- 2. Generalized, county-agnostic refresh function.
create or replace function refresh_unincorporated_boundary(_county_slug text)
returns jsonb
language plpgsql
as $$
declare
  _county_geom extensions.geometry;
  _muni_union  extensions.geometry;
  _result_geom extensions.geometry;
  _uninc_slug  text := _county_slug || '_unincorporated';
  _muni_count  int;
  _result_sqmi numeric;
begin
  select extensions.ST_MakeValid(boundary) into _county_geom
  from jurisdictions where slug = _county_slug and authority_type = 'county';

  if _county_geom is null then
    raise exception 'No county-type jurisdiction with slug %', _county_slug;
  end if;

  select
    extensions.ST_Union(extensions.ST_MakeValid(m.boundary)),
    count(*)
  into _muni_union, _muni_count
  from jurisdictions m
  where m.authority_type = 'municipal'
    and extensions.ST_Contains(_county_geom, extensions.ST_Centroid(m.boundary));

  if _muni_union is null then
    _result_geom := _county_geom;
  else
    _result_geom := extensions.ST_MakeValid(extensions.ST_Difference(_county_geom, _muni_union));
  end if;

  _result_geom := extensions.ST_Multi(_result_geom);

  update jurisdictions
  set boundary   = _result_geom::extensions.geometry(MultiPolygon, 4326),
      updated_at = now()
  where slug = _uninc_slug and authority_type = 'county_unincorporated';

  if not found then
    raise exception 'No county_unincorporated jurisdiction with slug %', _uninc_slug;
  end if;

  -- FIX: schema-qualify the geography type cast (extensions.geography, not bare geography).
  _result_sqmi := round((extensions.ST_Area(_result_geom::extensions.geography) / 2589988.11)::numeric, 1);

  return jsonb_build_object(
    'county_slug',               _county_slug,
    'unincorporated_slug',       _uninc_slug,
    'municipalities_subtracted', _muni_count,
    'result_sq_miles',           _result_sqmi
  );
end;
$$;

-- 3. Run once for El Paso (CS-only interim subtraction).
select refresh_unincorporated_boundary('el_paso_county');
