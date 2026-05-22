-- =============================================================================
-- Phase 0 — Read-side views and RPCs
-- Date: 2026-04-19
--
-- Summary: Adds the read-side surface used by the React app.
--   1. parcels_geojson: a view over `parcels` that emits `geometry` as GeoJSON
--      jsonb. PostgREST returns PostGIS geometry columns as hex WKB by default,
--      so the client selects this view instead of the base table.
--   2. get_parcel_context(_parcel_id uuid): a single round-trip query that
--      returns { parcel, jurisdiction, claims } as one jsonb document.
--      Jurisdiction is resolved spatially with a fixed authority-type
--      precedence (municipal beats county_unincorporated, etc.). Claims are
--      filtered to approved-only and joined with their source_snapshot
--      (title + url) for citation.
--
-- SECURITY: Phase 0 has no RLS and no auth; anon reads everything. Phase 1
-- will lock this down. No explicit GRANTs are added here; the Supabase
-- defaults (anon/authenticated SELECT on public objects) are sufficient
-- while RLS is off.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- View: parcels_geojson
-- Mirrors `parcels` but converts the PostGIS geometry to GeoJSON jsonb so
-- PostgREST/Supabase JS can return it directly without a hex WKB decode step.
-- Note: `geometry` here is jsonb (not extensions.geometry); selecting from
-- this view via the JS client yields a GeoJSON.MultiPolygon-shaped object.
-- -----------------------------------------------------------------------------
create or replace view parcels_geojson as
select
  p.id,
  p.source_apn,
  p.source_system,
  p.label,
  p.zone_district_code,
  extensions.ST_AsGeoJSON(p.geometry)::jsonb as geometry,
  p.raw_attrs,
  p.retrieved_at,
  p.source_url,
  p.created_at,
  p.updated_at
from parcels p;

-- -----------------------------------------------------------------------------
-- Function: get_parcel_context(_parcel_id uuid) returns jsonb
--
-- Returns a single jsonb document of shape:
--   {
--     "parcel": { id, source_apn, source_system, label, zone_district_code,
--                 geometry (GeoJSON), raw_attrs, retrieved_at, source_url },
--     "jurisdiction": { id, slug, name, authority_type, code_label,
--                       code_home_url, current_code_version } | null,
--     "claims": [ { id, jurisdiction_id, zone_district_code, rule_key,
--                   value_text, value_numeric, value_unit, section_ref,
--                   section_url, source_snapshot: { title, url } }, ... ]
--   }
--
-- Returns NULL if no parcel matches `_parcel_id`. Callers should treat NULL
-- as "not found" and surface that to the user.
--
-- Jurisdiction precedence: when multiple jurisdictions contain the parcel
-- (e.g., municipal + county boundaries overlap), we pick the most-specific
-- according to authority_type. Municipal wins over county_unincorporated,
-- which wins over county, then state, federal, special_district.
--
-- Claim filter:
--   * jurisdiction_id matches the resolved jurisdiction
--   * review_state = 'approved'
--   * EITHER zone_district_code is NULL (jurisdiction-wide rule)
--     OR zone_district_code equals the parcel's zone_district_code
--     (only meaningful if the parcel has a zone code).
-- -----------------------------------------------------------------------------
create or replace function get_parcel_context(_parcel_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  _parcel_geom        extensions.geometry;
  _parcel_zone        text;
  _parcel_jsonb       jsonb;
  _jurisdiction_id    uuid;
  _jurisdiction_jsonb jsonb;
  _claims_jsonb       jsonb;
begin
  select
    p.geometry,
    p.zone_district_code,
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
  into _parcel_geom, _parcel_zone, _parcel_jsonb
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
      'parcel',       _parcel_jsonb,
      'jurisdiction', null,
      'claims',       '[]'::jsonb
    );
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
      order by c.rule_key asc, c.zone_district_code asc nulls first
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
      or (_parcel_zone is not null and c.zone_district_code = _parcel_zone)
    );

  return jsonb_build_object(
    'parcel',       _parcel_jsonb,
    'jurisdiction', _jurisdiction_jsonb,
    'claims',       _claims_jsonb
  );
end;
$$;
